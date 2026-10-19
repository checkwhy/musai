import { rm } from "node:fs/promises";
import { join } from "node:path";
import { blobPath, hexOfRecordId, type RecordId } from "@musai/records";
import { GitBlobStore, LOCAL_DIR, MUSAI_DIR } from "@musai/store";
import { execa } from "execa";
import { fixedClock, SCENARIO_INSTANT } from "./clock.js";

const BLOBS_REF = "refs/heads/blobs";

/** A workspace's blob store, its branch commits dated at the scenario instant. */
export function blobStoreOf(workspace: string): GitBlobStore {
  return new GitBlobStore({ ctx: { gitDir: join(workspace, MUSAI_DIR) }, now: fixedClock(SCENARIO_INSTANT) });
}

/** The path a workspace's blob is materialised at, where a test swaps or removes the copy. */
export function cachedBlobPath(workspace: string, id: RecordId): string {
  return join(workspace, MUSAI_DIR, LOCAL_DIR, blobPath(id));
}

/** Sets `id` on the branch to `bytes`, or removes it, and drops the cached copy: a store whose
 * bytes were swapped, or never arrived. */
export async function rewriteBlob(workspace: string, id: RecordId, bytes: Uint8Array | null): Promise<void> {
  const gitDir = join(workspace, MUSAI_DIR);
  const git = (args: string[], options: { input?: Uint8Array; env?: Record<string, string> } = {}) =>
    execa("git", ["--git-dir", gitDir, ...args], options).then(({ stdout }) => stdout.trim());
  const hex = hexOfRecordId(id);
  const shard = hex.slice(0, 2);
  const tip = await git(["rev-parse", "--verify", BLOBS_REF]);
  const listing = async (treeish: string) =>
    (await git(["ls-tree", treeish]).catch(() => "")).split("\n").filter((line) => line.length > 0);
  const kept = (await listing(`${tip}:${shard}`)).filter((line) => !line.endsWith(`\t${hex}`));
  if (bytes !== null) {
    kept.push(`100644 blob ${await git(["hash-object", "-w", "--stdin"], { input: bytes })}\t${hex}`);
  }
  const root = (await listing(tip)).filter((line) => !line.endsWith(`\t${shard}`));
  if (kept.length > 0) {
    root.push(
      `040000 tree ${await git(["mktree"], { input: new TextEncoder().encode(`${kept.join("\n")}\n`) })}\t${shard}`,
    );
  }
  const tree = await git(["mktree"], {
    input: new TextEncoder().encode(root.length > 0 ? `${root.join("\n")}\n` : ""),
  });
  const commit = await git(["commit-tree", tree, "-p", tip, "-m", "rewrite a blob"], {
    env: {
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@musai.invalid",
      GIT_AUTHOR_DATE: SCENARIO_INSTANT,
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@musai.invalid",
      GIT_COMMITTER_DATE: SCENARIO_INSTANT,
    },
  });
  await git(["update-ref", BLOBS_REF, commit, tip]);
  await rm(cachedBlobPath(workspace, id), { force: true });
}
