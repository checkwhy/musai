import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { IndexDb } from "@musai/fold";
import type { OperationPlan } from "@musai/modules";
import {
  type Audience,
  type CaseRecord,
  type ClaimRecord,
  type ComputedRunRecord,
  CURRENT_SCHEMA_VERSIONS,
  canonicalBytes,
  claimTypesFrom,
  hexOfRecordId,
  type PerformedRunRecord,
  type RecordId,
  type ReleaseTerms,
  type RunRecord,
  rawId,
  recipeReadKey,
  recordId,
  recordPath,
  slotFor,
  slotReadKey,
  TRIPLE_CLAIM_TYPE,
  TRIPLE_DECLARATION,
  timestamp,
  versionString,
} from "@musai/records";
import { assertScopeFree, createScope, type PutItem, Store } from "@musai/store";
import {
  allowedSignersLine,
  commitAroundTheStore,
  fixtureBrief,
  fixtureRunRecord,
  generateTestKey,
  rowsHeld,
  type TestKey,
  writeTrustFile,
} from "@musai/test-support";
import { mintAttestation, signAttestation } from "@musai/trust";
import { afterAll, beforeAll, describe, expect, onTestFinished, test, vi } from "vitest";
import { DECLARATIVE_RULE, EVALUATE_COMMAND } from "../src/check-receipts.js";
import { clearanceAdmission } from "../src/clearance.js";
import type { WorkspaceRefusal } from "../src/context.js";
import { runHandler } from "../src/handler.js";
import { openWorkspace } from "../src/open-workspace.js";
import { perform, realisePlan } from "../src/plan.js";
import type { Workspace } from "../src/workspace.js";
import { FIXTURE_CLOCK, fixtureWorkspace, fixtureWrite, refusalOf } from "./fixture-distribution.js";

const PUBLISHER = "publisher@example.test";
const TERMS: ReleaseTerms = { form: "bytes", uses: ["review"], from: null, until: null, marking: null };
const WRITER = "writer" as Audience;
const CAST = "cast" as Audience;
const CREW = "crew" as Audience;

const opensshAvailable = spawnSync("ssh-keygen", ["-Y", "check-novalidate"], { stdio: "ignore" }).error === undefined;

type Attested =
  | { readonly purpose: "sealed"; readonly from: Audience; readonly extent?: "closure" }
  | { readonly purpose: "released"; readonly to: Audience; readonly terms?: ReleaseTerms; readonly via?: "model" }
  | { readonly purpose: "revoked"; readonly supersedes: readonly RecordId[] }
  | { readonly purpose: "made" };

/** A low-entropy atom, the kind of record a salt keeps a guess from confirming. */
function atom(): ClaimRecord {
  const conditions = { subject: "urn:loom:mara", predicate: "is", object: "the heir" };
  return {
    kind: "claim",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: TRIPLE_CLAIM_TYPE,
    about: [],
    slot: slotFor(TRIPLE_DECLARATION, conditions),
    conditions,
    canonical: conditions,
    rendering: "Mara is the heir.",
    evidence: [],
    exclusiveGroup: null,
  };
}

let key: TestKey;

beforeAll(async () => {
  key = await generateTestKey(PUBLISHER);
}, 60_000);

afterAll(async () => {
  await rm(key.dir, { recursive: true, force: true });
});

/** A workspace where `PUBLISHER` holds `publish` and signs, `cast` includes `writer`, and `crew` is
 * beside both. */
async function clearable() {
  const workspace = await fixtureWorkspace({ roles: `${key.principal} owner any\n` });
  const gitDir = join(workspace.dir, ".musai");
  await writeTrustFile({ gitDir }, "allowed-signers", allowedSignersLine(key));
  await writeTrustFile({ gitDir }, "audiences", "writer\ncast includes writer\ncrew\n");
  const write = async (...runs: readonly RunRecord[]): Promise<RecordId[]> =>
    workspace.store().putMany(runs.map((value) => ({ kind: "run" as const, value })));
  let attested = 0;
  const attestation = async (subject: RecordId, asked: Attested): Promise<PutItem> => {
    attested += 1;
    const minted = mintAttestation({
      subject,
      principal: key.principal,
      principalClass: "person",
      via: asked.purpose === "released" ? (asked.via ?? "tty") : "tty",
      purpose: asked.purpose,
      at: timestamp(`2026-01-01T00:00:${String(attested).padStart(2, "0")}.000Z`),
      ...(asked.purpose === "sealed"
        ? {
            seal:
              asked.extent === undefined ? { audience: asked.from } : { audience: asked.from, extent: asked.extent },
          }
        : {}),
      ...(asked.purpose === "released"
        ? { release: { audience: asked.to, extent: "record" as const, terms: asked.terms ?? TERMS } }
        : {}),
      ...(asked.purpose === "revoked" ? { supersedes: asked.supersedes } : {}),
    });
    const signature = await signAttestation({ attestation: minted, keyPath: key.keyPath });
    return { kind: "attestation", value: minted.record, signature };
  };
  const attest = async (subject: RecordId, asked: Attested): Promise<RecordId> => {
    const [id] = await workspace.store().putMany([await attestation(subject, asked)]);
    return id!;
  };
  const opened = async (clearance?: Audience, reportRefusal?: (refusal: WorkspaceRefusal) => void) => {
    const workspaceOpened = await openWorkspace({
      workspace: workspace.dir,
      scope: workspace.scope,
      now: FIXTURE_CLOCK,
      clearance,
      reportRefusal,
    });
    onTestFinished(() => workspaceOpened.close());
    return workspaceOpened;
  };
  const cleared = async (clearance: Audience): Promise<IndexDb> => (await opened(clearance)).index;
  const author = async (): Promise<IndexDb> => (await opened()).index;
  const commitRaw = (path: string, bytes: Uint8Array) =>
    commitAroundTheStore({ ctx: { gitDir }, scope: workspace.scope, now: FIXTURE_CLOCK }, path, bytes);
  const clearedPath = (clearance: Audience) =>
    join(
      gitDir,
      "local",
      "scopes",
      workspace.scope,
      "cleared",
      `${createHash("sha256").update(clearance).digest("hex")}.sqlite`,
    );
  return {
    gitDir,
    dir: workspace.dir,
    scope: workspace.scope,
    store: workspace.store,
    write,
    attestation,
    attest,
    opened,
    cleared,
    author,
    clearedPath,
    commitRaw,
  };
}

