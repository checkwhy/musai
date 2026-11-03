import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { type Admission, IndexDb } from "@musai/fold";
import type { OperationPlan } from "@musai/modules";
import {
  type AttestationRecord,
  type Audience,
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
  sidecarPath,
  slotFor,
  slotReadKey,
  TRIPLE_CLAIM_TYPE,
  TRIPLE_DECLARATION,
  timestamp,
  versionString,
} from "@musai/records";
import {
  assertScopeFree,
  createScope,
  type PutItem,
  readTrustBranch,
  readTrustTip,
  Store,
  scopeRefName,
  scopeVerificationCachePath,
} from "@musai/store";
import {
  allowedSignersLine,
  commitAroundTheStore,
  commitFilesAroundTheStore,
  fixtureArtifact,
  fixtureBrief,
  fixtureCase,
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
import { releaseStanding } from "../src/release.js";
import { clearedFold, Workspace } from "../src/workspace.js";
import { FIXTURE_CLOCK, fixtureWorkspace, fixtureWrite, refusalOf } from "./fixture-distribution.js";

const PUBLISHER = "publisher@example.test";
const TERMS: ReleaseTerms = { form: "bytes", uses: ["review"], from: null, until: null, marking: null };
const WRITER = "writer" as Audience;
const CAST = "cast" as Audience;
const CREW = "crew" as Audience;

const opensshAvailable = spawnSync("ssh-keygen", ["-Y", "check-novalidate"], { stdio: "ignore" }).error === undefined;

type Attested =
  | { readonly purpose: "sealed"; readonly from: Audience; readonly extent?: "closure" }
  | {
      readonly purpose: "released";
      readonly to: Audience;
      readonly terms?: ReleaseTerms;
      readonly via?: "model";
      readonly supersedes?: readonly RecordId[];
    }
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
/** A second holder of publish, whose principal names no record the publisher signed. */
let second: TestKey;

beforeAll(async () => {
  key = await generateTestKey(PUBLISHER);
  second = await generateTestKey("second@example.test");
}, 60_000);

afterAll(async () => {
  await rm(second.dir, { recursive: true, force: true });
});

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
      ...(asked.purpose === "revoked" || asked.purpose === "released"
        ? asked.supersedes === undefined
          ? {}
          : { supersedes: asked.supersedes }
        : {}),
    });
    const signature = await signAttestation({ attestation: minted, keyPath: key.keyPath });
    return { kind: "attestation", value: minted.record, signature };
  };
  const attest = async (subject: RecordId, asked: Attested): Promise<RecordId> => {
    const [id] = await workspace.store().putMany([await attestation(subject, asked)]);
    return id!;
  };
  /** Written around the store at an attestation version later than the kernel's, signed unless
   * its sidecar is `stripped`. */
  const attestLater = async (subject: RecordId, asked: Attested, supersedes: readonly RecordId[], stripped = false) => {
    const value = (await attestation(subject, asked)).value as AttestationRecord;
    const later = { ...value, schemaVersion: CURRENT_SCHEMA_VERSIONS.attestation + 1, supersedes };
    const bytes = canonicalBytes(later);
    const id = rawId(bytes);
    const signed = { id, record: later as unknown as AttestationRecord };
    const signature = stripped ? [] : [await signAttestation({ attestation: signed, keyPath: key.keyPath })];
    await commitFilesAroundTheStore({ ctx: { gitDir }, scope: workspace.scope, now: FIXTURE_CLOCK }, [
      { path: recordPath("attestation", id), bytes },
      ...signature.map((text) => ({ path: sidecarPath(id), bytes: new TextEncoder().encode(text) })),
    ]);
    return id;
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
    attestLater,
    opened,
    cleared,
    author,
    clearedPath,
    commitRaw,
  };
}

