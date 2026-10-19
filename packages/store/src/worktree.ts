import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Clock } from "@musai/records";
import { KernelError } from "@musai/records";
import {
  type GitContext,
  gitBranchDelete,
  gitBuildTree,
  gitCommitTree,
  gitHashObjectBatch,
  gitRevParse,
  gitWorktreeAdd,
  gitWorktreeForceCheckout,
  gitWorktreeList,
  gitWorktreeRemove,
} from "./git.js";
import { LOCAL_DIR } from "./init.js";

/** View branches are derived and disposable like the index, and never pushed. */
export const VIEW_BRANCH_PREFIX = "view/";

/** One checkout per open case. */
export const OPEN_DIR = `${LOCAL_DIR}/open`;

function openDirPath(ctx: GitContext): string {
  return join(ctx.gitDir, OPEN_DIR);
}

/** Resolves symlinks through the deepest existing ancestor: git reports paths resolved, and a
 * system temporary directory is a symlink on some platforms. */
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    if (parent === path) {
      return resolve(path);
    }
    return join(await canonical(parent), basename(path));
  }
}

function branchFor(slug: string): string {
  return `${VIEW_BRANCH_PREFIX}${slug}`;
}

function slugFromBranch(branch: string): string | null {
  return branch.startsWith(VIEW_BRANCH_PREFIX) ? branch.slice(VIEW_BRANCH_PREFIX.length) : null;
}

/** The author's own checkouts and branches are never this module's to touch. */
export class WorktreeBoundaryError extends KernelError {
  constructor(what: "path" | "branch" | "slug", value: string, boundary: string) {
    super({
      reason: "invalid-input",
      detail: `refusing to touch ${what} ${JSON.stringify(value)}: it is outside ${boundary}`,
      about: [value],
    });
    this.name = "WorktreeBoundaryError";
  }
}

/** Refuses a slug that could escape the open directory once joined onto it as a path segment. */
export function assertSafeSlugSegment(slug: string): void {
  // Windows drops trailing dots and spaces from a name, so `".. "` is the parent directory there.
  const asCreated = slug.replace(/[. ]+$/u, "");
  if (asCreated.length === 0 || /[/\\]/.test(slug) || slug.includes("\0")) {
    throw new WorktreeBoundaryError("slug", slug, "a single, real path segment under the open directory");
  }
}

async function assertUnderOpenDir(ctx: GitContext, path: string): Promise<void> {
  const dir = await canonical(openDirPath(ctx));
  const target = await canonical(path);
  if (target !== dir && !target.startsWith(dir + sep)) {
    throw new WorktreeBoundaryError("path", path, `the workspace's own local open directory (${dir})`);
  }
}

function assertViewBranch(branch: string): void {
  if (slugFromBranch(branch) === null) {
    throw new WorktreeBoundaryError("branch", branch, `the ${VIEW_BRANCH_PREFIX} namespace`);
  }
}

/** `path` is relative to the checkout's root. */
export interface ViewTreeFile {
  path: string;
  content: Uint8Array;
}

/** `stale` when the case the slug names no longer exists. */
export interface ViewWorktree {
  slug: string;
  branch: string;
  path: string;
  headCommit: string;
  stale: boolean;
}

/** The commit a view branch should hold, reusing its tip when the tree is unchanged so two renders
 * agree. It never moves the branch; the checkout does. */
export async function mintViewCommit(
  ctx: GitContext,
  branch: string,
  files: readonly ViewTreeFile[],
  now: Clock,
): Promise<string> {
  const currentTip = await gitRevParse(ctx, `refs/heads/${branch}`);

  const tmpDir = await mkdtemp(join(tmpdir(), "musai-view-"));
  let newTreeSha: string;
  try {
    const filePaths = await Promise.all(
      files.map(async (file, index) => {
        const filePath = join(tmpDir, `${index}`);
        await writeFile(filePath, file.content);
        return filePath;
      }),
    );
    const blobShas = await gitHashObjectBatch(ctx, filePaths);
    newTreeSha = await gitBuildTree(
      ctx,
      files.map((file, index) => ({ path: file.path, sha: blobShas[index]! })),
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  if (currentTip !== null) {
    const oldTreeSha = await gitRevParse(ctx, `${currentTip}^{tree}`);
    if (oldTreeSha === newTreeSha) {
      return currentTip;
    }
  }

  const parents = currentTip ? [currentTip] : [];
  return gitCommitTree(ctx, newTreeSha, parents, `render view for ${branch}\n`, now);
}

/** Only drafts stay writable, so an edit to a derived file fails before `save` would refuse it. */
async function applyFileModes(path: string, editablePaths: ReadonlySet<string>): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const absolute = join(entry.parentPath, entry.name);
    const relative = absolute
      .slice(path.length + 1)
      .split(sep)
      .join("/");
    if (relative === ".git" || relative.startsWith(".git/")) {
      continue;
    }
    await chmod(absolute, editablePaths.has(relative) ? 0o644 : 0o444);
  }
}

/** An interrupted materialisation leaves a directory every later `git worktree add` refuses. */
async function clearStrayPath(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/** Checks one case's files out into its own worktree, force-resetting one already registered; only
 * `editablePaths` keep their write bit. */
export async function materialiseView(
  ctx: GitContext,
  slug: string,
  files: readonly ViewTreeFile[],
  editablePaths: ReadonlySet<string>,
  now: Clock,
): Promise<ViewWorktree> {
  assertSafeSlugSegment(slug);
  const branch = branchFor(slug);
  const path = join(openDirPath(ctx), slug);
  const commit = await mintViewCommit(ctx, branch, files, now);

  const canonicalPath = await canonical(path);
  const existing = await gitWorktreeList(ctx);
  const registeredEntries = await Promise.all(
    existing.map(async (entry) => ({ entry, canonicalPath: await canonical(entry.path) })),
  );
  const registered = registeredEntries.some((row) => row.canonicalPath === canonicalPath);
  if (registered) {
    await gitWorktreeForceCheckout(ctx, path, branch, commit);
  } else {
    await clearStrayPath(path);
    await mkdir(dirname(path), { recursive: true });
    await gitWorktreeAdd(ctx, path, branch, commit);
  }

  await applyFileModes(path, editablePaths);

  return { slug, branch, path, headCommit: commit, stale: false };
}

/** Worktrees under the open directory on view branches, `stale` when absent from `liveSlugs`. */
export async function listViewWorktrees(ctx: GitContext, liveSlugs: ReadonlySet<string>): Promise<ViewWorktree[]> {
  const dir = await canonical(openDirPath(ctx));
  const entries = await gitWorktreeList(ctx);

  const result: ViewWorktree[] = [];
  for (const entry of entries) {
    if (entry.bare || entry.branch === null) {
      continue;
    }
    const entryPath = await canonical(entry.path);
    if (entryPath !== dir && !entryPath.startsWith(dir + sep)) {
      continue;
    }
    const slug = slugFromBranch(entry.branch);
    if (slug === null) {
      continue;
    }
    result.push({
      slug,
      branch: entry.branch,
      path: entry.path,
      headCommit: entry.headCommit ?? "",
      stale: !liveSlugs.has(slug),
    });
  }
  return result;
}

/** Removes one owned worktree and its branch, refusing anything outside before touching either. */
export async function removeViewWorktree(
  ctx: GitContext,
  worktree: Pick<ViewWorktree, "path" | "branch">,
): Promise<void> {
  await assertUnderOpenDir(ctx, worktree.path);
  assertViewBranch(worktree.branch);
  await gitWorktreeRemove(ctx, worktree.path);
  await gitBranchDelete(ctx, worktree.branch);
}