/** Every row a reader of the fold can reach: not its stamp, nor how far its walk has gone. */
function rowsSeen(path: string): Record<string, string[]> {
  const { schema_meta: _stamp, walked: _walked, ...seen } = rowsHeld(path);
  return seen;
}

function held(index: IndexDb, ...ids: readonly RecordId[]): boolean[] {
  return ids.map((id) => index.recordById(id) !== undefined);
}

/** A sealed record, a run that read it and a run that read that run, and a record beside them. */
function lineage(): { readonly sealed: PerformedRunRecord; readonly reader: RunRecord; readonly next: RunRecord } {
  const sealed = fixtureRunRecord("the sealed record");
  const reader = fixtureBrief("read the sealed record", { reads: [recordId(sealed)] });
  const next = fixtureBrief("read the reader", { reads: [recordId(reader)] });
  return { sealed, reader, next };
}

describe.skipIf(!opensshAvailable)("a cleared fold holds every record of the scope but what is sealed from it", () => {
  test("a sealed record is absent from the cleared fold, with its seal, and present in the author's", async () => {
    const { write, attest, cleared, author } = await clearable();
    const [sealed, beside] = await write(fixtureRunRecord("the sealed record"), fixtureRunRecord("beside it"));
    const seal = await attest(sealed!, { purpose: "sealed", from: WRITER });

    expect(held(await cleared(WRITER), sealed!, seal, beside!)).toEqual([false, false, true]);
    expect(held(await author(), sealed!, seal, beside!)).toEqual([true, true, true]);
  });

  test("a run that read a sealed record is absent with it, and so is a run that read that run", async () => {
    const { write, attest, cleared, author } = await clearable();
    const { sealed, reader, next } = lineage();
    const ids = await write(sealed, reader, next);
    await attest(ids[0]!, { purpose: "sealed", from: WRITER });

    expect(held(await cleared(WRITER), ...ids)).toEqual([false, false, false]);
    expect(held(await author(), ...ids)).toEqual([true, true, true]);
  });

  test("a release over a run that read a sealed record brings it back, and revoking the release takes it away again", async () => {
    const { write, attest, cleared } = await clearable();
    const { sealed, reader, next } = lineage();
    const ids = await write(sealed, reader, next);
    await attest(ids[0]!, { purpose: "sealed", from: WRITER });
    expect(held(await cleared(WRITER), ...ids)).toEqual([false, false, false]);

    const release = await attest(ids[1]!, { purpose: "released", to: WRITER });
    expect(held(await cleared(WRITER), ...ids)).toEqual([false, true, true]);

    await attest(ids[1]!, { purpose: "revoked", supersedes: [release] });
    expect(held(await cleared(WRITER), ...ids)).toEqual([false, false, false]);
  });

  test("a release relayed through a model lowers no run that read a sealed record", async () => {
    const { write, attest, cleared } = await clearable();
    const { sealed, reader } = lineage();
    const [sealedId, readerId] = await write(sealed, reader);
    await attest(sealedId!, { purpose: "sealed", from: WRITER });

    await attest(readerId!, { purpose: "released", to: WRITER, via: "model" });

    expect(held(await cleared(WRITER), readerId!)).toEqual([false]);
  });

  test("a release lowers a run whatever its window, since a fold reads no clock", async () => {
    const { write, attest, cleared } = await clearable();
    const { sealed, reader } = lineage();
    const [sealedId, readerId] = await write(sealed, reader);
    await attest(sealedId!, { purpose: "sealed", from: WRITER });
    await attest(readerId!, {
      purpose: "released",
      to: WRITER,
      terms: { ...TERMS, until: timestamp("2025-01-01T00:00:00.000Z") },
    });

    expect(held(await cleared(WRITER), readerId!)).toEqual([true]);
  });

  test("a seal hides its record from its audience, from what that audience includes and from what includes it", async () => {
    const { write, attest, cleared } = await clearable();
    const [fromCast, fromWriter] = await write(fixtureRunRecord("sealed from cast"), fixtureRunRecord("from writer"));
    await attest(fromCast!, { purpose: "sealed", from: CAST });
    await attest(fromWriter!, { purpose: "sealed", from: WRITER });

    for (const clearance of [WRITER, CAST, "public" as Audience]) {
      expect(held(await cleared(clearance), fromCast!, fromWriter!)).toEqual([false, false]);
    }
  });

  test("a seal hides nothing from an audience it neither includes nor is included by", async () => {
    const { write, attest, cleared } = await clearable();
    const [fromCast] = await write(fixtureRunRecord("sealed from cast"));
    await attest(fromCast!, { purpose: "sealed", from: CAST });

    expect(held(await cleared(CREW), fromCast!)).toEqual([true]);
  });

  test("a seal whose signer no longer holds publish hides nothing, though the fold was built while it stood", async () => {
    const { gitDir, write, attest, cleared } = await clearable();
    const [sealed] = await write(fixtureRunRecord("the sealed record"));
    await attest(sealed!, { purpose: "sealed", from: WRITER });
    expect(held(await cleared(WRITER), sealed!)).toEqual([false]);

    await writeTrustFile({ gitDir }, "roles", `${key.principal} delegate any\nowner@example.test owner any\n`);

    expect(held(await cleared(WRITER), sealed!)).toEqual([true]);
  });

  test("a run that landed before the record it read, which then lands sealed, is absent, cold and warm alike", async () => {
    const { write, attest, cleared, clearedPath } = await clearable();
    const { sealed, reader } = lineage();
    const [readerId] = await write(reader);
    expect(held(await cleared(WRITER), readerId!)).toEqual([true]);

    const [sealedId] = await write(sealed);
    await attest(sealedId!, { purpose: "sealed", from: WRITER });
    expect(held(await cleared(WRITER), sealedId!, readerId!)).toEqual([false, false]);
    const warmRows = rowsHeld(clearedPath(WRITER));

    await rm(clearedPath(WRITER));
    await cleared(WRITER);
    expect(rowsHeld(clearedPath(WRITER))).toEqual(warmRows);
  });

  test("records built on a sealed run by reading, superseding and attesting are absent with it, whatever order they land in", async () => {
    const { store, attestation, cleared, author } = await clearable();
    const sealed = fixtureRunRecord("the sealed record");
    const sealedId = recordId(sealed);
    const reader = fixtureBrief("read the sealed record", { reads: [sealedId] });
    const restated = { ...fixtureRunRecord("restated"), supersedes: [recordId(reader)] };
    const made = await attestation(recordId(restated), { purpose: "made" });
    const seal = await attestation(sealedId, { purpose: "sealed", from: WRITER });

    // Each written before what it builds on, so the fold meets it first.
    const ids = await store().putMany([
      made,
      ...[restated, reader, sealed].map((value) => ({ kind: "run" as const, value })),
      seal,
    ]);

    expect(held(await cleared(WRITER), ...ids)).toEqual(ids.map(() => false));
    expect(held(await author(), ...ids)).toEqual(ids.map(() => true));
  });

  test("a restatement superseding a sealed record is absent with it, and present once released", async () => {
    const { write, attest, cleared } = await clearable();
    const [sealed] = await write(fixtureRunRecord("the sealed record"));
    await attest(sealed!, { purpose: "sealed", from: WRITER });
    const [restated] = await write({ ...fixtureRunRecord("restated"), supersedes: [sealed!] });
    expect(held(await cleared(WRITER), restated!)).toEqual([false]);

    await attest(restated!, { purpose: "released", to: WRITER });

    expect(held(await cleared(WRITER), sealed!, restated!)).toEqual([false, true]);
  });

  test("a commit landing only a sealed record and its seal moves no row a reader of the cleared fold sees", async () => {
    const { store, write, attestation, attest, cleared, clearedPath } = await clearable();
    const [sealed] = await write(fixtureRunRecord("the sealed record"), fixtureRunRecord("beside it"));
    await attest(sealed!, { purpose: "sealed", from: WRITER });
    await cleared(WRITER);
    const before = rowsSeen(clearedPath(WRITER));

    const another = fixtureRunRecord("another sealed record");
    await store().putMany([
      { kind: "run", value: another },
      await attestation(recordId(another), { purpose: "sealed", from: WRITER }),
    ]);
    const after = await cleared(WRITER);

    expect(held(after, recordId(another))).toEqual([false]);
    expect(rowsSeen(clearedPath(WRITER))).toEqual(before);
  });

  test("a seal landing in the same commit as its record is withheld with it", async () => {
    const { store, attestation, cleared, author } = await clearable();
    const sealed = fixtureRunRecord("the sealed record");
    const seal = await attestation(recordId(sealed), { purpose: "sealed", from: WRITER });
    const [sealedId, sealId] = await store().putMany([{ kind: "run", value: sealed }, seal]);

    expect(held(await cleared(WRITER), sealedId!, sealId!)).toEqual([false, false]);
    expect(held(await author(), sealedId!, sealId!)).toEqual([true, true]);
  });

  test("standing is judged against the author's fold passed in, not the index the workspace reads", async () => {
    const { write, attest, cleared, opened } = await clearable();
    const [sealed] = await write(fixtureRunRecord("the sealed record"));
    await attest(sealed!, { purpose: "sealed", from: WRITER });
    const workspace = await opened();
    const station: Workspace = Object.create(workspace, { index: { value: await cleared(WRITER) } });

    const fold = await station.clearedFold(WRITER, await clearanceAdmission(station, workspace.index, WRITER));
    onTestFinished(() => fold.close());

    expect(held(fold, sealed!)).toEqual([false]);
  });

  test("a fold judged before a seal lands, folded after a station refolded past it, leaves the sealed record absent", async () => {
    const { write, attest, opened } = await clearable();
    const [sealed] = await write(fixtureRunRecord("canary: the sealed record's own words"));
    const judging = await opened();
    const judgedBefore = await clearanceAdmission(judging, judging.index, WRITER);
    await attest(sealed!, { purpose: "sealed", from: WRITER });
    const station = await opened(WRITER);

    const fold = await judging.clearedFold(WRITER, judgedBefore);
    onTestFinished(() => fold.close());

    expect([held(fold, sealed!), held(station.index, sealed!)]).toEqual([[false], [false]]);
    await expect(station.store.readBytes(sealed!, "run")).rejects.toMatchObject({ reason: "no-such-record" });
  });

  test("a fold judged under trust a station's fold has moved past is refused, and the station's stays", async () => {
    const { gitDir, write, attest, opened } = await clearable();
    await writeTrustFile({ gitDir }, "roles", "");
    const [sealed] = await write(fixtureRunRecord("canary: the sealed record's own words"));
    await attest(sealed!, { purpose: "sealed", from: WRITER });
    const judging = await opened();
    const judgedBefore = await clearanceAdmission(judging, judging.index, WRITER);
    await writeTrustFile({ gitDir }, "roles", `${key.principal} owner any\n`);
    const station = await opened(WRITER);

    await expect(judging.clearedFold(WRITER, judgedBefore)).rejects.toMatchObject({ reason: "head-moved" });

    expect(held(station.index, sealed!)).toEqual([false]);
    expect(held(await opened(WRITER).then((again) => again.index), sealed!)).toEqual([false]);
  });

  test("two admissions judged at one position agree, whatever lands while either is judged", async () => {
    const { write, attest, opened, cleared } = await clearable();
    const [sealed] = await write(fixtureRunRecord("canary: the sealed record's own words"));
    const seal = await attest(sealed!, { purpose: "sealed", from: WRITER });
    await attest(sealed!, { purpose: "revoked", supersedes: [seal] });
    const judging = await opened();
    const judgedBefore = await clearanceAdmission(judging, judging.index, WRITER);
    await attest(sealed!, { purpose: "sealed", from: WRITER });
    const late = await opened();
    // A judge racing the re-seal read its position before the re-seal folded in.
    const atBefore = Object.create(late.index, { watermark: { value: () => judgedBefore.through } });
    const judgedLate = await clearanceAdmission(late, atBefore, WRITER);
    const fold = await late.clearedFold(WRITER, judgedLate);
    onTestFinished(() => fold.close());
    const heldOnceFolded = held(fold, sealed!);

    const older = await judging.clearedFold(WRITER, judgedBefore);
    onTestFinished(() => older.close());

    expect(judgedLate.digest).toBe(judgedBefore.digest);
    expect([heldOnceFolded, held(fold, sealed!)]).toEqual([[true], [true]]);
    expect(held(await cleared(WRITER), sealed!)).toEqual([false]);
  });

  test("a revocation landing past the position an admission is judged at lifts no seal in it", async () => {
    const { write, attest, opened, cleared } = await clearable();
    const [sealed] = await write(fixtureRunRecord("canary: the sealed record's own words"));
    const seal = await attest(sealed!, { purpose: "sealed", from: WRITER });
    const before = (await opened()).index.watermark();
    await attest(sealed!, { purpose: "revoked", supersedes: [seal] });
    const late = await opened();
    const atBefore = Object.create(late.index, { watermark: { value: () => before } });

    const fold = await late.clearedFold(WRITER, await clearanceAdmission(late, atBefore, WRITER));
    onTestFinished(() => fold.close());

    expect(held(fold, sealed!)).toEqual([false]);
    expect(held(await cleared(WRITER), sealed!)).toEqual([true]);
  });

  test("lifting a seal by revocation brings its record back", async () => {
    const { write, attest, cleared } = await clearable();
    const [sealed] = await write(fixtureRunRecord("the sealed record"));
    const seal = await attest(sealed!, { purpose: "sealed", from: WRITER });
    expect(held(await cleared(WRITER), sealed!)).toEqual([false]);

    await attest(sealed!, { purpose: "revoked", supersedes: [seal] });

    expect(held(await cleared(WRITER), sealed!)).toEqual([true]);
  });

  test("an unreadable record that is sealed leaves no refusal in the cleared fold", async () => {
    const { attest, cleared, author, commitRaw } = await clearable();
    const unreadable = recordId(fixtureRunRecord("never readable"));
    await commitRaw(recordPath("run", unreadable), new TextEncoder().encode("not a record"));
    await attest(unreadable, { purpose: "sealed", from: WRITER });

    expect((await author()).refusals().map((refusal) => refusal.id)).toEqual([unreadable]);
    expect((await cleared(WRITER)).refusals()).toEqual([]);
  });

  test.each([
    ["a lone surrogate", '"output":"unreadable"', '"output":"\\ud800"'],
    ["a number past a double's range", '"exitCode":0', '"exitCode":1e999'],
  ])("a record holding %s folds as its path's refusal alone, cold and warm", async (_, from, to) => {
    const { write, opened, commitRaw, gitDir, scope, clearedPath } = await clearable();
    const [before] = await write(fixtureRunRecord("before it"));
    await opened();
    await opened(WRITER);
    const bytes = new TextEncoder().encode(
      new TextDecoder().decode(canonicalBytes(fixtureRunRecord("unreadable"))).replace(from, to),
    );
    const unreadable = rawId(bytes);
    await commitRaw(recordPath("run", unreadable), bytes);
    const [after] = await write(fixtureRunRecord("after it"));

    for (const reader of [await opened(), await opened(WRITER)]) {
      expect(held(reader.index, before!, unreadable, after!)).toEqual([true, false, true]);
      expect(reader.refusals.map((refusal) => [refusal.id, refusal.reason])).toEqual([
        [unreadable, "it holds a value with no RFC 8785 canonical form"],
      ]);
      const refused = refusalOf(() => reader.read(unreadable));
      await expect(refused).resolves.toMatchObject({ reason: "record-corrupted" });
      expect((await refused).message).not.toMatch(/not allowed/);
    }
    const folds = [join(gitDir, "local", "scopes", scope, "index.sqlite"), clearedPath(WRITER)];
    const warm = folds.map((path) => rowsHeld(path));
    for (const path of folds) {
      await rm(path);
    }
    await opened();
    await opened(WRITER);
    expect(folds.map((path) => rowsHeld(path))).toEqual(warm);
  });

  test("a seal landing on a cleared fold already built hides its record from it", async () => {
    const { write, attest, cleared } = await clearable();
    const [sealed] = await write(fixtureRunRecord("the sealed record"));
    expect(held(await cleared(WRITER), sealed!)).toEqual([true]);

    await attest(sealed!, { purpose: "sealed", from: WRITER });

    expect(held(await cleared(WRITER), sealed!)).toEqual([false]);
  });

  test("a cold and a warm cleared fold hold the same rows", async () => {
    const { write, attest, cleared, clearedPath } = await clearable();
    const { sealed, reader, next } = lineage();
    const later = fixtureBrief("read the sealed record later", { reads: [recordId(sealed)] });
    const early = fixtureBrief("read it before it landed", { reads: [recordId(later)] });
    const [sealedId] = await write(sealed, reader, early);
    await attest(sealedId!, { purpose: "sealed", from: WRITER });
    await cleared(WRITER);

    const beside = fixtureRunRecord("beside it");
    const [nextId] = await write(
      next,
      later,
      beside,
      fixtureBrief("read what is beside", { reads: [recordId(beside)] }),
    );
    await attest(sealedId!, { purpose: "made" });
    const warm = await cleared(WRITER);
    expect(held(warm, nextId!, recordId(later), recordId(early), recordId(beside))).toEqual([false, false, true, true]);
    const warmRows = rowsHeld(clearedPath(WRITER));

    await rm(clearedPath(WRITER));
    await cleared(WRITER);

    expect(rowsHeld(clearedPath(WRITER))).toEqual(warmRows);
  });
});

