import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Audience, Clock, RecordKind } from "@musai/records";
import {
  blobThreshold,
  type ClaimTypes,
  canonicalBytes,
  exceedsBlobThreshold,
  idFromPath,
  isSidecarPath,
  KernelError,
  kindFromPath,
  type MusaiRecord,
  NO_CLAIM_TYPES,
  RECORD_KINDS,
  type RecordId,
  rawId,
  readArrivingRecord,
  readStoredRecord,
  recordId,
  recordPath,
  referencesOf,
  sidecarPath,
  validateRecord,
} from "@musai/records";
import { readWorkspaceConfig, type WorkspaceConfig } from "./config.js";
import {
  type CommitPaths,
  type GitContext,
  gitCatFile,
  gitCatFileBatch,
  gitCommitTree,
  gitHashObjectBatch,
  gitIsAncestor,
  gitLogChanges,
  gitLooseObjectCount,
  gitLsTree,
  gitPackWithoutPruning,
  gitRevParse,
  gitSpliceTree,
  isAbsentPathError,
  ORDER_TRAILER,
  unansweredBatchSpec,
} from "./git.js";
import { LOCAL_DIR } from "./init.js";
import type {
  ChangedPath,
  CommitChanges,
  HeldWrites,
  PlacedItem,
  PutItem,
  RecordStore,
  RecordWriter,
} from "./record-store.js";
import { type CasRetryHooks, withCasRetry } from "./retry.js";
import { salted } from "./salt.js";
import { type ScopeFile, scopeDifference } from "./scope-difference.js";

const SCOPE_SEPARATOR_CHARACTERS = "-_.";

const SCOPE_CHARACTER_PATTERN = /^[A-Za-z0-9._-]+$/;

export class InvalidScopeError extends KernelError {
  constructor(scope: string, rule: string) {
    super({
      reason: "invalid-input",
      detail: `refusing scope ${JSON.stringify(scope)} as a ref name: ${rule}`,
      about: [scope],
    });
    this.name = "InvalidScopeError";
  }
}

/** Refuses rather than sanitises, since a rewritten scope name would write into another ref. */
function assertValidScope(scope: string): void {
  if (scope.length === 0) {
    throw new InvalidScopeError(scope, "a scope name must not be empty");
  }
  if (!SCOPE_CHARACTER_PATTERN.test(scope)) {
    throw new InvalidScopeError(
      scope,
      "a scope name may hold only unaccented letters, digits, and the separators '-', '_' and '.'",
    );
  }
  if (SCOPE_SEPARATOR_CHARACTERS.includes(scope[0]!) || SCOPE_SEPARATOR_CHARACTERS.includes(scope[scope.length - 1]!)) {
    throw new InvalidScopeError(scope, "a scope name must not begin or end with a separator");
  }
  if (scope.includes("..")) {
    throw new InvalidScopeError(scope, "a scope name must not contain a doubled dot");
  }
}

/** The store's only ref-name producer, so validating here covers every path through it. */
export function scopeRefName(scope: string): string {
  assertValidScope(scope);
  return `refs/heads/scope/${scope}`;
}

export interface MergeOptions {
  /** The records to carry; every record the source holds and the target lacks where absent. */
  readonly ids?: readonly RecordId[];
  /** Records written in the merge's own commit, such as the ruling that attests it. */
  readonly with?: readonly PutItem[];
}

export interface MergeResult {
  /** `null` where the target already held everything the merge would carry. */
  readonly commit: string | null;
  readonly merged: readonly RecordId[];
  readonly put: readonly RecordId[];
}

export interface StoreOptions {
  ctx: GitContext;
  scope: string;
  now: Clock;
  /** A store handed none refuses every claim. */
  claimTypes?: ClaimTypes;
  /** Loose objects past which a write packs the store; git's own `gc.auto` default. */
  packThreshold?: number;
  /** A cleared reader's fold: a read by an id it does not hold, and this store did not write,
   * answers as if none were written. */
  holds?: (id: RecordId) => boolean;
  /** A station's clearance, whose derived key salts what it writes in place of the workspace's. */
  clearance?: Audience;
  /** The configuration its opener read; a store handed none reads it at its first write. */
  config?: WorkspaceConfig;
}

