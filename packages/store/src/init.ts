import type { Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import type { Clock, RecordId } from "@musai/records";
import { hexOfRecordId, KernelError, rawId } from "@musai/records";
import {
  type GitContext,
  gitCommitTree,
  gitConfigLocalGet,
  gitConfigLocalSet,
  gitHashObjectBatch,
  gitInitBare,
  gitIsBareRepository,
  gitMkTree,
  gitRevParse,
  gitUpdateRefCas,
  type TreeEntry,
} from "./git.js";

export const MUSAI_DIR = ".musai";

/** Holds the index and the workspace key; a bare repository has no work tree to track it from. */
export const LOCAL_DIR = "local";

/** Under `local/`, the MCP sessions' call logs: disposable, and never a record. */
export const CALL_LOG_DIR = "calls";

/** One level below `local/`, so no scope name collides with the workspace's own files there. */
const SCOPES_DIR = "scopes";

export function scopeLocalDir(gitDir: string, scope: string): string {
  return join(gitDir, LOCAL_DIR, SCOPES_DIR, scope);
}

/** One fold file per scope, so rebuilding one never touches another's. The caller creates its
 * parent directories, since no engine does. */
export function scopeIndexPath(gitDir: string, scope: string): string {
  return join(scopeLocalDir(gitDir, scope), "index.sqlite");
}

/** Named by the audience's digest, since a key or identity audience is no portable file name. */
export function scopeClearedIndexPath(gitDir: string, scope: string, audience: string): string {
  const name = hexOfRecordId(rawId(new TextEncoder().encode(audience)));
  return join(scopeLocalDir(gitDir, scope), "cleared", `${name}.sqlite`);
}

/** Beside the fold, never in it: what an allowed-signers file grants is not in the log. Named by
 * that file's digest, so a process reading two trust commits keeps both caches. */
export function scopeVerificationCachePath(gitDir: string, scope: string, allowedSigners: RecordId): string {
  return join(scopeLocalDir(gitDir, scope), `attestation-verification-${hexOfRecordId(allowedSigners)}.json`);
}

/** Seeded on `main` so the empty-files default has files to be empty. */
const SEEDED_FILES: Record<string, string> = {
  "config.json": "{}\n",
  "allowed-signers": "",
  roles: "",
  audiences: "peer\nknown includes peer\n",
};

/** Read by an enclosing working tree, so its add-everything stages no fold, key or cached blob. */
const LOCAL_IGNORE: readonly [name: string, content: string] = [".gitignore", `${LOCAL_DIR}/\n`];

/** A file the operator already wrote there is theirs, and stays. */
async function ignoreLocalDir(gitDir: string): Promise<void> {
  try {
    await writeFile(join(gitDir, LOCAL_IGNORE[0]), LOCAL_IGNORE[1], { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
}

export interface WorkspaceInit {
  gitDir: string;
  localDir: string;
  created: boolean;
}

/** A bare repository with no `main` is no workspace: init moves one into place only once seeded. */
async function isBareMusaiRepository(gitDir: string): Promise<boolean> {
  const ctx: GitContext = { gitDir };
  return (await gitIsBareRepository(ctx)) && (await gitRevParse(ctx, "refs/heads/main")) !== null;
}

/** Objects are written before a ref points at them, so no collection may prune them mid-write. */
const COLLECTION_SETTINGS: ReadonlyArray<readonly [key: string, value: string]> = [
  ["gc.auto", "0"],
  ["gc.pruneExpire", "never"],
];

const SETTING_WRITE_ATTEMPTS = 5;

const SETTING_RETRY_MS = 50;

/** Git refuses a configuration write while another writer holds the lock, so each key is read
 * before every write and a lock refusal is retried. */
async function setCollectionSettings(gitDir: string): Promise<void> {
  const ctx: GitContext = { gitDir };
  for (const [key, value] of COLLECTION_SETTINGS) {
    let lockHeldBy = "";
    for (let written = 0; ; written++) {
      if ((await gitConfigLocalGet(ctx, key)) === value) {
        break;
      }
      if (written === SETTING_WRITE_ATTEMPTS) {
        throw new KernelError({
          reason: "workspace-incomplete",
          detail: `the workspace at ${gitDir} does not hold ${key} ${value}, which its compare-and-swap writes rely on, and ${SETTING_WRITE_ATTEMPTS} writes of it were refused while another writer held the configuration's lock: ${lockHeldBy}`,
          about: [gitDir, key],
        });
      }
      const refused = await gitConfigLocalSet(ctx, key, value);
      if (refused === null) {
        break;
      }
      if (!refused.lockHeld) {
        throw new KernelError({
          reason: "workspace-incomplete",
          detail: `the workspace at ${gitDir} does not hold ${key} ${value}, which its compare-and-swap writes rely on, and git refused to write it: ${refused.account}`,
          about: [gitDir, key],
        });
      }
      lockHeldBy = refused.account;
      await wait(SETTING_RETRY_MS);
    }
  }
}

export type WorkspaceAdoption = "adopted" | "absent" | "foreign";

/** Gives a workspace what a clone arrives without; nothing is written unless `gitDir` is a bare
 * repository holding `main`. */
export async function adoptWorkspace(gitDir: string): Promise<WorkspaceAdoption> {
  if (await isBareMusaiRepository(gitDir)) {
    // Settings precede `local/`, so an adoption that made `local/` has written them.
    await setCollectionSettings(gitDir);
    const localDir = join(gitDir, LOCAL_DIR);
    try {
      await mkdir(localDir, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      throw new KernelError({
        reason: "workspace-incomplete",
        detail: `the workspace at ${gitDir} keeps this machine's index and key in the directory ${localDir}, and a file stands there; move it and the workspace is adopted`,
        about: [localDir],
      });
    }
    await ignoreLocalDir(gitDir);
    return "adopted";
  }
  return (await workspaceAbsent(gitDir)) ? "absent" : "foreign";
}

/** Nothing stands at `gitDir` for `initWorkspace` to refuse; reads, and writes nothing. */
export async function workspaceAbsent(gitDir: string): Promise<boolean> {
  try {
    return (await readdir(gitDir)).length === 0;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return true;
    }
    if (code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
}

const HOLDER_PREFIX = `${MUSAI_DIR}-init-`;

/** `mkdtemp` appends six characters drawn from these. */
const HOLDER_SUFFIX = /^[A-Za-z0-9]{6}$/;

/** Written before the workspace it holds, so a holder an init killed mid-build leaves is one an
 * enclosing working tree stages nothing from. */
const HOLDER_IGNORE: readonly [name: string, content: string] = [".gitignore", "*\n"];

/** The holders beside `<dir>/.musai` an init left: one killed outright never removes its own. */
export async function initHolders(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name.startsWith(HOLDER_PREFIX) &&
        HOLDER_SUFFIX.test(entry.name.slice(HOLDER_PREFIX.length)),
    )
    .map((entry) => join(dir, entry.name))
    .sort();
}

/** Creates `<dir>/.musai` with a seeded `main`, or adopts the workspace there, a racing init's
 * included. Anything else at that path is refused, and a failed init leaves no `.musai`. */
export async function initWorkspace(dir: string, options: { now: Clock }): Promise<WorkspaceInit> {
  const workspaceDir = resolve(dir);
  const gitDir = join(workspaceDir, MUSAI_DIR);
  const localDir = join(gitDir, LOCAL_DIR);

  const found = await adoptWorkspace(gitDir);
  if (found === "adopted") {
    return { gitDir, localDir, created: false };
  }
  if (found === "foreign") {
    throw new KernelError({
      reason: "invalid-input",
      detail: `refusing to initialise a workspace at ${gitDir}: it already holds content this call did not create`,
      about: [gitDir],
    });
  }

  await mkdir(workspaceDir, { recursive: true });
  // A sibling, so the rename is atomic; `mkdir` inside it, as `mkdtemp`'s mode is owner-only.
  const holder = await mkdtemp(join(workspaceDir, HOLDER_PREFIX));
  const staging = join(holder, MUSAI_DIR);
  let created: boolean;
  try {
    await writeFile(join(holder, HOLDER_IGNORE[0]), HOLDER_IGNORE[1]);
    await mkdir(staging);
    await gitInitBare(staging);
    await setCollectionSettings(staging);
    await seedMain({ gitDir: staging }, options.now);
    await mkdir(join(staging, LOCAL_DIR));
    await ignoreLocalDir(staging);
    created = await moveIntoPlace(staging, gitDir);
  } finally {
    await rm(holder, { recursive: true, force: true });
  }

  return { gitDir, localDir, created };
}

/** An `rmdir` that finds the path gone or occupied leaves the rename to decide. */
const OCCUPIED_OR_ABSENT: ReadonlySet<string> = new Set(["ENOENT", "ENOTEMPTY", "EEXIST", "ENOTDIR"]);

/** An empty `.musai` is removed first: POSIX renames onto an empty directory, Windows onto none.
 * Answers false where a racing init's workspace landed first, which is adopted instead. */
async function moveIntoPlace(staging: string, gitDir: string): Promise<boolean> {
  try {
    await rmdir(gitDir);
  } catch (error) {
    if (!OCCUPIED_OR_ABSENT.has((error as NodeJS.ErrnoException).code ?? "")) {
      throw error;
    }
  }
  try {
    await rename(staging, gitDir);
    return true;
  } catch (error) {
    const occupant = await lstat(gitDir).catch(() => null);
    if (occupant === null) {
      throw error;
    }
    const adoption = await adoptWorkspace(gitDir);
    if (adoption === "adopted") {
      return false;
    }
    throw new KernelError({
      reason: "invalid-input",
      detail: `refusing to initialise a workspace at ${gitDir}: ${occupantKind(occupant, adoption)} was put there while this call built the workspace`,
      about: [gitDir],
      cause: error,
    });
  }
}

function occupantKind(occupant: Stats, adoption: WorkspaceAdoption): string {
  if (occupant.isSymbolicLink()) {
    return "a symbolic link";
  }
  if (occupant.isFile()) {
    return "a file";
  }
  if (!occupant.isDirectory()) {
    return "something that is neither a file nor a directory";
  }
  return adoption === "absent" ? "an empty directory" : "a directory that is not a workspace";
}

async function seedMain(ctx: GitContext, now: Clock): Promise<void> {
  const tmpDir = await mkdtemp(join(tmpdir(), "musai-init-"));
  try {
    const names = Object.keys(SEEDED_FILES);
    const filePaths = await Promise.all(
      names.map(async (name) => {
        const filePath = join(tmpDir, name);
        await writeFile(filePath, SEEDED_FILES[name]!);
        return filePath;
      }),
    );

    const blobShas = await gitHashObjectBatch(ctx, filePaths);
    const entries: TreeEntry[] = names.map((name, index) => ({
      mode: "100644",
      type: "blob",
      sha: blobShas[index]!,
      path: name,
    }));

    const treeSha = await gitMkTree(ctx, entries);
    const commitSha = await gitCommitTree(ctx, treeSha, [], "seed workspace configuration\n", now);
    // The repository is unpublished, so no other writer contends for `main`.
    await gitUpdateRefCas(ctx, "refs/heads/main", commitSha, null);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
