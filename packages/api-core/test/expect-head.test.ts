import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSIONS, type RecordKind, type RunRecord, timestamp, versionString } from "@musai/records";
import { RUNNER_PERFORMER } from "@musai/run";
import { type GitContext, initWorkspace, Store } from "@musai/store";
import { fixedClock } from "@musai/test-support";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { assertHeadUnmoved, HeadMovedError } from "../src/expect-head.js";
import { runHandler } from "../src/handler.js";
import type { OperationDescriptor } from "../src/registry.js";

const FIXED_INSTANT = timestamp("2026-01-01T00:00:00.000Z");
const now = fixedClock(FIXED_INSTANT);

function runRecord(output: string): RunRecord {
  return {
    kind: "run",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
    runKind: "run",
    determinism: "nondeterministic",
    performer: RUNNER_PERFORMER,
    recipe: { command: [], workingDirectory: "/", environment: {}, declared: [], substrates: [], isolation: "hygiene" },
    observation: {
      resolved: [],
      isolationHeld: "hygiene",
      binaries: [],
      bindings: [],
      output,
      outputLossy: false,
      exitCode: 0,
      scrubbed: [],
      startedAt: FIXED_INSTANT,
      finishedAt: FIXED_INSTANT,
      reads: [],
      cost: {},
    },
  };
}

interface FakeWriteInput {
  readonly label: string;
}

interface FakeWriteOutput {
  readonly minted: ReadonlyArray<{ readonly id: string; readonly kind: string; readonly record: unknown }>;
}

function fakeWriteOperation(): OperationDescriptor<FakeWriteInput, FakeWriteOutput> {
  return {
    id: "test.fake-write",
    version: versionString("1"),
    input: {
      type: "object",
      additionalProperties: false,
      required: ["label"],
      properties: { label: { type: "string" } },
    },
    output: true,
    effect: "write",
    authority: null,
    plans: false,
    reasons: ["head-moved"],
    documentation: "mints one run record, for exercising the write contract",
    cli: { verb: "fake-write", positional: ["label"], flags: [], describe: "d" },
    renderText: () => "",
    exitCode: () => 0,
    async handler(input, context) {
      const gitDir = join(context.workspace, ".musai");
      const store = new Store({ ctx: { gitDir }, scope: context.scope, now: context.now });
      const [id] = await store.putMany([{ kind: "run", value: runRecord(input.label) }]);
      return { minted: [{ id: id!, kind: "run", record: runRecord(input.label) }] };
    },
  };
}

function fakeReadOperation(): OperationDescriptor<Record<string, never>, { readonly tip: string | null }> {
  return {
    id: "test.fake-read",
    version: versionString("1"),
    input: true,
    output: true,
    effect: "read",
    authority: null,
    plans: true,
    reasons: [],
    documentation: "reads the store's own tip, for exercising the read contract",
    cli: { verb: "fake-read", positional: [], flags: [], describe: "d" },
    renderText: () => "",
    exitCode: () => 0,
    async handler(_input, context) {
      const gitDir = join(context.workspace, ".musai");
      const store = new Store({ ctx: { gitDir }, scope: context.scope, now: context.now });
      return { tip: await store.tip() };
    },
  };
}

