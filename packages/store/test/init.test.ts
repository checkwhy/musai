import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { KernelError } from "@musai/records";
import { fixedClock, ownConfigValue, ownGit, ownRefFormat, writeOwnConfig } from "@musai/test-support";
import { execa } from "execa";
import { afterEach, describe, expect, test, vi } from "vitest";
import { gitCheckIgnored } from "../src/git.js";
import { adoptWorkspace, initWorkspace, LOCAL_DIR, MUSAI_DIR } from "../src/init.js";

/** One instant for every initialisation, so racing seed commits are one commit. */
const FIXED_INSTANT = "2026-01-01T00:00:00.000Z";
const FIXED_NOW = fixedClock(FIXED_INSTANT);

let workspaces: string[] = [];

async function makeTempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "musai-init-test-"));
  workspaces.push(dir);
  return dir;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(workspaces.map((dir) => rm(dir, { recursive: true, force: true })));
  workspaces = [];
});

/** Two readings are equal only when no file changed and no entry, an empty directory included, came
 * or went. */
async function readTree(root: string): Promise<Map<string, Buffer | "directory">> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  const tree = new Map<string, Buffer | "directory">();
  const sorted = entries
    .map((entry) => ({ entry, path: join(entry.parentPath, entry.name) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const { entry, path } of sorted) {
    tree.set(path.slice(root.length + 1), entry.isDirectory() ? "directory" : await readFile(path));
  }
  return tree;
}

/** A bare clone as a receiver holds one: no `local/`, and none of the source's own settings. */
async function cloneWorkspace(source: string): Promise<string> {
  const target = await makeTempWorkspace();
  await execa("git", ["clone", "--quiet", "--bare", join(source, MUSAI_DIR), join(target, MUSAI_DIR)]);
  return target;
}

describe("initWorkspace", () => {
  test("creates <dir>/.musai and nothing outside it", async () => {
    const workspace = await makeTempWorkspace();
    const before = await readdir(workspace);
    expect(before).toEqual([]);

    await initWorkspace(workspace, { now: FIXED_NOW });

    const after = await readdir(workspace);
    expect(after).toEqual([MUSAI_DIR]);
  });

  test("reports itself as a bare repository", async () => {
    const workspace = await makeTempWorkspace();
    const { gitDir } = await initWorkspace(workspace, { now: FIXED_NOW });

    const { stdout } = await execa("git", ["--git-dir", gitDir, "rev-parse", "--is-bare-repository"]);
    expect(stdout.trim()).toBe("true");
  });

  test("disables automatic collection and sets prune expiry to never", async () => {
    const workspace = await makeTempWorkspace();
    const { gitDir } = await initWorkspace(workspace, { now: FIXED_NOW });

    expect(await ownConfigValue(gitDir, "gc.auto")).toBe("0");
    expect(await ownConfigValue(gitDir, "gc.pruneExpire")).toBe("never");
  });

  test("seeds main with the configuration file and the allowed-signers, roles and audiences files", async () => {
    const workspace = await makeTempWorkspace();
    const { gitDir } = await initWorkspace(workspace, { now: FIXED_NOW });

    const { stdout } = await execa("git", ["--git-dir", gitDir, "cat-file", "-p", "main:"]);
    expect(stdout).toContain("config.json");
    expect(stdout).toContain("allowed-signers");
    expect(stdout).toContain("roles");
    expect(stdout).toContain("audiences");
  });

  test("creates local/ for the index and the workspace key, and it is never tracked", async () => {
    const workspace = await makeTempWorkspace();
    const { gitDir, localDir } = await initWorkspace(workspace, { now: FIXED_NOW });

    const stat = await readdir(localDir);
    expect(stat).toEqual([]);

    const { stdout } = await execa("git", ["--git-dir", gitDir, "ls-files"]);
    expect(stdout.split("\n").filter((line) => line.startsWith(`${LOCAL_DIR}/`))).toEqual([]);
  });

  test("an enclosing repository ignores the workspace's local directory", async () => {
    const workspace = await makeTempWorkspace();
    await execa("git", ["init", "--quiet", workspace]);

    const { localDir } = await initWorkspace(workspace, { now: FIXED_NOW });

    expect(await gitCheckIgnored(localDir, workspace)).toBe("ignored");
    expect(await gitCheckIgnored(join(workspace, MUSAI_DIR, "objects"), workspace)).toBe("not-ignored");
  });

  test("running it a second time reports the workspace already exists and changes nothing", async () => {
    const workspace = await makeTempWorkspace();
    const first = await initWorkspace(workspace, { now: FIXED_NOW });
    expect(first.created).toBe(true);

    const before = await readTree(workspace);
    const second = await initWorkspace(workspace, { now: FIXED_NOW });
    expect(second.created).toBe(false);
    expect(second.gitDir).toBe(first.gitDir);

    const after = await readTree(workspace);
    expect(after).toEqual(before);
  });

  test("initialising a workspace that arrived without local/ makes it, with the two collection settings compare-and-swap relies on, and reports the workspace as existing", async () => {
    const source = await makeTempWorkspace();
    await initWorkspace(source, { now: FIXED_NOW });
    const clone = await cloneWorkspace(source);
    const gitDir = join(clone, MUSAI_DIR);
    expect(await readdir(gitDir)).not.toContain(LOCAL_DIR);
    expect(await ownConfigValue(gitDir, "gc.auto")).toBeNull();
    expect(await ownConfigValue(gitDir, "gc.pruneExpire")).toBeNull();

    const adopted = await initWorkspace(clone, { now: FIXED_NOW });

    expect(adopted.created).toBe(false);
    expect(adopted.gitDir).toBe(gitDir);
    expect(await readdir(adopted.localDir)).toEqual([]);
    expect(await ownConfigValue(gitDir, "gc.auto")).toBe("0");
    expect(await ownConfigValue(gitDir, "gc.pruneExpire")).toBe("never");
  });

  test("refuses a non-bare git directory at the workspace's own path, and writes nothing", async () => {
    const workspace = await makeTempWorkspace();
    const gitDir = join(workspace, MUSAI_DIR);
    await execa("git", ["init", "--quiet", gitDir]);

    const before = await readTree(workspace);
    await expect(initWorkspace(workspace, { now: FIXED_NOW })).rejects.toThrow(gitDir);
    const after = await readTree(workspace);
    expect(after).toEqual(before);
  });

  test("refuses a bare repository holding no main, as an interrupted initialisation leaves one, and writes nothing", async () => {
    const workspace = await makeTempWorkspace();
    const gitDir = join(workspace, MUSAI_DIR);
    await execa("git", ["init", "--quiet", "--bare", gitDir]);

    const before = await readTree(workspace);
    await expect(initWorkspace(workspace, { now: FIXED_NOW })).rejects.toThrow(gitDir);
    const after = await readTree(workspace);
    expect(after).toEqual(before);
  });

  test("refuses a .musai that is a file by name, and writes nothing", async () => {
    const workspace = await makeTempWorkspace();
    const gitDir = join(workspace, MUSAI_DIR);
    await writeFile(gitDir, "a file where the repository goes\n");

    const before = await readTree(workspace);
    const refusal = await initWorkspace(workspace, { now: FIXED_NOW }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(KernelError);
    expect(refusal).toMatchObject({ reason: "invalid-input", about: [gitDir] });
    expect(await readTree(workspace)).toEqual(before);
  });

  test("refuses a directory holding one unrelated file, and writes nothing", async () => {
    const workspace = await makeTempWorkspace();
    const gitDir = join(workspace, MUSAI_DIR);
    await mkdir(gitDir, { recursive: true });
    await writeFile(join(gitDir, "unrelated.txt"), "hello\n");

    const before = await readTree(workspace);
    await expect(initWorkspace(workspace, { now: FIXED_NOW })).rejects.toThrow(gitDir);
    const after = await readTree(workspace);
    expect(after).toEqual(before);
  });

  test("many initialisations of one directory at once leave a single seeded root, whichever of them the directory check turns away", async () => {
    const workspace = await makeTempWorkspace();
    const gitDir = join(workspace, MUSAI_DIR);

    // Late callers are refused by name; the rest share one instant, so their seed commits coincide.
    const outcomes = await Promise.allSettled(
      Array.from({ length: 6 }, () => initWorkspace(workspace, { now: FIXED_NOW })),
    );
    expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBe(true);

    const { stdout: reachable } = await execa("git", ["--git-dir", gitDir, "rev-list", "--count", "refs/heads/main"]);
    expect(reachable.trim()).toBe("1");

    const { stdout: unreachable } = await execa("git", ["--git-dir", gitDir, "fsck", "--unreachable", "--no-progress"]);
    expect(unreachable).not.toContain("unreachable commit");
  });
});

describe("adoptWorkspace", () => {
  test("adopting a directory that holds no workspace writes nothing", async () => {
    const root = await makeTempWorkspace();
    const gitDirOf = (name: string): string => join(root, name, MUSAI_DIR);
    await mkdir(join(root, "absent"));
    await mkdir(gitDirOf("empty"), { recursive: true });
    await execa("git", ["init", "--quiet", gitDirOf("non-bare")]);
    await execa("git", ["init", "--quiet", "--bare", gitDirOf("bare-without-main")]);
    await mkdir(gitDirOf("unrelated"), { recursive: true });
    await writeFile(join(gitDirOf("unrelated"), "unrelated.txt"), "hello\n");
    await mkdir(join(root, "file"));
    await writeFile(gitDirOf("file"), "a file where the repository goes\n");
    await writeFile(join(root, "under-a-file"), "a file where the workspace's directory goes\n");

    for (const [name, answer] of [
      ["absent", "absent"],
      ["empty", "absent"],
      ["non-bare", "foreign"],
      ["bare-without-main", "foreign"],
      ["unrelated", "foreign"],
      ["file", "foreign"],
      ["under-a-file", "foreign"],
    ] as const) {
      const before = await readTree(root);
      expect(await adoptWorkspace(gitDirOf(name))).toBe(answer);
      expect(await readTree(root)).toEqual(before);
    }
  });

  test("adopting a workspace whose local/ is a file refuses workspace-incomplete naming local/, and leaves the file as it was", async () => {
    const source = await makeTempWorkspace();
    await initWorkspace(source, { now: FIXED_NOW });
    const gitDir = join(await cloneWorkspace(source), MUSAI_DIR);
    const local = join(gitDir, LOCAL_DIR);
    await writeFile(local, "a file where the machine's own directory goes\n");

    const refusal = await adoptWorkspace(gitDir).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(KernelError);
    expect(refusal).toMatchObject({ reason: "workspace-incomplete", about: [local] });
    expect(await readFile(local, "utf8")).toBe("a file where the machine's own directory goes\n");
  });

  test("twenty adoptions of one clone at once all adopt it, none refused by the local/ another made first", async () => {
    const source = await makeTempWorkspace();
    await initWorkspace(source, { now: FIXED_NOW });
    const gitDir = join(await cloneWorkspace(source), MUSAI_DIR);

    // Git holds the configuration lock about a millisecond, so the retry past it is pinned below.
    const answers = await Promise.all(Array.from({ length: 20 }, () => adoptWorkspace(gitDir)));

    expect(answers).toEqual(Array.from({ length: 20 }, () => "adopted"));
    expect(await readdir(join(gitDir, LOCAL_DIR))).toEqual([]);
    expect(await ownConfigValue(gitDir, "gc.auto")).toBe("0");
    expect(await ownConfigValue(gitDir, "gc.pruneExpire")).toBe("never");
  });

  test("an adoption finding the configuration locked by another writer refuses by name while a setting is missing, making no local/, and adopts once both are set", async () => {
    const source = await makeTempWorkspace();
    await initWorkspace(source, { now: FIXED_NOW });
    const gitDir = join(await cloneWorkspace(source), MUSAI_DIR);
    const lock = join(gitDir, "config.lock");
    await writeFile(lock, "");

    const refusal = await adoptWorkspace(gitDir).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(KernelError);
    expect(refusal).toMatchObject({ reason: "workspace-incomplete", about: [gitDir, "gc.auto"] });
    expect(await readdir(gitDir)).not.toContain(LOCAL_DIR);

    await rm(lock);
    await writeOwnConfig(gitDir, ["gc.auto", "0"]);
    await writeOwnConfig(gitDir, ["gc.pruneExpire", "never"]);
    await writeFile(lock, "");

    expect(await adoptWorkspace(gitDir)).toBe("adopted");
    expect(await readdir(join(gitDir, LOCAL_DIR))).toEqual([]);
  });

  test("an adoption finding the configuration locked for a moment by another writer adopts once the lock is freed, setting both keys, whatever language the shell speaks", async () => {
    const source = await makeTempWorkspace();
    await initWorkspace(source, { now: FIXED_NOW });
    const gitDir = join(await cloneWorkspace(source), MUSAI_DIR);
    const lock = join(gitDir, "config.lock");
    await writeFile(lock, "");
    vi.stubEnv("LC_ALL", "de_DE.UTF-8");
    vi.stubEnv("LANGUAGE", "de");

    // Under load the first write may miss the lock entirely, which passes without the retry.
    const freed = wait(100).then(() => rm(lock, { force: true }));
    const answer = await adoptWorkspace(gitDir);
    await freed;

    expect(answer).toBe("adopted");
    expect(await ownConfigValue(gitDir, "gc.auto")).toBe("0");
    expect(await ownConfigValue(gitDir, "gc.pruneExpire")).toBe("never");
  });
});

/** The stubbed environment sets `gc.auto` for the clone, yet init and adoption still write both
 * settings into each repository's own file. */
async function expectSettingsInOwnConfiguration(fresh: string, clone: string): Promise<void> {
  const cloneGitDir = join(clone, MUSAI_DIR);
  const effective = await execa("git", ["--git-dir", cloneGitDir, "config", "--get", "gc.auto"]);
  expect(effective.stdout.trim()).toBe("0");
  expect(await ownConfigValue(cloneGitDir, "gc.auto")).toBeNull();
  expect(await ownConfigValue(cloneGitDir, "gc.pruneExpire")).toBeNull();

  const { gitDir: freshGitDir } = await initWorkspace(fresh, { now: FIXED_NOW });
  expect(await adoptWorkspace(cloneGitDir)).toBe("adopted");

  for (const gitDir of [freshGitDir, cloneGitDir]) {
    expect(await ownConfigValue(gitDir, "gc.auto")).toBe("0");
    expect(await ownConfigValue(gitDir, "gc.pruneExpire")).toBe("never");
  }
}

describe("the collection settings a workspace carries", () => {
  test("a fresh workspace and an adopted clone hold both in their own configuration where a global configuration holds them too", async () => {
    const source = await makeTempWorkspace();
    await initWorkspace(source, { now: FIXED_NOW });
    const clone = await cloneWorkspace(source);
    const fresh = await makeTempWorkspace();
    const global = join(await makeTempWorkspace(), "global-config");
    await writeFile(global, "[gc]\n\tauto = 0\n\tpruneExpire = never\n");
    vi.stubEnv("GIT_CONFIG_GLOBAL", global);

    await expectSettingsInOwnConfiguration(fresh, clone);
  });

  test("a fresh workspace and an adopted clone hold both in their own configuration where the command line's configuration holds them too", async () => {
    const source = await makeTempWorkspace();
    await initWorkspace(source, { now: FIXED_NOW });
    const clone = await cloneWorkspace(source);
    const fresh = await makeTempWorkspace();
    vi.stubEnv("GIT_CONFIG_PARAMETERS", "'gc.auto'='0' 'gc.pruneExpire'='never'");

    await expectSettingsInOwnConfiguration(fresh, clone);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "an adoption whose configuration git may not write refuses by name at once, with git's own account",
    async () => {
      const source = await makeTempWorkspace();
      await initWorkspace(source, { now: FIXED_NOW });
      const gitDir = join(await cloneWorkspace(source), MUSAI_DIR);
      await chmod(gitDir, 0o555);

      const refusal = await adoptWorkspace(gitDir)
        .then(
          () => undefined,
          (error: unknown) => error,
        )
        .finally(() => chmod(gitDir, 0o755));

      expect(refusal).toBeInstanceOf(KernelError);
      expect(refusal).toMatchObject({ reason: "workspace-incomplete", about: [gitDir, "gc.auto"] });
      expect((refusal as KernelError).detail).toContain("git refused to write it");
      expect((refusal as KernelError).detail).toContain("Permission denied");
    },
  );
});

describe("what a workspace is, whatever the shell exports", () => {
  test("a fresh workspace takes no template, reference format or object format from a global configuration", async () => {
    const workspace = await makeTempWorkspace();
    const template = await makeTempWorkspace();
    await writeFile(join(template, "template-marker"), "copied from the global configuration's template\n");
    const global = join(await makeTempWorkspace(), "global-config");
    await writeFile(
      global,
      `[init]\n\ttemplateDir = ${template}\n\tdefaultRefFormat = reftable\n\tdefaultObjectFormat = sha256\n`,
    );
    vi.stubEnv("GIT_CONFIG_GLOBAL", global);

    const { gitDir } = await initWorkspace(workspace, { now: FIXED_NOW });
    vi.unstubAllEnvs();

    expect(await readdir(gitDir)).not.toContain("template-marker");
    expect(await ownRefFormat(gitDir)).toBe("files");
    expect(await ownGit(gitDir, ["rev-parse", "--show-object-format"])).toBe("sha1");
  });

  test.skipIf(process.platform === "win32")(
    "a fresh workspace is a sha1 repository holding its seed commit under a git whose own default is sha256",
    async () => {
      const workspace = await makeTempWorkspace();
      const bin = await makeTempWorkspace();
      // A git whose default is sha256, set inside each call past the caller's environment.
      const path = process.env["PATH"] ?? "";
      await writeFile(
        join(bin, "git"),
        `#!/bin/sh\nPATH='${path.replaceAll("'", "'\\''")}' GIT_DEFAULT_HASH=sha256 exec git "$@"\n`,
      );
      await chmod(join(bin, "git"), 0o755);
      vi.stubEnv("PATH", `${bin}${delimiter}${path}`);
      const probe = join(bin, "probe.git");
      await execa("git", ["init", "--quiet", "--bare", probe]);
      expect(await ownGit(probe, ["rev-parse", "--show-object-format"])).toBe("sha256");

      const { gitDir } = await initWorkspace(workspace, { now: FIXED_NOW });
      vi.unstubAllEnvs();

      expect(await ownGit(gitDir, ["rev-parse", "--show-object-format"])).toBe("sha1");
      expect(await ownGit(gitDir, ["cat-file", "-t", "refs/heads/main"])).toBe("commit");
    },
  );

  test("a fresh workspace keeps its references in files where the shell exports another reference format", async () => {
    const workspace = await makeTempWorkspace();
    vi.stubEnv("GIT_DEFAULT_REF_FORMAT", "reftable");

    const { gitDir } = await initWorkspace(workspace, { now: FIXED_NOW });

    expect(await ownRefFormat(gitDir)).toBe("files");
  });

  test("a fresh workspace takes nothing from a template directory the shell names", async () => {
    const workspace = await makeTempWorkspace();
    const template = await makeTempWorkspace();
    await writeFile(join(template, "template-marker"), "copied from the shell's template\n");
    vi.stubEnv("GIT_TEMPLATE_DIR", template);

    const { gitDir } = await initWorkspace(workspace, { now: FIXED_NOW });

    expect(await readdir(gitDir)).not.toContain("template-marker");
  });

  test("a workspace is adopted whatever work tree or bareness the shell names", async () => {
    const source = await makeTempWorkspace();
    await initWorkspace(source, { now: FIXED_NOW });
    const workTree = await makeTempWorkspace();

    for (const [name, value] of [
      ["GIT_WORK_TREE", workTree],
      ["GIT_CONFIG_PARAMETERS", "'core.bare'='false'"],
    ] as const) {
      const gitDir = join(await cloneWorkspace(source), MUSAI_DIR);
      vi.stubEnv(name, value);

      expect(await adoptWorkspace(gitDir)).toBe("adopted");
      vi.unstubAllEnvs();
    }
  });
});

describe("what every git call is handed, whatever the shell exports", () => {
  test.skipIf(process.platform === "win32")(
    "a pinned call reads no system attributes file and stops at a filesystem boundary, and the check for an enclosing ignore crosses one, whatever the shell sets for either",
    async () => {
      const workspace = await makeTempWorkspace();
      const bin = await makeTempWorkspace();
      const log = join(bin, "environments");
      const quoted = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
      // Logs each call's system-attributes and filesystem-crossing variables, then runs git.
      await writeFile(
        join(bin, "git"),
        `#!/bin/sh\nprintf '%s %s\\n' "\${GIT_ATTR_NOSYSTEM-unset}" "\${GIT_DISCOVERY_ACROSS_FILESYSTEM-unset}" >> ${quoted(log)}\nPATH=${quoted(process.env["PATH"] ?? "")} exec git "$@"\n`,
      );
      await chmod(join(bin, "git"), 0o755);
      vi.stubEnv("PATH", `${bin}${delimiter}${process.env["PATH"] ?? ""}`);
      vi.stubEnv("GIT_ATTR_NOSYSTEM", "0");
      vi.stubEnv("GIT_DISCOVERY_ACROSS_FILESYSTEM", "0");

      await initWorkspace(workspace, { now: FIXED_NOW });
      const pinned = (await readFile(log, "utf8")).trim().split("\n");
      await rm(log);
      await gitCheckIgnored(join(workspace, MUSAI_DIR, LOCAL_DIR), workspace);
      const operators = (await readFile(log, "utf8")).trim().split("\n");
      vi.unstubAllEnvs();

      expect(pinned.length).toBeGreaterThan(1);
      expect(new Set(pinned)).toEqual(new Set(["1 unset"]));
      expect(operators).toEqual(["0 1"]);
    },
  );
});
