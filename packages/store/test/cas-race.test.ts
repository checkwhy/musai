import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CURRENT_SCHEMA_VERSIONS, recordId, versionString } from "@musai/records";
import { type FixtureRepo, makeFixtureRepo } from "@musai/test-support";
import { execa } from "execa";
import { afterEach, describe, expect, test } from "vitest";
import { gitRevParse, gitUpdateRefCas } from "../src/git.js";
import { CasExhaustedError, DEFAULT_RETRY_POLICY, withCasRetry } from "../src/retry.js";
import { Store, scopeRefName } from "../src/store.js";

const here = dirname(fileURLToPath(import.meta.url));
const workerScript = join(here, "support", "cas-race-worker.ts");
const tsLoader = fileURLToPath(import.meta.resolve("@musai/test-support/ts-esm"));

interface WorkerReport {
  ok: boolean;
  ids?: string[];
  retries?: number;
  error?: string;
}

async function runWorker(gitDir: string, scope: string, lane: string, barrierDir: string) {
  const result = await execa("node", ["--import", tsLoader, workerScript, gitDir, scope, lane, barrierDir]);
  return { report: JSON.parse(result.stdout) as WorkerReport, exitCode: result.exitCode };
}

let repos: FixtureRepo[] = [];
let barrierDirs: string[] = [];
let homeDirs: string[] = [];

afterEach(async () => {
  await Promise.all(repos.map((repo) => repo.cleanup()));
  await Promise.all(barrierDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  await Promise.all(homeDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  repos = [];
  barrierDirs = [];
  homeDirs = [];
});

async function makeBarrierDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "musai-cas-race-barrier-"));
  barrierDirs.push(dir);
  return dir;
}

function caseValue(slug: string) {
  return {
    kind: "case" as const,
    schemaVersion: CURRENT_SCHEMA_VERSIONS.case,
    type: null,
    slug,
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
  };
}

describe("withCasRetry, racing two real writers on one scope ref", () => {
  test("two subprocesses adding disjoint records both land, with at least one retry", async () => {
    const repo = await makeFixtureRepo("race");
    repos.push(repo);
    const barrierDir = await makeBarrierDir();

    const [a, b] = await Promise.all([
      runWorker(repo.ctx.gitDir, repo.scope, "a", barrierDir),
      runWorker(repo.ctx.gitDir, repo.scope, "b", barrierDir),
    ]);

    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.report.ok).toBe(true);
    expect(b.report.ok).toBe(true);

    const { stdout: treeListing } = await execa("git", [
      "--git-dir",
      repo.ctx.gitDir,
      "ls-tree",
      "-r",
      scopeRefName(repo.scope),
    ]);
    expect(treeListing).toContain(a.report.ids![0]!.replace("sha256:", ""));
    expect(treeListing).toContain(b.report.ids![0]!.replace("sha256:", ""));

    const totalRetries = (a.report.retries ?? 0) + (b.report.retries ?? 0);
    expect(totalRetries).toBeGreaterThanOrEqual(1);
  });
});

describe("withCasRetry, bounded attempts and backoff", () => {
  test("a losing lane with one allowed attempt raises CasExhaustedError naming the ref", async () => {
    const repo = await makeFixtureRepo("solo");
    repos.push(repo);
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });

    await store.putMany([{ kind: "case", value: caseValue("seed") }]);

    const losing = store.putMany([{ kind: "case", value: caseValue("loser") }], {
      policy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 },
      async beforeSwap() {
        // A concurrent writer lands before this lane swaps, so its swap must lose.
        await store.putMany([{ kind: "case", value: caseValue("winner") }]);
      },
    });

    await expect(losing).rejects.toBeInstanceOf(CasExhaustedError);
    await expect(losing).rejects.toThrow(scopeRefName(repo.scope));
  });

  test("a fixed random source produces a reproducible, growing, non-uniform backoff sequence", async () => {
    const repo = await makeFixtureRepo("backoff");
    repos.push(repo);

    async function run(): Promise<number[]> {
      const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
      const delays: number[] = [];
      const randomValues = [0.1, 0.9, 0.3];
      let callIndex = 0;
      let interference = 0;

      await store.putMany([{ kind: "case", value: caseValue(`target-${Math.random()}`) }], {
        policy: { baseDelayMs: 10, growthFactor: 2, jitterFraction: 0.5, maxAttempts: 4 },
        random: () => randomValues[callIndex++ % randomValues.length]!,
        sleep: async () => {},
        onRetry: (_attemptNumber, delayMs) => delays.push(delayMs),
        async beforeSwap(_tip, attemptNumber) {
          if (attemptNumber <= 3) {
            interference++;
            await store.putMany([{ kind: "case", value: caseValue(`interference-${interference}-${Math.random()}`) }]);
          }
        },
      });

      return delays;
    }

    const first = await run();

    expect(first).toHaveLength(3);
    expect(first[1]!).toBeGreaterThan(first[0]!);
    expect(first[2]!).toBeGreaterThan(first[1]!);
    expect(new Set(first).size).toBeGreaterThan(1);
    expect(first).toEqual([10.5, 29, 46]);
  });
});