describe("assertHeadUnmoved", () => {
  let workspace: string;
  let store: Store;
  const scope = "default";

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-expect-head-"));
    const { gitDir } = await initWorkspace(workspace, { now });
    const ctx: GitContext = { gitDir };
    store = new Store({ ctx, scope, now });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("passes without raising when the tip matches the expected head", async () => {
    await store.putMany([{ kind: "run", value: runRecord("seed") }]);
    const tip = await store.tip();
    await expect(assertHeadUnmoved(store, tip!)).resolves.toBeUndefined();
  });

  test("raises HeadMovedError naming both the expected and the found head when the tip has moved", async () => {
    await store.putMany([{ kind: "run", value: runRecord("first") }]);
    const staleTip = await store.tip();
    await store.putMany([{ kind: "run", value: runRecord("second") }]);
    const movedTip = await store.tip();

    const error = await assertHeadUnmoved(store, staleTip!).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HeadMovedError);
    expect((error as HeadMovedError).reason).toBe("head-moved");
    expect((error as HeadMovedError).about).toEqual([`expected:${staleTip}`, `found:${movedTip}`]);
  });

  test("does not call into the store's own compare-and-swap retry: refusing this way never re-reads the tip a second time", async () => {
    let tipReads = 0;
    const countingStore: Pick<Store, "tip"> = {
      tip: async () => {
        tipReads++;
        return store.tip();
      },
    };
    await store.putMany([{ kind: "run", value: runRecord("only") }]);
    await expect(assertHeadUnmoved(countingStore, `sha256:${"0".repeat(64)}`)).rejects.toBeInstanceOf(HeadMovedError);
    expect(tipReads).toBe(1);
  });
});

describe("runHandler's own head guard, wired through the write contract", () => {
  let workspace: string;
  const scope = "default";
  const writeOp = fakeWriteOperation();
  const readOp = fakeReadOperation();

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-expect-head-handler-"));
    await initWorkspace(workspace, { now });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  function storeAt(): Store {
    return new Store({ ctx: { gitDir: join(workspace, ".musai") }, scope, now });
  }

  test("a write result carries one entry per minted record, id and body, needing no second store read to assert on", async () => {
    const output = await runHandler(writeOp, { label: "a" }, { workspace, scope, now });
    expect(output.minted).toHaveLength(1);
    expect(output.minted[0]!.kind).toBe("run");
    expect(output.minted[0]!.record).toMatchObject({ kind: "run" });
  });

  test("a write with no expectHead writes against the current tip, as today", async () => {
    const before = await storeAt().tip();
    const output = await runHandler(writeOp, { label: "b" }, { workspace, scope, now });
    const after = await storeAt().tip();
    expect(after).not.toBe(before);
    expect(output.minted).toHaveLength(1);
  });

  test("a write whose expectHead matches the tip writes, and the returned records are the ones committed", async () => {
    await runHandler(writeOp, { label: "seed" }, { workspace, scope, now });
    const tip = await storeAt().tip();
    const output = await runHandler(writeOp, { label: "c" }, { workspace, scope, now, expectHead: tip! });
    const committed = await storeAt().read(output.minted[0]!.id as never, output.minted[0]!.kind as RecordKind);
    expect(committed).toMatchObject(output.minted[0]!.record as object);
  });

  test("a write whose expectHead names a commit the tip has moved past refuses with the moved-head reason, naming both heads", async () => {
    await runHandler(writeOp, { label: "seed" }, { workspace, scope, now });
    const staleTip = await storeAt().tip();
    await runHandler(writeOp, { label: "mover" }, { workspace, scope, now });
    const movedTip = await storeAt().tip();

    const error: unknown = await runHandler(
      writeOp,
      { label: "loser" },
      {
        workspace,
        scope,
        now,
        expectHead: staleTip!,
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HeadMovedError);
    expect((error as HeadMovedError).about).toEqual([`expected:${staleTip}`, `found:${movedTip}`]);
  });

  test("after such a refusal the store's tip is unchanged and no record was written", async () => {
    await runHandler(writeOp, { label: "seed" }, { workspace, scope, now });
    const tipBefore = await storeAt().tip();

    await runHandler(
      writeOp,
      { label: "refused" },
      {
        workspace,
        scope,
        now,
        expectHead: `sha256:${"0".repeat(64)}`,
      },
    ).catch(() => undefined);

    const tipAfter = await storeAt().tip();
    expect(tipAfter).toBe(tipBefore);
  });

  test("a read operation given an expectHead that has moved is unaffected — the guard applies to writes only", async () => {
    await runHandler(writeOp, { label: "before-read" }, { workspace, scope, now });
    const output = await runHandler(readOp, {}, { workspace, scope, now, expectHead: `sha256:${"0".repeat(64)}` });
    expect(output.tip).not.toBeNull();
  });
});
