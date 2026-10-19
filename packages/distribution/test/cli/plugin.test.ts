import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { repoGitDir } from "../repo-git-dir.js";

const CLI_PATH = fileURLToPath(new URL("../../dist/bin/cli.js", import.meta.url));
const SKILLFUL_FIXTURE_DIR = fileURLToPath(new URL("../fixtures/skillful", import.meta.url));

describe("plugin sync — against the built binary", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-cli-plugin-"));
    await execa("node", [CLI_PATH, "init", workspace]);
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("a module's marked skill reaches the plugin the moment `module build` installs it, with no `plugin sync` invoked", async () => {
    const sourceGitDir = await repoGitDir();
    await execa("node", [
      CLI_PATH,
      "lab",

      "module",
      "build",
      SKILLFUL_FIXTURE_DIR,
      "--workspace",
      workspace,
      "--source-git-dir",
      sourceGitDir,
    ]);

    const written = await readFile(join(workspace, "plugin", "skills", "musai-skillful", "SKILL.md"), "utf8");
    expect(written).toBe("skillful's own conversational entry, rendered for real.");
  });

  test("running `plugin sync` by hand afterwards finds nothing changed, and running it again is still byte-identical", async () => {
    const target = join(workspace, "plugin", "skills", "musai-skillful", "SKILL.md");
    const before = await readFile(target);

    const first = await execa("node", [CLI_PATH, "lab", "plugin", "sync", "--workspace", workspace, "--json"]);
    const firstOutput = JSON.parse(first.stdout) as {
      written: readonly string[];
      removed: readonly string[];
      unchanged: readonly string[];
    };
    expect(firstOutput.unchanged).toContain("musai-skillful");
    expect(firstOutput.written).toEqual([]);

    const second = await execa("node", [CLI_PATH, "lab", "plugin", "sync", "--workspace", workspace, "--json"]);
    const secondOutput = JSON.parse(second.stdout) as {
      written: readonly string[];
      removed: readonly string[];
      unchanged: readonly string[];
    };
    expect(secondOutput).toEqual(firstOutput);

    const after = await readFile(target);
    expect(Buffer.compare(before, after)).toBe(0);
  });
});
