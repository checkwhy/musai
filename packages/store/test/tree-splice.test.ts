import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KernelError } from "@musai/records";
import { fixedClock, SCENARIO_INSTANT } from "@musai/test-support";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type GitContext,
  gitBuildTree,
  gitCommitTree,
  gitHashObjectBatch,
  gitInitBare,
  gitLsTree,
  gitMkTree,
  gitSpliceTree,
} from "../src/git.js";

const KINDS = ["attestation", "case", "claim"] as const;
const PREFIXES = ["00", "3f", "a7", "ff"] as const;
const CASES = 40;
const now = fixedClock(SCENARIO_INSTANT);

let scratch: string;
let ctx: GitContext;
let blobs: string[];

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "musai-tree-splice-"));
  const gitDir = join(scratch, "repo.git");
  await gitInitBare(gitDir);
  ctx = { gitDir };
  const files = await Promise.all(
    Array.from({ length: 48 }, async (_, index) => {
      const path = join(scratch, `blob-${index}`);
      await writeFile(path, `content ${index}\n`);
      return path;
    }),
  );
  blobs = await gitHashObjectBatch(ctx, files);
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** A seeded source in `[0, 1)`, so a failing case replays from its seed. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, from: readonly T[]): T {
  return from[Math.floor(random() * from.length)]!;
}

/** A record under two shard levels, a sidecar, or a file beside `records/`. Shards are few, so a
 * batch lands in the base's. */
function recordShapedPath(random: () => number): string {
  const kind = pick(random, KINDS);
  const first = pick(random, PREFIXES);
  const second = pick(random, PREFIXES);
  const tail = Array.from({ length: 60 }, () => pick(random, [..."0123456789abcdef"])).join("");
  const name = `${first}${second}${tail}`;
  if (random() < 0.15) {
    return `blobs/${first}/${name}`;
  }
  return kind === "attestation" && random() < 0.3
    ? `records/${kind}/${first}/${second}/${name}.json.sig`
    : `records/${kind}/${first}/${second}/${name}.json`;
}

/** The reference tree, written by git's own index in two processes whatever the depth; a later
 * entry for a path replaces an earlier one. */
async function indexTree(files: readonly { path: string; sha: string }[]): Promise<string> {
  const env = { GIT_INDEX_FILE: join(scratch, "reference-index") };
  await rm(env.GIT_INDEX_FILE, { force: true });
  await execa("git", ["--git-dir", ctx.gitDir, "update-index", "--add", "--index-info"], {
    env,
    input: files.map((file) => `100644 ${file.sha}\t${file.path}\n`).join(""),
  });
  return (await execa("git", ["--git-dir", ctx.gitDir, "write-tree"], { env })).stdout.trim();
}

async function commitOf(files: readonly { path: string; sha: string }[]): Promise<string> {
  return gitCommitTree(ctx, await indexTree(files), [], "base\n", now);
}

describe("a tree spliced from the trees a write touches", () => {
  test("a spliced tree equals the tree rebuilt whole from the same entries", async () => {
    for (let seed = 1; seed <= CASES; seed++) {
      const random = seeded(seed);
      const base = Array.from({ length: 1 + Math.floor(random() * 30) }, () => ({
        path: recordShapedPath(random),
        sha: pick(random, blobs),
      }));
      const baseCommit = await commitOf(base);
      const batch = Array.from({ length: 1 + Math.floor(random() * 12) }, () =>
        random() < 0.25
          ? { path: pick(random, base).path, sha: pick(random, blobs) }
          : { path: recordShapedPath(random), sha: pick(random, blobs) },
      );

      const whole = await indexTree([
        ...(await gitLsTree(ctx, baseCommit)).map((entry) => ({ path: entry.path, sha: entry.sha })),
        ...batch,
      ]);

      expect({ seed, tree: await gitSpliceTree(ctx, baseCommit, batch) }).toEqual({ seed, tree: whole });
    }
  });

  test("a spliced tree over no base equals the tree built from the batch alone", async () => {
    const random = seeded(CASES + 1);
    const batch = Array.from({ length: 10 }, () => ({ path: recordShapedPath(random), sha: pick(random, blobs) }));

    expect(await gitSpliceTree(ctx, null, batch)).toBe(await gitBuildTree(ctx, batch));
  });

  test("a base holding an entry the store never writes is refused, naming the entry", async () => {
    const shard = (
      await execa("git", ["--git-dir", ctx.gitDir, "mktree"], {
        input: `100755 blob ${blobs[0]}\tunexpected.json\n`,
      })
    ).stdout.trim();
    const kind = await gitMkTree(ctx, [{ mode: "040000", type: "tree", sha: shard, path: "00" }]);
    const records = await gitMkTree(ctx, [{ mode: "040000", type: "tree", sha: kind, path: "claim" }]);
    const root = await gitMkTree(ctx, [{ mode: "040000", type: "tree", sha: records, path: "records" }]);
    const baseCommit = await gitCommitTree(ctx, root, [], "base\n", now);

    const refusal = await gitSpliceTree(ctx, baseCommit, [
      { path: `records/claim/00/00/0000${"1".repeat(60)}.json`, sha: blobs[1]! },
    ]).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(KernelError);
    expect((refusal as KernelError).reason).toBe("record-corrupted");
    expect((refusal as KernelError).message).toContain("records/claim/00");
    expect((refusal as KernelError).message).toContain("unexpected.json");
    expect((refusal as KernelError).message).toContain("100755");
  });
});
