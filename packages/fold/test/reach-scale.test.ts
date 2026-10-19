import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  type ComputedRunRecord,
  CURRENT_SCHEMA_VERSIONS,
  EVALUATOR_VERSION,
  type RecordId,
  readEntryFor,
  recordId,
  timestamp,
} from "@musai/records";
import { initWorkspace, Store } from "@musai/store";
import { afterEach, expect, test } from "vitest";
import { IndexDb } from "../src/index-db.js";
import { openIndexProvider } from "../src/sqlite-provider.js";

const RUNS = 10_000;
const READS_PER_RUN = 10;
const HUB_READERS = 1_000;
/** The measured answer is under 50 ms here; this catches a scan, not a slower machine. */
const REACH_CEILING_MS = 500;
/** Catches only a superlinear regression; the run's measurements record the time itself. */
const FOLD_CEILING_MS = 120_000;
const now = () => timestamp("2026-10-07T00:00:00.000Z");

let workspace: string | undefined;

afterEach(async () => {
  if (workspace !== undefined) {
    await rm(workspace, { recursive: true, force: true });
  }
  workspace = undefined;
});

/** An evaluation of claim `index` reading the hub if it is among the first readers, and its own
 * records for the rest. */
function evaluationReading(index: number, hub: RecordId): ComputedRunRecord {
  const own = Array.from({ length: READS_PER_RUN }, (_, read) => recordId({ evaluation: index, read }));
  const read = index < HUB_READERS ? [hub, ...own.slice(1)] : own;
  return {
    kind: "run",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
    runKind: "evaluation",
    performer: { kind: "runner", version: EVALUATOR_VERSION },
    determinism: "deterministic",
    recipe: { command: ["evaluate", "scale/rule", `scale/claim@1:${index}`], substrates: [] },
    observation: { output: "{}", reads: read.map((id) => readEntryFor(id)), cost: {} },
  };
}

test(
  "a hundred thousand read-set rows over ten thousand runs fold in one pass, and a hub's reach is one lookup",
  async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-reach-scale-"));
    const { gitDir } = await initWorkspace(workspace, { now });
    const store = new Store({ ctx: { gitDir }, scope: "default", now });
    const hub = await store.put("run", evaluationReading(-1, recordId({ marker: "nothing" })));
    await store.putMany(
      Array.from({ length: RUNS }, (_, index) => ({ kind: "run", value: evaluationReading(index, hub) })),
    );
    const path = join(workspace, "index.sqlite");
    const index = new IndexDb(path);

    const foldStarted = performance.now();
    await index.fold(store);
    const folded = performance.now() - foldStarted;

    const raw = openIndexProvider().open(path);
    const { rows } = raw.prepare("SELECT count(*) AS rows FROM reads").get() as { rows: number };
    raw.close();
    expect(rows).toBe(RUNS * READS_PER_RUN + READS_PER_RUN);
    expect(folded).toBeLessThan(FOLD_CEILING_MS);

    await store.put("run", { ...evaluationReading(-2, recordId({ marker: "nothing" })), supersedes: [hub] });
    await index.fold(store);
    const reachStarted = performance.now();
    const reach = index.reachOf(hub);
    const reached = performance.now() - reachStarted;

    expect(reach).toHaveLength(HUB_READERS);
    expect(reached).toBeLessThan(REACH_CEILING_MS);
    console.info(`fold of ${rows} read rows over ${RUNS} runs: ${Math.round(folded)} ms`);
    console.info(`reachOf a hub read by ${HUB_READERS} runs: ${reached.toFixed(1)} ms`);
  },
  FOLD_CEILING_MS * 2,
);
