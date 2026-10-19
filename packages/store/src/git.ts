import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Clock, RecordId } from "@musai/records";
import { isRecordId, KernelError } from "@musai/records";
import { execa } from "execa";

/** Every plumbing call names its repository here, never through the working directory. */
export interface GitContext {
  gitDir: string;
  /** Reads the operator's own configuration, so a bound checkout's measurement agrees with what
   * their `git status` calls clean. */
  operatorConfig?: boolean;
}

export interface TreeEntry {
  mode: "100644" | "040000";
  type: "blob" | "tree";
  sha: string;
  path: string;
}

export interface LsTreeEntry {
  mode: string;
  type: string;
  sha: string;
  path: string;
}

const MUSAI_COMMIT_IDENTITY = {
  name: "Musai Kernel",
  email: "kernel@musai.invalid",
};

/** As `git rev-parse --local-env-vars` lists them; any could point a call at another repository. */
const REPOSITORY_CHANNELS: ReadonlySet<string> = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
]);

/** Variables that let the shell, not the call's arguments, shape what a call makes or answers. */
const REPOSITORY_SHAPERS: ReadonlySet<string> = new Set([
  "GIT_DEFAULT_REF_FORMAT",
  "GIT_TEMPLATE_DIR",
  "GIT_ATTR_SOURCE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_LITERAL_PATHSPECS",
  "GIT_GLOB_PATHSPECS",
  "GIT_NOGLOB_PATHSPECS",
  "GIT_ICASE_PATHSPECS",
  "GIT_REDIRECT_STDIN",
  "GIT_REDIRECT_STDOUT",
  "GIT_REDIRECT_STDERR",
]);

/** The process environment less every channel and shaper. Pinned, it reads no operator or system
 * file: per-user ones point at uncreated paths, as no device name exists on every platform. */
function runEnv(
  configAnchor: string,
  operatorConfig = false,
  extra: Record<string, string> = {},
): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !REPOSITORY_CHANNELS.has(entry[0]) && !REPOSITORY_SHAPERS.has(entry[0]),
    ),
  );
  // Absence and a held lock are told apart by git's words, which a translation would change.
  const located = { ...inherited, LC_ALL: "C" };
  if (operatorConfig) {
    return { ...located, ...extra };
  }
  return {
    ...located,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(configAnchor, "unwritten-global-config"),
    XDG_CONFIG_HOME: join(configAnchor, "unwritten-xdg-config"),
    ...extra,
  };
}

async function runGit(
  ctx: GitContext,
  args: string[],
  options: { input?: string; env?: Record<string, string>; exact?: boolean; cwd?: string } = {},
): Promise<string> {
  // Resolved first: git runs from inside it, where a relative name would point one level deeper.
  const gitDir = resolve(ctx.gitDir);
  const result = await execa("git", ["--git-dir", gitDir, ...args], {
    cwd: options.cwd ?? gitDir,
    env: runEnv(gitDir, ctx.operatorConfig === true, options.env),
    extendEnv: false,
    input: options.input,
    // Content is returned byte for byte; a listing may lose its final newline.
    stripFinalNewline: options.exact !== true,
  });
  return result.stdout;
}

/** Resolved through git, so a nested checkout or a linked worktree's pointer file answers too. A
 * relative `named` is read against `workingDirectory`. */
export async function resolveGitDir(workingDirectory: string, named?: string): Promise<string | null> {
  try {
    const result = await execa(
      "git",
      [...(named === undefined ? [] : ["--git-dir", named]), "rev-parse", "--absolute-git-dir"],
      {
        cwd: workingDirectory,
        env: runEnv(workingDirectory),
        extendEnv: false,
      },
    );
    return result.stdout.trim();
  } catch {
    return null;
  }
}

/** The top level of the working tree holding `directory`, read as the operator's own git reads it;
 * `null` outside any working tree. */
export async function resolveWorkTree(directory: string): Promise<string | null> {
  try {
    const result = await execa("git", ["rev-parse", "--show-toplevel"], {
      cwd: directory,
      env: runEnv(directory, true),
      extendEnv: false,
    });
    return result.stdout.trim();
  } catch {
    return null;
  }
}

