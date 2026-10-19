import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { clockFromEnvironment, openWorkspace, runHandler } from "@musai/api-core";
import { buildModule } from "@musai/devkit";
import type { RuleInput } from "@musai/modules";
import type { RecordId, RunRecord } from "@musai/records";
import { MUSAI_DIR, Store } from "@musai/store";
import {
  blobStoreOf,
  fixtureRunRecord,
  foldedIndex,
  generateTestKey,
  rowsHeld,
  type TestKey,
} from "@musai/test-support";
import { afterAll, beforeAll, describe, expect, onTestFinished, test, vi } from "vitest";
import { claimStatus } from "../src/ops/claim.js";
import {
  claim,
  emptyWorld,
  now,
  opensshAvailable,
  PUBLISHER,
  SCOPE,
  seal,
  slotOf,
  type World,
  WRITER,
} from "./sealed-world.js";

const host = vi.hoisted(() => ({ throwsOnInvocation: 0 }));

vi.mock("@musai/evaluate", async (importOriginal) => {
  const original = await importOriginal<typeof import("@musai/evaluate")>();
  return {
    ...original,
    runRestartLoop: (options: Parameters<typeof original.runRestartLoop>[0]) => {
      let invoked = 0;
      return original.runRestartLoop({
        ...options,
        invoker: {
          invoke: async (input: RuleInput) => {
            invoked += 1;
            if (invoked === host.throwsOnInvocation) {
              throw new Error("the host could not be reached");
            }
            return options.invoker.invoke(input);
          },
        },
      });
    },
  };
});

const CORE_MODULE_DIR = fileURLToPath(new URL("../../core-module", import.meta.url));
/** A module whose rule asks for two runs, then fails as its condition says. */
const FAILS_AFTER_RUNS_MODULE_DIR = fileURLToPath(new URL("./fixtures/fails-after-runs", import.meta.url));
const FAILS_AFTER_RUNS_RULE = "fails-after-runs/after-two-runs";

/** How a loop ends after its two runs: its host dies, its rule answers what no rule may, or its
 * host throws rather than answering. */
const FAILURES = [
  ["its host dies", "crash"],
  ["its rule answers malformed output", "malformed"],
  ["its host throws", "throws"],
] as const;

let key: TestKey;
const scratch: string[] = [];

beforeAll(async () => {
  key = await generateTestKey(PUBLISHER);
}, 60_000);

afterAll(async () => {
  await rm(key.dir, { recursive: true, force: true });
  for (const dir of scratch) {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A workspace with the failing rule built and a claim it judges, failing as `mode` says. */
async function failingCheck(mode: string): Promise<World & { readonly check: RecordId }> {
  const world = await emptyWorld(key, scratch);
  for (const dir of [CORE_MODULE_DIR, FAILS_AFTER_RUNS_MODULE_DIR]) {
    await buildModule(dir, world.store, {
      blobs: blobStoreOf(world.workspace),
      index: await foldedIndex(world.store),
      now,
    });
  }
  const [check] = await world.store.putMany([
    { kind: "claim", value: claim(mode, { [FAILS_AFTER_RUNS_RULE]: `${mode} ${mode}` }) },
  ]);
  return { ...world, check: check! };
}

/** Checks the claim as its author, with a moving clock so each run spawns; a throwing host
 * refuses the call, and every other failure concludes the check open. */
async function checked(world: World, mode: string): Promise<void> {
  host.throwsOnInvocation = mode === "throws" ? 2 : 0;
  onTestFinished(() => {
    host.throwsOnInvocation = 0;
  });
  const status = runHandler(claimStatus, { claim: slotOf(mode) }, { ...world.author, now: clockFromEnvironment() });
  if (mode === "throws") {
    await expect(status).rejects.toThrow();
  } else {
    expect((await status).label).toBe("open");
  }
}

/** The runs the failing rule asked for, and its claim's evaluations, as the author holds them. */
async function minted(world: World, mode: string): Promise<{ receipts: RecordId[]; evaluations: RecordId[] }> {
  const receipts: RecordId[] = [];
  const evaluations: RecordId[] = [];
  for (const id of await world.store.list("run")) {
    const run = (await world.store.read(id, "run")) as RunRecord;
    if (run.runKind === "run" && run.recipe.command.includes(mode)) {
      receipts.push(id);
    }
    if (run.runKind === "evaluation" && run.recipe.command.includes(slotOf(mode))) {
      evaluations.push(id);
    }
  }
  return { receipts, evaluations };
}

function clearedPath(world: World): string {
  const digest = createHash("sha256").update(WRITER).digest("hex");
  return join(world.workspace, MUSAI_DIR, "local", "scopes", SCOPE, "cleared", `${digest}.sqlite`);
}

/** Every row a reader of the fold can reach: not its stamp, nor how far its walk has gone. */
function rowsSeen(path: string): Record<string, string[]> {
  const { schema_meta: _stamp, walked: _walked, ...seen } = rowsHeld(path);
  return seen;
}

async function heldBy(world: World, cleared: boolean, ids: readonly RecordId[]): Promise<boolean[]> {
  const opened = await openWorkspace(cleared ? world.station : world.author);
  onTestFinished(() => opened.close());
  return ids.map((id) => opened.index.holds(id));
}

describe("a check whose loop fails after two performed runs", () => {
  test.each(FAILURES)(
    "leaves both receipts recorded where %s",
    async (_, mode) => {
      const world = await failingCheck(mode);

      await checked(world, mode);

      const { receipts, evaluations } = await minted(world, mode);
      expect(receipts).toHaveLength(2);
      const opened = await openWorkspace(world.author);
      onTestFinished(() => opened.close());
      const commits = new Set([...receipts, ...evaluations].map((id) => opened.index.commitOf(id)));
      expect([commits.size, evaluations.length]).toEqual([1, mode === "throws" ? 0 : 1]);
    },
    120_000,
  );

  test("reports its own failure where what it performed cannot land either", async () => {
    const world = await failingCheck("throws");
    host.throwsOnInvocation = 2;
    onTestFinished(() => {
      host.throwsOnInvocation = 0;
    });
    const putMany = vi.spyOn(Store.prototype, "putMany").mockRejectedValue(new Error("the store refused the write"));
    onTestFinished(() => putMany.mockRestore());

    const status = runHandler(
      claimStatus,
      { claim: slotOf("throws") },
      { ...world.author, now: clockFromEnvironment() },
    );

    await expect(status).rejects.toThrow("the host could not be reached");
    expect(putMany).toHaveBeenCalled();
  }, 120_000);
});

describe.skipIf(!opensshAvailable)("a closure seal over a check whose loop fails", () => {
  test.each(FAILURES)(
    "shows a station neither receipt where %s, and withdraws nothing it held",
    async (_, mode) => {
      const world = await failingCheck(mode);
      const [beside] = await world.store.putMany([{ kind: "run", value: fixtureRunRecord("held by the station") }]);
      await seal(world, world.check, true);
      expect(await heldBy(world, true, [beside!])).toEqual([true]);
      const rows = rowsSeen(clearedPath(world));

      await checked(world, mode);

      const { receipts } = await minted(world, mode);
      expect(await heldBy(world, false, receipts)).toEqual([true, true]);
      expect(await heldBy(world, true, [beside!, ...receipts])).toEqual([true, false, false]);
      expect(rowsSeen(clearedPath(world))).toEqual(rows);
    },
    120_000,
  );
});
