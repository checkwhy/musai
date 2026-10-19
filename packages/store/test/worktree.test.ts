import { readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type FixtureRepo, makeFixtureRepo } from "@musai/test-support";
import { afterEach, describe, expect, test } from "vitest";
import {
  assertSafeSlugSegment,
  listViewWorktrees,
  materialiseView,
  OPEN_DIR,
  removeViewWorktree,
  VIEW_BRANCH_PREFIX,
  type ViewTreeFile,
  WorktreeBoundaryError,
} from "../src/worktree.js";

const HERE = dirname(fileURLToPath(import.meta.url));

let repos: FixtureRepo[] = [];

afterEach(async () => {
  await Promise.all(repos.map((repo) => repo.cleanup()));
  repos = [];
});

async function newRepo(): Promise<FixtureRepo> {
  const repo = await makeFixtureRepo();
  repos.push(repo);
  return repo;
}

function dossierAndDraft(dossierText: string, draftText: string): ViewTreeFile[] {
  return [
    { path: "dossier.md", content: new TextEncoder().encode(dossierText) },
    { path: "drafts/draft.md", content: new TextEncoder().encode(draftText) },
  ];
}

describe("materialiseView", () => {
  test("a second materialisation at one head yields the same commit and the same file bytes", async () => {
    const repo = await newRepo();
    const files = dossierAndDraft("# a case\n", "some prose\n");

    const first = await materialiseView(repo.ctx, "a-case", files, new Set(["drafts/draft.md"]), repo.now);
    const second = await materialiseView(repo.ctx, "a-case", files, new Set(["drafts/draft.md"]), repo.now);

    expect(second.headCommit).toBe(first.headCommit);
    expect(second.path).toBe(first.path);
    await expect(readFile(join(second.path, "dossier.md"), "utf8")).resolves.toBe("# a case\n");
    await expect(readFile(join(second.path, "drafts/draft.md"), "utf8")).resolves.toBe("some prose\n");
  });

  test("materialising again with changed content resets the worktree to the new bytes, at a new commit", async () => {
    const repo = await newRepo();
    const first = await materialiseView(
      repo.ctx,
      "a-case",
      dossierAndDraft("# v1\n", "prose\n"),
      new Set(["drafts/draft.md"]),
      repo.now,
    );
    const second = await materialiseView(
      repo.ctx,
      "a-case",
      dossierAndDraft("# v2\n", "prose\n"),
      new Set(["drafts/draft.md"]),
      repo.now,
    );

    expect(second.headCommit).not.toBe(first.headCommit);
    await expect(readFile(join(second.path, "dossier.md"), "utf8")).resolves.toBe("# v2\n");
  });

  test("every non-draft file in the materialised tree has no write bit, and every draft does", async () => {
    const repo = await newRepo();
    const files: ViewTreeFile[] = [
      { path: "dossier.md", content: new TextEncoder().encode("# a case\n") },
      { path: "artifacts/abc.md", content: new TextEncoder().encode("history\n") },
      { path: "drafts/draft.md", content: new TextEncoder().encode("prose\n") },
    ];
    const worktree = await materialiseView(repo.ctx, "a-case", files, new Set(["drafts/draft.md"]), repo.now);

    const dossierMode = (await stat(join(worktree.path, "dossier.md"))).mode & 0o777;
    const artifactMode = (await stat(join(worktree.path, "artifacts/abc.md"))).mode & 0o777;
    const draftMode = (await stat(join(worktree.path, "drafts/draft.md"))).mode & 0o777;

    expect(dossierMode & 0o222).toBe(0);
    expect(artifactMode & 0o222).toBe(0);
    expect(draftMode & 0o222).not.toBe(0);
  });

  test("an interrupted materialisation leaves a worktree listViewWorktrees reports as stale rather than one that reads as live", async () => {
    const repo = await newRepo();
    // A slug no live case names, as an interrupted materialisation leaves behind.
    await materialiseView(repo.ctx, "orphan-case", dossierAndDraft("# orphan\n", "prose\n"), new Set(), repo.now);

    const worktrees = await listViewWorktrees(repo.ctx, new Set<string>());

    const orphan = worktrees.find((entry) => entry.slug === "orphan-case");
    expect(orphan).toBeDefined();
    expect(orphan!.stale).toBe(true);
  });
});