/** The first of `HEAD`'s parentless commits in git's oldest-first walk, the same in every clone
 * and fork; `null` before the first commit. */
export async function gitOldestRootCommit(ctx: GitContext): Promise<string | null> {
  try {
    const roots = await runGit(ctx, ["rev-list", "--max-parents=0", "--reverse", "HEAD"]);
    return roots.split("\n")[0]!.trim() || null;
  } catch {
    return null;
  }
}

export async function gitHashObjectBatch(ctx: GitContext, filePaths: string[]): Promise<string[]> {
  if (filePaths.length === 0) {
    return [];
  }
  const stdout = await runGit(ctx, ["hash-object", "-w", "--stdin-paths"], {
    input: `${filePaths.join("\n")}\n`,
  });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function gitMkTree(ctx: GitContext, entries: TreeEntry[]): Promise<string> {
  const stdin = entries.map((entry) => `${entry.mode} ${entry.type} ${entry.sha}\t${entry.path}`).join("\n");
  const stdout = await runGit(ctx, ["mktree"], { input: stdin.length > 0 ? `${stdin}\n` : "" });
  return stdout.trim();
}

/** Every tree needs an entry: `--batch` separates trees by a blank line, so an empty first reads as
 * none. */
export async function gitMkTreeBatch(ctx: GitContext, trees: readonly TreeEntry[][]): Promise<string[]> {
  const stdin = trees
    .map((entries) => entries.map((entry) => `${entry.mode} ${entry.type} ${entry.sha}\t${entry.path}`).join("\n"))
    .join("\n\n");
  const stdout = await runGit(ctx, ["mktree", "--batch"], { input: `${stdin}\n` });
  const ids = stdout.split("\n").filter((line) => line.length > 0);
  if (ids.length !== trees.length) {
    throw new KernelError({
      reason: "tool-unavailable",
      detail: `git mktree --batch answered ${ids.length} tree ids for ${trees.length} trees`,
      about: [ctx.gitDir],
    });
  }
  return ids;
}

/** A declared identity, never the configuration's, so one instant mints one commit. */
export async function gitCommitTree(
  ctx: GitContext,
  treeSha: string,
  parents: string[],
  message: string,
  now: Clock,
): Promise<string> {
  const args = ["commit-tree", treeSha];
  for (const parent of parents) {
    args.push("-p", parent);
  }
  const instant = now();
  // On stdin, since a batch's trailer outgrows argv; completed to a line, as `-m` completes it.
  const stdout = await runGit(ctx, args, {
    input: message.endsWith("\n") ? message : `${message}\n`,
    env: {
      GIT_AUTHOR_NAME: MUSAI_COMMIT_IDENTITY.name,
      GIT_AUTHOR_EMAIL: MUSAI_COMMIT_IDENTITY.email,
      GIT_AUTHOR_DATE: instant,
      GIT_COMMITTER_NAME: MUSAI_COMMIT_IDENTITY.name,
      GIT_COMMITTER_EMAIL: MUSAI_COMMIT_IDENTITY.email,
      GIT_COMMITTER_DATE: instant,
    },
  });
  return stdout.trim();
}

/** A commit object written as given, so its author, dates and message survive a rewrite. */
export async function gitWriteCommitObject(ctx: GitContext, raw: string): Promise<string> {
  return (await runGit(ctx, ["hash-object", "-t", "commit", "-w", "--stdin"], { input: raw })).trim();
}

/** Git's refusals for a ref another writer moved, created or locked. Only a lock's `File exists`
 * counts, since any other lock failure is a fault a retry cannot clear. */
const CONTENDED_REF_REJECTION =
  /cannot lock ref '[^']*': (?:is at [0-9a-f]+ but expected [0-9a-f]+|reference already exists|Unable to create '[^']*\.lock': File exists)/;

/** Matched on the message, since every `cat-file` failure exits alike and only this is absence. */
const ABSENT_PATH_REJECTION = /^fatal: [Pp]ath '.+' does not exist in '.+'$/m;

export function isAbsentPathError(error: unknown): boolean {
  const stderr = subprocessStderr(error);
  return stderr !== undefined && ABSENT_PATH_REJECTION.test(stderr);
}

