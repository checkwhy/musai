import { fileURLToPath } from "node:url";
import { execa } from "execa";

/** The monorepo's `.git`, resolved worktree-aware: the core module and fixtures nest inside it. */
export async function repoGitDir(): Promise<string> {
  const { stdout } = await execa("git", ["rev-parse", "--absolute-git-dir"], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
  });
  return stdout.trim();
}
