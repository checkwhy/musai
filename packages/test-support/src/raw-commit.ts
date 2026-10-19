import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitCommitTree, gitHashObjectBatch, gitRevParse, scopeRefName, withCasRetry } from "@musai/store";
import { execa } from "execa";
import type { FixtureRepo } from "./fixture-repo.js";

type StoreAt = Pick<FixtureRepo, "ctx" | "scope" | "now">;

export interface RawFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** Bypasses the `Store` and its checks, so a test holds what a hand or a peer could put in git. */
export async function commitAroundTheStore(repo: StoreAt, path: string, bytes: Uint8Array): Promise<string> {
  return commitFilesAroundTheStore(repo, [{ path, bytes }]);
}

/** The tree is built through git's index plumbing, so nothing here copies the store's layout. */
export async function commitFilesAroundTheStore(repo: StoreAt, files: readonly RawFile[]): Promise<string> {
  const ref = scopeRefName(repo.scope);
  const tmpDir = await mkdtemp(join(tmpdir(), "musai-raw-commit-"));
  try {
    const filePaths = files.map((_, index) => join(tmpDir, `bytes-${index}`));
    await Promise.all(files.map((file, index) => writeFile(filePaths[index]!, file.bytes)));
    const blobShas = await gitHashObjectBatch(repo.ctx, filePaths);

    const tip = await gitRevParse(repo.ctx, ref);
    const env = { ...process.env, GIT_INDEX_FILE: join(tmpDir, "index") };
    const git = (args: string[]) => execa("git", ["--git-dir", repo.ctx.gitDir, ...args], { env });
    await git(tip ? ["read-tree", tip] : ["read-tree", "--empty"]);
    for (const [index, file] of files.entries()) {
      await git(["update-index", "--add", "--cacheinfo", `100644,${blobShas[index]!},${file.path}`]);
    }
    const { stdout: treeSha } = await git(["write-tree"]);

    const commitSha = await gitCommitTree(
      repo.ctx,
      treeSha.trim(),
      tip ? [tip] : [],
      "commit bytes around the store\n",
      repo.now,
    );
    await withCasRetry({ ctx: repo.ctx, ref }, async () => ({ commitSha, value: undefined }));
    return commitSha;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
