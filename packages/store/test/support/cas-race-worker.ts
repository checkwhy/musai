import { access } from "node:fs/promises";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSIONS, recordId, versionString } from "@musai/records";
import { fixedClock, SCENARIO_INSTANT } from "@musai/test-support";
import type { GitContext } from "../../src/git.js";
import { Store } from "../../src/store.js";

/** Run by the race test; a filesystem barrier holds each lane until both have built, forcing a
 * collision. */

interface WorkerReport {
  ok: true;
  ids: string[];
  retries: number;
}

interface WorkerFailure {
  ok: false;
  error: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForSibling(barrierDir: string, self: string, sibling: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await exists(join(barrierDir, `ready-${sibling}`)))) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for lane ${sibling} at the barrier`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  void self;
}

async function main(): Promise<void> {
  const [gitDir, scope, lane, barrierDir] = process.argv.slice(2);
  if (!gitDir || !scope || !lane || !barrierDir) {
    throw new Error("usage: cas-race-worker <gitDir> <scope> <lane> <barrierDir>");
  }
  const sibling = lane === "a" ? "b" : "a";

  const ctx: GitContext = { gitDir };
  const store = new Store({ ctx, scope, now: fixedClock(SCENARIO_INSTANT) });

  let retries = 0;
  const { writeFile } = await import("node:fs/promises");

  const ids = await store.putMany(
    [
      {
        kind: "case",
        value: {
          kind: "case",
          schemaVersion: CURRENT_SCHEMA_VERSIONS.case,
          type: null,
          slug: `race-${lane}`,
          claims: [],
          preset: {
            module: "musai.core",
            contribution: "musai.core/race",
            moduleRecord: recordId({ marker: "preset-module" }),
          },
          projectCommit: "0".repeat(40),
          overrides: {},
          evaluatorVersion: versionString("1"),
          supersedes: [],
        },
      },
    ],
    {
      onRetry: () => {
        retries++;
      },
      async beforeSwap(_tip, attemptNumber) {
        if (attemptNumber !== 1) {
          return;
        }
        await writeFile(join(barrierDir, `ready-${lane}`), "");
        await waitForSibling(barrierDir, lane, sibling);
      },
    },
  );

  const report: WorkerReport = { ok: true, ids, retries };
  process.stdout.write(JSON.stringify(report));
}

main().catch((error: unknown) => {
  const failure: WorkerFailure = { ok: false, error: error instanceof Error ? error.message : String(error) };
  process.stdout.write(JSON.stringify(failure));
  process.exitCode = 1;
});
