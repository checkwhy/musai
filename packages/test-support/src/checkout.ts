import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitContext } from "@musai/store";
import { execa } from "execa";

/** Fixture commits' identity, so none depends on the operator's own git configuration. */
export const COMMIT_ENV = {
  GIT_AUTHOR_NAME: "musai-test",
  GIT_AUTHOR_EMAIL: "musai-test@example.invalid",
  GIT_COMMITTER_NAME: "musai-test",
  GIT_COMMITTER_EMAIL: "musai-test@example.invalid",
};

export interface Checkout {
  readonly dir: string;
  readonly ctx: GitContext;
  cleanup(): Promise<void>;
}

export async function makeCheckout(committedContent = "hello"): Promise<Checkout> {
  const dir = await mkdtemp(join(tmpdir(), "musai-checkout-"));
  await execa("git", ["init", "--quiet", "--initial-branch", "main", dir]);
  await writeFile(join(dir, "tracked.txt"), committedContent);
  await execa("git", ["-C", dir, "add", "tracked.txt"]);
  await execa("git", ["-C", dir, "commit", "--quiet", "-m", "initial"], { env: COMMIT_ENV });
  return {
    dir,
    ctx: { gitDir: join(dir, ".git") },
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function commitContent(dir: string, content: string): Promise<string> {
  await writeFile(join(dir, "tracked.txt"), content);
  await execa("git", ["-C", dir, "commit", "--quiet", "-am", content], { env: COMMIT_ENV });
  return headCommit(dir);
}

export async function headCommit(dir: string): Promise<string> {
  return (await execa("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
}

export async function headTree(dir: string): Promise<string> {
  return (await execa("git", ["-C", dir, "rev-parse", "HEAD^{tree}"])).stdout.trim();
}

export async function bindCheckouts(localDir: string, bindings: Readonly<Record<string, string>>): Promise<void> {
  const table = Object.fromEntries(Object.entries(bindings).map(([name, directory]) => [name, { directory }]));
  await writeFile(join(localDir, "checkouts.json"), JSON.stringify(table));
}