function subprocessStderr(error: unknown): string | undefined {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = (error as { stderr: unknown }).stderr;
    return typeof stderr === "string" ? stderr : undefined;
  }
  return undefined;
}

/** Bytes that would split or end a field of the `-z` instruction, checked whatever callers do. */
const REF_INSTRUCTION_FORBIDDEN_PATTERN = /[\0\n]/;

function assertRefIsInstructionSafe(ref: string): void {
  if (REF_INSTRUCTION_FORBIDDEN_PATTERN.test(ref)) {
    throw new RangeError(
      `refusing to build a ref-update instruction for ${JSON.stringify(ref)}: it carries a byte that would separate or terminate one of the instruction's own fields`,
    );
  }
}

/** Answers false only for contention git reports; anything else is rethrown, so a bounded retry
 * never mistakes a permanent fault for contention. */
export async function gitUpdateRefCas(
  ctx: GitContext,
  ref: string,
  newSha: string,
  oldSha: string | null,
): Promise<boolean> {
  assertRefIsInstructionSafe(ref);
  const oldValue = oldSha ?? "0000000000000000000000000000000000000000";
  const instruction = `update ${ref}\0${newSha}\0${oldValue}\0`;
  try {
    await runGit(ctx, ["update-ref", "--stdin", "-z"], { input: instruction });
    return true;
  } catch (error) {
    const stderr = subprocessStderr(error);
    if (stderr && CONTENDED_REF_REJECTION.test(stderr)) {
      return false;
    }
    throw error;
  }
}

/** Deletes `ref` only where it still names `oldSha`; false where git reports contention. */
export async function gitDeleteRefCas(ctx: GitContext, ref: string, oldSha: string): Promise<boolean> {
  assertRefIsInstructionSafe(ref);
  try {
    await runGit(ctx, ["update-ref", "--stdin", "-z"], { input: `delete ${ref}\0${oldSha}\0` });
    return true;
  } catch (error) {
    const stderr = subprocessStderr(error);
    if (stderr && CONTENDED_REF_REJECTION.test(stderr)) {
      return false;
    }
    throw error;
  }
}

/** Every ref under `prefix` with the commit it names, in git's ref order. */
export async function gitForEachRef(ctx: GitContext, prefix: string): Promise<{ ref: string; sha: string }[]> {
  const listing = await runGit(ctx, ["for-each-ref", "--format=%(objectname) %(refname)", prefix]);
  return listing
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha, ref] = line.split(" ") as [string, string];
      return { ref, sha };
    });
}

/** An object's content byte for byte, by object id or `<tree-ish>:<path>`. */
export async function gitCatFile(ctx: GitContext, objectSpec: string): Promise<Buffer> {
  const stdout = await runGit(ctx, ["cat-file", "-p", objectSpec], { exact: true });
  return Buffer.from(stdout, "utf8");
}

/** Id, type and content length; the newline after the content is not part of it. */
const BATCH_OBJECT_HEADER = /^[0-9a-f]{40} [a-z]+ (\d+)$/;

/** Follows the spec, exactly as sent, when it resolves to no object. */
const BATCH_MISSING_SUFFIX = " missing";

/** A batch that answered a spec with neither an object nor a missing one, or with nothing. */
export function unansweredBatchSpec(spec: string, because: string): KernelError {
  return new KernelError({
    reason: "tool-unavailable",
    detail: `git cat-file --batch did not answer ${spec}: ${because}`,
    about: [spec],
  });
}

/** Slices each answer by the length its header declares, never by line, since content may hold
 * newlines. */
class BatchAnswerReader {
  private readonly specs: readonly string[];
  private pending: Buffer = Buffer.alloc(0);
  /** `null` while the header is awaited. */
  private declared: number | null = null;
  /** Also the index of the spec the next answer is for. */
  private answered = 0;

  constructor(specs: readonly string[]) {
    this.specs = specs;
  }