/** A run, a restatement citing it, and a run that read the first. */
function cited(): { readonly first: RunRecord; readonly restated: RunRecord; readonly reader: RunRecord } {
  const first = fixtureRunRecord("cited by the restatement");
  const restated = { ...fixtureRunRecord("the restatement"), supersedes: [recordId(first)] };
  const reader = fixtureBrief("read what the restatement cites", { reads: [recordId(first)] });
  return { first, restated, reader };
}

describe.skipIf(!opensshAvailable)("a seal names its extent: its record alone, or all its record cites", () => {
  test("a seal naming no extent hides its record and leaves what it cites", async () => {
    const { write, attest, cleared } = await clearable();
    const { first, restated, reader } = cited();
    const ids = await write(first, restated, reader);

    await attest(ids[1]!, { purpose: "sealed", from: WRITER });

    expect(held(await cleared(WRITER), ...ids)).toEqual([true, false, true]);
  });

  test("a closure seal hides what its record cites, an attestation on it and a run that read it", async () => {
    const { write, attest, cleared, author } = await clearable();
    const { first, restated, reader } = cited();
    const ids = await write(first, restated, reader);
    const made = await attest(ids[0]!, { purpose: "made" });

    await attest(ids[1]!, { purpose: "sealed", from: WRITER, extent: "closure" });

    expect(held(await cleared(WRITER), ...ids, made)).toEqual([false, false, false, false]);
    expect(held(await author(), ...ids, made)).toEqual([true, true, true, true]);
  });

  test("a closure seal hides nothing from an audience it neither includes nor is included by", async () => {
    const { write, attest, cleared } = await clearable();
    const { first, restated } = cited();
    const ids = await write(first, restated);

    await attest(ids[1]!, { purpose: "sealed", from: CAST, extent: "closure" });

    expect(held(await cleared(CREW), ...ids)).toEqual([true, true]);
    expect(held(await cleared(WRITER), ...ids)).toEqual([false, false]);
  });

  test("lifting a closure seal brings back all it hid", async () => {
    const { write, attest, cleared } = await clearable();
    const { first, restated, reader } = cited();
    const ids = await write(first, restated, reader);
    const seal = await attest(ids[1]!, { purpose: "sealed", from: WRITER, extent: "closure" });
    expect(held(await cleared(WRITER), ...ids)).toEqual([false, false, false]);

    await attest(ids[1]!, { purpose: "revoked", supersedes: [seal] });

    expect(held(await cleared(WRITER), ...ids)).toEqual([true, true, true]);
  });

  test("a closure seal's closure is walked as of the position judged at, whatever lands while it is judged", async () => {
    const { write, attest, opened } = await clearable();
    const { first, restated } = cited();
    const [firstId] = await write(first);
    await attest(recordId(restated), { purpose: "sealed", from: WRITER, extent: "closure" });
    const judging = await opened();
    const judgedBefore = await clearanceAdmission(judging, judging.index, WRITER);
    await write(restated);
    const late = await opened();
    const atBefore = Object.create(late.index, { watermark: { value: () => judgedBefore.through } });

    const judgedLate = await clearanceAdmission(late, atBefore, WRITER);
    const fold = await late.clearedFold(WRITER, judgedLate);
    onTestFinished(() => fold.close());

    expect(judgedLate.digest).toBe(judgedBefore.digest);
    expect(held(fold, firstId!)).toEqual([true]);
    expect(held((await opened(WRITER)).index, firstId!, recordId(restated))).toEqual([false, false]);
  });

  test("a closure member landing after its seal is folded warm as a cold fold folds it", async () => {
    const { write, attest, cleared, clearedPath } = await clearable();
    const { first, restated, reader } = cited();
    const [restatedId] = await write(restated);
    await attest(restatedId!, { purpose: "sealed", from: WRITER, extent: "closure" });
    const [besideId] = await write(fixtureRunRecord("beside it"));
    expect(held(await cleared(WRITER), restatedId!, besideId!)).toEqual([false, true]);
    const stamped = rowsHeld(clearedPath(WRITER))["schema_meta"];

    const [firstId, readerId] = await write(first, reader);
    const warm = await cleared(WRITER);
    expect(held(warm, firstId!, readerId!, besideId!)).toEqual([false, false, true]);
    const warmRows = rowsHeld(clearedPath(WRITER));
    expect(warmRows["schema_meta"]?.map((row) => JSON.parse(row).admission)).toEqual(
      stamped?.map((row) => JSON.parse(row).admission),
    );

    await rm(clearedPath(WRITER));
    await cleared(WRITER);

    expect(rowsHeld(clearedPath(WRITER))).toEqual(warmRows);
  });

  test("a closure member landing after its seal and citing what the fold admitted takes it out, cold and warm alike", async () => {
    const { write, attest, cleared, clearedPath } = await clearable();
    const { first, restated, reader } = cited();
    const [firstId, readerId] = await write(first, reader);
    await attest(recordId(restated), { purpose: "sealed", from: WRITER, extent: "closure" });
    expect(held(await cleared(WRITER), firstId!, readerId!)).toEqual([true, true]);

    const [restatedId] = await write(restated);
    expect(held(await cleared(WRITER), firstId!, restatedId!, readerId!)).toEqual([false, false, false]);
    const warmRows = rowsHeld(clearedPath(WRITER));

    await rm(clearedPath(WRITER));
    await cleared(WRITER);

    expect(rowsHeld(clearedPath(WRITER))).toEqual(warmRows);
  });

  test("a release over a closure member leaves it hidden, and one over a run that read a member lowers that run", async () => {
    const { write, attest, cleared } = await clearable();
    const { first, restated, reader } = cited();
    const ids = await write(first, restated, reader);
    await attest(ids[1]!, { purpose: "sealed", from: WRITER, extent: "closure" });

    await attest(ids[0]!, { purpose: "released", to: WRITER });
    await attest(ids[2]!, { purpose: "released", to: WRITER });

    expect(held(await cleared(WRITER), ...ids)).toEqual([false, false, true]);
  });
});

