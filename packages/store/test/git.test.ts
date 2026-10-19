import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timestamp } from "@musai/records";
import { makeFixtureRepo, ownGit, ownRefFormat } from "@musai/test-support";
import { execa } from "execa";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  gitCatFileBatch,
  gitCheckIgnored,
  gitHashObjectBatch,
  gitInitWorkTree,
  gitMkTree,
  gitRevParse,
  gitWorkingTreeTree,
  resolveGitDir,
} from "../src/git.js";
import { initWorkspace, MUSAI_DIR } from "../src/init.js";

let cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(cleanups.map((cleanup) => cleanup()));
  cleanups = [];
});

async function temporaryDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "musai-git-environment-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** The two ways a shell points git at an operator's per-user files. */
const PERSONAL_FILE_HOMES: ReadonlyArray<{
  readonly reachedBy: string;
  readonly place: (root: string, name: string, content: string) => Promise<void>;
}> = [
  {
    reachedBy: "XDG_CONFIG_HOME",
    place: async (root, name, content) => {
      await mkdir(join(root, "xdg", "git"), { recursive: true });
      await writeFile(join(root, "xdg", "git", name), content);
      vi.stubEnv("XDG_CONFIG_HOME", join(root, "xdg"));
    },
  },
  {
    reachedBy: "HOME",
    place: async (root, name, content) => {
      await mkdir(join(root, "home", ".config", "git"), { recursive: true });
      await writeFile(join(root, "home", ".config", "git", name), content);
      vi.stubEnv("XDG_CONFIG_HOME", undefined);
      vi.stubEnv("HOME", join(root, "home"));
    },
  },
];

