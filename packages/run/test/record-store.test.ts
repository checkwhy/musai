import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexDb } from "@musai/fold";
import type { RunRecord } from "@musai/records";
import { CURRENT_SCHEMA_VERSIONS, KernelError, recordPath, timestamp } from "@musai/records";
import type { CommitChanges } from "@musai/store";
import { gitCommitTree, gitRevParse, Store, scopeRefName, withCasRetry } from "@musai/store";
import { commitAroundTheStore, type FixtureRepo, makeFixtureRepo } from "@musai/test-support";
import { execa } from "execa";
import { afterEach, describe, expect, test } from "vitest";
import { RUNNER_PERFORMER } from "../src/performer.js";

const FIXED_INSTANT = timestamp("2026-01-01T00:00:00.000Z");

let repos: FixtureRepo[] = [];

afterEach(async () => {
  await Promise.all(repos.map((repo) => repo.cleanup()));
  repos = [];
});

/** A receipt whose output is `output`, so two calls with different outputs are two records. */
function receipt(output: string): RunRecord {
  return {
    kind: "run",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
    runKind: "run",
    determinism: "nondeterministic",
    performer: RUNNER_PERFORMER,
    recipe: {
      command: ["true"],
      workingDirectory: "/",
      environment: {},
      declared: [],
      substrates: [],
      isolation: "hygiene",
    },
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

/** Commits the tip with `path` removed, around the `Store`, which never deletes a path itself. */
async function deleteAroundTheStore(repo: FixtureRepo, path: string): Promise<string> {
  const ref = scopeRefName(repo.scope);
  const tmpDir = await mkdtemp(join(tmpdir(), "musai-raw-delete-"));
  try {
    const tip = (await gitRevParse(repo.ctx, ref))!;
    const env = { ...process.env, GIT_INDEX_FILE: join(tmpDir, "index") };
    const git = (args: string[], input?: string) =>
      execa("git", ["--git-dir", repo.ctx.gitDir, ...args], { env, input });
    await git(["read-tree", tip]);
    await git(["update-index", "--index-info"], `0 ${"0".repeat(40)}\t${path}\n`);
    const { stdout: treeSha } = await git(["write-tree"]);
    const commitSha = await gitCommitTree(
      repo.ctx,
      treeSha.trim(),
      [tip],
      "delete a record around the store\n",
      repo.now,
    );
    await withCasRetry({ ctx: repo.ctx, ref }, async () => ({ commitSha, value: undefined }));
    return commitSha;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/** Recommits the tip's own tree, which the `Store` never does: an empty diff a walk must count. */
async function commitNothingAroundTheStore(repo: FixtureRepo): Promise<string> {
  const ref = scopeRefName(repo.scope);
  const tip = (await gitRevParse(repo.ctx, ref))!;
  const treeSha = (await gitRevParse(repo.ctx, `${tip}^{tree}`))!;
  const commitSha = await gitCommitTree(repo.ctx, treeSha, [tip], "commit nothing around the store\n", repo.now);
  await withCasRetry({ ctx: repo.ctx, ref }, async () => ({ commitSha, value: undefined }));
  return commitSha;
}

describe("the log a store hands the fold, against a per-commit diff of the same range", () => {
  test("lists the same paths per commit in the same order, a modified path's bytes as they are at that commit, and a deleted path's as null", async () => {
    const repo = await makeFixtureRepo("log-against-diff");
    repos.push(repo);
    // Off, against git's default, so a walk reading root paths from this key would miss them.
    await execa("git", ["--git-dir", repo.ctx.gitDir, "config", "log.showRoot", "false"]);
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });

    // Two records at the root, then commits outside `records/`, rewriting, deleting and empty.
    const [modifiedId] = await store.putMany([
      { kind: "run", value: receipt("first") },
      { kind: "run", value: receipt("second") },
    ]);
    const notePath = "notes/readme.txt";
    await commitAroundTheStore(repo, notePath, new TextEncoder().encode("a note beside the records\n"));
    const modifiedPath = recordPath("run", modifiedId!);
    const modifiedText = `${JSON.stringify(receipt("x".repeat(200_000)), null, 2)}\n`;
    const modifying = await commitAroundTheStore(repo, modifiedPath, new TextEncoder().encode(modifiedText));
    const deleting = await deleteAroundTheStore(repo, notePath);
    await commitNothingAroundTheStore(repo);
    const tip = (await store.tip())!;

    const walked: CommitChanges[] = [];
    for await (const changes of store.changesSince(null)) {
      walked.push(changes);
    }

    // The oracle is git's own per-commit commands, sharing no helper with the walk.
    const lines = async (args: string[]) =>
      (await execa("git", ["--git-dir", repo.ctx.gitDir, ...args])).stdout
        .split("\n")
        .filter((line) => line.length > 0);
    expect(walked.map((changes) => changes.commit)).toEqual(await lines(["rev-list", "--reverse", tip]));
    let previous: string | null = null;
    for (const { commit, committedAt, changed } of walked) {
      const listed = await lines(
        previous === null
          ? ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", commit]
          : ["diff-tree", "--no-commit-id", "--name-only", "-r", previous, commit],
      );
      const paths = changed.map((entry) => entry.path);
      // The set before the order, so a path missing from one side fails apart from a reordering.
      expect(new Set(paths)).toEqual(new Set(listed));
      expect(paths).toEqual(listed);
      expect(committedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      previous = commit;
    }
    // Two paths at the root, so order within a commit is compared too; none in the last.
    expect(walked.map((changes) => changes.changed.length)).toEqual([2, 1, 1, 1, 0]);

    const modified = walked.find((changes) => changes.commit === modifying)!.changed;
    expect(modified.map((entry) => entry.path)).toEqual([modifiedPath]);
    expect(modified[0]!.bytes).not.toBeNull();
    expect(modifiedText).toContain("\n");
    expect(Buffer.from(modified[0]!.bytes!).toString("utf8")).toBe(modifiedText);
    const deleted = walked.find((changes) => changes.commit === deleting)!.changed;
    expect(deleted).toEqual([{ path: notePath, bytes: null }]);
  });
});

describe("a fold over a history that deleted a record path", () => {
  test("refuses it as a corrupted record naming the commit and the path, with every earlier commit applied and none after", async () => {
    const repo = await makeFixtureRepo("deleted-record");
    repos.push(repo);
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const [keptId] = await store.putMany([{ kind: "run", value: receipt("written, then deleted") }]);
    const written = await store.tip();
    const path = recordPath("run", keptId!);
    const deleting = await deleteAroundTheStore(repo, path);
    const [laterId] = await store.putMany([{ kind: "run", value: receipt("written after the deletion") }]);

    const index = new IndexDb();
    const refusal = await index.fold(store).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(KernelError);
    expect((refusal as KernelError).reason).toBe("record-corrupted");
    expect((refusal as KernelError).about).toEqual([deleting, path]);
    expect((refusal as KernelError).detail).toContain(deleting);
    expect((refusal as KernelError).detail).toContain(path);
    expect(index.watermark()).toBe(written);
    expect(index.recordById(keptId!)?.id).toBe(keptId);
    expect(index.recordById(laterId!)).toBeUndefined();
  });
});