/** Git's `gc.auto` default: `init` turns git's collection off, so the store packs itself. */
export const PACK_THRESHOLD = 6700;

function buildCommitMessage(items: readonly { readonly kind: RecordKind }[], ids: RecordId[]): string {
  const kinds = [...new Set(items.map((item) => item.kind))].join(", ");
  const subject = `write ${items.length} record${items.length === 1 ? "" : "s"} (${kinds})`;
  const trailers = ["Musai-Event: record.put"];
  const claimIds = ids.filter((_, index) => items[index]!.kind === "claim");
  if (claimIds.length > 0) {
    trailers.push(`Musai-Claim: ${claimIds.join(", ")}`);
  }
  trailers.push(`${ORDER_TRAILER}: ${ids.join(", ")}`);
  return `${subject}\n\n${trailers.join("\n")}\n`;
}

/** The ids, ordered as the commits holding them wrote them; one with no order trailer reads in path
 * order, and an id none of them names keeps its place after the rest. */
function inWriteOrder(ids: readonly RecordId[], commits: readonly CommitPaths[]): RecordId[] {
  const rank = new Map<RecordId, number>();
  for (const { order, changes } of commits) {
    const written =
      order.length > 0
        ? order
        : changes
            .filter(({ path, blob }) => blob !== null && path.startsWith("records/") && !isSidecarPath(path))
            .map(({ path }) => path)
            .sort()
            .map(idFromPath);
    for (const id of written) {
      if (!rank.has(id)) {
        rank.set(id, rank.size);
      }
    }
  }
  const last = rank.size;
  return [...ids].sort((a, b) => (rank.get(a) ?? last) - (rank.get(b) ?? last));
}

/** Typed so a surface can tell a caller's stale or mistaken id from the kernel failing. */
export class RecordNotFoundError extends KernelError {
  readonly id: RecordId;

  constructor(id: RecordId, scope: string, because?: string) {
    super({
      reason: "no-such-record",
      detail:
        because === undefined ? `no record ${id} in scope ${scope}` : `no record ${id} in scope ${scope}: ${because}`,
      about: [id],
    });
    this.name = "RecordNotFoundError";
    this.id = id;
  }
}

function refuseStraySignature(item: { readonly kind: RecordKind; readonly signature?: string }): void {
  if (item.signature !== undefined && item.kind !== "attestation") {
    throw new KernelError({
      reason: "invalid-input",
      detail: `refusing to write a signature beside a ${item.kind} record: only an attestation is signed`,
      about: [item.kind],
    });
  }
}

export class Store implements RecordStore, RecordWriter {
  private readonly ctx: GitContext;
  readonly scope: string;
  private readonly now: Clock;
  private readonly claimTypes: ClaimTypes;
  private readonly packThreshold: number;
  private readonly holds: (id: RecordId) => boolean;
  private readonly clearance: Audience | undefined;
  /** Read back before any fold holds them, as an evaluation reads the receipts it mints. */
  private readonly written = new Set<RecordId>();
  private configPromise: Promise<WorkspaceConfig> | null;

  constructor(options: StoreOptions) {
    this.ctx = options.ctx;
    this.scope = options.scope;
    this.now = options.now;
    this.claimTypes = options.claimTypes ?? NO_CLAIM_TYPES;
    this.packThreshold = options.packThreshold ?? PACK_THRESHOLD;
    this.holds = options.holds ?? (() => true);
    this.clearance = options.clearance;
    this.configPromise = options.config === undefined ? null : Promise.resolve(options.config);
  }

  private get refName(): string {
    return scopeRefName(this.scope);
  }

  /** Read once per store, so a batch costs one configuration read rather than one per record. */
  private workspaceConfig(): Promise<WorkspaceConfig> {
    if (this.configPromise === null) {
      this.configPromise = readWorkspaceConfig(this.ctx);
    }
    return this.configPromise;
  }