  /** `null` for a spec git holds nothing at. */
  *push(chunk: Buffer): Generator<Uint8Array | null, void, undefined> {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    while (this.answered < this.specs.length) {
      if (this.declared === null) {
        const lineEnd = this.pending.indexOf(0x0a);
        if (lineEnd === -1) {
          return;
        }
        const line = this.pending.subarray(0, lineEnd).toString("utf8");
        this.pending = this.pending.subarray(lineEnd + 1);
        const header = BATCH_OBJECT_HEADER.exec(line);
        if (header === null) {
          const spec = this.specs[this.answered]!;
          if (line !== `${spec}${BATCH_MISSING_SUFFIX}`) {
            throw unansweredBatchSpec(
              spec,
              `it printed ${JSON.stringify(line)}, which names neither an object nor a missing one`,
            );
          }
          this.answered += 1;
          yield null;
          continue;
        }
        this.declared = Number(header[1]);
      }
      if (this.pending.length < this.declared + 1) {
        return;
      }
      // Copied, so an answer handed on does not pin the chunk it arrived in.
      const bytes = new Uint8Array(this.pending.subarray(0, this.declared));
      this.pending = this.pending.subarray(this.declared + 1);
      this.declared = null;
      this.answered += 1;
      yield bytes;
    }
  }

  /** Refuses output that ended while a spec still waited on its answer. */
  finish(): void {
    if (this.answered < this.specs.length) {
      throw unansweredBatchSpec(this.specs[this.answered]!, "its output ended first");
    }
  }
}

/** Each spec's bytes in order, `null` for one naming no object. Output is streamed, never
 * collected, so a long history neither fills memory nor deadlocks on the pipe. */
export async function* gitCatFileBatch(
  ctx: GitContext,
  specs: readonly string[],
): AsyncGenerator<Uint8Array | null, void, undefined> {
  if (specs.length === 0) {
    return;
  }
  // Spawned directly, since `runGit`'s string result is not byte-preserving.
  const gitDir = resolve(ctx.gitDir);
  const subprocess = execa("git", ["--git-dir", gitDir, "cat-file", "--batch"], {
    cwd: gitDir,
    env: runEnv(gitDir),
    extendEnv: false,
    input: `${specs.join("\n")}\n`,
    encoding: "buffer",
    // Standard error is kept for the message a failure carries.
    buffer: { stdout: false },
  });
  try {
    const reader = new BatchAnswerReader(specs);
    // Iterated before any await, so the stream stays under this reader's back-pressure.
    for await (const chunk of subprocess.stdout) {
      yield* reader.push(chunk);
    }
    await subprocess;
    reader.finish();
  } finally {
    // Ends the child of a reader that stopped early; a no-op once it has exited.
    subprocess.kill();
    await subprocess.catch(() => undefined);
  }
}

export async function gitLsTree(ctx: GitContext, treeish: string): Promise<LsTreeEntry[]> {
  const stdout = await runGit(ctx, ["ls-tree", "-r", "--full-tree", treeish]);
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [meta, path] = line.split("\t");
      const [mode, type, sha] = meta!.split(" ");
      return { mode: mode!, type: type!, sha: sha!, path: path! };
    });
}

interface TreeBuildNode {
  blobs: Map<string, string>;
  dirs: Map<string, TreeBuildNode>;
}

function insertTreePath(root: TreeBuildNode, path: string, blobSha: string): void {
  const parts = path.split("/");
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const name = parts[i]!;
    let child = node.dirs.get(name);
    if (!child) {
      child = { blobs: new Map(), dirs: new Map() };
      node.dirs.set(name, child);
    }
    node = child;
  }
  node.blobs.set(parts[parts.length - 1]!, blobSha);
}

async function writeTreeBuildNode(ctx: GitContext, node: TreeBuildNode): Promise<string> {
  const entries: TreeEntry[] = [];
  for (const [name, sha] of node.blobs) {
    entries.push({ mode: "100644", type: "blob", sha, path: name });
  }
  for (const [name, child] of node.dirs) {
    const sha = await writeTreeBuildNode(ctx, child);
    entries.push({ mode: "040000", type: "tree", sha, path: name });
  }
  return gitMkTree(ctx, entries);
}

export async function gitBuildTree(ctx: GitContext, files: { path: string; sha: string }[]): Promise<string> {
  const root: TreeBuildNode = { blobs: new Map(), dirs: new Map() };
  for (const file of files) {
    insertTreePath(root, file.path, file.sha);
  }
  return writeTreeBuildNode(ctx, root);
}