/** A run whose recipe runs `program`, so it shares a recipe only with runs of that program. */
function runOf(program: string, output: string): PerformedRunRecord {
  const run = fixtureRunRecord(output);
  return { ...run, recipe: { ...run.recipe, command: [program] } };
}

/** A check claim whose interpreter condition holds `parameters` verbatim, citing `run`. */
function checkCiting(run: RecordId, parameters: string): ClaimRecord {
  const claim = atom();
  return {
    ...claim,
    conditions: { ...claim.conditions, [DECLARATIVE_RULE]: parameters },
    evidence: [
      {
        run,
        selector: { module: "musai.core", parser: "exit-code", version: versionString("1"), key: "result" },
        item: recordId({ run, key: "result" }),
      },
    ],
  };
}

/** A check claim sealed by closure from `writer`, citing one run, beside another run of the cited
 * recipe, a run of the recipe its condition names and a run of a third. */
async function sealedCheck(parameters: string) {
  const world = await clearable();
  const [cited, rerun, receipt, beside] = await world.write(
    fixtureRunRecord("cited by the check"),
    fixtureRunRecord("the cited recipe run again"),
    runOf("named", "a receipt of the declared recipe"),
    runOf("beside", "beside it"),
  );
  const [check] = await (await world.opened()).put([{ kind: "claim", value: checkCiting(cited!, parameters) }]);
  await world.attest(check!, { purpose: "sealed", from: WRITER, extent: "closure" });
  return { ...world, check: check!, cited: cited!, rerun: rerun!, receipt: receipt!, beside: beside! };
}

