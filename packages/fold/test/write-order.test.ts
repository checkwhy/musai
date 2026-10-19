import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ComputedRunRecord,
  CURRENT_SCHEMA_VERSIONS,
  EVALUATOR_VERSION,
  type RecordId,
  recordId,
  timestamp,
} from "@musai/records";
import { createScope, gitCommitTree, gitRevParse, initWorkspace, Store } from "@musai/store";
import { describe, expect, onTestFinished, test } from "vitest";
import { IndexDb } from "../src/index-db.js";

const now = () => timestamp("2026-10-18T00:00:00.000Z");

function run(label: string): ComputedRunRecord {
  return {
    kind: "run",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
    runKind: "evaluation",
    performer: { kind: "runner", version: EVALUATOR_VERSION },
    determinism: "deterministic",
    recipe: { command: ["evaluate", label], substrates: [] },
    observation: { output: "{}", reads: [], cost: {} },
  };
}

/** Two runs whose ids sort against the order they are named in. */
function againstIdOrder(): [ComputedRunRecord, ComputedRunRecord] {
  for (let attempt = 0; ; attempt += 1) {
    const first = run(`first ${attempt}`);
    const second = run(`second ${attempt}`);
    if (recordId(first) > recordId(second)) {
      return [first, second];
    }
  }
}

async function workspace(): Promise<{ store: Store; gitDir: string; index: IndexDb }> {
  const dir = await mkdtemp(join(tmpdir(), "musai-fold-order-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const { gitDir } = await initWorkspace(dir, { now });
  const index = new IndexDb(join(dir, "index.sqlite"));
  onTestFinished(() => index.close());
  return { store: new Store({ ctx: { gitDir }, scope: "default", now }), gitDir, index };
}

async function foldedOrder(index: IndexDb, store: Store): Promise<RecordId[]> {
  await index.fold(store);
  return (index.eventsAfter() ?? []).filter((event) => event.kind === "run.recorded").map((event) => event.recordId);
}

describe("the order a commit's records fold in", () => {
  test("records one commit lands fold in the order their writer wrote them, whatever their ids", async () => {
    const { store, index } = await workspace();
    const [first, second] = againstIdOrder();
    await store.putMany([
      { kind: "run", value: first },
      { kind: "run", value: second },
    ]);

    expect(await foldedOrder(index, store)).toEqual([recordId(first), recordId(second)]);
  });

  test("a commit naming no order folds its records in path order", async () => {
    const { store, gitDir, index } = await workspace();
    const [first, second] = againstIdOrder();
    await store.putMany([
      { kind: "run", value: first },
      { kind: "run", value: second },
    ]);
    const written = (await store.tip())!;
    const ctx = { gitDir };
    const tree = (await gitRevParse(ctx, `${written}^{tree}`))!;
    const parent = await gitRevParse(ctx, `${written}^`);
    const unordered = await gitCommitTree(ctx, tree, parent === null ? [] : [parent], "write 2 records\n", now);
    await createScope(ctx, "unordered", unordered);

    expect(await foldedOrder(index, new Store({ ctx, scope: "unordered", now }))).toEqual([
      recordId(second),
      recordId(first),
    ]);
  });

  test("a merge folds the source's records in the order the source wrote them", async () => {
    const { store, gitDir, index } = await workspace();
    await store.put("run", run("the base"));
    await createScope({ gitDir }, "fork", (await store.tip())!);
    const fork = new Store({ ctx: { gitDir }, scope: "fork", now });
    const [first, second] = againstIdOrder();
    await fork.put("run", first);
    await fork.put("run", second);
    await store.mergeFrom("fork");

    expect((await foldedOrder(index, store)).slice(1)).toEqual([recordId(first), recordId(second)]);
  });
});