/** The object format is pinned to sha1 at `init`. */
const TREE_ENTRY_ID_BYTES = 20;

/** Refuses any entry but a regular file or a directory, since splicing beside it would carry
 * forward a tree this store never made. */
function parseTreeObject(bytes: Uint8Array, dir: string, base: string): TreeEntry[] {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    const nul = buffer.indexOf(0x00, space + 1);
    const idEnd = nul + 1 + TREE_ENTRY_ID_BYTES;
    if (space === -1 || nul === -1 || idEnd > buffer.length) {
      throw new KernelError({
        reason: "record-corrupted",
        detail: `refusing the tree at ${dir === "" ? "the root" : dir} of ${base}: its bytes are not a tree object`,
        about: [base, dir],
      });
    }
    const mode = buffer.toString("utf8", offset, space);
    const name = buffer.toString("utf8", space + 1, nul);
    const sha = buffer.toString("hex", nul + 1, idEnd);
    offset = idEnd;
    if (mode === "40000") {
      entries.push({ mode: "040000", type: "tree", sha, path: name });
    } else if (mode === "100644") {
      entries.push({ mode: "100644", type: "blob", sha, path: name });
    } else {
      throw new KernelError({
        reason: "record-corrupted",
        detail: `refusing the tree at ${dir === "" ? "the root" : dir} of ${base}: it holds ${name} with mode ${mode}, which this store never writes`,
        about: [base, dir === "" ? name : `${dir}/${name}`],
      });
    }
  }
  return entries;
}

/** `dir` is `""` at the root. */
function splitTreePath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? { dir: "", name: path } : { dir: path.slice(0, slash), name: path.slice(slash + 1) };
}

/** `base`'s tree with each file placed at its path, touching only the directories on those paths.
 * It equals `gitBuildTree` over the whole base listing. */
export async function gitSpliceTree(
  ctx: GitContext,
  base: string | null,
  files: readonly { path: string; sha: string }[],
): Promise<string> {
  const dirs = new Map<string, Map<string, TreeEntry>>([["", new Map()]]);
  for (const file of files) {
    let { dir } = splitTreePath(file.path);
    for (;;) {
      if (!dirs.has(dir)) {
        dirs.set(dir, new Map());
      }
      if (dir === "") {
        break;
      }
      dir = splitTreePath(dir).dir;
    }
  }
  const touched = [...dirs.keys()];

  if (base !== null) {
    const answers = gitCatFileBatch(
      ctx,
      touched.map((dir) => (dir === "" ? `${base}^{tree}` : `${base}:${dir}`)),
    );
    let index = 0;
    for await (const answer of answers) {
      const dir = touched[index++]!;
      if (answer !== null) {
        const held = dirs.get(dir)!;
        for (const entry of parseTreeObject(answer, dir, base)) {
          held.set(entry.path, entry);
        }
      }
    }
  }

  for (const file of files) {
    const { dir, name } = splitTreePath(file.path);
    dirs.get(dir)!.set(name, { mode: "100644", type: "blob", sha: file.sha, path: name });
  }

  // Directories at one depth are independent, so each depth is one `mktree --batch`.
  const depthOf = (dir: string) => (dir === "" ? 0 : dir.split("/").length);
  const byDepth = new Map<number, string[]>();
  for (const dir of touched) {
    byDepth.set(depthOf(dir), [...(byDepth.get(depthOf(dir)) ?? []), dir]);
  }
  for (const depth of [...byDepth.keys()].sort((a, b) => b - a).filter((depth) => depth > 0)) {
    const level = byDepth.get(depth)!;
    const shas = await gitMkTreeBatch(
      ctx,
      level.map((dir) => [...dirs.get(dir)!.values()]),
    );
    for (const [index, dir] of level.entries()) {
      const { dir: parent, name } = splitTreePath(dir);
      dirs.get(parent)!.set(name, { mode: "040000", type: "tree", sha: shas[index]!, path: name });
    }
  }
  return gitMkTree(ctx, [...dirs.get("")!.values()]);
}

