import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { clockFromEnvironment, type OperationContext, openWorkspace, runHandler } from "@musai/api-core";
import { buildModule } from "@musai/devkit";
import {
  type ClaimRecord,
  type ClaimTypeDeclaration,
  type ComputedRunRecord,
  CURRENT_SCHEMA_VERSIONS,
  claimTypesFrom,
  hexOfRecordId,
  type ModuleRecord,
  type RecordId,
  type RunRecord,
  recordId,
  slotFor,
} from "@musai/records";
import { initWorkspace, Store } from "@musai/store";
import { blobStoreOf, declareClaimTypes, fixedClock, foldedIndex, rewriteBlob } from "@musai/test-support";
import { afterAll, beforeAll, describe, expect, onTestFinished, test } from "vitest";
import { labelledClaim } from "../src/claim.js";
import { evaluationRecipe, mintEvaluation } from "../src/evaluation.js";
import { claimStatus } from "../src/ops/claim.js";

const CORE_MODULE_DIR = fileURLToPath(new URL("../../core-module", import.meta.url));
/** A module whose rule asks for a record by id, read from its condition, and for a run. */
const RECORD_NEED_MODULE_DIR = fileURLToPath(new URL("./fixtures/record-need", import.meta.url));
const RECORD_NEED_RULE = "record-need/cites-a-record";
const DECLARATIVE = "musai.core/declarative";
const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: "musai.evaluation-test/claim@1", identityDimensions: ["id"] };
const CLAIM_TYPES = claimTypesFrom([CLAIM_DECLARATION]);

function slotOf(id: string): string {
  return slotFor(CLAIM_DECLARATION, { id });
}

/** An interpreter condition over one recipe per tag, each passing its tag to a clean exit; with
 * no tag, one recipe every caller of it shares. */
function exitsCleanly(...tags: readonly string[]): string {
  const recipes = (tags.length === 0 ? [null] : tags).map((tag) => ({
    name: tag ?? "r",
    kind: "run",
    recipe: {
      command: ["node", "-e", "process.exit(0)", ...(tag === null ? [] : [tag])],
      workingDirectory: "/",
      environment: {},
      declared: [],
      substrates: [],
      isolation: "hygiene",
    },
  }));
  return JSON.stringify({
    recipes,
    expectations: recipes.map(({ name }) => ({ kind: "exitCodeIs", recipe: name, value: 0 })),
  });
}

function claim(id: string, conditions: Record<string, string> = {}): ClaimRecord {
  return {
    kind: "claim",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: CLAIM_DECLARATION.type,
    about: [],
    slot: slotOf(id),
    conditions: { id, ...conditions },
    canonical: { statement: id },
    rendering: id,
    evidence: [],
    exclusiveGroup: null,
  };
}

