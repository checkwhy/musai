import { join } from "node:path";
import { execa } from "execa";

/** Strips every `GIT_` variable, so no configuration a test or its shell sets reaches a call. */
function withoutGitVariables(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].toUpperCase().startsWith("GIT_"),
    ),
  );
}

function ownConfigArgs(gitDir: string, args: readonly string[]): string[] {
  return ["config", "--file", join(gitDir, "config"), ...args];
}

/** A test's oracle for what a repository is, read without the shell's environment. */
export async function ownGit(gitDir: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execa("git", ["--git-dir", gitDir, ...args], {
    env: withoutGitVariables(),
    extendEnv: false,
  });
  return stdout.trim();
}

/** Read from the repository's `config` file alone, never git's effective configuration. */
export async function ownConfigValue(gitDir: string, key: string): Promise<string | null> {
  const { exitCode, stdout } = await execa("git", ownConfigArgs(gitDir, ["--get", key]), {
    env: withoutGitVariables(),
    extendEnv: false,
    reject: false,
  });
  return exitCode === 0 ? stdout.trim() : null;
}

/** `files` where unset, as git reads it, so a git too old to name another backend agrees. */
export async function ownRefFormat(gitDir: string): Promise<string> {
  return (await ownConfigValue(gitDir, "extensions.refStorage")) ?? "files";
}

export async function writeOwnConfig(gitDir: string, args: readonly string[]): Promise<void> {
  await execa("git", ownConfigArgs(gitDir, args), { env: withoutGitVariables(), extendEnv: false });
}