/** The tree git would commit from `workTree` less each `excluded` path, in a scratch index. A
 * `seed` commit supplies only modes the disk cannot express, as `core.fileMode=false` does. */
export async function gitWorkingTreeTree(
  ctx: GitContext,
  workTree: string,
  indexFile: string,
  seed?: string,
  excluded: readonly string[] = [],
): Promise<string> {
  // Absolute, since git runs from the work tree and would read a relative one from there again.
  const root = resolve(workTree);
  // Run from the work tree, so `add -A` covers all of it.
  const options = { env: { GIT_INDEX_FILE: indexFile }, cwd: root };
  if (seed !== undefined) {
    await runGit(ctx, ["read-tree", seed], options);
  }
  if (excluded.length > 0) {
    await runGit(
      ctx,
      ["--work-tree", root, "rm", "-r", "--cached", "--quiet", "--ignore-unmatch", "--", ...excluded],
      options,
    );
  }
  const pathspecs = excluded.length === 0 ? [] : ["--", ".", ...excluded.map((path) => `:(exclude,literal)${path}`)];
  await runGit(ctx, ["--work-tree", root, "add", "-A", ...pathspecs], options);
  const stdout = await runGit(ctx, ["write-tree"], options);
  return stdout.trim();
}

export interface TreeChange {
  readonly status: string;
  readonly path: string;
  /** The blob at `to`, all zeros where `to` holds none. */
  readonly sha: string;
}

/** Every file whose entry differs from `from` to `to`, with git's one-letter status. */
export async function gitDiffTreeRaw(ctx: GitContext, from: string, to: string): Promise<TreeChange[]> {
  const fields = (await runGit(ctx, ["diff-tree", "-r", "-z", "--raw", "--no-renames", from, to])).split("\0");
  const changes: TreeChange[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [, , , sha, status] = fields[index]!.split(" ") as [string, string, string, string, string];
    changes.push({ status, path: fields[index + 1]!, sha });
  }
  return changes;
}

/** The paths, files only, whose entries differ between two trees. */
export async function gitDiffTreePaths(ctx: GitContext, from: string, to: string): Promise<string[]> {
  const stdout = await runGit(ctx, ["diff-tree", "-r", "-z", "--name-only", from, to]);
  return stdout.split("\0").filter((path) => path.length > 0);
}

export async function gitRevParse(ctx: GitContext, ref: string): Promise<string | null> {
  try {
    const stdout = await runGit(ctx, ["rev-parse", "--verify", ref]);
    return stdout.trim();
  } catch {
    return null;
  }
}

/** `merge-base --is-ancestor` answers 1 for "no" and anything else for a failure; an ancestor the
 * repository no longer holds, as after a rewrite was pruned, is no ancestor. */