describe("a performed evaluation is a run naming what its rule was handed", () => {
  let workspace: string;
  let store: Store;
  const scope = "default";
  const now = fixedClock("2026-10-07T00:00:00.000Z");

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-evaluation-run-"));
    const { gitDir } = await initWorkspace(workspace, { now });
    store = new Store({ ctx: { gitDir }, scope, now, claimTypes: CLAIM_TYPES });
    await declareClaimTypes(store, [CLAIM_DECLARATION]);
    for (const dir of [CORE_MODULE_DIR, RECORD_NEED_MODULE_DIR]) {
      await buildModule(dir, store, { blobs: blobStoreOf(workspace), index: await foldedIndex(store), now });
    }
  }, 120_000);

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  function ctx(): OperationContext {
    return { workspace, scope, now };
  }

  async function evaluations(): Promise<{ id: RecordId; run: ComputedRunRecord }[]> {
    const runs = await Promise.all(
      (await store.list("run")).map(async (id) => ({ id, run: (await store.read(id, "run")) as RunRecord })),
    );
    return runs.filter((entry) => entry.run.runKind === "evaluation") as { id: RecordId; run: ComputedRunRecord }[];
  }

  test("a performed check mints one evaluation run whose read-set names the claim's slot and each receipt", async () => {
    const [claimId] = await store.putMany([
      { kind: "claim", value: claim("checked", { [DECLARATIVE]: exitsCleanly() }) },
    ]);
    const before = (await evaluations()).length;

    const status = await runHandler(claimStatus, { claim: slotOf("checked") }, ctx());

    const minted = (await evaluations()).slice(before);
    expect(minted).toHaveLength(1);
    const { run } = minted[0]!;
    expect(run.recipe.command).toEqual(["evaluate", DECLARATIVE, slotOf("checked")]);
    expect(JSON.parse(run.observation.output as string)).toEqual({ label: status.label, reason: expect.any(String) });
    const receipts = (await store.list("run")).filter((id) => !minted.some((entry) => entry.id === id));
    expect(run.observation.reads).toContainEqual({
      key: `slot:${slotOf("checked")}`,
      consumed: { sha256: hexOfRecordId(claimId!) },
    });
    const evidence = run.observation.reads.filter((entry) => !entry.key.startsWith("slot:"));
    expect(evidence.length).toBeGreaterThan(0);
    for (const entry of evidence) {
      const receipt = `sha256:${entry.consumed.sha256}` as RecordId;
      expect(receipts).toContain(receipt);
      // A run need asked for the latest receipt of its recipe, so it is read under the recipe.
      expect(entry.key).toBe(`recipe:${recordId(((await store.read(receipt, "run")) as RunRecord).recipe)}`);
    }
  }, 60_000);

  test.each([
    ["the interpreter over two recipes", "lands-two", async () => ({ [DECLARATIVE]: exitsCleanly("first", "second") })],
    [
      "a module's rule",
      "lands-the-rule's",
      async () => {
        const [cited] = await store.putMany([{ kind: "claim", value: claim("asked-for-by-the-landing") }]);
        return { [RECORD_NEED_RULE]: cited! };
      },
    ],
  ])(
    "a check performed by %s lands every receipt its loop performed in its evaluation's commit",
    async (_, id, conditions) => {
      await store.putMany([{ kind: "claim", value: claim(id, await conditions()) }]);
      const before = new Set(await store.list("run"));

      // A moving clock, so each run spawns rather than reusing a receipt an earlier check landed.
      await runHandler(claimStatus, { claim: slotOf(id) }, { ...ctx(), now: clockFromEnvironment() });

      const minted = (await store.list("run")).filter((run) => !before.has(run));
      const opened = await openWorkspace(ctx());
      onTestFinished(() => opened.close());
      const evaluated = (run: RecordId) => (opened.read(run) as RunRecord).runKind === "evaluation";
      const [evaluation, ...others] = minted.filter(evaluated);
      const receipts = minted.filter((run) => !evaluated(run));
      expect(others).toEqual([]);
      expect(receipts.length).toBeGreaterThan(0);
      expect(receipts.map((receipt) => opened.index.commitOf(receipt))).toEqual(
        receipts.map(() => opened.index.commitOf(evaluation!)),
      );
    },
    60_000,
  );

  test("a receipt for its recipe landed since stales a claim read without performing", async () => {
    await store.putMany([{ kind: "claim", value: claim("receipt-landed", { [DECLARATIVE]: exitsCleanly() }) }]);
    await store.putMany([{ kind: "claim", value: claim("shares-the-recipe", { [DECLARATIVE]: exitsCleanly() }) }]);
    await runHandler(claimStatus, { claim: slotOf("receipt-landed") }, ctx());
    expect(
      await runHandler(claimStatus, { claim: slotOf("receipt-landed") }, { ...ctx(), mode: "plan" }),
    ).toMatchObject({
      reason: null,
    });

    // A moving clock, so the other check spawns a receipt of its own rather than the same bytes.
    await runHandler(claimStatus, { claim: slotOf("shares-the-recipe") }, { ...ctx(), now: clockFromEnvironment() });
    const read = await runHandler(claimStatus, { claim: slotOf("receipt-landed") }, { ...ctx(), mode: "plan" });

    expect(read).toMatchObject({ label: "open", reason: "stale" });
  }, 60_000);

  test("a second status over unchanged reads mints no evaluation", async () => {
    await store.putMany([{ kind: "claim", value: claim("again", { [DECLARATIVE]: exitsCleanly() }) }]);
    await runHandler(claimStatus, { claim: slotOf("again") }, ctx());
    const afterFirst = (await evaluations()).length;

    await runHandler(claimStatus, { claim: slotOf("again") }, ctx());

    expect((await evaluations()).length).toBe(afterFirst);
  }, 60_000);

  test("an evaluation that only reads what is recorded mints nothing, though it concluded otherwise", async () => {
    await store.putMany([{ kind: "claim", value: claim("recorded", { [DECLARATIVE]: exitsCleanly() }) }]);
    const before = (await evaluations()).length;

    await labelledClaim(await openWorkspace({ workspace, scope, now }), slotOf("recorded"), "recorded");

    expect((await evaluations()).length).toBe(before);
  }, 60_000);

  test("a record a rule asked for that is a claim reads under the claim's slot", async () => {
    const [cited] = await store.putMany([{ kind: "claim", value: claim("asked-for") }]);
    await store.putMany([{ kind: "claim", value: claim("asks", { [RECORD_NEED_RULE]: cited! }) }]);

    await runHandler(claimStatus, { claim: slotOf("asks") }, ctx());

    const asking = (await evaluations()).find((entry) => entry.run.recipe.command[2] === slotOf("asks"));
    expect(asking?.run.observation.reads).toContainEqual({
      key: `slot:${slotOf("asked-for")}`,
      consumed: { sha256: hexOfRecordId(cited!) },
    });
  }, 60_000);

  test("a claim whose evaluation read a record that a later record at its slot replaced reads stale", async () => {
    const [cited] = await store.putMany([{ kind: "claim", value: claim("replaced-later") }]);
    await store.putMany([{ kind: "claim", value: claim("rests-on", { [RECORD_NEED_RULE]: cited! }) }]);
    const performed = await runHandler(claimStatus, { claim: slotOf("rests-on") }, ctx());
    expect(performed.label).toBe("holds");

    await store.putMany([
      { kind: "claim", value: { ...claim("replaced-later"), rendering: "replaced, restated", supersedes: [cited!] } },
    ]);
    const read = await runHandler(claimStatus, { claim: slotOf("rests-on") }, { ...ctx(), mode: "plan" });

    expect(read).toMatchObject({ label: "open", reason: "stale" });
  }, 60_000);

  test("a claim that read nothing that moved keeps its status", async () => {
    const [cited] = await store.putMany([{ kind: "claim", value: claim("left-alone") }]);
    await store.putMany([{ kind: "claim", value: claim("rests-alone", { [RECORD_NEED_RULE]: cited! }) }]);
    const [other] = await store.putMany([{ kind: "claim", value: claim("moved-elsewhere") }]);
    const performed = await runHandler(claimStatus, { claim: slotOf("rests-alone") }, ctx());

    await store.putMany([
      { kind: "claim", value: { ...claim("moved-elsewhere"), rendering: "moved, restated", supersedes: [other!] } },
    ]);
    const read = await runHandler(claimStatus, { claim: slotOf("rests-alone") }, { ...ctx(), mode: "plan" });

    expect(read).toMatchObject({ label: performed.label, reason: null });
  }, 60_000);

  test("an evaluation returning to an earlier verdict supersedes the latest and reads as latest", async () => {
    await store.putMany([{ kind: "claim", value: claim("flips", { [DECLARATIVE]: exitsCleanly() }) }]);
    const opened = async () => openWorkspace({ workspace, scope, now });
    const contribution = (await opened()).index.contributionById(DECLARATIVE)!;
    const recipe = evaluationRecipe(contribution, slotOf("flips"), undefined);
    const verdicts = ["holds", "fails", "holds"] as const;

    const ids: (RecordId | null)[] = [];
    for (const label of verdicts) {
      const current = await opened();
      ids.push(
        await mintEvaluation(current, current.store.held(), recipe, [], { kind: "verdict", label, reason: label }),
      );
    }

    expect(new Set(ids).size).toBe(3);
    const latest = (await opened()).index.receiptByRecipe(recordId(recipe));
    expect(latest?.recordId).toBe(ids[2]);
    expect(latest?.record.supersedes).toEqual([ids[1]]);
  }, 60_000);
});

