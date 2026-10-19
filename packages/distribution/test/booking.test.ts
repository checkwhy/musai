import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OperationContext } from "@musai/api-core";
import { isOperationError, openWorkspace, runHandler } from "@musai/api-core";
import { buildModule } from "@musai/devkit";
import { IndexDb } from "@musai/fold";
import { readClaimTypeDeclarations, readPresetDeclarations, readSlotDeclarations } from "@musai/modules";
import {
  type CaseRecord,
  type ClaimRecord,
  type ClaimTypeDeclaration,
  type RecordId,
  resolveSlot,
  slotFor,
} from "@musai/records";
import { initWorkspace, Store } from "@musai/store";
import { blobStoreOf, fixedClock } from "@musai/test-support";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { caseBook, caseSoundcheck } from "../src/ops/case.js";
import { caseStatus } from "../src/ops/case-status.js";
import { claimStatus } from "../src/ops/claim.js";
import { gateAsk, gatePending } from "../src/ops/gate.js";

const CORE_MODULE_DIR = fileURLToPath(new URL("../../core-module", import.meta.url));
const CASEBOOK_DIR = fileURLToPath(new URL("../../scenarios/casebook/modules/casebook", import.meta.url));
const TWO_RULERS_DIR = fileURLToPath(new URL("./fixtures/two-rulers", import.meta.url));
const TWO_RULERS_KIND = "two-rulers/audit";
const TWO_RULERS_RULE = "two-rulers/audits";
const KIND = "fixture-casebook/report";
const REPRODUCES_TYPE = "fixture-casebook/reproduces@1";
const DISPOSITION_TYPE = "fixture-casebook/disposition@1";

/** The report's claim types spelled here, not read from the pack, so an edit moves one side. */
const REPORT_CLAIM_TYPES: readonly ClaimTypeDeclaration[] = [
  { type: REPRODUCES_TYPE, identityDimensions: ["case"] },
  { type: "fixture-casebook/worth-fixing@1", identityDimensions: ["case"] },
  { type: DISPOSITION_TYPE, identityDimensions: ["case", "disposition"] },
];

/** Declarations reduced to what a slot is computed from, in one order. */
function identities(declarations: readonly ClaimTypeDeclaration[]): readonly ClaimTypeDeclaration[] {
  return declarations
    .map(({ type, identityDimensions }) => ({ type, identityDimensions }))
    .sort((left, right) => (left.type < right.type ? -1 : 1));
}