describe("what the store's git makes and answers, whatever the shell exports", () => {
  test.skipIf(process.platform === "win32")(
    "git answers in the C locale whatever language the shell speaks, since refusals are read by their words",
    async () => {
      const repo = await makeFixtureRepo("git-locale");
      cleanups.push(() => repo.cleanup());
      const shims = await temporaryDirectory();
      const record = join(shims, "environments");
      await writeFile(
        join(shims, "git"),
        `#!/bin/sh\necho "$LC_ALL" >> ${JSON.stringify(record)}\nPATH="\${PATH#*:}" exec git "$@"\n`,
        { mode: 0o755 },
      );
      vi.stubEnv("PATH", `${shims}:${process.env["PATH"] ?? ""}`);
      vi.stubEnv("LC_ALL", "de_DE.UTF-8");
      vi.stubEnv("LANGUAGE", "de");

      await gitMkTree(repo.ctx, []);
      await gitCheckIgnored(repo.workspace);

      const locales = (await readFile(record, "utf8")).trim().split("\n");
      expect(locales).toEqual(["C", "C"]);
    },
  );

  test("a repository made with a work tree is sha1, keeps its references in files and takes no template, whatever the global configuration and the shell name", async () => {
    const root = await temporaryDirectory();
    const template = join(root, "template");
    await mkdir(template);
    await writeFile(join(template, "template-marker"), "copied from the global configuration's template\n");
    const global = join(root, "global-config");
    await writeFile(
      global,
      `[init]\n\ttemplateDir = ${template}\n\tdefaultRefFormat = reftable\n\tdefaultObjectFormat = sha256\n\tdefaultBranch = trunk\n`,
    );
    vi.stubEnv("GIT_CONFIG_GLOBAL", global);
    vi.stubEnv("GIT_DEFAULT_HASH", "sha256");
    const checkout = join(root, "checkout");

    await gitInitWorkTree(checkout);
    vi.unstubAllEnvs();

    const gitDir = join(checkout, ".git");
    expect(await readdir(gitDir)).not.toContain("template-marker");
    expect(await ownGit(gitDir, ["rev-parse", "--show-object-format"])).toBe("sha1");
    expect(await ownRefFormat(gitDir)).toBe("files");
    expect(await ownGit(gitDir, ["rev-parse", "--is-bare-repository"])).toBe("false");
    expect(await ownGit(gitDir, ["symbolic-ref", "HEAD"])).toBe("refs/heads/main");
  });

  test("the tree a work tree folds to takes no attributes from a source the shell names", async () => {
    const repo = await makeFixtureRepo();
    cleanups.push(repo.cleanup);
    const scratch = await temporaryDirectory();
    const attributes = join(scratch, "attributes");
    await writeFile(attributes, "* text eol=lf\n");
    const [attributesBlob] = await gitHashObjectBatch(repo.ctx, [attributes]);
    const attributesTree = await gitMkTree(repo.ctx, [
      { mode: "100644", type: "blob", sha: attributesBlob!, path: ".gitattributes" },
    ]);
    const workTree = join(scratch, "work-tree");
    await mkdir(workTree);
    await writeFile(join(workTree, "line.txt"), "a line ending in a carriage return\r\n");
    const folded = await gitWorkingTreeTree(repo.ctx, workTree, join(scratch, "index-before"));
    vi.stubEnv("GIT_ATTR_SOURCE", attributesTree);

    expect(await gitWorkingTreeTree(repo.ctx, workTree, join(scratch, "index-after"))).toBe(folded);
  });

  test("a search for the repository a directory belongs to climbs past a ceiling the shell names", async () => {
    const root = await temporaryDirectory();
    const checkout = join(root, "checkout");
    await execa("git", ["init", "--quiet", checkout]);
    const nested = join(checkout, "nested");
    await mkdir(nested);
    const found = await resolveGitDir(nested);
    expect(found).not.toBeNull();
    vi.stubEnv("GIT_CEILING_DIRECTORIES", checkout);

    expect(await resolveGitDir(nested)).toBe(found);
  });

  test("whether its enclosing work tree ignores a path is answered whatever pathspec matching the shell asks for", async () => {
    const root = await temporaryDirectory();
    const checkout = join(root, "checkout");
    await execa("git", ["init", "--quiet", checkout]);
    await writeFile(join(checkout, ".gitignore"), "ignored.txt\n");
    const ignored = join(checkout, "ignored.txt");
    expect(await gitCheckIgnored(ignored)).toBe("ignored");

    for (const name of ["GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS"]) {
      vi.stubEnv(name, "1");
      expect(await gitCheckIgnored(ignored)).toBe("ignored");
      vi.unstubAllEnvs();
    }
  });

  test("the tree a work tree folds to holds a file the operator's own ignore file names", async () => {
    const repo = await makeFixtureRepo();
    cleanups.push(repo.cleanup);

    for (const { reachedBy, place } of PERSONAL_FILE_HOMES) {
      const scratch = await temporaryDirectory();
      const workTree = join(scratch, "work-tree");
      await mkdir(workTree);
      await writeFile(join(workTree, "personal.txt"), "a file a personal ignore names\n");
      await place(scratch, "ignore", "personal.txt\n");

      const tree = await gitWorkingTreeTree(repo.ctx, workTree, join(scratch, "index"));
      vi.unstubAllEnvs();

      expect({ reachedBy, names: await ownGit(repo.ctx.gitDir, ["ls-tree", "--name-only", tree]) }).toEqual({
        reachedBy,
        names: "personal.txt",
      });
    }
  });

  test("the blob a file is written as takes no attributes from the operator's own attributes file", async () => {
    const repo = await makeFixtureRepo();
    cleanups.push(repo.cleanup);

    for (const { reachedBy, place } of PERSONAL_FILE_HOMES) {
      const scratch = await temporaryDirectory();
      const file = join(scratch, "line.txt");
      await writeFile(file, "a line ending in a carriage return\r\n");
      const raw = await ownGit(repo.ctx.gitDir, ["hash-object", "--no-filters", file]);
      await place(scratch, "attributes", "* text eol=lf\n");

      const [blob] = await gitHashObjectBatch(repo.ctx, [file]);
      vi.unstubAllEnvs();

      expect({ reachedBy, blob }).toEqual({ reachedBy, blob: raw });
    }
  });
});

describe("a git dir named relative to the process's working directory", () => {
  test("reads the refs and objects its absolute path reads, though git runs from inside it", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "musai-relative-git-dir-"));
    const before = process.cwd();
    try {
      const { gitDir } = await initWorkspace(workspace, { now: () => timestamp("2026-10-08T00:00:00.000Z") });
      const main = await gitRevParse({ gitDir }, "refs/heads/main");
      expect(main).not.toBeNull();
      process.chdir(workspace);
      const named = { gitDir: MUSAI_DIR };

      expect(await gitRevParse(named, "refs/heads/main")).toBe(main);
      const batched: (Uint8Array | null)[] = [];
      for await (const bytes of gitCatFileBatch(named, [`${main}:config.json`])) {
        batched.push(bytes);
      }
      expect(batched[0]).not.toBeNull();
    } finally {
      process.chdir(before);
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