describe("withCasRetry, a ref another process holds locked", () => {
  test("a write that finds the scope's ref locked retries, and lands once the lock is released", async () => {
    const repo = await makeFixtureRepo("locked");
    repos.push(repo);
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    await store.putMany([{ kind: "case", value: caseValue("seed") }]);
    const lock = join(repo.ctx.gitDir, `${scopeRefName(repo.scope)}.lock`);
    await writeFile(lock, "");

    let retries = 0;
    const [id] = await store.putMany([{ kind: "case", value: caseValue("after-the-lock") }], {
      // The wait before a retry is where the other process lets go.
      sleep: () => rm(lock, { force: true }),
      onRetry: () => {
        retries++;
      },
    });

    expect(retries).toBeGreaterThanOrEqual(1);
    expect((await store.read(id!, "case")).kind).toBe("case");
  });

  test("a lock that is never released exhausts the retry as contention, never as a raw failure", async () => {
    const repo = await makeFixtureRepo("stuck-lock");
    repos.push(repo);
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    await store.putMany([{ kind: "case", value: caseValue("seed") }]);
    await writeFile(join(repo.ctx.gitDir, `${scopeRefName(repo.scope)}.lock`), "");

    const blocked = store.putMany([{ kind: "case", value: caseValue("behind-the-lock") }], {
      policy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 3 },
      sleep: async () => {},
    });

    await expect(blocked).rejects.toBeInstanceOf(CasExhaustedError);
  });
});

describe("gitUpdateRefCas, telling a lost race apart from a failure", () => {
  test("a ref update against an unwritable git directory raises on the first attempt with the subprocess's own cause, and the retry hook records no calls", async (context) => {
    context.skip(
      process.getuid?.() === 0,
      "root writes through mode bits, so an unwritable directory cannot refuse it",
    );
    const repo = await makeFixtureRepo("unwritable");
    repos.push(repo);
    const mainTip = await gitRevParse(repo.ctx, "refs/heads/main");
    const refsHeadsDir = join(repo.ctx.gitDir, "refs", "heads");
    await chmod(refsHeadsDir, 0o500);

    let retryCalls = 0;
    try {
      await expect(
        withCasRetry(
          {
            ctx: repo.ctx,
            ref: "refs/heads/scope/unwritable",
            onRetry: () => {
              retryCalls++;
            },
          },
          async () => ({ commitSha: mainTip!, value: undefined }),
        ),
      ).rejects.toThrow(/permission denied|unable to create/i);
    } finally {
      await chmod(refsHeadsDir, 0o755);
    }

    expect(retryCalls).toBe(0);
  });

  test("a per-user git configuration file the plumbing would choke on never reaches a plumbing call", async () => {
    const repo = await makeFixtureRepo("config-leak");
    repos.push(repo);
    const fakeHome = await mkdtemp(join(tmpdir(), "musai-fake-home-"));
    homeDirs.push(fakeHome);
    // Git refuses every command over an unparseable file, so a call that answers never read it.
    await writeFile(join(fakeHome, ".gitconfig"), "this is not a configuration file\n");

    const originalHome = process.env["HOME"];
    process.env["HOME"] = fakeHome;
    try {
      expect(await gitRevParse(repo.ctx, "refs/heads/main")).not.toBeNull();
    } finally {
      if (originalHome === undefined) {
        delete process.env["HOME"];
      } else {
        process.env["HOME"] = originalHome;
      }
    }
  });
});

describe("gitUpdateRefCas refuses a ref that could add a field to the batch instruction, before it is assembled", () => {
  test("refuses a ref containing the field-separator byte", async () => {
    const repo = await makeFixtureRepo("ref-injection-nul");
    try {
      await expect(gitUpdateRefCas(repo.ctx, `refs/heads/evil${"\0"}ref`, "a".repeat(40), null)).rejects.toThrow(
        /refusing to build a ref-update instruction/,
      );
    } finally {
      await repo.cleanup();
    }
  });

  test("refuses a ref containing a line break", async () => {
    const repo = await makeFixtureRepo("ref-injection-newline");
    try {
      await expect(gitUpdateRefCas(repo.ctx, "refs/heads/evil\nref", "a".repeat(40), null)).rejects.toThrow(
        /refusing to build a ref-update instruction/,
      );
    } finally {
      await repo.cleanup();
    }
  });
});