  /** The record salted as its writer salts it: under its clearance's key where it has one. */
  salted(record: MusaiRecord): Promise<MusaiRecord> {
    return salted(join(this.ctx.gitDir, LOCAL_DIR), record, { now: this.now, clearance: this.clearance });
  }

  async tip(): Promise<string | null> {
    return gitRevParse(this.ctx, this.refName);
  }

  async descends(from: string, to: string): Promise<boolean> {
    return gitIsAncestor(this.ctx, from, to);
  }

  async put(kind: RecordKind, value: unknown): Promise<RecordId> {
    const ids = await this.putMany([{ kind, value }]);
    return ids[0]!;
  }

  /** One object write, one tree, one commit and one compare-and-swap for the whole batch. */
  async putMany(items: readonly PutItem[], hooks: CasRetryHooks = {}): Promise<RecordId[]> {
    return this.writeBatch(items, (tmpDir) => this.stage(items, tmpDir), hooks);
  }

  /** Writes held back from the scope, each minted and readable at once, until `land` writes them
   * in one commit. */
  held(): HeldWrites {
    const items = new Map<RecordId, PutItem>();
    return {
      scope: this.scope,
      put: async (kind, value) => {
        const {
          records: [record],
        } = await this.validated([{ kind, value }]);
        const id = recordId(record!);
        items.set(id, { kind, value: record });
        return id;
      },
      read: async (id, kind) => {
        const item = items.get(id);
        return item?.kind === kind ? (item.value as MusaiRecord) : this.read(id, kind);
      },
      land: async (more) => (await this.putMany([...items.values(), ...more])).slice(items.size),
    };
  }

  /** Records arriving whole keep their bytes, so each keeps the version and id it was minted at. */
  async placeMany(items: readonly PlacedItem[], hooks: CasRetryHooks = {}): Promise<RecordId[]> {
    return this.writeBatch(items, (tmpDir) => this.placed(items, tmpDir), hooks);
  }