describe("a case booked under a kind cites the claims that kind names", () => {
  let workspace: string;
  let store: Store;
  const scope = "default";
  const now = fixedClock("2026-08-30T00:00:00.000Z");

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-booking-"));
    const { gitDir } = await initWorkspace(workspace, { now });
    store = new Store({ ctx: { gitDir }, scope, now });
    const index = new IndexDb(":memory:");
    await index.fold(store);
    await buildModule(CORE_MODULE_DIR, store, { blobs: blobStoreOf(workspace), index, now });
    await index.fold(store);
    await buildModule(CASEBOOK_DIR, store, { blobs: blobStoreOf(workspace), index, now });
  }, 180_000);

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  function ctx(): OperationContext {
    return { workspace, scope, now };
  }

  async function claimsOf(caseId: RecordId): Promise<ClaimRecord[]> {
    const record = (await store.read(caseId, "case")) as CaseRecord;
    return Promise.all(record.claims.map(async (id) => (await store.read(id, "claim")) as ClaimRecord));
  }

  test("mints the setlist in the order the kind named it, and records the kind it was booked under", async () => {
    const booked = await runHandler(caseBook, { slug: "reported-fault", kind: KIND, about: ["./reports/4711"] }, ctx());

    const caseRecord = (await store.read(booked.case, "case")) as CaseRecord;
    expect(caseRecord.type).toBe(KIND);
    expect(booked.minted.map((item) => item.kind)).toEqual(["case", "claim", "claim", "claim", "claim"]);

    // The setlist's order is the order a case is worked through.
    const claims = await claimsOf(booked.case);
    expect(claims.map((claim) => claim.type)).toEqual([
      "fixture-casebook/reproduces@1",
      "fixture-casebook/worth-fixing@1",
      "fixture-casebook/disposition@1",
      "fixture-casebook/disposition@1",
    ]);
    expect(claims[0]!.rendering).toBe("the fault reported in ./reports/4711 reproduces");
  }, 60_000);

  test("the claim types the workspace holds are the pack's own beside the core module's, and they compute the slots a booking mints", async () => {
    const booked = await runHandler(caseBook, { slug: "declared-by-the-pack", kind: KIND }, ctx());

    const opened = await openWorkspace({ workspace, scope, now });
    const held = readClaimTypeDeclarations(opened.index);
    expect(held.refused).toEqual([]);
    expect(identities(held.declarations)).toEqual(
      identities([...REPORT_CLAIM_TYPES, { type: "musai.core/check@1", identityDimensions: ["subject", "statement"] }]),
    );

    // A slot is computed from the type and identity dimensions alone, so both spellings agree.
    const declaredBy = new Map(REPORT_CLAIM_TYPES.map((declaration) => [declaration.type, declaration]));
    const claims = await claimsOf(booked.case);
    expect(claims.map((claim) => claim.slot)).toEqual(
      claims.map((claim) => slotFor(declaredBy.get(claim.type)!, claim.conditions)),
    );
  }, 120_000);

  test("a claim whose canonical payload does not satisfy the schema its type declares is refused, naming the type", async () => {
    const refused = await runHandler(
      caseBook,
      { slug: "payload-outside-its-schema", kind: KIND, overrides: { [DISPOSITION_TYPE]: { disposition: 4711 } } },
      ctx(),
    ).catch((error: unknown) => error);

    expect(isOperationError(refused)).toBe(true);
    expect((refused as { reason: string }).reason).toBe("invalid-input");
    expect((refused as { about: readonly string[] }).about).toEqual([DISPOSITION_TYPE]);
    expect((refused as { detail: string }).detail).toContain(KIND);
    expect((refused as { detail: string }).detail).toMatch(/disposition must be string/);
  }, 60_000);

  test("a claim of a type declaring no schema carries whatever payload its kind gave it", async () => {
    const slug = "payload-unconstrained";
    const booked = await runHandler(
      caseBook,
      { slug, kind: KIND, overrides: { [REPRODUCES_TYPE]: { reporter: 4711 } } },
      ctx(),
    );

    const opened = await openWorkspace({ workspace, scope, now });
    expect(opened.claimTypes.get(REPRODUCES_TYPE)?.canonical).toBeUndefined();
    const reproduces = (await claimsOf(booked.case)).find((claim) => claim.type === REPRODUCES_TYPE)!;
    expect(reproduces.canonical).toEqual({ case: slug, subject: slug, reporter: 4711 });
  }, 60_000);

  test("the check among them is settled by running it, with nothing further asked of the caller", async () => {
    const booked = await runHandler(caseBook, { slug: "settled-by-a-run", kind: KIND }, ctx());
    const claims = await claimsOf(booked.case);

    const status = await runHandler(claimStatus, { claim: claims[0]!.slot }, ctx());

    expect(status.label).toBe("holds");
  }, 60_000);

  test("a check the booking pointed at a failing command fails", async () => {
    const booked = await runHandler(
      caseBook,
      { slug: "fails-its-check", kind: KIND, overrides: { suite: "process.exit(2)" } },
      ctx(),
    );
    const claims = await claimsOf(booked.case);

    const status = await runHandler(claimStatus, { claim: claims[0]!.slot }, ctx());

    expect(status.label).toBe("fails");
  }, 60_000);

  test("soundcheck answers for every claim the setlist named, and progress offers the gate it named first", async () => {
    const booked = await runHandler(caseBook, { slug: "worked-through", kind: KIND }, ctx());

    const sound = await runHandler(caseSoundcheck, { case: "worked-through" }, ctx());
    expect(sound.claims).toHaveLength(4);
    expect(sound.claims[0]!.label).toBe("holds");

    // The check has no gate class, so the first gate is the judgment after it.
    const progress = await runHandler(caseStatus, { case: "worked-through" }, ctx());
    const cited = ((await store.read(booked.case, "case")) as CaseRecord).claims;
    expect(progress.next?.class).toBe("judgment");
    expect(progress.next?.gate).toBe(cited[1]);
    expect(progress.counts.holds).toBe(1);
  }, 120_000);

  test("the gates a setlist declares are offered, and its exclusive pair is one gate with two answers", async () => {
    const booked = await runHandler(caseBook, { slug: "offered-as-gates", kind: KIND }, ctx());
    const cited = ((await store.read(booked.case, "case")) as CaseRecord).claims;

    const pending = await runHandler(gatePending, { case: "offered-as-gates" }, ctx());

    // Four claims, two gates: the check is no gate, and the two dispositions are one choice.
    expect(pending.gates.map((gate) => gate.gateClass).sort()).toEqual(["intent", "judgment"]);

    const disposition = pending.gates.find((gate) => gate.gateClass === "intent")!;
    const asked = await runHandler(gateAsk, { claim: disposition.claim }, ctx());

    expect(asked.options.map((option) => option.value).sort()).toEqual(["file", "withdraw"]);
    expect(cited).toContain(disposition.claim);
  }, 120_000);

  test("two cases of one kind do not share a claim", async () => {
    const first = await runHandler(caseBook, { slug: "one-report", kind: KIND }, ctx());
    const second = await runHandler(caseBook, { slug: "another-report", kind: KIND }, ctx());

    const firstSlots = (await claimsOf(first.case)).map((claim) => claim.slot);
    const secondSlots = (await claimsOf(second.case)).map((claim) => claim.slot);

    expect(firstSlots).toHaveLength(4);
    expect(firstSlots.filter((slot) => secondSlots.includes(slot))).toEqual([]);
  }, 120_000);

  test("a booking naming the core's interpreter is refused, saying it is a rule a command's check names", async () => {
    const refused = await runHandler(caseBook, { slug: "not-a-kind", kind: "musai.core/declarative" }, ctx()).catch(
      (error: unknown) => error,
    );

    expect((refused as Error).message).toContain("a rule contribution, not a kind");
    expect((refused as Error).message).toContain('check "<sentence>" -- <command>');
  }, 60_000);

  test("a booking naming a kind no installed module contributes is refused, naming the kinds there are", async () => {
    const refused = await runHandler(caseBook, { slug: "absent-kind", kind: "nobody/ships-this" }, ctx()).catch(
      (error: unknown) => error,
    );

    expect(isOperationError(refused)).toBe(true);
    expect((refused as { reason: string }).reason).toBe("no-such-record");
    expect((refused as Error).message).toContain(`the kinds installed here: ${KIND}`);
  }, 60_000);

  test("planning a booking answers with the ids the write would mint, and writes nothing", async () => {
    const before = await store.tip();
    const planned = await runHandler(caseBook, { slug: "planned-only", kind: KIND }, { ...ctx(), mode: "plan" });
    expect(await store.tip()).toBe(before);

    const written = await runHandler(caseBook, { slug: "planned-only", kind: KIND }, ctx());
    expect(written.minted.map((item) => item.id)).toEqual(planned.minted.map((item) => item.id));
  }, 120_000);

  test("a booking naming no preset resolves the same slot values as one naming a preset that assigns nothing", async () => {
    const booked = await runHandler(caseBook, { slug: "no-preset-named", kind: KIND }, ctx());
    const caseRecord = (await store.read(booked.case, "case")) as CaseRecord;

    const opened = await openWorkspace({ workspace, scope, now });
    const slots = readSlotDeclarations(opened.index);
    const pinned = readPresetDeclarations(opened.index, slots).get(caseRecord.preset.contribution);
    expect(pinned?.assignments).toEqual({});

    // Against no preset layer, every slot resolves to its declaration's default the same way.
    for (const id of slots.keys()) {
      const throughPreset = resolveSlot(id, slots, { preset: pinned!.assignments, booking: caseRecord.overrides });
      const withoutPreset = resolveSlot(id, slots, { booking: caseRecord.overrides });
      expect(throughPreset).toEqual(withoutPreset);
      expect(throughPreset.layer).toBe("pack-defaults");
    }
  }, 60_000);

  test("a booking naming no kind still mints one base triple claim per about URI", async () => {
    const booked = await runHandler(caseBook, { slug: "booked-bare", about: ["./one", "./two"] }, ctx());

    const caseRecord = (await store.read(booked.case, "case")) as CaseRecord;
    expect(caseRecord.type).toBeNull();
    expect((await claimsOf(booked.case)).map((claim) => claim.type)).toEqual(["triple@1", "triple@1"]);
  }, 60_000);
  test("booking a slug again answers its case where the booking matches, and refuses one that differs", async () => {
    const first = await runHandler(caseBook, { slug: "booked-twice", about: ["./one"] }, ctx());
    const again = await runHandler(caseBook, { slug: "booked-twice", about: ["./one"] }, ctx());
    const differing = await runHandler(caseBook, { slug: "booked-twice", about: ["./two"] }, ctx()).catch(
      (error: unknown) => error,
    );

    expect(again.case).toBe(first.case);
    expect(differing).toMatchObject({ reason: "invalid-input", about: ["booked-twice"] });
  }, 60_000);
});