/** A commit holding `commit`'s tree beside it, as a rewrite of the trust branch makes. */
function commitBeside(gitDir: string, commit: string): string {
  const identity = {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  const made = spawnSync("git", ["--git-dir", gitDir, "commit-tree", `${commit}^{tree}`, "-m", "rewritten"], {
    env: { ...process.env, ...identity },
    encoding: "utf8",
  });
  return made.stdout.trim();
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

  test("a release at a later attestation version takes away a release it supersedes, and a stripped revocation at one too", async () => {
    const { write, attest, attestLater, cleared } = await clearable();
    const { sealed, reader, next } = lineage();
    const ids = await write(sealed, reader, next);
    await attest(ids[0]!, { purpose: "sealed", from: WRITER });
    const replaced = await attest(ids[1]!, { purpose: "released", to: WRITER });
    const revoked = await attest(ids[1]!, { purpose: "released", to: CAST });
    await attestLater(ids[1]!, { purpose: "released", to: WRITER }, [replaced]);
    expect(held(await cleared(WRITER), ...ids)).toEqual([false, true, true]);

    await attestLater(ids[1]!, { purpose: "revoked", supersedes: [revoked] }, [revoked], true);
    expect(held(await cleared(WRITER), ...ids)).toEqual([false, false, false]);
  });

  test("a station reads the standing of a record it holds past an attestation at a later version, stripped or signed", async () => {
    const { write, attest, attestLater, opened } = await clearable();
    const [record] = await write(fixtureRunRecord("released, then withdrawn"));
    const signed = await attest(record!, { purpose: "released", to: WRITER });
    const stripped = await attest(record!, { purpose: "released", to: CAST });
    await attestLater(record!, { purpose: "released", to: CREW }, [signed]);
    await attestLater(record!, { purpose: "revoked", supersedes: [stripped] }, [stripped], true);

    const station = await opened(WRITER);
    expect(station.index.withdrawingBySubject(record!)).toHaveLength(2);
    expect((await releaseStanding(station, record!)).standing).toEqual([]);
  });

  test("an attestation at a later version over a sealed record is withheld with it, its refusal and what it fixes alike", async () => {
    const { write, attest, attestLater, cleared, author } = await clearable();
    const [sealed] = await write(fixtureRunRecord("the sealed record"));
    await attest(sealed!, { purpose: "sealed", from: WRITER });
    const later = await attestLater(sealed!, { purpose: "released", to: CREW }, []);

    const station = await cleared(WRITER);
    expect(station.withdrawingBySubject(sealed!)).toEqual([]);
    expect(station.refusals().map((refusal) => refusal.id)).not.toContain(later);
    const authored = await author();
    expect(authored.withdrawingBySubject(sealed!).map((entry) => entry.id)).toEqual([later]);
    expect(authored.refusals().map((refusal) => refusal.id)).toContain(later);
  });

  test("a later attestation a cleared fold keeps names no record it withholds, and still withdraws the release beside one", async () => {
    const { write, attest, attestLater, opened } = await clearable();
    const [shown, sealed] = await write(fixtureRunRecord("shown"), fixtureRunRecord("sealed"));
    await attest(sealed!, { purpose: "sealed", from: WRITER });
    const release = await attest(shown!, { purpose: "released", to: WRITER });
    await attestLater(shown!, { purpose: "revoked", supersedes: [release] }, [release, sealed!], true);

    const station = await opened(WRITER);
    expect(station.index.attestationsBySubject(shown!).map((entry) => entry.id)).toEqual([release]);
    expect(station.index.withdrawingBySubject(shown!).map((entry) => entry.record.supersedes)).toEqual([[release]]);
    expect((await releaseStanding(station, shown!)).standing).toEqual([]);
  });

  test("a revocation a cleared fold withholds for superseding a sealed record still withdraws, there, the release beside it", async () => {
    const { write, attest, opened } = await clearable();
    const [shown, sealed] = await write(fixtureRunRecord("shown"), fixtureRunRecord("sealed"));
    await attest(sealed!, { purpose: "sealed", from: WRITER });
    const release = await attest(shown!, { purpose: "released", to: WRITER });
    const revocation = await attest(shown!, { purpose: "revoked", supersedes: [release, sealed!] });

    const station = await opened(WRITER);
    expect(held(station.index, revocation)).toEqual([false]);
    expect(station.index.attestationsBySubject(shown!).map((entry) => entry.id)).toEqual([release]);
    expect((await releaseStanding(station, shown!)).standing).toEqual([]);
    expect(JSON.stringify(station.index.withdrawingBySubject(shown!))).not.toContain(sealed!);
  });

  test("a release a cleared fold withholds for superseding a sealed record still replaces there the release beside it, granting nothing", async () => {
    const { write, attest, opened } = await clearable();
    const [shown, sealed] = await write(fixtureRunRecord("shown"), fixtureRunRecord("sealed"));
    await attest(sealed!, { purpose: "sealed", from: WRITER });
    const replaced = await attest(shown!, { purpose: "released", to: WRITER });
    const replacing = await attest(shown!, { purpose: "released", to: WRITER, supersedes: [replaced, sealed!] });

    const station = await opened(WRITER);
    expect(held(station.index, replacing)).toEqual([false]);
    expect((await releaseStanding(station, shown!)).standing).toEqual([]);
  });

  test("a release on a sealed record still replaces, at a station, the shown release of another record it supersedes", async () => {
    const { write, attest, opened } = await clearable();
    const [shown, sealed] = await write(fixtureRunRecord("shown"), fixtureRunRecord("sealed"));
    await attest(sealed!, { purpose: "sealed", from: WRITER });
    const replaced = await attest(shown!, { purpose: "released", to: WRITER });
    await attest(sealed!, { purpose: "released", to: CREW, supersedes: [replaced] });

    const station = await opened(WRITER);
    expect((await releaseStanding(station, shown!)).standing).toEqual([]);
    expect(JSON.stringify(station.index.withdrawingSuperseding(replaced))).not.toContain(sealed!);
  });

  test("a station's store answers a withheld attestation as absent, while its withdrawal still counts", async () => {
    const { write, attest, opened } = await clearable();
    const [shown, sealed] = await write(fixtureRunRecord("shown"), fixtureRunRecord("sealed"));
    await attest(sealed!, { purpose: "sealed", from: WRITER });
    const replaced = await attest(shown!, { purpose: "released", to: WRITER });
    const replacing = await attest(shown!, { purpose: "released", to: WRITER, supersedes: [replaced, sealed!] });

    const station = await opened(WRITER);
    await expect(station.store.read(replacing, "attestation")).rejects.toMatchObject({ reason: "no-such-record" });
    await expect(station.store.readBytes(replacing, "attestation")).rejects.toMatchObject({
      reason: "no-such-record",
    });
    await expect(station.store.readSidecar(replacing)).rejects.toMatchObject({ reason: "no-such-record" });
    expect((await releaseStanding(station, shown!)).standing).toEqual([]);
  });

  test("a station's withdrawal row on a withheld subject names no principal, time or purpose of the attestation", async () => {
    const { gitDir, write, attest, store, opened, clearedPath } = await clearable();
    await writeTrustFile({ gitDir }, "roles", `${key.principal} owner any\n${second.principal} owner any\n`);
    await writeTrustFile({ gitDir }, "allowed-signers", allowedSignersLine(key) + allowedSignersLine(second));
    const [shown, sealed] = await write(fixtureRunRecord("shown"), fixtureRunRecord("sealed"));
    await attest(sealed!, { purpose: "sealed", from: WRITER });
    const replaced = await attest(shown!, { purpose: "released", to: WRITER });
    const at = "2026-03-03T03:03:03.000Z";
    for (const purpose of ["released", "revoked"] as const) {
      const minted = mintAttestation({
        subject: sealed!,
        principal: second.principal,
        principalClass: "person",
        via: "tty",
        purpose,
        at: timestamp(at),
        supersedes: [replaced],
        ...(purpose === "released" ? { release: { audience: CREW, extent: "record" as const, terms: TERMS } } : {}),
      });
      const signature = await signAttestation({ attestation: minted, keyPath: second.keyPath });
      await store().putMany([{ kind: "attestation", value: minted.record, signature }]);
    }

    const station = await opened(WRITER);
    expect((await releaseStanding(station, shown!)).standing).toEqual([]);
    expect(station.index.withdrawingAttestations()).toEqual([]);
    const seen = JSON.stringify(rowsSeen(clearedPath(WRITER)));
    expect(seen).not.toContain(second.principal);
    expect(seen).not.toContain(at);
  });

  test("a station's withdrawal follows a trust move that makes the attestation behind it verify", async () => {
    const { gitDir, write, attest, store, opened } = await clearable();
    await writeTrustFile({ gitDir }, "roles", `${key.principal} owner any\n${second.principal} owner any\n`);
    const [shown, sealed] = await write(fixtureRunRecord("shown"), fixtureRunRecord("sealed"));
    await attest(sealed!, { purpose: "sealed", from: WRITER });
    // To an audience beside the clearance, so its standing moves nothing else the admission names.
    const replaced = await attest(shown!, { purpose: "released", to: CREW });
    const minted = mintAttestation({
      subject: sealed!,
      principal: second.principal,
      principalClass: "person",
      via: "tty",
      purpose: "released",
      at: timestamp("2026-03-03T03:03:03.000Z"),
      supersedes: [replaced],
      release: { audience: CREW, extent: "record", terms: TERMS },
    });
    const signature = await signAttestation({ attestation: minted, keyPath: second.keyPath });
    await store().putMany([{ kind: "attestation", value: minted.record, signature }]);
    expect((await releaseStanding(await opened(WRITER), shown!)).standing.map((release) => release.id)).toEqual([
      replaced,
    ]);

    await writeTrustFile({ gitDir }, "allowed-signers", allowedSignersLine(key) + allowedSignersLine(second));
    expect((await releaseStanding(await opened(WRITER), shown!)).standing).toEqual([]);
    expect((await releaseStanding(await opened(), shown!)).standing).toEqual([]);
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

  test("a seal whose verification cannot run refuses a cleared open rather than admit what it seals", async () => {
    const { gitDir, scope, write, attest, opened, cleared } = await clearable();
    const [sealed] = await write(fixtureRunRecord("canary: what the seal withholds"));
    const seal = await attest(sealed!, { purpose: "sealed", from: WRITER });
    const bin = await mkdtemp(join(tmpdir(), "musai-faulting-ssh-keygen-"));
    onTestFinished(() => rm(bin, { recursive: true, force: true }));
    await writeFile(join(bin, "ssh-keygen"), "#!/bin/sh\nexit 255\n");
    await chmod(join(bin, "ssh-keygen"), 0o755);
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env["PATH"] ?? ""}`);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });

    await expect(opened(WRITER)).rejects.toMatchObject({ reason: "tool-unavailable", about: [seal] });
    vi.unstubAllEnvs();

    const signers = rawId(new TextEncoder().encode((await readTrustBranch({ gitDir })).allowedSigners));
    const cachePath = scopeVerificationCachePath(gitDir, scope, signers);
    expect(await readFile(cachePath, "utf8").catch(() => "")).not.toContain(seal);
    expect(held(await cleared(WRITER), sealed!, seal)).toEqual([false, false]);
  });

  test("a seal whose signer's allowed-signers line ssh-keygen cannot read refuses a cleared open rather than admit what it seals", async () => {
    const { gitDir, write, attest, opened } = await clearable();
    const [sealed] = await write(fixtureRunRecord("canary: what an unreadable line would let through"));
    await attest(sealed!, { purpose: "sealed", from: WRITER });
    const unread = allowedSignersLine(key, "bogus-opt").trimEnd();
    await writeTrustFile({ gitDir }, "allowed-signers", `${unread}\n`);

    await expect(opened(WRITER)).rejects.toThrow(`line 1: ${unread}`);
  });

  test("a seal whose signer's line negates its own key form refuses a cleared open rather than admit what it seals", async () => {
    const { gitDir, write, attest, opened } = await clearable();
    const [sealed] = await write(fixtureRunRecord("canary: what a negated principal would let through"));
    await attest(sealed!, { purpose: "sealed", from: WRITER });
    const negated = `${key.name},${key.principal},!${key.principal} ${key.pubKeyLine}`;
    await writeTrustFile({ gitDir }, "allowed-signers", `${negated}\n`);

    await expect(opened(WRITER)).rejects.toThrow(`line 1: ${negated}`);
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

    const fold = await clearedFold(station, WRITER, await clearanceAdmission(station, workspace.index, WRITER));
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

    const fold = await clearedFold(judging, WRITER, judgedBefore);
    onTestFinished(() => fold.close());

    expect([held(fold, sealed!), held(station.index, sealed!)]).toEqual([[false], [false]]);
    await expect(station.store.readBytes(sealed!, "run")).rejects.toMatchObject({ reason: "no-such-record" });
  });

  test("a fold judged under a trust the branch has since advanced past holds only what the trust at its tip admits", async () => {
    const { gitDir, write, attest, opened, clearedPath } = await clearable();
    await writeTrustFile({ gitDir }, "roles", "");
    const [sealed] = await write(fixtureRunRecord("canary: the sealed record's own words"));
    await attest(sealed!, { purpose: "sealed", from: WRITER });
    const judging = await opened();
    const judgedBefore = await clearanceAdmission(judging, judging.index, WRITER);
    await writeTrustFile({ gitDir }, "roles", `${key.principal} owner any\n`);
    const tip = (await opened()).matrix.commit;

    const fold = await clearedFold(judging, WRITER, judgedBefore);
    onTestFinished(() => fold.close());

    const [stamp] = rowsHeld(clearedPath(WRITER))["schema_meta"]!;
    expect([held(fold, sealed!), JSON.parse(stamp!).trust]).toEqual([[false], tip]);
  });

  test("a station opened after a trust advance reads nothing it withholds, though a fold walked the file under the trust before it", async () => {
    const { gitDir, write, attest, opened, clearedPath } = await clearable();
    await writeTrustFile({ gitDir }, "roles", "");
    const [sealed] = await write(fixtureRunRecord("canary: the sealed record's own words"));
    await attest(sealed!, { purpose: "sealed", from: WRITER });
    const judging = await opened();
    const judgedBefore = await clearanceAdmission(judging, judging.index, WRITER);
    let advanced = false;
    // The branch advances right after the fold's last read of its tip, before the walk.
    const advancingOnRead: Admission = {
      ...judgedBefore,
      trustTip: async () => {
        const tip = await judgedBefore.trustTip();
        if (!advanced) {
          advanced = true;
          await writeTrustFile({ gitDir }, "roles", `${key.principal} owner any\n`);
        }
        return tip;
      },
    };
    const walked = await clearedFold(judging, WRITER, advancingOnRead);
    onTestFinished(() => walked.close());
    const [walkedStamp] = rowsHeld(clearedPath(WRITER))["schema_meta"]!;
    expect(JSON.parse(walkedStamp!).trust).toBe(judging.matrix.commit);

    const station = await opened(WRITER);

    const [stamp] = rowsHeld(clearedPath(WRITER))["schema_meta"]!;
    expect([held(station.index, sealed!), JSON.parse(stamp!).trust]).toEqual([[false], station.matrix.commit]);
  });

  test("a fold judged under trust a station's fold has moved past is judged again under the trust branch as it stands", async () => {
    const { gitDir, write, attest, opened } = await clearable();
    await writeTrustFile({ gitDir }, "roles", "");
    const [sealed] = await write(fixtureRunRecord("canary: the sealed record's own words"));
    await attest(sealed!, { purpose: "sealed", from: WRITER });
    const judging = await opened();
    const judgedBefore = await clearanceAdmission(judging, judging.index, WRITER);
    await writeTrustFile({ gitDir }, "roles", `${key.principal} owner any\n`);
    const station = await opened(WRITER);

    const fold = await clearedFold(judging, WRITER, judgedBefore);
    onTestFinished(() => fold.close());

    expect([held(fold, sealed!), held(station.index, sealed!)]).toEqual([[false], [false]]);
  });

  test("a re-judge under a trust that widens the audience a seal hides from refolds and withholds what it hides", async () => {
    const { gitDir, write, attest, opened } = await clearable();
    await writeTrustFile({ gitDir }, "audiences", "writer\ncast\ncrew\n");
    const [sealed] = await write(fixtureRunRecord("canary: the sealed record's own words"));
    await attest(sealed!, { purpose: "sealed", from: CAST });
    const judging = await opened();
    const judgedBefore = await clearanceAdmission(judging, judging.index, WRITER);
    await writeTrustFile({ gitDir }, "audiences", "writer\ncast\ncrew\nextras\n");
    expect(held((await opened(WRITER)).index, sealed!)).toEqual([true]);
    await writeTrustFile({ gitDir }, "audiences", "writer\ncast includes writer\ncrew\nextras\n");

    const fold = await clearedFold(judging, WRITER, judgedBefore);
    onTestFinished(() => fold.close());

    expect(held(fold, sealed!)).toEqual([false]);
  });

  test("a re-judge under a trust that takes publish from a seal's signer refolds and holds what that trust admits", async () => {
    const { gitDir, write, attest, opened } = await clearable();
    const [sealed] = await write(fixtureRunRecord("canary: the sealed record's own words"));
    await attest(sealed!, { purpose: "sealed", from: WRITER });
    const judging = await opened();
    const judgedBefore = await clearanceAdmission(judging, judging.index, WRITER);
    await writeTrustFile({ gitDir }, "audiences", "writer\ncast includes writer\ncrew\nextras\n");
    expect(held((await opened(WRITER)).index, sealed!)).toEqual([false]);
    await writeTrustFile({ gitDir }, "roles", `${key.principal} delegate any\nowner@example.test owner any\n`);

    const fold = await clearedFold(judging, WRITER, judgedBefore);
    onTestFinished(() => fold.close());

    expect(held(fold, sealed!)).toEqual([true]);
  });

  test("a rewind that drops a seal but keeps its record is refused at open, the author's fold refusing first", async () => {
    const { gitDir, scope, write, attest, opened, cleared } = await clearable();
    const [sealed] = await write(fixtureRunRecord("canary: the sealed record's own words"));
    const unsealed = (await opened()).index.watermark()!;
    await attest(sealed!, { purpose: "sealed", from: WRITER });
    expect(held(await cleared(WRITER), sealed!)).toEqual([false]);
    spawnSync("git", ["--git-dir", gitDir, "update-ref", scopeRefName(scope), unsealed]);

    await expect(opened(WRITER)).rejects.toMatchObject({ reason: "record-corrupted" });
  });

  test("a cleared fold over a rewound trust branch refolds and holds only what the trust it stands at admits", async () => {
    const { gitDir, write, attest, opened, cleared } = await clearable();
    const [sealed] = await write(fixtureRunRecord("canary: the sealed record's own words"));
    await attest(sealed!, { purpose: "sealed", from: WRITER });
    const standing = (await opened()).matrix.commit;
    await writeTrustFile({ gitDir }, "roles", "");
    expect(held(await cleared(WRITER), sealed!)).toEqual([true]);
    spawnSync("git", ["--git-dir", gitDir, "update-ref", "refs/heads/main", standing]);

    expect(held(await cleared(WRITER), sealed!)).toEqual([false]);
  });

  test.each([
    ["rewound", (_: string, standing: string) => standing],
    ["rewritten", (gitDir: string, standing: string) => commitBeside(gitDir, standing)],
  ])(
    "a fold judged under a trust commit a %s trust branch left is judged at its tip and resets no file",
    async (_, leave) => {
      const { gitDir, write, attest, opened, cleared, clearedPath } = await clearable();
      const [sealed] = await write(fixtureRunRecord("canary: the sealed record's own words"));
      await attest(sealed!, { purpose: "sealed", from: WRITER });
      const base = (await opened()).matrix.commit;
      await writeTrustFile({ gitDir }, "roles", "");
      const judging = await opened();
      const judgedLooser = await clearanceAdmission(judging, judging.index, WRITER);
      spawnSync("git", ["--git-dir", gitDir, "update-ref", "refs/heads/main", leave(gitDir, base)]);
      const station = await cleared(WRITER);
      const before = rowsHeld(clearedPath(WRITER));

      const fold = await clearedFold(judging, WRITER, judgedLooser);
      onTestFinished(() => fold.close());

      expect([held(fold, sealed!), held(station, sealed!), rowsHeld(clearedPath(WRITER))]).toEqual([
        [false],
        [false],
        before,
      ]);
    },
  );

  test("a running process follows a rewound trust branch on its next write", async () => {
    const { gitDir, write, attest, opened } = await clearable();
    const [sealed] = await write(fixtureRunRecord("canary: the sealed record's own words"));
    await attest(sealed!, { purpose: "sealed", from: WRITER });
    const base = (await opened()).matrix.commit;
    await writeTrustFile({ gitDir }, "roles", "");
    const station = await opened(WRITER);
    expect(held(station.index, sealed!)).toEqual([true]);
    spawnSync("git", ["--git-dir", gitDir, "update-ref", "refs/heads/main", base]);

    const [written] = await station.put([{ kind: "run", value: fixtureRunRecord("written after the rewind") }]);

    expect(held(station.index, sealed!, written!)).toEqual([false, true]);
  });

  test("a running process judges each write once, at the trust branch's tip", async () => {
    const { gitDir, dir, scope, write, attest } = await clearable();
    const [sealed] = await write(fixtureRunRecord("canary: the sealed record's own words"));
    await attest(sealed!, { purpose: "sealed", from: WRITER });
    const judgedAt: string[] = [];
    const station = await Workspace.open({
      dir,
      scope,
      now: FIXTURE_CLOCK,
      clearance: {
        audience: WRITER,
        admission: (author) => {
          judgedAt.push(author.matrix.commit);
          return clearanceAdmission(author, author.index, WRITER);
        },
      },
    });
    onTestFinished(() => station.close());
    await writeTrustFile({ gitDir }, "audiences", "writer\ncast includes writer\ncrew\nextras\n");
    const tip = await readTrustTip({ gitDir });
    judgedAt.length = 0;

    await station.put([{ kind: "run", value: fixtureRunRecord("written after the advance") }]);

    expect(judgedAt).toEqual([tip]);
  });

  /** A station whose every admission records the workspace it judged in, closing included. */
  async function adoptingStation() {
    const { gitDir, dir, scope, opened } = await clearable();
    const judgedIn: Workspace[] = [];
    const closed = new Set<Workspace>();
    const station = await Workspace.open({
      dir,
      scope,
      now: FIXTURE_CLOCK,
      clearance: {
        audience: WRITER,
        admission: (author) => {
          if (!judgedIn.includes(author)) {
            const close = author.close.bind(author);
            vi.spyOn(author, "close").mockImplementation(() => {
              closed.add(author);
              close();
            });
          }
          judgedIn.push(author);
          return clearanceAdmission(author, author.index, WRITER);
        },
      },
    });
    onTestFinished(() => station.close());
    const base = await readTrustTip({ gitDir });
    let written = 0;
    const writeTimes = async (times: number) => {
      for (let n = 0; n < times; n += 1) {
        written += 1;
        await station.put([{ kind: "run", value: fixtureRunRecord(`write ${written}`) }]);
      }
    };
    const moveTrust = async (audiences: string) => {
      await writeTrustFile({ gitDir }, "audiences", audiences);
      return readTrustTip({ gitDir });
    };
    return { gitDir, base, station, judgedIn, closed, writeTimes, moveTrust, opened };
  }

  test("a running process adopts the trust tip once per tip, not once per write", async () => {
    const { judgedIn, writeTimes, moveTrust } = await adoptingStation();
    const tip = await moveTrust("writer\ncast includes writer\ncrew\nextras\n");
    judgedIn.length = 0;

    await writeTimes(10);

    expect(new Set(judgedIn).size).toBe(1);
    expect(judgedIn[0]!.matrix.commit).toBe(tip);
  });

  test("a trust move closes the workspace adopted at the old tip", async () => {
    const { station, judgedIn, closed, writeTimes, moveTrust } = await adoptingStation();
    await moveTrust("writer\ncast includes writer\ncrew\nextras\n");
    await writeTimes(1);
    const adoptedFirst = judgedIn.at(-1)!;
    const tip = await moveTrust("writer\ncast includes writer\ncrew\nextras\nstand-ins\n");

    const [written] = await station.put([{ kind: "run", value: fixtureRunRecord("written after the second move") }]);

    const adoptedNext = judgedIn.at(-1)!;
    expect([closed.has(adoptedFirst), closed.has(adoptedNext)]).toEqual([true, false]);
    expect(adoptedNext.matrix.commit).toBe(tip);
    expect(held(station.index, written!)).toEqual([true]);
  });

  test("a trust branch returning to the commit a process opened at closes the workspace adopted past it", async () => {
    const { gitDir, base, station, judgedIn, closed, writeTimes, moveTrust } = await adoptingStation();
    await moveTrust("writer\ncast includes writer\ncrew\nextras\n");
    await writeTimes(1);
    const adopted = judgedIn.at(-1)!;
    spawnSync("git", ["--git-dir", gitDir, "update-ref", "refs/heads/main", base]);

    const [written] = await station.put([{ kind: "run", value: fixtureRunRecord("written after the rewind") }]);

    expect(closed.has(adopted)).toBe(true);
    expect(judgedIn.at(-1)!.matrix.commit).toBe(base);
    expect(held(station.index, written!)).toEqual([true]);
  });

  test("closing a cleared workspace closes the workspace its author adopted", async () => {
    const { station, judgedIn, closed, writeTimes, moveTrust } = await adoptingStation();
    await moveTrust("writer\ncast includes writer\ncrew\nextras\n");
    await writeTimes(1);

    station.close();

    expect(closed.has(judgedIn.at(-1)!)).toBe(true);
  });

  test("a workspace adopted at an earlier tip adopts a later one through the workspace that adopted it", async () => {
    const { opened, moveTrust } = await adoptingStation();
    const author = await opened();
    await moveTrust("writer\ncast includes writer\ncrew\nextras\n");
    const adopted = await author.atTrustTip(WRITER);
    const tip = await moveTrust("writer\ncast includes writer\ncrew\nextras\nstand-ins\n");

    const later = await adopted.atTrustTip(WRITER);

    expect(later).toBe(await author.atTrustTip(WRITER));
    expect(later.matrix.commit).toBe(tip);
  });

  test("a cleared fold whose trust commit was pruned refolds under the trust branch as it stands", async () => {
    const { gitDir, write, attest, opened, cleared } = await clearable();
    const [sealed] = await write(fixtureRunRecord("canary: the sealed record's own words"));
    await attest(sealed!, { purpose: "sealed", from: WRITER });
    const base = (await opened()).matrix.commit;
    await writeTrustFile({ gitDir }, "roles", "");
    (await opened(WRITER)).close();
    spawnSync("git", ["--git-dir", gitDir, "update-ref", "refs/heads/main", commitBeside(gitDir, base)]);
    spawnSync("git", ["--git-dir", gitDir, "reflog", "expire", "--expire=now", "--all"]);
    spawnSync("git", ["--git-dir", gitDir, "gc", "--quiet", "--prune=now"]);

    expect(held(await cleared(WRITER), sealed!)).toEqual([false]);
  });

  test("a re-judge under a trust branch that no longer declares the clearance is refused, as an open under it is", async () => {
    const { gitDir, write, attest, opened } = await clearable();
    await writeTrustFile({ gitDir }, "roles", "");
    const [sealed] = await write(fixtureRunRecord("canary: the sealed record's own words"));
    await attest(sealed!, { purpose: "sealed", from: CAST });
    const judging = await opened();
    const judgedBefore = await clearanceAdmission(judging, judging.index, WRITER);
    await writeTrustFile({ gitDir }, "roles", `${key.principal} owner any\n`);
    const station = await opened(WRITER);
    await writeTrustFile({ gitDir }, "audiences", "cast\ncrew\n");

    await expect(clearedFold(judging, WRITER, judgedBefore)).rejects.toMatchObject({ reason: "invalid-input" });

    expect(held(station.index, sealed!)).toEqual([false]);
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
    const fold = await clearedFold(late, WRITER, judgedLate);
    onTestFinished(() => fold.close());
    const heldOnceFolded = held(fold, sealed!);

    const older = await clearedFold(judging, WRITER, judgedBefore);
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

    const fold = await clearedFold(late, WRITER, await clearanceAdmission(late, atBefore, WRITER));
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

/** A case to seal and one beside it, each with a draft and that draft's successor. */
async function draftedCases(world: Awaited<ReturnType<typeof clearable>>) {
  const [sealedCase, openCase] = await world.store().putMany([
    { kind: "case", value: fixtureCase("sealed-with-its-drafts") },
    { kind: "case", value: fixtureCase("open-with-its-drafts") },
  ]);
  const [sealedDraft, openDraft] = await world.store().putMany([
    { kind: "artifact", value: fixtureArtifact(sealedCase!, "the sealed case's first draft") },
    { kind: "artifact", value: fixtureArtifact(openCase!, "the open case's first draft") },
  ]);
  const [sealedNext, openNext] = await world.store().putMany([
    { kind: "artifact", value: fixtureArtifact(sealedCase!, "the sealed case's next draft", [sealedDraft!]) },
    { kind: "artifact", value: fixtureArtifact(openCase!, "the open case's next draft", [openDraft!]) },
  ]);
  return {
    sealed: [sealedCase!, sealedDraft!, sealedNext!],
    open: [openCase!, openDraft!, openNext!],
  };
}

function draftsListed(index: IndexDb, caseId: RecordId): RecordId[] {
  return index.artifactsOfCase(caseId).map(({ id }) => id);
}

describe.skipIf(!opensshAvailable)("a record is sealed with the case it names", () => {
  test("a station cleared below a case's seal holds none of its drafts, by id or listed, and keeps an open case's", async () => {
    const world = await clearable();
    const { sealed, open } = await draftedCases(world);
    await world.attest(sealed[0]!, { purpose: "sealed", from: CAST });

    const station = await world.cleared(WRITER);
    expect(held(station, ...sealed)).toEqual([false, false, false]);
    expect(draftsListed(station, sealed[0]!)).toEqual([]);
    expect(held(station, ...open)).toEqual([true, true, true]);
    expect(draftsListed(station, open[0]!)).toEqual([...open.slice(1)].sort());
    const author = await world.author();
    expect(held(author, ...sealed, ...open)).toEqual([true, true, true, true, true, true]);
    expect(draftsListed(author, sealed[0]!)).toEqual([...sealed.slice(1)].sort());
    expect(held(await world.cleared(CREW), ...sealed)).toEqual([true, true, true]);
  });

  test("a draft landed before its case's seal is withheld once the seal lands, cold and warm alike", async () => {
    const world = await clearable();
    const { sealed } = await draftedCases(world);
    expect(held(await world.cleared(WRITER), ...sealed)).toEqual([true, true, true]);

    await world.attest(sealed[0]!, { purpose: "sealed", from: WRITER });

    expect(held(await world.cleared(WRITER), ...sealed)).toEqual([false, false, false]);
    const warm = rowsHeld(world.clearedPath(WRITER));
    await rm(world.clearedPath(WRITER));
    await world.cleared(WRITER);
    expect(rowsHeld(world.clearedPath(WRITER))).toEqual(warm);
  });

  test("a successor released to a station lists none of the drafts of the sealed case it supersedes", async () => {
    const world = await clearable();
    const { sealed } = await draftedCases(world);
    await world.attest(sealed[0]!, { purpose: "sealed", from: WRITER });
    const [successor] = await world
      .store()
      .putMany([{ kind: "case", value: fixtureCase("sealed-with-its-drafts", [], { supersedes: [sealed[0]!] }) }]);
    await world.attest(successor!, { purpose: "released", to: WRITER });
    const [successorDraft] = await world
      .store()
      .putMany([{ kind: "artifact", value: fixtureArtifact(successor!, "the successor's own draft") }]);

    const station = await world.cleared(WRITER);
    expect(held(station, successor!, successorDraft!, ...sealed)).toEqual([true, true, false, false, false]);
    expect(draftsListed(station, successor!)).toEqual([successorDraft]);
    expect(draftsListed(await world.author(), successor!)).toEqual([successorDraft!, ...sealed.slice(1)].sort());
  });

  test("a closure seal over one draft hides its case, and with it every other draft under the case", async () => {
    const world = await clearable();
    const { sealed, open } = await draftedCases(world);
    const [beside] = await world
      .store()
      .putMany([{ kind: "artifact", value: fixtureArtifact(sealed[0]!, "a draft beside the others") }]);
    await world.attest(beside!, { purpose: "sealed", from: WRITER, extent: "closure" });

    expect(held(await world.cleared(WRITER), beside!, ...sealed, ...open)).toEqual([
      false,
      false,
      false,
      false,
      true,
      true,
      true,
    ]);
  });

  test("a release over the last draft of a sealed case brings it back, and revoking the release takes it away again", async () => {
    const world = await clearable();
    const { sealed } = await draftedCases(world);
    await world.attest(sealed[0]!, { purpose: "sealed", from: WRITER });
    expect(held(await world.cleared(WRITER), ...sealed)).toEqual([false, false, false]);

    const release = await world.attest(sealed[2]!, { purpose: "released", to: WRITER });
    expect(held(await world.cleared(WRITER), ...sealed)).toEqual([false, false, true]);

    await world.attest(sealed[2]!, { purpose: "revoked", supersedes: [release] });
    expect(held(await world.cleared(WRITER), ...sealed)).toEqual([false, false, false]);
  });

  test.each([
    ["a retraction", "retracted"],
    ["a redraft", "drafted"],
  ] as const)(
    "%s of a released draft of a sealed case withholds the draft from the station, cold and warm alike",
    async (_, lifecycle) => {
      const world = await clearable();
      const { sealed } = await draftedCases(world);
      await world.attest(sealed[0]!, { purpose: "sealed", from: WRITER });
      await world.attest(sealed[2]!, { purpose: "released", to: WRITER });
      expect(held(await world.cleared(WRITER), ...sealed)).toEqual([false, false, true]);

      const replacing = { ...fixtureArtifact(sealed[0]!, "replacing the released draft", [sealed[2]!]), lifecycle };
      const [replacingId] = await world.store().putMany([{ kind: "artifact", value: replacing }]);

      expect(held(await world.cleared(WRITER), replacingId!, ...sealed)).toEqual([false, false, false, false]);
      expect(held(await world.author(), replacingId!, ...sealed)).toEqual([true, true, true, true]);
      const warm = rowsHeld(world.clearedPath(WRITER));
      await rm(world.clearedPath(WRITER));
      await world.cleared(WRITER);
      expect(rowsHeld(world.clearedPath(WRITER))).toEqual(warm);
    },
  );

  test("a release over a draft a successor withheld for its case already replaced brings nothing back", async () => {
    const world = await clearable();
    const { sealed } = await draftedCases(world);
    await world.attest(sealed[0]!, { purpose: "sealed", from: WRITER });

    await world.attest(sealed[1]!, { purpose: "released", to: WRITER });

    expect(held(await world.cleared(WRITER), ...sealed)).toEqual([false, false, false]);
  });

  test("a released draft goes once a draft under a case withheld for the sealed case it replaces replaces it", async () => {
    const world = await clearable();
    const { sealed } = await draftedCases(world);
    await world.attest(sealed[0]!, { purpose: "sealed", from: WRITER });
    await world.attest(sealed[2]!, { purpose: "released", to: WRITER });
    const [successor] = await world
      .store()
      .putMany([{ kind: "case", value: fixtureCase("sealed-with-its-drafts", [], { supersedes: [sealed[0]!] }) }]);

    const [replacing] = await world
      .store()
      .putMany([{ kind: "artifact", value: fixtureArtifact(successor!, "the successor's redraft", [sealed[2]!]) }]);

    expect(held(await world.cleared(WRITER), successor!, replacing!, sealed[2]!)).toEqual([false, false, false]);
  });

  test("a released draft stays where its successor's case is a released successor of the sealed case", async () => {
    const world = await clearable();
    const { sealed } = await draftedCases(world);
    await world.attest(sealed[0]!, { purpose: "sealed", from: WRITER });
    await world.attest(sealed[2]!, { purpose: "released", to: WRITER });
    const [successor] = await world
      .store()
      .putMany([{ kind: "case", value: fixtureCase("sealed-with-its-drafts", [], { supersedes: [sealed[0]!] }) }]);
    await world.attest(successor!, { purpose: "released", to: WRITER });

    const [replacing] = await world
      .store()
      .putMany([{ kind: "artifact", value: fixtureArtifact(successor!, "the successor's redraft", [sealed[2]!]) }]);

    const station = await world.cleared(WRITER);
    expect(held(station, successor!, replacing!, sealed[2]!)).toEqual([true, true, true]);
    expect(station.successorsOf(sealed[2]!).map(({ successor: next }) => next)).toEqual([replacing]);
  });

  test("a draft a retired draft replaced goes with it, so nothing it replaced reads live in its place", async () => {
    const world = await clearable();
    const { open } = await draftedCases(world);
    await world.attest(open[2]!, { purpose: "released", to: WRITER });
    const [successor] = await world
      .store()
      .putMany([{ kind: "case", value: fixtureCase("open-with-its-drafts", [], { supersedes: [open[0]!] }) }]);
    await world.attest(successor!, { purpose: "sealed", from: WRITER });
    const before = await world.cleared(WRITER);
    expect(before.successorsOf(open[1]!).map(({ successor: next }) => next)).toEqual([open[2]]);

    await world
      .store()
      .putMany([
        { kind: "artifact", value: fixtureArtifact(successor!, "redrafted under the sealed successor", [open[2]!]) },
      ]);

    const station = await world.cleared(WRITER);
    expect(held(station, ...open)).toEqual([true, false, false]);
    expect(draftsListed(station, open[0]!)).toEqual([]);
    expect(held(await world.author(), ...open)).toEqual([true, true, true]);
  });

  test("released drafts of a sealed case stay while released successors replace them, and go once one is not", async () => {
    const world = await clearable();
    const { sealed } = await draftedCases(world);
    await world.attest(sealed[0]!, { purpose: "sealed", from: WRITER });
    for (const draft of sealed.slice(1)) {
      await world.attest(draft, { purpose: "released", to: WRITER });
    }
    expect(held(await world.cleared(WRITER), ...sealed)).toEqual([false, true, true]);

    const [last] = await world
      .store()
      .putMany([{ kind: "artifact", value: fixtureArtifact(sealed[0]!, "the unreleased last draft", [sealed[2]!]) }]);

    expect(held(await world.cleared(WRITER), last!, ...sealed)).toEqual([false, false, false, false]);
  });

  test("a release over a case withheld for the sealed case it replaces brings its drafts back", async () => {
    const world = await clearable();
    const { sealed } = await draftedCases(world);
    await world.attest(sealed[0]!, { purpose: "sealed", from: WRITER });
    const [successor] = await world
      .store()
      .putMany([{ kind: "case", value: fixtureCase("sealed-with-its-drafts", [], { supersedes: [sealed[0]!] }) }]);
    const [draft] = await world
      .store()
      .putMany([{ kind: "artifact", value: fixtureArtifact(successor!, "a draft of the successor") }]);
    expect(held(await world.cleared(WRITER), successor!, draft!)).toEqual([false, false]);

    await world.attest(successor!, { purpose: "released", to: WRITER });

    expect(held(await world.cleared(WRITER), successor!, draft!)).toEqual([true, true]);
  });

  test("a case and its draft landing in one commit are judged together, cold and warm alike", async () => {
    const world = await clearable();
    const { sealed } = await draftedCases(world);
    await world.attest(sealed[0]!, { purpose: "sealed", from: WRITER });
    await world.cleared(WRITER);
    const successor = fixtureCase("sealed-with-its-drafts", [], { supersedes: [sealed[0]!] });
    const [successorId, draft] = await world.store().putMany([
      { kind: "case", value: successor },
      { kind: "artifact", value: fixtureArtifact(recordId(successor), "a draft landing with its case") },
    ]);

    expect(held(await world.cleared(WRITER), successorId!, draft!)).toEqual([false, false]);
    const warm = rowsHeld(world.clearedPath(WRITER));
    await rm(world.clearedPath(WRITER));
    await world.cleared(WRITER);
    expect(rowsHeld(world.clearedPath(WRITER))).toEqual(warm);
  });

  test("a closure seal over a successor's draft reaches the cases it replaces, a station's own booking among them", async () => {
    const world = await clearable();
    const [authors] = await world.store().putMany([{ kind: "case", value: fixtureCase("booked-twice") }]);
    const station = await world.opened(WRITER);
    const [stations] = await station.put([{ kind: "case", value: fixtureCase("booked-twice"), salt: true }]);
    const [stationsDraft] = await station.put([
      { kind: "artifact", value: fixtureArtifact(stations!, "the station's draft under its booking") },
    ]);
    const kept = fixtureCase("booked-twice", [], { supersedes: [authors!, stations!] });
    const [keptId] = await world.store().putMany([{ kind: "case", value: kept }]);
    const [keptDraft] = await world
      .store()
      .putMany([{ kind: "artifact", value: fixtureArtifact(keptId!, "the kept case's draft") }]);
    expect(held(await world.cleared(WRITER), keptId!, keptDraft!, stations!, stationsDraft!)).toEqual([
      true,
      true,
      true,
      true,
    ]);

    await world.attest(keptDraft!, { purpose: "sealed", from: WRITER, extent: "closure" });

    expect(held(await world.cleared(WRITER), keptId!, keptDraft!, authors!, stations!, stationsDraft!)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  test("a station's own draft under its own booking of a slug sealed from it stays visible to it", async () => {
    const world = await clearable();
    const { sealed } = await draftedCases(world);
    await world.attest(sealed[0]!, { purpose: "sealed", from: WRITER });
    const station = await world.opened(WRITER);
    const [booked] = await station.put([{ kind: "case", value: fixtureCase("sealed-with-its-drafts"), salt: true }]);
    const [drafted] = await station.put([
      { kind: "artifact", value: fixtureArtifact(booked!, "the station's own draft") },
    ]);

    expect(held(station.index, booked!, drafted!, ...sealed)).toEqual([true, true, false, false, false]);
    expect(draftsListed(station.index, booked!)).toEqual([drafted]);
    expect(held(await world.cleared(WRITER), booked!, drafted!)).toEqual([true, true]);
  });

  test("a station's own draft under a case sealed from it after is withheld from it, as the author's are", async () => {
    const world = await clearable();
    const { sealed } = await draftedCases(world);
    const station = await world.opened(WRITER);
    const [drafted] = await station.put([
      { kind: "artifact", value: fixtureArtifact(sealed[0]!, "the station's draft of the author's case") },
    ]);
    expect(station.index.holds(drafted!)).toBe(true);

    await world.attest(sealed[0]!, { purpose: "sealed", from: WRITER });

    expect(held(await world.cleared(WRITER), drafted!, ...sealed)).toEqual([false, false, false, false]);
    expect(held(await world.author(), drafted!)).toEqual([true]);
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
    const fold = await clearedFold(late, WRITER, judgedLate);
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

  test("withholds what an evaluation of the sealed claim reads, and nothing an evaluation of another claim at its slot reads", async () => {
    const other: ClaimRecord = { ...ruleCheck(), conditions: { ...ruleCheck().conditions, [MODULE_RULE]: "[]" } };
    const byOther = runOf("read-by-other", "read by the other claim's evaluation");
    const bySealed = runOf("read-by-sealed", "read by the sealed claim's evaluation");
    const { check, write, cleared } = await sealedRuleCheck((sealed) => [
      byOther,
      evaluationOf(recordId(other), byOther),
      bySealed,
      evaluationOf(sealed, bySealed),
    ]);
    const [otherAgain, sealedAgain] = [runOf("read-by-other", "landed later"), runOf("read-by-sealed", "landed later")];
    await write(otherAgain, sealedAgain, evaluationElsewhere(check, otherAgain, sealedAgain));

    const seen = held(
      await cleared(WRITER),
      ...[byOther, otherAgain, bySealed, sealedAgain].map((run) => recordId(run)),
    );
    expect(seen).toEqual([true, true, false, false]);
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
    const [caseId] = await world
      .store()
      .putMany([{ kind: "case", value: fixtureCase("cites-a-claim-yet-to-land", [late]) }]);
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