/** An interpreter condition naming one recipe, given as raw JSON text. */
function namingRecipe(recipe: string): string {
  return `{"recipes":[{"name":"named","recipe":${recipe}}],"expectations":[]}`;
}

describe.skipIf(!opensshAvailable)("a closure seal over a check whose condition does not read", () => {
  test.each([
    ["does not parse", '{"recipes": ['],
    ["names recipes as no list", JSON.stringify({ recipes: "named", expectations: [] })],
    ["names a recipe as a number with no canonical form", namingRecipe("1e999")],
    ["names a recipe as a lone surrogate", namingRecipe('"\\ud800"')],
  ])("hides the check, what it cites and its cited recipe's runs where its condition %s", async (_, broken) => {
    const { check, cited, rerun, receipt, beside, opened, author } = await sealedCheck(broken);

    const station = await opened(WRITER);

    expect(held(station.index, check, cited, rerun, receipt, beside)).toEqual([false, false, false, true, true]);
    expect(held(await author(), check, cited, rerun, receipt, beside)).toEqual([true, true, true, true, true]);
  });

  test("still hides the receipts of each recipe its well-formed entries name", async () => {
    const parameters = JSON.stringify({
      recipes: [{ name: "named", recipe: runOf("named", "").recipe }, null, { name: "unnamed" }],
      expectations: [],
    });
    const { check, cited, rerun, receipt, beside, cleared } = await sealedCheck(parameters);

    const seen = held(await cleared(WRITER), check, cited, rerun, receipt, beside);

    expect(seen).toEqual([false, false, false, false, true]);
  });

  test("shows a station what a well-formed check of its cited recipe shows it: no refusal, no-such-record", async () => {
    const broken = await sealedCheck('{"recipes": [');
    const formed = await sealedCheck(namingRecipe(JSON.stringify(fixtureRunRecord("").recipe)));
    const seen = [];

    for (const { check, opened, clearedPath } of [broken, formed]) {
      const station = await opened(WRITER);
      const refused = (() => {
        try {
          station.read(check);
        } catch (error) {
          return error as Error & { readonly reason?: string };
        }
        return expect.unreachable("a sealed check was read");
      })();
      seen.push({
        rows: rowsSeen(clearedPath(WRITER)),
        refusals: station.refusals,
        refused: [refused.reason, refused.message.replace(check, "<check>")],
      });
    }

    expect(seen[0]).toEqual(seen[1]);
  });

  test("a cold and a warm cleared fold hold the same rows past it", async () => {
    const { cited, write, cleared, clearedPath } = await sealedCheck('{"recipes": [');
    await cleared(WRITER);

    const [reader, again, later] = await write(
      fixtureBrief("read what the check cites", { reads: [cited] }),
      fixtureRunRecord("the cited recipe run once more"),
      runOf("later", "landed later"),
    );
    expect(held(await cleared(WRITER), reader!, again!, later!)).toEqual([false, false, true]);
    const warm = rowsHeld(clearedPath(WRITER));

    await rm(clearedPath(WRITER));
    await cleared(WRITER);

    expect(rowsHeld(clearedPath(WRITER))).toEqual(warm);
  });
});