  private async writeBatch(
    items: readonly { readonly kind: RecordKind }[],
    staged: (tmpDir: string) => Promise<{ readonly ids: RecordId[]; readonly files: ScopeFile[] }>,
    hooks: CasRetryHooks,
  ): Promise<RecordId[]> {
    if (items.length === 0) {
      return [];
    }

    // Validates the scope before any object is written.
    void this.refName;

    const tmpDir = await mkdtemp(join(tmpdir(), "musai-put-"));
    try {
      const { ids, files } = await staged(tmpDir);
      const message = buildCommitMessage(items, ids);
      await this.swapRef(async (tip) => ({ commitSha: await this.splice(tip, files, message), value: ids }), hooks);
      for (const id of ids) {
        this.written.add(id);
      }
      await this.packPastThreshold();
      return ids;
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }

  /** Every record and file `source` holds and this scope lacks, or the chosen records with the
   * attestations over them, in one commit whose only parent is this scope's tip. */
  async mergeFrom(source: string, options: MergeOptions = {}, hooks: CasRetryHooks = {}): Promise<MergeResult> {
    const sourceTip = await gitRevParse(this.ctx, scopeRefName(source));
    const tmpDir = await mkdtemp(join(tmpdir(), "musai-merge-"));
    try {
      const staged = options.with === undefined ? { ids: [], files: [] } : await this.stage(options.with, tmpDir);
      if (sourceTip === null && staged.files.length === 0) {
        return { commit: null, merged: [], put: [] };
      }
      const result = await this.swapRef(async (tip) => {
        const landing = await this.landing(source, sourceTip, tip, options.ids, staged.ids);
        const merged = landing.filter((file) => !isSidecarPath(file.path)).map((file) => idFromPath(file.path));
        const files = [...landing, ...staged.files];
        const order = [...(await this.sourceOrder(merged, sourceTip, tip)), ...staged.ids];
        const message =
          `merge ${merged.length} record${merged.length === 1 ? "" : "s"} from scope ${source}\n\n` +
          `Musai-Event: record.merge\nMusai-Source: ${source} ${sourceTip ?? "empty"}\n` +
          (order.length > 0 ? `${ORDER_TRAILER}: ${order.join(", ")}\n` : "");
        const commitSha = files.length === 0 && tip !== null ? tip : await this.splice(tip, files, message);
        return { commitSha, value: { commit: commitSha === tip ? null : commitSha, merged, put: staged.ids } };
      }, hooks);
      await this.packPastThreshold();
      return result;
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }

  /** The records `mergeFrom` would carry from `source` at this scope's tip, writing nothing. */
  async mergePreview(source: string, ids?: readonly RecordId[]): Promise<RecordId[]> {
    const sourceTip = await gitRevParse(this.ctx, scopeRefName(source));
    const landing = await this.landing(source, sourceTip, await this.tip(), ids, []);
    return landing.filter((file) => !isSidecarPath(file.path)).map((file) => idFromPath(file.path));
  }

  /** The merged ids in the order the source's commits past `tip` wrote them. */
  private async sourceOrder(merged: readonly RecordId[], sourceTip: string | null, tip: string | null) {
    return sourceTip === null ? [...merged] : inWriteOrder(merged, await gitLogChanges(this.ctx, tip, sourceTip));
  }

  private async landing(
    source: string,
    sourceTip: string | null,
    tip: string | null,
    ids: readonly RecordId[] | undefined,
    put: readonly RecordId[],
  ): Promise<ScopeFile[]> {
    const difference = sourceTip === null ? [] : await scopeDifference(this.ctx, sourceTip, tip);
    return ids === undefined ? difference : this.chosen(source, difference, ids, tip, put);
  }

  /** The chosen records the difference holds, and the source's attestations over them; an id
   * neither scope holds, and a citation the target would not hold after the merge, are refused. */
  private async chosen(
    source: string,
    difference: readonly ScopeFile[],
    ids: readonly RecordId[],
    tip: string | null,
    put: readonly RecordId[],
  ): Promise<ScopeFile[]> {
    const byPath = new Map(difference.map((file) => [file.path, file]));
    const records = new Map(
      difference.filter((file) => !isSidecarPath(file.path)).map((file) => [idFromPath(file.path), file]),
    );
    const wanted = new Set(ids);
    const landing: ScopeFile[] = [];
    for (const id of ids) {
      const file = records.get(id);
      if (file !== undefined) {
        landing.push(file);
      } else if (!(await this.holdsAt(tip, id, RECORD_KINDS))) {
        throw new RecordNotFoundError(id, source);
      }
    }
    for (const [id, file] of records) {
      if (wanted.has(id) || kindFromPath(file.path) !== "attestation") {
        continue;
      }
      const attestation = JSON.parse((await gitCatFile(this.ctx, file.sha)).toString("utf8")) as { subject: string };
      if (wanted.has(attestation.subject as RecordId)) {
        landing.push(file, ...[byPath.get(sidecarPath(id))].filter((sidecar) => sidecar !== undefined));
      }
    }
    const landingRecords = landing.filter((file) => !isSidecarPath(file.path));
    const landed = new Set<RecordId>([...landingRecords.map((file) => idFromPath(file.path)), ...put]);
    for (const file of landingRecords) {
      const record = JSON.parse((await gitCatFile(this.ctx, file.sha)).toString("utf8")) as Parameters<
        typeof referencesOf
      >[0];
      for (const citation of referencesOf(record).citations) {
        if (!landed.has(citation.id) && !(await this.holdsAt(tip, citation.id, citation.kinds))) {
          throw new KernelError({
            reason: "invalid-input",
            about: [citation.id],
            detail: `${idFromPath(file.path)} cites ${citation.id} at ${citation.path}, which neither scope ${this.scope} holds nor this merge carries; choose it too`,
          });
        }
      }
    }
    return landing;
  }

  private async holdsAt(tip: string | null, id: RecordId, kinds: readonly RecordKind[]): Promise<boolean> {
    if (tip === null) {
      return false;
    }
    for (const kind of kinds) {
      if ((await gitRevParse(this.ctx, `${tip}:${recordPath(kind, id)}`)) !== null) {
        return true;
      }
    }
    return false;
  }

  /** Validates and hashes a batch, writing its objects; which tree they land in is the caller's. */
  private async stage(
    items: readonly PutItem[],
    tmpDir: string,
  ): Promise<{ readonly ids: RecordId[]; readonly files: ScopeFile[] }> {
    const { records: validatedRecords, bytesList } = await this.validated(items);
    // Ids are minted over the validated form, since those are the bytes a later read digests.
    const ids = validatedRecords.map((record) => recordId(record));
    return this.objects(items, ids, bytesList, tmpDir);
  }

  /** Each record as the store writes it: validated, salted where asked, within the threshold. */
  private async validated(
    items: readonly PutItem[],
  ): Promise<{ readonly records: MusaiRecord[]; readonly bytesList: Uint8Array[] }> {
    const validatedRecords: MusaiRecord[] = [];
    for (const item of items) {
      const validation = validateRecord(item.value, { unregisteredClaimTypes: "refuse", claimTypes: this.claimTypes });
      if (!validation.ok) {
        throw new KernelError({
          reason: "invalid-input",
          detail: `refusing to write an invalid ${item.kind} record: ${validation.error}`,
          about: [item.kind],
        });
      }
      refuseStraySignature(item);
      validatedRecords.push(item.salt === true ? await this.salted(validation.record) : validation.record);
    }

    const config = await this.workspaceConfig();
    const bytesList = validatedRecords.map((record) => canonicalBytes(record));
    for (let index = 0; index < items.length; index++) {
      const byteLength = bytesList[index]!.byteLength;
      if (exceedsBlobThreshold(byteLength, config.values)) {
        const threshold = blobThreshold(config.values);
        throw new KernelError({
          reason: "invalid-input",
          detail: `refusing to write a ${items[index]!.kind} record of ${byteLength} bytes: exceeds the workspace's configured threshold of ${threshold} bytes; store the payload beside the repository as a blob and reference it by id instead`,
          about: [items[index]!.kind],
        });
      }
    }
    return { records: validatedRecords, bytesList };
  }

  /** Reads each record as the fold would and keeps its bytes, for the caller to land in a tree. */
  private async placed(
    items: readonly PlacedItem[],
    tmpDir: string,
  ): Promise<{ readonly ids: RecordId[]; readonly files: ScopeFile[] }> {
    const ids = items.map((item) => {
      refuseStraySignature(item);
      const id = rawId(item.bytes);
      readArrivingRecord(item.bytes, id, item.kind);
      return id;
    });
    return this.objects(
      items,
      ids,
      items.map((item) => item.bytes),
      tmpDir,
    );
  }

  private async objects(
    items: readonly { readonly kind: RecordKind; readonly signature?: string }[],
    ids: readonly RecordId[],
    bytesList: readonly Uint8Array[],
    tmpDir: string,
  ): Promise<{ readonly ids: RecordId[]; readonly files: ScopeFile[] }> {
    const paths = items.map((item, index) => recordPath(item.kind, ids[index]!));
    const signatures = items.flatMap((item, index) =>
      item.signature === undefined ? [] : [{ path: sidecarPath(ids[index]!), text: item.signature }],
    );

    const filePaths = await Promise.all(
      bytesList.map(async (bytes, index) => {
        const filePath = join(tmpDir, `${index}`);
        await writeFile(filePath, bytes);
        return filePath;
      }),
    );
    const signaturePaths = await Promise.all(
      signatures.map(async (signature, index) => {
        const filePath = join(tmpDir, `signature-${index}`);
        await writeFile(filePath, signature.text);
        return filePath;
      }),
    );

    const blobShas = await gitHashObjectBatch(this.ctx, [...filePaths, ...signaturePaths]);
    return {
      ids: [...ids],
      files: [
        ...paths.map((path, index) => ({ path, sha: blobShas[index]! })),
        ...signatures.map((signature, index) => ({ path: signature.path, sha: blobShas[items.length + index]! })),
      ],
    };
  }

  /** The tip itself where every path already holds this content, so no commit is minted. */
  private async splice(tip: string | null, files: readonly ScopeFile[], message: string): Promise<string> {
    // A path the tip already holds is replaced rather than sat beside.
    const newTreeSha = await gitSpliceTree(this.ctx, tip, [...files]);
    if (tip !== null && (await gitRevParse(this.ctx, `${tip}^{tree}`)) === newTreeSha) {
      return tip;
    }
    return gitCommitTree(this.ctx, newTreeSha, tip ? [tip] : [], message, this.now);
  }

  private async packPastThreshold(): Promise<void> {
    if ((await gitLooseObjectCount(this.ctx)) >= this.packThreshold) {
      await gitPackWithoutPruning(this.ctx);
    }
  }

  private reads(id: RecordId): boolean {
    return this.holds(id) || this.written.has(id);
  }

  /** Reads through the write path's contract, so a record the store would not write is refused. */
  async read(id: RecordId, kind: RecordKind): Promise<MusaiRecord> {
    return readStoredRecord(await this.readBytes(id, kind), id, kind);
  }

  /** The bytes as git holds them, never normalised: a signature covers exactly these. */
  async readBytes(id: RecordId, kind: RecordKind): Promise<Uint8Array> {
    if (!this.reads(id)) {
      throw new RecordNotFoundError(id, this.scope);
    }
    const tip = await this.tip();
    if (!tip) {
      throw new RecordNotFoundError(id, this.scope, "the scope holds no records yet");
    }
    try {
      return await gitCatFile(this.ctx, `${tip}:${recordPath(kind, id)}`);
    } catch (error) {
      if (isAbsentPathError(error)) {
        throw new RecordNotFoundError(id, this.scope);
      }
      throw error;
    }
  }

  /** `null` only when absent: an unreadable signature must never pass for one never made. */
  async readSidecar(attestationId: RecordId): Promise<string | null> {
    if (!this.reads(attestationId)) {
      throw new RecordNotFoundError(attestationId, this.scope);
    }
    const tip = await this.tip();
    if (!tip) {
      return null;
    }
    try {
      return (await gitCatFile(this.ctx, `${tip}:${sidecarPath(attestationId)}`)).toString("utf8");
    } catch (error) {
      if (isAbsentPathError(error)) {
        return null;
      }
      throw error;
    }
  }

  async list(kind: RecordKind): Promise<RecordId[]> {
    const tip = await this.tip();
    if (!tip) {
      return [];
    }
    const entries = await gitLsTree(this.ctx, tip);
    const prefix = `records/${kind}/`;
    return entries
      .filter((entry) => entry.path.startsWith(prefix) && !isSidecarPath(entry.path))
      .map((entry) => idFromPath(entry.path))
      .filter((id) => this.reads(id));
  }

  async swapRef<T>(
    build: (tip: string | null) => Promise<{ commitSha: string; value: T }>,
    hooks: CasRetryHooks = {},
  ): Promise<T> {
    return withCasRetry({ ctx: this.ctx, ref: this.refName, ...hooks }, build);
  }

  /** Two processes for the whole walk: `git log` names each changed blob and one `cat-file
   * --batch` answers them by object id, so the walk pays per record rather than per tree level. */
  async *changesSince(cursor: string | null): AsyncIterable<CommitChanges> {
    const tip = await this.tip();
    if (!tip) {
      return;
    }
    const log = await gitLogChanges(this.ctx, cursor, tip);
    const answers = gitCatFileBatch(
      this.ctx,
      log.flatMap(({ changes }) => changes.flatMap(({ blob }) => (blob === null ? [] : [blob]))),
    );
    try {
      for (const { commit, committedAt, order, changes } of log) {
        const changed: ChangedPath[] = [];
        for (const { path, blob } of changes) {
          if (blob === null) {
            changed.push({ path, bytes: null });
            continue;
          }
          // The batch answers once per blob, so it never ends before the last one.
          const answer = await answers.next();
          if (answer.done) {
            throw unansweredBatchSpec(blob, "it ended first");
          }
          if (answer.value === null) {
            throw unansweredBatchSpec(
              blob,
              `the repository holds no such object, though the log names it at ${path} in ${commit}`,
            );
          }
          changed.push({ path, bytes: answer.value });
        }
        yield { commit, committedAt, order, changed };
      }
    } finally {
      await answers.return();
    }
  }
}
