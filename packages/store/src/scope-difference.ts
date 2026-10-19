import { isSidecarPath, KernelError } from "@musai/records";
import { type GitContext, gitDiffTreeRaw, gitLsTree } from "./git.js";

/** A file to splice into a tree: its path and the blob already in the repository. */
export interface ScopeFile {
  readonly path: string;
  readonly sha: string;
}

const RECORDS_PREFIX = "records/";

/** The record files `from` holds and `to` lacks, with their sidecars, read off a tree diff so the
 * cost follows the change; a path is an id, so differing bytes at one are a corrupt record. */
export async function scopeDifference(ctx: GitContext, from: string, to: string | null): Promise<ScopeFile[]> {
  if (to === null) {
    return (await gitLsTree(ctx, from))
      .filter((entry) => entry.path.startsWith(RECORDS_PREFIX))
      .map((entry) => ({ path: entry.path, sha: entry.sha }));
  }
  const files: ScopeFile[] = [];
  for (const change of await gitDiffTreeRaw(ctx, to, from)) {
    if (!change.path.startsWith(RECORDS_PREFIX) || change.status === "D") {
      continue;
    }
    if (change.status === "A") {
      files.push({ path: change.path, sha: change.sha });
      continue;
    }
    // The target keeps its own signature beside a record both scopes hold.
    if (isSidecarPath(change.path)) {
      continue;
    }
    throw new KernelError({
      reason: "record-corrupted",
      about: [change.path],
      detail: `${change.path} holds different bytes at ${from} and at ${to}, though a record's path is its id`,
    });
  }
  return files;
}