const MODULE_RULE = "acme.mod/rule";

/** A check claim a module's rule judges, so what its evaluations read decides its recipes. */
function ruleCheck(): ClaimRecord {
  const claim = atom();
  return { ...claim, conditions: { ...claim.conditions, [MODULE_RULE]: "{}" } };
}

/** An evaluation of `check` by its rule, reading each receipt under its recipe. */
function evaluationOf(check: RecordId, ...receipts: readonly RunRecord[]): ComputedRunRecord {
  const { slot } = ruleCheck();
  return {
    ...fixtureBrief(""),
    runKind: "evaluation",
    recipe: { command: [EVALUATE_COMMAND, MODULE_RULE, slot], substrates: [] },
    observation: {
      output: `judged over ${receipts.map((receipt) => recordId(receipt)).join(", ")}`,
      reads: [
        { key: slotReadKey(slot), consumed: { sha256: hexOfRecordId(check) } },
        ...receipts.map((receipt) => ({
          key: recipeReadKey(recordId(receipt.recipe)),
          consumed: { sha256: hexOfRecordId(recordId(receipt)) },
        })),
      ],
      cost: {},
    },
  };
}

/** An evaluation of another claim by the same rule, reading each receipt under its recipe. */
function evaluationElsewhere(check: RecordId, ...receipts: readonly RunRecord[]): ComputedRunRecord {
  return {
    ...evaluationOf(check, ...receipts),
    recipe: { command: [EVALUATE_COMMAND, MODULE_RULE, "elsewhere"], substrates: [] },
  };
}

/** `ruleCheck` landed and sealed by closure from `writer`, once what `before` makes of it lands. */
async function sealedRuleCheck(before: (check: RecordId) => readonly RunRecord[] = () => []) {
  const world = await clearable();
  const [check] = await (await world.opened()).put([{ kind: "claim", value: ruleCheck() }]);
  const runs = before(check!);
  if (runs.length > 0) {
    await world.write(...runs);
  }
  await world.attest(check!, { purpose: "sealed", from: WRITER, extent: "closure" });
  return { ...world, check: check! };
}