describe("a kind whose setlist names a claim with two rules in its conditions", () => {
  let workspace: string;
  const scope = "default";
  const now = fixedClock("2026-08-30T00:00:00.000Z");

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-booking-two-rules-"));
    const { gitDir } = await initWorkspace(workspace, { now });
    const store = new Store({ ctx: { gitDir }, scope, now });
    const index = new IndexDb(":memory:");
    await index.fold(store);
    await buildModule(CORE_MODULE_DIR, store, { blobs: blobStoreOf(workspace), index, now });
    await index.fold(store);
    await buildModule(TWO_RULERS_DIR, store, { blobs: blobStoreOf(workspace), index, now });
  }, 180_000);

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("books, and reading the case is refused naming both rules, since nothing decides which settles the claim", async () => {
    const context: OperationContext = { workspace, scope, now };
    const booked = await runHandler(caseBook, { slug: "audited", kind: TWO_RULERS_KIND }, context);
    expect(booked.minted.map((item) => item.kind)).toEqual(["case", "claim"]);

    const refused = await runHandler(caseSoundcheck, { case: "audited" }, context).catch((error: unknown) => error);

    expect(isOperationError(refused)).toBe(true);
    expect((refused as { reason: string }).reason).toBe("invalid-input");
    expect((refused as { detail: string }).detail).toContain("more than one rule");
    expect((refused as { detail: string }).detail).toContain("musai.core/declarative");
    expect((refused as { detail: string }).detail).toContain(TWO_RULERS_RULE);
  }, 60_000);

  test("a booking naming a module's rule is refused, naming the check that has a claim judged by it", async () => {
    const context: OperationContext = { workspace, scope, now };

    const refused = await runHandler(caseBook, { slug: "by-a-rule", kind: TWO_RULERS_RULE }, context).catch(
      (error: unknown) => error,
    );

    expect(refused).toMatchObject({ reason: "invalid-input", about: [TWO_RULERS_RULE] });
    expect((refused as Error).message).toContain(`check "<sentence>" --rule ${TWO_RULERS_RULE}`);
  }, 60_000);
});