export async function gitIsAncestor(ctx: GitContext, ancestor: string, descendant: string): Promise<boolean> {
  if ((await gitRevParse(ctx, `${ancestor}^{commit}`)) === null) {
    return false;
  }
  try {
    await runGit(ctx, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (error) {
    if ((error as { exitCode?: number }).exitCode === 1) {
      return false;
    }
    throw error;
  }
}

/** Loose objects alone: `count-objects` reads no pack, so the count costs one spawn. */
export async function gitLooseObjectCount(ctx: GitContext): Promise<number> {
  return Number.parseInt(await runGit(ctx, ["count-objects"]), 10);
}

/** Packs what refs reach and prunes nothing, so an object a concurrent write has not yet pointed a
 * ref at survives; `false` where another collection holds git's own lock. */
export async function gitPackWithoutPruning(ctx: GitContext): Promise<boolean> {
  try {
    await runGit(ctx, ["gc", "--no-prune", "--quiet"]);
    return true;
  } catch (error) {
    if (/gc is already running/.test((error as { stderr?: string }).stderr ?? "")) {
      return false;
    }
    throw error;
  }
}

/** `false` where git finds no repository to answer for. */
export async function gitIsBareRepository(ctx: GitContext): Promise<boolean> {
  try {
    const stdout = await runGit(ctx, ["rev-parse", "--is-bare-repository"]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/** Pinned to sha1, since the store's plumbing and the events cursor carry forty-hex object ids. */
export async function gitInitBare(gitDir: string): Promise<void> {
  await execa("git", ["init", "--quiet", "--bare", "--object-format=sha1", "--initial-branch", "main", gitDir], {
    env: runEnv(gitDir),
    extendEnv: false,
  });
}

/** Pinned to sha1 like `gitInitBare`, so a tree measured in it is named as the store's are. */
export async function gitInitWorkTree(dir: string): Promise<void> {
  await execa("git", ["init", "--quiet", "--object-format=sha1", "--initial-branch", "main", dir], {
    env: runEnv(dir),
    extendEnv: false,
  });
}

/** The repository's own file alone answers; any failure but the key's absence propagates. */
export async function gitConfigLocalGet(ctx: GitContext, key: string): Promise<string | null> {
  try {
    const stdout = await runGit(ctx, ["config", "--local", "--get", key]);
    return stdout.trim();
  } catch (error) {
    if ((error as { exitCode?: number }).exitCode === 1) {
      return null;
    }
    throw error;
  }
}

/** Every refused write exits 255 alike, so git's C-locale message is what marks a held lock. */
const CONFIG_LOCK_HELD = /^error: could not lock config file .+: File exists$/m;

/** `null` when the write landed. */
export async function gitConfigLocalSet(
  ctx: GitContext,
  key: string,
  value: string,
): Promise<{ readonly lockHeld: boolean; readonly account: string } | null> {
  try {
    await runGit(ctx, ["config", "--local", key, value]);
    return null;
  } catch (error) {
    const account = subprocessStderr(error)?.trim() ?? String(error);
    return { lockHeld: CONFIG_LOCK_HELD.test(account), account };
  }
}

/** The trailer naming a commit's record ids in the order its writer wrote them. */
export const ORDER_TRAILER = "Musai-Order";

/** `blob` is `null` for a path the commit deleted. */
export interface CommitPaths {
  commit: string;
  committedAt: string;
  /** Empty for a commit whose message names no order. */
  order: RecordId[];
  changes: { path: string; blob: string | null }[];
}

/** No raw diff line has this shape, which lets one listing carry both. */
const LOG_COMMIT_HEADER = /^([0-9a-f]{40}) (\d+)\t(.*)$/;

const ORDERED_ID = /sha256:[0-9a-f]{64}/g;

/** From the epoch seconds, since git's own ISO rendering of UTC differs between its versions. */
function instantOf(epochSeconds: string): string {
  return new Date(Number(epochSeconds) * 1000).toISOString();
}

function orderedIds(trailer: string): RecordId[] {
  return Array.from(trailer.matchAll(ORDERED_ID), ([id]) => id).filter((id): id is RecordId => isRecordId(id));
}

/** With `--no-renames`, no status carries a score. */
const LOG_RAW_CHANGE = /^:\d{6} \d{6} [0-9a-f]{40} ([0-9a-f]{40}) ([A-Z])\t(.+)$/;

/** One process for the whole range, oldest first. `--no-renames` makes a rename a deletion and an
 * addition, and an unexpected line is refused rather than read as a path. */
export async function gitLogChanges(ctx: GitContext, from: string | null, to: string): Promise<CommitPaths[]> {
  const range = from ? `${from}..${to}` : to;
  const stdout = await runGit(ctx, [
    "log",
    "--no-show-signature",
    "--reverse",
    "--raw",
    "--no-abbrev",
    "--no-renames",
    `--format=%H %ct%x09%(trailers:key=${ORDER_TRAILER},valueonly,unfold)`,
    "--root",
    range,
  ]);
  const commits: CommitPaths[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    const header = LOG_COMMIT_HEADER.exec(line);
    if (header) {
      commits.push({
        commit: header[1]!,
        committedAt: instantOf(header[2]!),
        order: orderedIds(header[3]!),
        changes: [],
      });
      continue;
    }
    const change = LOG_RAW_CHANGE.exec(line);
    if (change === null) {
      throw new KernelError({
        reason: "tool-unavailable",
        detail: `git log printed ${JSON.stringify(line)}, which is neither a commit nor a raw diff line`,
        about: [range],
      });
    }
    commits[commits.length - 1]!.changes.push({ path: change[3]!, blob: change[2] === "D" ? null : change[1]! });
  }
  return commits;
}

export type EnclosingIgnoreStatus = "ignored" | "not-ignored" | "no-repository";

/** Whether an enclosing working tree's add-everything would stage `path`, asked under the
 * operator's configuration and across filesystems, as that add-everything runs. */
export async function gitCheckIgnored(path: string, from: string = dirname(path)): Promise<EnclosingIgnoreStatus> {
  try {
    await execa("git", ["check-ignore", "--quiet", path], {
      cwd: from,
      env: runEnv(from, true, { GIT_DISCOVERY_ACROSS_FILESYSTEM: "1" }),
      extendEnv: false,
    });
    return "ignored";
  } catch (error) {
    const exitCode = (error as { exitCode?: number }).exitCode;
    return exitCode === 1 ? "not-ignored" : "no-repository";
  }
}

/** `headCommit` is `null` before any commit is checked out; `branch` is `null` when detached. */
export interface WorktreeEntry {
  path: string;
  headCommit: string | null;
  branch: string | null;
  bare: boolean;
}

function parseWorktreeListPorcelain(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: { path?: string; headCommit?: string; branch?: string; bare?: boolean } | null = null;
  const flush = (): void => {
    if (current?.path !== undefined) {
      entries.push({
        path: current.path,
        headCommit: current.headCommit ?? null,
        branch: current.branch ?? null,
        bare: current.bare === true,
      });
    }
    current = null;
  };
  for (const line of stdout.split("\n")) {
    if (line.length === 0) {
      flush();
      continue;
    }
    const spaceIndex = line.indexOf(" ");
    const key = spaceIndex === -1 ? line : line.slice(0, spaceIndex);
    const value = spaceIndex === -1 ? "" : line.slice(spaceIndex + 1);
    current ??= {};
    if (key === "worktree") {
      current.path = value;
    } else if (key === "HEAD") {
      current.headCommit = value;
    } else if (key === "branch") {
      // The porcelain form always prints the full ref.
      current.branch = value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;
    } else if (key === "bare") {
      current.bare = true;
    }
  }
  flush();
  return entries;
}

/** The bare repository itself is one entry, with `bare: true`. */
export async function gitWorktreeList(ctx: GitContext): Promise<WorktreeEntry[]> {
  const stdout = await runGit(ctx, ["worktree", "list", "--porcelain"]);
  return parseWorktreeListPorcelain(stdout);
}

/** Refuses a path already registered or occupied; it only ever adds. */
export async function gitWorktreeAdd(ctx: GitContext, path: string, branch: string, commit: string): Promise<void> {
  await runGit(ctx, ["worktree", "add", "--quiet", "-B", branch, path, commit]);
}

/** Passed explicitly, since this kernel never lets git discover a repository from the cwd. */
async function worktreeGitDir(path: string): Promise<string> {
  const dotGit = (await readFile(join(path, ".git"), "utf8")).trim();
  const match = /^gitdir:\s*(.+)$/.exec(dotGit);
  if (!match) {
    throw new KernelError({
      reason: "invalid-input",
      detail: `${join(path, ".git")} does not name a linked worktree's own git directory`,
      about: [path],
    });
  }
  return match[1]!;
}

/** Resets a registered worktree to `commit`, which `git worktree add` cannot do a second time. */
export async function gitWorktreeForceCheckout(
  ctx: GitContext,
  path: string,
  branch: string,
  commit: string,
): Promise<void> {
  const gitDir = await worktreeGitDir(path);
  await execa(
    "git",
    ["--git-dir", gitDir, "--work-tree", path, "checkout", "--quiet", "--force", "-B", branch, commit],
    {
      cwd: path,
      env: runEnv(ctx.gitDir),
      extendEnv: false,
    },
  );
}

export async function gitWorktreeRemove(ctx: GitContext, path: string): Promise<void> {
  await runGit(ctx, ["worktree", "remove", "--force", path]);
}

export async function gitBranchDelete(ctx: GitContext, branch: string): Promise<void> {
  await runGit(ctx, ["branch", "-D", branch]);
}