describe.skipIf(!opensshAvailable)("a closure seal over a check a module's rule judges", () => {
  test("withholds every receipt of each recipe an evaluation landed before it read", async () => {
    const receipt = runOf("read", "read before the seal");
    const { check, cleared } = await sealedRuleCheck((sealed) => [receipt, evaluationOf(sealed, receipt)]);

    expect(held(await cleared(WRITER), check, recordId(receipt))).toEqual([false, false]);
  });

  test("leaves a station's rows byte-identical, and every receipt it held, when an evaluation it cannot see lands", async () => {
    const receipt = runOf("held", "held by the station");
    const { check, write, cleared, clearedPath } = await sealedRuleCheck(() => [receipt]);
    const receiptId = recordId(receipt);
    expect(held(await cleared(WRITER), receiptId)).toEqual([true]);
    const rows = rowsSeen(clearedPath(WRITER));

    const [evaluation] = await write(evaluationOf(check, receipt));

    expect(held(await cleared(WRITER), receiptId, evaluation!)).toEqual([true, false]);
    expect(rowsSeen(clearedPath(WRITER))).toEqual(rows);
  });

  test("withholds a receipt landing with or after an evaluation reading its recipe, cold and warm alike", async () => {
    const first = runOf("read", "landed before the evaluation");
    const { check, write, cleared, clearedPath } = await sealedRuleCheck(() => [first]);
    await cleared(WRITER);
    await write(evaluationOf(check, first));
    const after = runOf("read", "landed after the evaluation, read by another claim's");
    const beside = runOf("beside", "landed in the evaluation's commit");
    await write(after, evaluationElsewhere(check, after));
    await write(beside, evaluationOf(check, first, beside));

    const seen = held(await cleared(WRITER), recordId(first), recordId(after), recordId(beside));
    expect(seen).toEqual([true, false, false]);
    const warm = rowsHeld(clearedPath(WRITER));
    await rm(clearedPath(WRITER));
    await cleared(WRITER);
    expect(rowsHeld(clearedPath(WRITER))).toEqual(warm);
  });

  test("withholds a receipt landing after it that no evaluation in its own commit read, cold and warm alike", async () => {
    const early = runOf("early", "landed apart before the seal");
    const { check, write, cleared, clearedPath } = await sealedRuleCheck(() => [early]);
    await cleared(WRITER);
    const read = runOf("read-beside", "read by another claim's evaluation in its own commit");
    const [apart] = await write(runOf("apart", "landed apart after the seal"));
    await write(read, evaluationElsewhere(check, read));

    expect(held(await cleared(WRITER), recordId(early), apart!, recordId(read))).toEqual([true, false, true]);
    const warm = rowsHeld(clearedPath(WRITER));
    await rm(clearedPath(WRITER));
    await cleared(WRITER);
    expect(rowsHeld(clearedPath(WRITER))).toEqual(warm);
  });

  test("withdraws no receipt a station held when the sealed closure's module-rule claim lands after the seal, cold and warm alike", async () => {
    const world = await clearable();
    const earlier = { ...ruleCheck(), rendering: "An earlier claim at its slot." };
    const [earlierId] = await (await world.opened()).put([{ kind: "claim", value: earlier }]);
    const read = runOf("read-earlier", "read by an evaluation of the earlier claim");
    await world.write(read, evaluationOf(earlierId!, read));
    const late = recordId(ruleCheck());
    const citing: CaseRecord = {
      kind: "case",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.case,
      type: null,
      slug: "cites-a-claim-yet-to-land",
      claims: [late],
      preset: { module: "musai.core", contribution: "musai.core/bare", moduleRecord: recordId({ marker: "bare" }) },
      projectCommit: "0".repeat(40),
      overrides: {},
      evaluatorVersion: versionString("1"),
    };
    const [caseId] = await world.store().putMany([{ kind: "case", value: citing }]);
    await world.attest(caseId!, { purpose: "sealed", from: WRITER, extent: "closure" });
    const [apart] = await world.write(runOf("apart", "landed apart before the claim"));
    expect(held(await world.cleared(WRITER), recordId(read), apart!)).toEqual([true, true]);
    const rows = rowsSeen(world.clearedPath(WRITER));

    await createScope({ gitDir: world.gitDir }, "elsewhere", (await world.store().tip())!);
    const elsewhere = new Store({
      ctx: { gitDir: world.gitDir },
      scope: "elsewhere",
      now: FIXTURE_CLOCK,
      claimTypes: claimTypesFrom([TRIPLE_DECLARATION]),
    });
    await elsewhere.put("claim", ruleCheck());
    await world.store().mergeFrom("elsewhere");

    expect(held(await world.cleared(WRITER), late, recordId(read), apart!)).toEqual([false, true, true]);
    expect(rowsSeen(world.clearedPath(WRITER))).toEqual(rows);
    const after = runOf("read-earlier", "landed after the claim");
    const [afterId, apartAfter] = await world.write(after, runOf("apart", "landed apart after the claim"));
    expect(held(await world.cleared(WRITER), afterId!, apartAfter!)).toEqual([false, false]);
    const warm = rowsHeld(world.clearedPath(WRITER));
    await rm(world.clearedPath(WRITER));
    await world.cleared(WRITER);
    expect(rowsHeld(world.clearedPath(WRITER))).toEqual(warm);
  });
});