describe("a claim read without performing answers from an evaluation nothing has moved under", () => {
  let workspace: string;
  let store: Store;
  const scope = "default";
  const now = fixedClock("2026-10-08T00:00:00.000Z");

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-evaluation-recorded-"));
    const { gitDir } = await initWorkspace(workspace, { now });
    store = new Store({ ctx: { gitDir }, scope, now, claimTypes: CLAIM_TYPES });
    await declareClaimTypes(store, [CLAIM_DECLARATION]);
    for (const dir of [CORE_MODULE_DIR, RECORD_NEED_MODULE_DIR]) {
      await buildModule(dir, store, { blobs: blobStoreOf(workspace), index: await foldedIndex(store), now });
    }
  }, 120_000);

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("keeps its status with no rule invoked, though the rule's bundle can no longer be read", async () => {
    const [cited] = await store.putMany([{ kind: "claim", value: claim("stays-put") }]);
    await store.putMany([{ kind: "claim", value: claim("rests-on-it", { [RECORD_NEED_RULE]: cited! }) }]);
    const performed = await runHandler(claimStatus, { claim: slotOf("rests-on-it") }, { workspace, scope, now });
    expect(performed.label).toBe("holds");
    const opened = await openWorkspace({ workspace, scope, now });
    const contribution = opened.index.contributionById(RECORD_NEED_RULE)!;
    const module = opened.read(contribution.moduleRecord) as ModuleRecord;

    await rewriteBlob(workspace, module.bundle!, null);
    const read = await runHandler(
      claimStatus,
      { claim: slotOf("rests-on-it") },
      { workspace, scope, now, mode: "plan" },
    );

    expect(read).toMatchObject({ label: "holds", reason: null });
  }, 60_000);
});