describe("listViewWorktrees", () => {
  test("returns nothing for a worktree the author created outside the open directory", async () => {
    const repo = await newRepo();

    // Under the author's own directory, on a branch this module would never name.
    const outsidePath = join(dirname(repo.workspace), `author-owned-${Date.now()}`);
    const { gitWorktreeAdd, gitCommitTree, gitHashObjectBatch, gitBuildTree } = await import("../src/git.js");
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const tmpDir = await mkdtemp(join(tmpdir(), "musai-outside-"));
    const filePath = join(tmpDir, "0");
    await writeFile(filePath, "hello\n");
    const [sha] = await gitHashObjectBatch(repo.ctx, [filePath]);
    const tree = await gitBuildTree(repo.ctx, [{ path: "readme.md", sha: sha! }]);
    const commit = await gitCommitTree(repo.ctx, tree, [], "author's own commit\n", repo.now);
    await gitWorktreeAdd(repo.ctx, outsidePath, "author/own-branch", commit);
    await rm(tmpDir, { recursive: true, force: true });

    try {
      const worktrees = await listViewWorktrees(repo.ctx, new Set<string>());
      expect(worktrees.find((entry) => entry.branch === "author/own-branch")).toBeUndefined();
    } finally {
      const { gitWorktreeRemove } = await import("../src/git.js");
      await gitWorktreeRemove(repo.ctx, outsidePath);
    }
  });
});

describe("removeViewWorktree", () => {
  test("refuses a path outside the open directory, by name", async () => {
    const repo = await newRepo();
    await expect(
      removeViewWorktree(repo.ctx, {
        path: join(repo.workspace, "not-the-open-dir"),
        branch: `${VIEW_BRANCH_PREFIX}a-case`,
      }),
    ).rejects.toThrow(WorktreeBoundaryError);
  });

  test("refuses a branch outside the view prefix, by name", async () => {
    const repo = await newRepo();
    const worktree = await materialiseView(
      repo.ctx,
      "a-case",
      dossierAndDraft("# a case\n", "prose\n"),
      new Set(),
      repo.now,
    );
    await expect(removeViewWorktree(repo.ctx, { path: worktree.path, branch: "not-a-view-branch" })).rejects.toThrow(
      WorktreeBoundaryError,
    );
  });

  test("removes exactly the named worktree and its branch", async () => {
    const repo = await newRepo();
    const worktree = await materialiseView(
      repo.ctx,
      "a-case",
      dossierAndDraft("# a case\n", "prose\n"),
      new Set(),
      repo.now,
    );
    await removeViewWorktree(repo.ctx, worktree);

    const worktrees = await listViewWorktrees(repo.ctx, new Set(["a-case"]));
    expect(worktrees.find((entry) => entry.slug === "a-case")).toBeUndefined();
  });
});

describe("no code path in this module pushes anywhere", () => {
  test("the module's own source names no push command and no remote", async () => {
    const source = await readFile(join(HERE, "..", "src", "worktree.ts"), "utf8");
    expect(source).not.toMatch(/["'`]push["'`]/);
    expect(source.toLowerCase()).not.toContain("remote");
  });
});

describe("assertSafeSlugSegment", () => {
  test("refuses a slug that would climb out of the open directory once joined onto it", () => {
    for (const bad of ["../elsewhere", "a/../../etc", "a/b", "a\\b", "", ".", ".."]) {
      expect(() => assertSafeSlugSegment(bad)).toThrow(WorktreeBoundaryError);
    }
  });

  test("refuses a slug whose trailing dots and spaces a filesystem would strip back into a climb", () => {
    // Windows strips trailing dots and spaces, so each of these names the parent once created.
    for (const bad of [".. ", "..  ", "...", ". ", ".. . ", "  ", " .."]) {
      expect(() => assertSafeSlugSegment(bad), bad).toThrow(WorktreeBoundaryError);
    }
  });

  test("accepts an ordinary slug whose trailing punctuation still leaves a real name", () => {
    for (const good of ["v1.", "release-1.0", "a case", ".git", "a.b"]) {
      expect(() => assertSafeSlugSegment(good), good).not.toThrow();
    }
  });

  test("materialiseView refuses a case slug carrying a path separator, before touching any git command", async () => {
    const repo = await newRepo();
    await expect(
      materialiseView(repo.ctx, "../escape", dossierAndDraft("# x\n", "y\n"), new Set(), repo.now),
    ).rejects.toThrow(WorktreeBoundaryError);
  });

  test("accepts an ordinary slug", () => {
    expect(() => assertSafeSlugSegment("a-real-slug")).not.toThrow();
  });
});

describe("OPEN_DIR", () => {
  test("names the workspace's own local open directory", async () => {
    expect(OPEN_DIR).toBe("local/open");
    const repo = await newRepo();
    const worktree = await materialiseView(
      repo.ctx,
      "a-case",
      dossierAndDraft("# a case\n", "prose\n"),
      new Set(),
      repo.now,
    );
    expect(worktree.path).toBe(join(repo.ctx.gitDir, OPEN_DIR, "a-case"));
    const openDirEntries = await readdir(join(repo.ctx.gitDir, OPEN_DIR));
    expect(openDirEntries).toContain("a-case");
  });
});