describe.skipIf(!opensshAvailable)("a workspace opened under a clearance reads only what that clearance covers", () => {
  test("a read by a sealed id answers no-such-record from the workspace and its store alike, naming no seal", async () => {
    const { write, attest, opened } = await clearable();
    const [sealed, beside] = await write(fixtureRunRecord("the sealed record"), fixtureRunRecord("beside it"));
    const seal = await attest(sealed!, { purpose: "sealed", from: WRITER });
    const station = await opened(WRITER);

    const reads: readonly (() => unknown)[] = [
      () => station.read(sealed!),
      () => station.store.read(sealed!, "run"),
      () => station.store.readBytes(sealed!, "run"),
      () => station.store.read(seal, "attestation"),
      () => station.store.readSidecar(seal),
    ];
    for (const read of reads) {
      const refused = await (async () => read())().then(
        () => expect.unreachable("a sealed id was read"),
        (error: unknown) => error,
      );
      expect(refused).toMatchObject({ reason: "no-such-record" });
      expect(String((refused as Error).message)).not.toMatch(/seal/i);
    }
    expect(station.read(beside!)).toEqual(fixtureRunRecord("beside it"));
    expect(await station.store.read(beside!, "run")).toEqual(fixtureRunRecord("beside it"));
    expect(await station.store.list("run")).toEqual([beside]);
    expect((await opened()).read(sealed!)).toEqual(fixtureRunRecord("the sealed record"));
  });

  test("its refusals, and the refusals it reports as it opens, are its own fold's", async () => {
    const { attest, opened, commitRaw } = await clearable();
    const unreadable = recordId(fixtureRunRecord("never readable"));
    await commitRaw(recordPath("run", unreadable), new TextEncoder().encode("not a record"));
    await attest(unreadable, { purpose: "sealed", from: WRITER });
    const reported: WorkspaceRefusal[] = [];

    const station = await opened(WRITER, (refusal) => reported.push(refusal));

    expect([station.refusals, reported]).toEqual([[], []]);
    expect((await opened()).refusals.map((refusal) => refusal.id)).toEqual([unreadable]);
  });

  test("a clearance that is no audience, or one the audiences file does not declare, is refused as it opens", async () => {
    const { opened } = await clearable();
    const undeclaredKey = `key:SHA256:${"A".repeat(43)}` as Audience;

    for (const clearance of ["Not An Audience", "nobody", undeclaredKey] as Audience[]) {
      await expect(opened(clearance)).rejects.toMatchObject({ reason: "invalid-input", about: [clearance] });
    }
    expect((await opened(CAST)).clearance).toBe(CAST);
  });

  test("a seal written through a cleared workspace hides its record from that workspace at once", async () => {
    const { write, attestation, opened } = await clearable();
    const [visible] = await write(fixtureRunRecord("visible until sealed"));
    const station = await opened(WRITER);
    expect(station.index.holds(visible!)).toBe(true);

    const [seal] = await station.put([await attestation(visible!, { purpose: "sealed", from: WRITER })]);

    expect([station.index.holds(visible!), station.index.holds(seal!)]).toEqual([false, false]);
    expect(() => station.read(visible!)).toThrow(expect.objectContaining({ reason: "no-such-record" }));
    expect(held((await opened()).index, visible!, seal!)).toEqual([true, true]);
  });

  test("a station salting the text of the author's sealed salted claim mints another id, planned and performed", async () => {
    const { attest, opened, dir, scope } = await clearable();
    const [authors] = await (await opened()).put([{ kind: "claim", value: atom(), salt: true }]);
    await attest(authors!, { purpose: "sealed", from: WRITER });
    const salting: OperationPlan = { put: [{ kind: "claim", value: atom(), salt: true }], attest: [], needs: [] };
    const context = { workspace: dir, scope, now: FIXTURE_CLOCK, clearance: WRITER };
    const station = await opened(WRITER);

    const planned = await realisePlan(salting, station, context, "fixture.salts@1", undefined);
    const guess = planned.minted[0]!.id;
    await perform(planned, [], station);
    const [put] = await station.put([{ kind: "claim", value: atom(), salt: true }]);
    const [again] = await (await opened(WRITER)).put([{ kind: "claim", value: atom(), salt: true }]);

    expect(guess).not.toBe(authors);
    expect([put, again]).toEqual([guess, guess]);
    expect(station.read(guess)).toEqual(planned.minted[0]!.record);
    expect(() => station.read(authors!)).toThrow(expect.objectContaining({ reason: "no-such-record" }));
    const [restated] = await (await opened()).put([{ kind: "claim", value: atom(), salt: true }]);
    expect(restated).toBe(authors);
  });

  test("a cleared workspace is refused a fork, naming its clearance, and leaves no scope behind", async () => {
    const { gitDir, write, attest, opened } = await clearable();
    const [sealed] = await write(fixtureRunRecord("the sealed record"));
    await attest(sealed!, { purpose: "sealed", from: WRITER });
    const station = await opened(WRITER);

    for (const writing of [true, false]) {
      await expect(station.fork("forked", writing)).rejects.toMatchObject({
        reason: "invalid-input",
        about: [WRITER],
      });
    }

    await expect(assertScopeFree({ gitDir }, "forked")).resolves.toBeUndefined();
  });

  test("a station passing back the head it was shown writes, though a sealed-only commit sits on top", async () => {
    const { dir, scope, write, store, attestation, opened } = await clearable();
    await write(fixtureRunRecord("visible"));
    const shown = (await opened(WRITER)).index.watermark()!;
    const sealed = fixtureRunRecord("the sealed record");
    await store().putMany([
      { kind: "run", value: sealed },
      await attestation(recordId(sealed), { purpose: "sealed", from: WRITER }),
    ]);
    const station = { workspace: dir, scope, now: FIXTURE_CLOCK, clearance: WRITER, expectHead: shown };

    const written = await runHandler(fixtureWrite, { label: "written by the station" }, station);

    expect(written.minted).toHaveLength(1);
  });

  test("a moved-head refusal under a clearance names no commit the cleared fold lacks", async () => {
    const { dir, scope, write, store, attestation, opened } = await clearable();
    await write(fixtureRunRecord("visible"));
    const shown = (await opened(WRITER)).index.watermark()!;
    await write(fixtureRunRecord("visible, landed since"));
    const sealed = fixtureRunRecord("the sealed record");
    await store().putMany([
      { kind: "run", value: sealed },
      await attestation(recordId(sealed), { purpose: "sealed", from: WRITER }),
    ]);
    const moved = (await opened(WRITER)).index.watermark()!;
    const hidden = (await store().tip())!;
    const station = { workspace: dir, scope, now: FIXTURE_CLOCK, clearance: WRITER, expectHead: shown };

    const refused = await refusalOf(() => runHandler(fixtureWrite, { label: "too late" }, station));

    expect(refused).toMatchObject({ reason: "head-moved", about: [`expected:${shown}`, `found:${moved}`] });
    expect(JSON.stringify({ ...refused, message: refused.message })).not.toContain(hidden);
  });

  test("closing a cleared workspace closes the author's fold it holds as well", async () => {
    const { dir, scope } = await clearable();
    const close = vi.spyOn(IndexDb.prototype, "close");
    onTestFinished(() => close.mockRestore());
    const station = await openWorkspace({ workspace: dir, scope, now: FIXTURE_CLOCK, clearance: WRITER });

    station.close();

    expect(new Set(close.mock.contexts).size).toBe(2);
    expect(close.mock.contexts).toContain(station.index);
  });
});
