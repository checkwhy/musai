import { hexOfRecordId, isRecordKind, KernelError, type RecordId, rawId, recordPath } from "@musai/records";
import {
  type GitContext,
  gitCatFileBatch,
  gitLogChanges,
  gitLsTree,
  gitRevParse,
  gitSpliceTree,
  gitUpdateRefCas,
  gitWriteCommitObject,
} from "./git.js";
import { scopeRefName } from "./store.js";

/** Where a rewritten scope's one-level history stays, so nothing it held is lost. */
export const ONE_LEVEL_REF_PREFIX = "refs/one-level/scope/";

const ONE_LEVEL_PATH = /^records\/([^/]+)\/([0-9a-f]{2})\/([0-9a-f]{64})\.json(\.sig)?$/;

const TWO_LEVEL_PATH = /^records\/[^/]+\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.json(\.sig)?$/;

/** What a rewrite moved: every commit of the scope once any record moves, else none. */
export interface Relayout {
  readonly commits: number;
  readonly records: number;
}

interface OneLevelRecord {
  readonly id: RecordId;
  readonly path: string;
  readonly sidecar: boolean;
}

function oneLevelRecord(path: string): OneLevelRecord | null {
  const match = ONE_LEVEL_PATH.exec(path);
  if (match === null) {
    return null;
  }
  const [, kind, prefix, hex, sig] = match;
  if (!isRecordKind(kind) || !hex!.startsWith(prefix!)) {
    return null;
  }
  const id = `sha256:${hex}` as RecordId;
  return { id, path: `${recordPath(kind, id)}${sig ?? ""}`, sidecar: sig !== undefined };
}

function refused(path: string, commit: string, because: string): KernelError {
  return new KernelError({
    reason: "record-corrupted",
    detail: `refusing to rewrite the scope: ${path} in ${commit} ${because}, so nothing was rewritten`,
    about: [commit, path],
  });
}

/** A file's rewritten path, refusing one under `records/` in neither layout. */
function relaidPath(path: string, commit: string): string {
  if (!path.startsWith("records/") || TWO_LEVEL_PATH.test(path)) {
    return path;
  }
  const record = oneLevelRecord(path);
  if (record === null) {
    throw refused(path, commit, "is a record path in neither the one-level nor the two-level layout");
  }
  return record.path;
}

export async function oneLevelRecordCount(ctx: GitContext, scope: string): Promise<number> {
  const tip = await gitRevParse(ctx, scopeRefName(scope));
  if (tip === null) {
    return 0;
  }
  const paths = (await gitLogChanges(ctx, null, tip)).flatMap(({ changes }) => changes.map(({ path }) => path));
  return new Set(paths.filter((path) => oneLevelRecord(path)?.sidecar === false)).size;
}

/** Ids are digests of record bytes, which a rewrite never touches; each is checked before any ref
 * moves, and the rewritten tip must list exactly the one-level tip's files at their new paths. */
export async function relayoutScope(
  ctx: GitContext,
  scope: string,
  options: { readonly write: boolean } = { write: true },
): Promise<Relayout> {
  const ref = scopeRefName(scope);
  const tip = await gitRevParse(ctx, ref);
  if (tip === null) {
    return { commits: 0, records: 0 };
  }
  const log = await gitLogChanges(ctx, null, tip);
  const moved = new Map<string, { commit: string; blob: string; id: RecordId }>();
  for (const { commit, changes } of log) {
    for (const { path, blob } of changes) {
      if (blob === null) {
        throw refused(path, commit, "is deleted, which the store never does");
      }
      relaidPath(path, commit);
      const record = oneLevelRecord(path);
      if (record !== null && !record.sidecar && !moved.has(path)) {
        moved.set(path, { commit, blob, id: record.id });
      }
    }
  }
  if (moved.size === 0) {
    return { commits: 0, records: 0 };
  }
  await checkDigests(ctx, moved);
  const relayout = { commits: log.length, records: moved.size };
  if (!options.write) {
    return relayout;
  }

  const raws = gitCatFileBatch(
    ctx,
    log.map(({ commit }) => commit),
  );
  let parent: string | null = null;
  try {
    for (const { commit, changes } of log) {
      const raw = new TextDecoder().decode((await raws.next()).value as Uint8Array);
      const tree = await gitSpliceTree(
        ctx,
        parent,
        changes.map(({ path, blob }) => ({ path: relaidPath(path, commit), sha: blob! })),
      );
      parent = await gitWriteCommitObject(ctx, rewrittenCommit(raw, commit, tree, parent));
    }
  } finally {
    await raws.return();
  }
  await checkTips(ctx, tip, parent!);
  const kept = `${ONE_LEVEL_REF_PREFIX}${scope}`;
  if (!(await gitUpdateRefCas(ctx, kept, tip, null))) {
    throw new KernelError({
      reason: "invalid-input",
      detail: `refusing to move ${ref}: ${kept} already keeps a one-level history, and a rewrite never replaces it`,
      about: [kept],
    });
  }
  if (!(await gitUpdateRefCas(ctx, ref, parent!, tip))) {
    throw new KernelError({
      reason: "head-moved",
      detail: `refusing to move ${ref}: it moved while its history was rewritten; run the rewrite again`,
      about: [ref],
    });
  }
  return relayout;
}

async function checkDigests(
  ctx: GitContext,
  moved: ReadonlyMap<string, { commit: string; blob: string; id: RecordId }>,
): Promise<void> {
  const entries = [...moved];
  let index = 0;
  for await (const bytes of gitCatFileBatch(
    ctx,
    entries.map(([, { blob }]) => blob),
  )) {
    const [path, { commit, id }] = entries[index++]!;
    if (bytes === null || hexOfRecordId(rawId(bytes)) !== hexOfRecordId(id)) {
      throw refused(path, commit, "does not digest to the id its name carries");
    }
  }
}

/** A commit with one parent at most: the store writes no merge, and its log diffs against one. */
function rewrittenCommit(raw: string, commit: string, tree: string, parent: string | null): string {
  const headerEnd = raw.indexOf("\n\n");
  const header = raw.slice(0, headerEnd).split("\n");
  const parents = header.filter((line) => line.startsWith("parent "));
  if (parents.length > 1) {
    throw refused("its parents", commit, "is a merge, which the store never writes");
  }
  const kept = header.filter((line) => !line.startsWith("tree ") && !line.startsWith("parent "));
  return [`tree ${tree}`, ...(parent === null ? [] : [`parent ${parent}`]), ...kept].join("\n") + raw.slice(headerEnd);
}

async function checkTips(ctx: GitContext, before: string, after: string): Promise<void> {
  const listing = (entries: { path: string; sha: string }[]) => entries.map(({ path, sha }) => `${sha} ${path}`).sort();
  const expected = listing(
    (await gitLsTree(ctx, before)).map(({ path, sha }) => ({ path: relaidPath(path, before), sha })),
  );
  const actual = listing(await gitLsTree(ctx, after));
  if (expected.join("\n") !== actual.join("\n")) {
    throw new KernelError({
      reason: "record-corrupted",
      detail: `refusing to move the scope: the rewritten tip ${after} does not hold exactly the files of ${before}`,
      about: [before, after],
    });
  }
}
