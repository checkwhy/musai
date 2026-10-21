import { rmSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ArgumentRecord,
  ArtifactRecord,
  AttestationRecord,
  CaseRecord,
  ClaimRecord,
  ContributionEntry,
  DigestSet,
  DimensionRegistry,
  ModuleRecord,
  MusaiRecord,
  RecordKind,
  RuleRecord,
  RulingRecord,
  RunRecord,
  Timestamp,
} from "@musai/records";
import {
  type Conditions,
  type EventKind,
  hexOfRecordId,
  idFromPath,
  isSidecarPath,
  KernelError,
  kindFromPath,
  type ReadEntry,
  type RecordId,
  RecordRefusedError,
  readStoredRecord,
  recipeOfReadKey,
  type Selector,
  scopeAdmits,
  slotOfReadKey,
} from "@musai/records";
import type { RecordStore } from "@musai/store";
import { applyCommit } from "./apply-commit.js";
import type {
  FoldContributions,
  FoldEngine,
  FoldExtension,
  FoldRefusal,
  FoldTable,
  IndexedRecordInput,
} from "./fold-extension.js";
import {
  foldRefusalOf,
  foldRefusalRows,
  foldTableIsCurrent,
  foldTableRows,
  forgetFoldTablesOutside,
  reconcileFoldTables,
  takeFoldTableDown,
} from "./fold-tables.js";
import type {
  ContributedRows,
  EventCursor,
  FoldedRecord,
  FoldInterruptEvent,
  IndexedAnchor,
  IndexedArgument,
  IndexedArtifact,
  IndexedAttestation,
  IndexedCase,
  IndexedClaim,
  IndexedContribution,
  IndexedEvent,
  IndexedEvidenceEdge,
  IndexedModuleInstall,
  IndexedRead,
  IndexedReceipt,
  IndexedRecord,
  IndexedRefusal,
  IndexedRule,
  IndexedRuling,
  IndexedRulingOnSlot,
  IndexedSuccessor,
  QueryDeclaration,
  RefusedRecordPath,
} from "./rows.js";
import { KERNEL_INDEX_TABLES } from "./schema.js";
import { type IndexConnection, type IndexProvider, openIndexProvider } from "./sqlite-provider.js";

/** A stored index at another version is rebuilt from the records, never migrated. */
export const INDEX_SCHEMA_VERSION = 23;

/** Which records a fold holds; one built under another digest is refolded from nothing, and one
 * built under any is never folded without it. */
export interface Admission {
  /** Names the rule and everything it was judged against. */
  readonly digest: string;
  /** Read before the rule was judged, so it saw every record up to here; the fold stops here. */
  readonly through: string | null;
  /** The trust branch's commit the rule's standing was judged under. */
  readonly trust: string;
  /** `admitted` answers for every record landed before this one, and beside it in its commit. A
   * rule admits no less as more is admitted, and asks about a record beside it only through it. */
  readonly admits: (record: IndexedRecordInput, admitted: (id: RecordId) => boolean) => boolean;
  /** Whether a path refused at `commit` names a record this fold withholds. */
  readonly withholds: (id: RecordId, commit: string, admitted: (id: RecordId) => boolean) => boolean;
  /** The rule judged afresh against what it was judged against, as that now stands. */
  readonly judgedAgain: () => Promise<Admission>;
}

/** The admission a fold was last stamped with, and where it was judged. */
interface Stamp {
  readonly digest: string | null;
  readonly through: string | null;
  readonly trust: string | null;
}

function sameStamp(a: Stamp, b: Stamp): boolean {
  return a.digest === b.digest && a.through === b.through && a.trust === b.trust;
}

/** Whether `stamped` lies past `judged` along a history that only grows. */
async function liesPast(store: RecordStore, stamped: string | null, judged: string | null): Promise<boolean> {
  return stamped !== null && stamped !== judged && (judged === null || (await store.descends(judged, stamped)));
}

/** Whether `stamp` was judged past `admission`, on the scope's log or on the trust branch. */
async function stampPasses(store: RecordStore, stamp: Stamp, admission: Admission): Promise<boolean> {
  return (
    (await liesPast(store, stamp.through, admission.through)) || (await liesPast(store, stamp.trust, admission.trust))
  );
}

/** What a commit leaves in a fold: the records it admits and the refusals it keeps. */
interface Judged {
  readonly added: readonly FoldedRecord[];
  readonly refused: readonly RefusedRecordPath[];
}

/** Where a record landed in the log: its commit's place. */
interface Landing {
  readonly seq: number;
}

/** SQLite syncs once per transaction, which costs more than one commit's statements. */
const COMMITS_PER_TRANSACTION = 256;

/** Lands what a failed walk applied, else rolls it back; either way the index is consistent. */
function landAfterFailure(db: IndexConnection): void {
  try {
    db.exec("COMMIT");
  } catch {
    try {
      db.exec("ROLLBACK");
    } catch {
      // No transaction was left open: the engine already rolled it back.
    }
  }
}

/** A group and no group are not ambiguous: silence never outranks a declared menu. */

const ID_PREFIX = "sha256:";
const RECORD_FILE_HEX = /\/([0-9a-f]{64})\.json$/;

/** A commit's records in the order its writer named, then any it did not name in path order: an
 * id digests the binaries its run resolved, so path order differs between machines. */
function inWrittenOrder<T extends { readonly path: string }>(paths: readonly T[], order: readonly RecordId[]): T[] {
  const rank = new Map(order.map((id, index) => [id.slice(ID_PREFIX.length), index]));
  const rankOf = ({ path }: T) => rank.get(RECORD_FILE_HEX.exec(path)?.[1] ?? "") ?? order.length;
  return [...paths].sort((a, b) => rankOf(a) - rankOf(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export class AmbiguousExclusiveGroupError extends KernelError {
  constructor(slot: string, groups: readonly string[]) {
    super({
      reason: "declaration-conflict",
      detail:
        `refusing to resolve a representative claim at slot ${slot}: its contributors declare ` +
        `different exclusive groups (${groups.join(", ")}), and nothing names which one governs`,
      about: [slot, ...groups],
    });
    this.name = "AmbiguousExclusiveGroupError";
  }
}

/** A superseded rule record is not live, so a correction is never this conflict. */
export class RuleRecordConflictError extends KernelError {
  constructor(contribution: string, records: readonly RecordId[]) {
    super({
      reason: "declaration-conflict",
      detail:
        `refusing to read the rule record for ${contribution}: ${records.length} current rule records ` +
        `name it (${records.join(", ")}), and nothing decides which of them states its policy`,
      about: [contribution, ...records],
    });
    this.name = "RuleRecordConflictError";
  }
}

/** A disposable fold over one scope's records, rebuilt from git rather than migrated. */
export class IndexDb {
  private db: IndexConnection;
  private reader: IndexConnection | undefined;
  private readonly provider: IndexProvider;
  private readonly location: string;

  constructor(location: string = ":memory:") {
    this.location = location;
    this.provider = openIndexProvider();
    this.db = this.openDatabase();
    this.ensureSchema();
  }

  private openDatabase(): IndexConnection {
    try {
      return this.provider.open(this.location);
    } catch {
      // A file that is not a SQLite database is rebuilt, as a schema-version mismatch is.
      if (this.location !== ":memory:") {
        rmSync(this.location, { force: true });
      }
      return this.provider.open(this.location);
    }
  }

  private ensureSchema(): void {
    let versionRow: { version: number } | undefined;
    try {
      const tableExists = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'")
        .get();
      versionRow = tableExists
        ? (this.db.prepare("SELECT version FROM schema_meta WHERE id = 0").get() as { version: number } | undefined)
        : undefined;
    } catch {
      versionRow = undefined;
    }
    if (versionRow !== undefined && versionRow.version === INDEX_SCHEMA_VERSION) {
      return;
    }
    this.resetSchema();
  }

  /** Empties the index to the current schema with no watermark; the next fold refills it. */
  rebuild(): void {
    this.resetSchema();
  }

  private resetSchema(admission?: Admission): void {
    for (const table of KERNEL_INDEX_TABLES.keys()) {
      this.db.exec(`DROP TABLE IF EXISTS ${table};`);
    }
    for (const statements of KERNEL_INDEX_TABLES.values()) {
      for (const statement of statements) {
        this.db.exec(statement);
      }
    }
    this.db
      .prepare("INSERT INTO schema_meta (id, version, admission, through, trust) VALUES (0, ?, ?, ?, ?)")
      .run(INDEX_SCHEMA_VERSION, admission?.digest ?? null, admission?.through ?? null, admission?.trust ?? null);
    this.db.prepare("INSERT INTO watermark (id, commit_sha) VALUES (0, NULL)").run();
    this.db.prepare("INSERT INTO walked (id, commit_sha) VALUES (0, NULL)").run();
  }

  close(): void {
    this.reader?.close();
    this.db.close();
  }

  /** `scratch` is this engine but not this file, so a declaration cannot reach the fold. */
  engine(): FoldEngine {
    return {
      name: this.provider.name,
      capabilities: this.provider.capabilities(),
      scratch: () => this.provider.open(":memory:"),
    };
  }

  /** Runs on a read-only connection, so a write fails at the engine; an omitted parameter binds
   * `NULL`. A surface passing a caller's values through validates them against the schema first. */
  runQuery(declaration: QueryDeclaration, parameters: Record<string, unknown>): unknown[] {
    this.reader ??= this.provider.openReadOnly(this.location);
    const bound = Object.fromEntries(
      Object.keys(declaration.parameters).map((name) => [name, parameters[name] ?? null]),
    );
    return this.reader.prepare(declaration.statement).all(bound);
  }

  /** A consistent copy of this fold at `path`, which must not exist, and the commit the copy has
   * folded: read from the copy, since another handle may fold on while it is taken. */
  snapshotTo(path: string): string | null {
    this.db.prepare("VACUUM INTO ?").run(path);
    const copy = this.provider.openReadOnly(path);
    try {
      const row = copy.prepare("SELECT commit_sha FROM watermark WHERE id = 0").get() as
        | { commit_sha: string | null }
        | undefined;
      return row?.commit_sha ?? null;
    } finally {
      copy.close();
    }
  }

  /** The last commit this index holds rows of, or `null` before the first; under an admission, a
   * commit it admitted nothing of is passed over here. */
  watermark(): string | null {
    const row = this.db.prepare("SELECT commit_sha FROM watermark WHERE id = 0").get() as
      | { commit_sha: string | null }
      | undefined;
    return row?.commit_sha ?? null;
  }

  /** The last commit the walk has passed, held or not. */
  private walked(): string | null {
    const row = this.db.prepare("SELECT commit_sha FROM walked WHERE id = 0").get() as
      | { commit_sha: string | null }
      | undefined;
    return row?.commit_sha ?? null;
  }

  private stamp(): Stamp {
    const row = this.db.prepare("SELECT admission, through, trust FROM schema_meta WHERE id = 0").get() as
      | { admission: string | null; through: string | null; trust: string | null }
      | undefined;
    return { digest: row?.admission ?? null, through: row?.through ?? null, trust: row?.trust ?? null };
  }

  holds(id: RecordId): boolean {
    return this.db.prepare("SELECT 1 FROM records WHERE id = ?").get(id) !== undefined;
  }

  /** Whether `id` landed in `commit` or in a commit before it. */
  landedBy(id: RecordId, commit: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM records JOIN commits ON commits.sha = records.commit_sha " +
            "WHERE records.id = ? AND commits.seq <= (SELECT seq FROM commits WHERE sha = ?)",
        )
        .get(id, commit) !== undefined
    );
  }

  /** The commit `id` landed in, or `undefined` where this fold holds no such record. */
  commitOf(id: RecordId): string | undefined {
    const row = this.db.prepare("SELECT commit_sha FROM records WHERE id = ?").get(id) as
      | { commit_sha: string }
      | undefined;
    return row?.commit_sha;
  }

  /** The body `readStoredRecord` produced at fold, the same form the store reads from git. */
  recordById(id: RecordId): IndexedRecord | undefined {
    const row = this.db.prepare("SELECT record_json FROM records WHERE id = ?").get(id) as
      | { record_json: string }
      | undefined;
    if (row === undefined) {
      return undefined;
    }
    return { id, record: JSON.parse(row.record_json) as MusaiRecord };
  }

  /** Of two refusals claiming one id, the first by commit then path answers. */
  refusalFor(id: RecordId): IndexedRefusal | undefined {
    const row = this.db
      .prepare("SELECT commit_sha, path, reason FROM refusals WHERE id = ? ORDER BY commit_sha ASC, path ASC LIMIT 1")
      .get(id) as { commit_sha: string; path: string; reason: string } | undefined;
    if (row === undefined) {
      return undefined;
    }
    return { id, commit: row.commit_sha, path: row.path, reason: row.reason };
  }

  /** The commit time of the commit that landed the latest of `ids`, never a clock read. */
  latestCommitTimeOf(ids: readonly RecordId[]): string | null {
    const row = this.db
      .prepare(
        "SELECT commits.committed_at AS committed_at FROM records " +
          "JOIN commits ON commits.sha = records.commit_sha " +
          `WHERE records.id IN (${ids.map(() => "?").join(", ")}) ` +
          "ORDER BY commits.seq DESC, records.position DESC LIMIT 1",
      )
      .get(...ids) as { committed_at: string } | undefined;
    return row?.committed_at ?? null;
  }

  /** Every claim whose slot or record id carries `hex` right after its algorithm. */
  claimsWithHexPrefix(hex: string): { readonly slot: string; readonly id: RecordId }[] {
    const pattern = `sha256:${hex}%`;
    return this.db
      .prepare("SELECT DISTINCT slot, id FROM claims WHERE slot LIKE ? OR id LIKE ? ORDER BY slot, id")
      .all(pattern, pattern) as { slot: string; id: RecordId }[];
  }

  /** Every slot holding a claim of `type`, in slot order. */
  claimSlotsOfType(type: string): string[] {
    const rows = this.db.prepare("SELECT DISTINCT slot FROM claims WHERE type = ? ORDER BY slot").all(type) as {
      slot: string;
    }[];
    return rows.map((row) => row.slot);
  }

  /** The slots holding a claim of `type` whose rendering is exactly `text`. */
  claimSlotsRendering(type: string, text: string): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT slot FROM claims WHERE type = ? AND rendering = ? ORDER BY slot")
      .all(type, text) as { slot: string }[];
    return rows.map((row) => row.slot);
  }

  /** The contributor whose exclusive group governs the slot, else the lowest id; a declared group
   * outranks none, and two different groups throw. */
  claimAtSlot(slot: string): IndexedClaim | undefined {
    const contributors = this.contributorsAtSlot(slot);
    if (contributors.length === 0) {
      return undefined;
    }
    const groups = new Set(
      contributors
        .map((contributor) => (contributor.record as ClaimRecord).exclusiveGroup)
        .filter((group): group is string => group !== null),
    );
    if (groups.size > 1) {
      throw new AmbiguousExclusiveGroupError(slot, [...groups].sort());
    }
    if (groups.size === 0) {
      return contributors[0];
    }
    const governingGroup = [...groups][0]!;
    return contributors.find((contributor) => (contributor.record as ClaimRecord).exclusiveGroup === governingGroup);
  }

  /** Live contributors by id; a superseded claim stays reachable through `successorsOf`. */
  contributorsAtSlot(slot: string): IndexedClaim[] {
    const rows = this.db
      .prepare(
        "SELECT id, type, rendering, record_json FROM claims WHERE slot = ? " +
          "AND id NOT IN (SELECT predecessor FROM succession) ORDER BY id ASC",
      )
      .all(slot) as Array<{ id: string; type: string; rendering: string; record_json: string }>;
    return rows.map((row) => ({
      slot,
      id: row.id as RecordId,
      type: row.type,
      rendering: row.rendering,
      record: JSON.parse(row.record_json) as MusaiRecord,
    }));
  }

  /** Confirmed against each slot's governing claim: a contributor's own column may be outdated. */
  claimsInGroup(group: string): IndexedClaim[] {
    const rows = this.db
      .prepare("SELECT DISTINCT slot FROM claims WHERE exclusive_group = ? ORDER BY slot ASC")
      .all(group) as Array<{ slot: string }>;
    const claims: IndexedClaim[] = [];
    for (const row of rows) {
      const claim = this.claimAtSlot(row.slot);
      if (claim !== undefined && (claim.record as ClaimRecord).exclusiveGroup === group) {
        claims.push(claim);
      }
    }
    return claims;
  }

  /** A superseded contributor's edges are left out, lest a correction inherit what it withdrew. */
  evidenceEdgesOf(slot: string): IndexedEvidenceEdge[] {
    const rows = this.db
      .prepare(
        "SELECT run_id, selector, selector_module, selector_parser, selector_version, selector_key, item " +
          "FROM evidence_edges WHERE claim_slot = ? AND record_id NOT IN (SELECT predecessor FROM succession) " +
          "ORDER BY run_id ASC, selector ASC",
      )
      .all(slot) as Array<{
      run_id: string;
      selector: string;
      selector_module: string;
      selector_parser: string;
      selector_version: string;
      selector_key: string;
      item: string;
    }>;
    const seen = new Set<string>();
    const edges: IndexedEvidenceEdge[] = [];
    for (const row of rows) {
      const identity = `${row.run_id}\u0000${row.selector}\u0000${row.item}`;
      if (seen.has(identity)) {
        continue;
      }
      seen.add(identity);
      edges.push({
        run: row.run_id as RecordId,
        selector: {
          module: row.selector_module,
          parser: row.selector_parser,
          version: row.selector_version,
          key: row.selector_key,
        } as Selector,
        item: row.item as RecordId,
      });
    }
    return edges;
  }

  /** A condition on `column` admitting only the records installed names resolve to. */
  private resolvedModuleRecords(
    column: string,
    landed: (id: RecordId) => boolean = () => true,
  ): { condition: string; ids: string[] } {
    const ids = this.installedModuleRecords(landed).map((install) => install.id);
    return { condition: `${column} IN (${ids.map(() => "?").join(", ")})`, ids };
  }

  /** Only the record each installed name resolves to: registries refuse an id two rows share. */
  contributionsOf(kind: string): IndexedContribution[] {
    return this.installedContributionsWhere("contribution_kind", kind);
  }

  contributionsWithId(id: string): IndexedContribution[] {
    return this.installedContributionsWhere("contribution_id", id);
  }

  private installedContributionsWhere(
    column: "contribution_kind" | "contribution_id",
    value: string,
  ): IndexedContribution[] {
    const resolved = this.resolvedModuleRecords("module_record");
    const rows = this.db
      .prepare(
        "SELECT module_record, module_name, module_version, entry_json FROM module_contributions " +
          `WHERE ${column} = ? AND ${resolved.condition} ` +
          "ORDER BY contribution_id ASC, contribution_version ASC, module_record ASC",
      )
      .all(value, ...resolved.ids) as Array<{
      module_record: string;
      module_name: string;
      module_version: string;
      entry_json: string;
    }>;
    return rows.map((row) => ({
      moduleRecord: row.module_record as RecordId,
      moduleName: row.module_name,
      moduleVersion: row.module_version,
      entry: JSON.parse(row.entry_json) as ContributionEntry,
    }));
  }

  /** Ties on `started_at` break by place in the log, which a rebuild reproduces. */
  receiptByRecipe(recipeIdValue: RecordId): IndexedReceipt | undefined {
    return this.receiptsByRecipe(recipeIdValue, 1)[0];
  }

  /** Every receipt for a recipe, the latest first. */
  receiptsByRecipe(recipeIdValue: RecordId, limit = -1): IndexedReceipt[] {
    const rows = this.db
      .prepare(
        "SELECT receipts.recipe_id AS recipe_id, receipts.record_id AS record_id, " +
          "receipts.started_at AS started_at, receipts.record_json AS record_json FROM receipts " +
          "JOIN records ON records.id = receipts.record_id JOIN commits ON commits.sha = records.commit_sha " +
          "WHERE receipts.recipe_id = ? " +
          "ORDER BY receipts.started_at DESC, commits.seq DESC, records.position DESC LIMIT ?",
      )
      .all(recipeIdValue, limit) as { recipe_id: string; record_id: string; started_at: string; record_json: string }[];
    return rows.map((row) => ({
      recipeId: row.recipe_id as RecordId,
      recordId: row.record_id as RecordId,
      startedAt: row.started_at as Timestamp,
      record: JSON.parse(row.record_json) as RunRecord,
    }));
  }

  /** Every run whose read-set names `key`, in the log's order: one lookup on the key's index. */
  readersOf(key: string): IndexedRead[] {
    const rows = this.db
      .prepare(
        "SELECT reads.reader AS reader, reads.consumed_json AS consumed_json FROM reads " +
          "JOIN records ON records.id = reads.reader JOIN commits ON commits.sha = records.commit_sha " +
          "WHERE reads.key = ? ORDER BY commits.seq ASC, records.position ASC",
      )
      .all(key) as { reader: string; consumed_json: string }[];
    return rows.map((row) => ({
      reader: row.reader as RecordId,
      consumed: JSON.parse(row.consumed_json) as DigestSet,
    }));
  }

  /** One hop of a change's reach: the readers of `key` whose read is behind. */
  reachOf(key: string): IndexedRead[] {
    const behind = this.behindAt(key);
    return this.readersOf(key).filter((read) => behind(read.reader, read.consumed));
  }

  /** Whether `reader`'s read is behind: what it read moved, or a newer receipt for it landed. */
  readMoved(reader: RecordId, read: ReadEntry): boolean {
    return this.behindAt(read.key)(reader, read.consumed);
  }

  /** A recipe is behind for a reader a receipt for it landed after, or beside it unread, since a
   * restored tree reuses an older receipt; a slot or a record is behind where it holds another. */
  private behindAt(key: string): (reader: RecordId, consumed: DigestSet) => boolean {
    const recipe = recipeOfReadKey(key);
    if (recipe !== undefined) {
      const latest = this.db
        .prepare(
          "SELECT commits.seq AS seq FROM receipts " +
            "JOIN records ON records.id = receipts.record_id JOIN commits ON commits.sha = records.commit_sha " +
            "WHERE receipts.recipe_id = ? ORDER BY commits.seq DESC LIMIT 1",
        )
        .get(recipe) as Landing | undefined;
      // Nothing in one commit lands first: a receipt beside the reader is newer unless it read it.
      const besideUnread = this.db.prepare(
        "SELECT 1 FROM receipts JOIN records ON records.id = receipts.record_id " +
          "JOIN commits ON commits.sha = records.commit_sha " +
          "WHERE receipts.recipe_id = ? AND commits.seq = ? AND receipts.record_id != ?",
      );
      return (reader, consumed) => {
        const landed = this.landingOf(reader);
        if (latest === undefined || landed === undefined || latest.seq < landed.seq) {
          return false;
        }
        return (
          latest.seq > landed.seq || besideUnread.get(recipe, landed.seq, `sha256:${consumed.sha256}`) !== undefined
        );
      };
    }
    const held = this.heldAt(key)?.sha256;
    return (_reader, consumed) => consumed.sha256 !== held;
  }

  private landingOf(id: RecordId): Landing | undefined {
    return this.db
      .prepare(
        "SELECT commits.seq AS seq FROM records JOIN commits ON commits.sha = records.commit_sha WHERE records.id = ?",
      )
      .get(id) as Landing | undefined;
  }

  /** What a slot or record key holds now: the slot's claim, or the record's latest successor. */
  private heldAt(key: string): DigestSet | undefined {
    const slot = slotOfReadKey(key);
    const held = slot === undefined ? this.latestSuccessorOf(key as RecordId) : this.claimAtSlot(slot)?.id;
    return held === undefined ? undefined : { sha256: hexOfRecordId(held) };
  }

  /** Followed by the latest successor in landing order; ids are content, so the chain ends. */
  private latestSuccessorOf(id: RecordId): RecordId | undefined {
    if (this.recordById(id) === undefined) {
      return undefined;
    }
    let held = id;
    for (let next = this.successorsOf(held).at(-1); next !== undefined; next = this.successorsOf(held).at(-1)) {
      held = next.successor;
    }
    return held;
  }

  /** When each run in the scope began, as its observation records it. */
  receiptStarts(): string[] {
    const rows = this.db.prepare("SELECT started_at FROM receipts").all() as { started_at: string }[];
    return rows.map((row) => row.started_at);
  }

  /** Only a record an installed name resolves to answers, the latest in the log among them; with
   * `landed`, installed as of the records it holds. */
  contributionById(id: string, landed?: (id: RecordId) => boolean): IndexedContribution | undefined {
    const resolved = this.resolvedModuleRecords("module_contributions.module_record", landed);
    const row = this.db
      .prepare(
        "SELECT module_contributions.module_record AS module_record, module_contributions.module_name AS module_name, " +
          "module_contributions.module_version AS module_version, module_contributions.entry_json AS entry_json " +
          "FROM module_contributions " +
          "JOIN records ON records.id = module_contributions.module_record " +
          "JOIN commits ON commits.sha = records.commit_sha " +
          "WHERE module_contributions.contribution_id = ? " +
          `AND ${resolved.condition} ` +
          "ORDER BY commits.seq DESC, records.position DESC LIMIT 1",
      )
      .get(id, ...resolved.ids) as
      | { module_record: string; module_name: string; module_version: string; entry_json: string }
      | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      moduleRecord: row.module_record as RecordId,
      moduleName: row.module_name,
      moduleVersion: row.module_version,
      entry: JSON.parse(row.entry_json) as ContributionEntry,
    };
  }

  /** The latest record in the log per name among those `landed`, never by id: a hash says nothing
   * of age. */
  installedModuleRecords(landed: (id: RecordId) => boolean = () => true): IndexedModuleInstall[] {
    const rows = this.db
      .prepare(
        "SELECT records.id AS id, records.record_json AS record_json FROM records " +
          "JOIN commits ON commits.sha = records.commit_sha " +
          "WHERE records.kind = 'module' ORDER BY commits.seq ASC, records.position ASC",
      )
      .all() as Array<{ id: string; record_json: string }>;
    const byName = new Map<string, IndexedModuleInstall>();
    for (const row of rows.filter((candidate) => landed(candidate.id as RecordId))) {
      const record = JSON.parse(row.record_json) as ModuleRecord;
      byName.set(record.name, { id: row.id as RecordId, name: record.name, version: record.version });
    }
    return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  anchorsOf(artifactId: RecordId): IndexedAnchor[] {
    const rows = this.db
      .prepare("SELECT label, full_id FROM artifact_anchors WHERE artifact_id = ? ORDER BY label ASC")
      .all(artifactId) as Array<{ label: string; full_id: string }>;
    return rows.map((row) => ({ label: row.label, fullId: row.full_id as RecordId }));
  }

  /** Ordered by id, so which of two cases sharing a slug answers is fixed by the records. */
  caseBySlug(slug: string): IndexedCase | undefined {
    const row = this.db.prepare("SELECT id, record_json FROM cases WHERE slug = ? ORDER BY id ASC LIMIT 1").get(slug) as
      | { id: string; record_json: string }
      | undefined;
    if (row === undefined) {
      return undefined;
    }
    return { id: row.id as RecordId, record: JSON.parse(row.record_json) as CaseRecord };
  }

  /** The case pinning the claim, else one pinning a record it descends from, so a successor finds
   * its case. */
  caseForClaim(claimId: RecordId): IndexedCase | undefined {
    const row = this.db
      .prepare(
        "WITH RECURSIVE lineage(id) AS (SELECT ? UNION " +
          "SELECT succession.predecessor FROM succession JOIN lineage ON succession.successor = lineage.id) " +
          "SELECT cases.id AS id, cases.record_json AS record_json FROM cases " +
          "JOIN case_claims ON case_claims.case_id = cases.id " +
          "WHERE case_claims.claim_id IN (SELECT id FROM lineage) " +
          "ORDER BY (case_claims.claim_id = ?) DESC, cases.id ASC LIMIT 1",
      )
      .get(claimId, claimId) as { id: string; record_json: string } | undefined;
    if (row === undefined) {
      return undefined;
    }
    return { id: row.id as RecordId, record: JSON.parse(row.record_json) as CaseRecord };
  }

  cases(): IndexedCase[] {
    const rows = this.db.prepare("SELECT id, record_json FROM cases ORDER BY id ASC").all() as Array<{
      id: string;
      record_json: string;
    }>;
    return rows.map((row) => ({ id: row.id as RecordId, record: JSON.parse(row.record_json) as CaseRecord }));
  }

  caseSlugs(): string[] {
    const rows = this.db.prepare("SELECT slug FROM cases ORDER BY id ASC").all() as Array<{ slug: string }>;
    return rows.map((row) => row.slug);
  }

  /** Superseded artifacts included: the caller derives the open heads from the whole set. */
  artifactsOfCase(caseId: RecordId): IndexedArtifact[] {
    const rows = this.db
      .prepare("SELECT id, record_json FROM artifacts WHERE case_id = ? ORDER BY id ASC")
      .all(caseId) as Array<{ id: string; record_json: string }>;
    return rows.map((row) => ({ id: row.id as RecordId, record: JSON.parse(row.record_json) as ArtifactRecord }));
  }

  /** Every subject an attestation of `purpose` names, by id. */
  subjectsAttested(purpose: string): RecordId[] {
    const rows = this.db
      .prepare("SELECT DISTINCT subject FROM attestations WHERE purpose = ? ORDER BY subject ASC")
      .all(purpose) as { subject: string }[];
    return rows.map((row) => row.subject as RecordId);
  }

  /** Every purpose answers, revocations included; what one counts for is the caller's. */
  attestationsBySubject(subject: RecordId, principal?: string): IndexedAttestation[] {
    const rows = this.db
      .prepare(
        "SELECT id, record_json FROM attestations WHERE subject = ? AND (? IS NULL OR principal = ?) ORDER BY id ASC",
      )
      .all(subject, principal ?? null, principal ?? null) as Array<{ id: string; record_json: string }>;
    return rows.map((row) => ({ id: row.id as RecordId, record: JSON.parse(row.record_json) as AttestationRecord }));
  }

  /** Every ruling on the slot's live claims, each with the records that name it as a predecessor;
   * which succession retires a ruling is the reader's rule, not the fold's. */
  rulingsFor(slot: string, dimensions: DimensionRegistry): IndexedRulingOnSlot[] {
    const found = new Map<string, IndexedRuling>();
    const claimBound = this.db
      .prepare(
        "SELECT rulings.id AS id, rulings.record_json AS record_json FROM rulings " +
          "JOIN claims ON claims.id = rulings.claim_id WHERE claims.slot = ? " +
          "AND claims.id NOT IN (SELECT predecessor FROM succession)",
      )
      .all(slot) as Array<{ id: string; record_json: string }>;
    for (const row of claimBound) {
      found.set(row.id, { id: row.id as RecordId, record: JSON.parse(row.record_json) as RulingRecord });
    }
    for (const contributor of this.contributorsAtSlot(slot)) {
      const claim = contributor.record as ClaimRecord;
      const typeBound = this.db
        .prepare("SELECT id, over_scope_json, record_json FROM rulings WHERE over_type = ?")
        .all(claim.type) as Array<{ id: string; over_scope_json: string; record_json: string }>;
      for (const row of typeBound) {
        if (scopeAdmits(JSON.parse(row.over_scope_json) as Conditions, claim.conditions, dimensions)) {
          found.set(row.id, { id: row.id as RecordId, record: JSON.parse(row.record_json) as RulingRecord });
        }
      }
    }
    return [...found.values()]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((ruling) => ({ ...ruling, successors: this.successorsOf(ruling.id) }));
  }

  /** Two live records naming one contribution throw, since an order over hashes is arbitrary. */
  ruleFor(contribution: string): IndexedRule | undefined {
    const rows = this.db
      .prepare(
        "SELECT id, record_json FROM rules WHERE contribution = ? " +
          "AND id NOT IN (SELECT predecessor FROM succession) ORDER BY id ASC",
      )
      .all(contribution) as Array<{ id: string; record_json: string }>;
    if (rows.length > 1) {
      throw new RuleRecordConflictError(
        contribution,
        rows.map((row) => row.id as RecordId),
      );
    }
    const [row] = rows;
    return row === undefined
      ? undefined
      : { id: row.id as RecordId, record: JSON.parse(row.record_json) as RuleRecord };
  }

  /** A superseded argument attacks nothing, as a superseded ruling bears on nothing. */
  argumentsAgainst(target: RecordId): IndexedArgument[] {
    const rows = this.db
      .prepare(
        "SELECT id, record_json FROM arguments WHERE target = ? " +
          "AND id NOT IN (SELECT predecessor FROM succession) ORDER BY id ASC",
      )
      .all(target) as Array<{ id: string; record_json: string }>;
    return rows.map((row) => ({ id: row.id as RecordId, record: JSON.parse(row.record_json) as ArgumentRecord }));
  }

  /** In landing order, the order a fork's first succession is read from. */
  successorsOf(id: RecordId): IndexedSuccessor[] {
    const rows = this.db
      .prepare(
        "SELECT succession.successor AS successor, succession.successor_kind AS successor_kind FROM succession " +
          "JOIN records ON records.id = succession.successor JOIN commits ON commits.sha = records.commit_sha " +
          "WHERE succession.predecessor = ? ORDER BY commits.seq ASC, records.position ASC",
      )
      .all(id) as Array<{ successor: string; successor_kind: string }>;
    return rows.map((row) => ({ successor: row.successor as RecordId, kind: row.successor_kind as RecordKind }));
  }

  /** Recorded rather than thrown: one bad path must not stop every later read, nor disappear. */
  refusals(): IndexedRefusal[] {
    const rows = this.db
      .prepare("SELECT commit_sha, path, id, reason FROM refusals ORDER BY commit_sha ASC, path ASC")
      .all() as Array<{ commit_sha: string; path: string; id: string | null; reason: string }>;
    return rows.map((row) => ({
      id: row.id as RecordId | null,
      commit: row.commit_sha,
      path: row.path,
      reason: row.reason,
    }));
  }

  /** Each stays until its declaration is re-pinned or goes away. */
  foldRefusals(): FoldRefusal[] {
    return [...foldRefusalRows(this.db).values()];
  }

  /** A declaration stands whether or not its table was built, so a reader checks this first. */
  foldTablesHeld(): ReadonlySet<string> {
    return new Set(foldTableRows(this.db).keys());
  }

  /** Unsettled where no refusal explains the absence; derived from the fold, not from this pass. */
  absentFoldTables(declared: readonly FoldTable[]): FoldRefusal[] {
    const held = this.foldTablesHeld();
    const written = foldRefusalRows(this.db);
    const absent: FoldRefusal[] = [];
    for (const table of declared) {
      if (held.has(table.name)) {
        continue;
      }
      absent.push(
        written.get(table.name) ?? {
          name: table.name,
          contributionId: table.contributionId,
          moduleRecord: table.moduleRecord,
          version: table.version,
          reason:
            `the table ${table.name}, contributed at ${table.contributionId}, is not in this fold: ` +
            "its row function did not answer here, and the next open tries again",
          settled: false,
        },
      );
    }
    return absent;
  }

  /** Events past `after` in log order; `undefined` when no held commit matches, rather than
   * silently answering from the start. */
  eventsAfter(after?: EventCursor): IndexedEvent[] | undefined {
    let seq = -1;
    if (after !== undefined) {
      const row = this.db.prepare("SELECT seq FROM commits WHERE sha = ?").get(after.commit) as
        | { seq: number }
        | undefined;
      if (row === undefined) {
        return undefined;
      }
      seq = row.seq;
    }
    // A `NULL` position matches no event of the cursor's own commit.
    const rows = this.db
      .prepare(
        "SELECT events.kind AS kind, events.about AS about, events.record_id AS record_id, " +
          "events.commit_sha AS commit_sha, commits.seq AS seq " +
          "FROM events JOIN commits ON events.commit_sha = commits.sha " +
          "WHERE commits.seq > ? OR (commits.seq = ? AND events.position > ?) " +
          "ORDER BY commits.seq ASC, events.position ASC",
      )
      .all(seq, seq, after?.position ?? null) as Array<{
      kind: string;
      about: string;
      record_id: string;
      commit_sha: string;
      seq: number;
    }>;
    return rows.map((row) => ({
      kind: row.kind as EventKind,
      about: row.about,
      recordId: row.record_id as RecordId,
      commit: row.commit_sha,
      seq: row.seq,
    }));
  }

  /** The watermark advances with each commit's rows. Declarations are read again after the walk,
   * so a table declared by a commit this pass folded is built in the same pass. */
  async fold(
    store: RecordStore,
    onStep?: (event: FoldInterruptEvent) => void,
    contributions?: FoldContributions,
    admission?: Admission,
  ): Promise<void> {
    const judged = await this.stampFor(store, admission);
    const tip = judged === undefined ? await store.tip() : judged.through;
    if (!tip) {
      return;
    }

    const cursor = this.walked();
    if (cursor !== null && cursor !== tip && !(await store.descends(cursor, tip))) {
      throw this.historyMoved(cursor, tip);
    }
    if (cursor !== tip) {
      // A table about to be rebuilt needs no per-record invocation.
      const current =
        contributions === undefined
          ? []
          : contributions.declarations().filter((table) => foldTableIsCurrent(this.db, table));
      const loaded =
        contributions !== undefined && current.length > 0 ? await contributions.extensions(current) : undefined;
      try {
        forgetFoldTablesOutside(this.db, loaded?.extensions ?? []);
        await this.walk(store, cursor, tip, loaded?.extensions ?? [], onStep, judged);
      } finally {
        await loaded?.close();
      }
    }

    if (contributions !== undefined) {
      await reconcileFoldTables(this.db, contributions);
    }
  }

  /** Stamps this file with the admission it folds under, judged again once where the stamp lies
   * past it: folding under an older judgement would bring back what a newer one withholds. */
  private async stampFor(store: RecordStore, admission: Admission | undefined): Promise<Admission | undefined> {
    let judged = admission;
    let again = false;
    for (;;) {
      const stamp = this.stamp();
      if (judged !== undefined && (await stampPasses(store, stamp, judged))) {
        if (again) {
          throw this.judgedBehind(judged);
        }
        judged = await judged.judgedAgain();
        again = true;
      } else if (this.swapStamp(stamp, judged)) {
        return judged;
      }
    }
  }

  /** Checked against the stamp read before it and set in one transaction, so two folds under
   * different admissions cannot both reset and then fill one file. */
  private swapStamp(seen: Stamp, admission: Admission | undefined): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const stamp = this.stamp();
      if (!sameStamp(stamp, seen)) {
        this.db.exec("ROLLBACK");
        return false;
      }
      if (admission === undefined) {
        if (stamp.digest !== null) {
          throw new Error(
            `refusing to fold ${this.location} without an admission: it was built under one, and a ` +
              "fold without it would hold every record",
          );
        }
      } else if (stamp.digest !== admission.digest) {
        this.resetSchema(admission);
      } else {
        this.db
          .prepare("UPDATE schema_meta SET through = ?, trust = ? WHERE id = 0")
          .run(admission.through, admission.trust);
      }
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private judgedBehind(admission: Admission): KernelError {
    return new KernelError({
      reason: "head-moved",
      detail: `refusing to fold ${this.location} under an admission judged at ${admission.through ?? "an empty scope"}: the file was folded under one judged past it, and judged again it is still behind; open the workspace again`,
      about: [this.location],
    });
  }

  /** Another fold restamped this file between two batches; folding on would mix two admissions. */
  private assertStamp(admission: Admission | undefined): void {
    if (this.stamp().digest !== (admission?.digest ?? null)) {
      throw new KernelError({
        reason: "head-moved",
        detail: `refusing to fold on: ${this.location} was refolded under another admission while this fold ran`,
        about: [this.location],
      });
    }
  }

  /** Folding on would mix the old history's rows with the new one's, so the reader rebuilds. */
  private historyMoved(watermark: string, tip: string): KernelError {
    const remedy =
      this.location === ":memory:"
        ? "fold into a fresh index"
        : `delete ${dirname(this.location)} and fold again to rebuild it from the new history`;
    return new KernelError({
      reason: "record-corrupted",
      detail: `refusing to fold: the scope's tip ${tip} does not descend from the folded commit ${watermark}, so the history moved under the index; ${remedy}`,
      about: [watermark, tip],
    });
  }

  /** A refused table comes down before its commit applies: dropped after, a crash would leave it
   * claiming rows it lacks. */
  private async walk(
    store: RecordStore,
    cursor: string | null,
    tip: string,
    extensions: readonly FoldExtension[],
    onStep?: (event: FoldInterruptEvent) => void,
    admission?: Admission,
  ): Promise<void> {
    const refusedTables = new Set<string>();
    let grouped = 0;
    let open = false;
    const land = () => {
      if (open) {
        this.db.exec("COMMIT");
        open = false;
        grouped = 0;
      }
    };
    try {
      for await (const { commit, committedAt, order, changed } of store.changesSince(cursor)) {
        onStep?.({ commit, phase: "before-commit" });
        const recordPaths = inWrittenOrder(
          changed.filter(({ path }) => path.startsWith("records/") && !isSidecarPath(path)),
          order,
        );
        const added: FoldedRecord[] = [];
        const refused: RefusedRecordPath[] = [];
        for (const [position, { path, bytes }] of recordPaths.entries()) {
          let id: RecordId;
          try {
            id = idFromPath(path);
            kindFromPath(path);
          } catch (error) {
            refused.push({ id: null, path, reason: error instanceof Error ? error.message : String(error) });
            continue;
          }
          if (bytes === null) {
            throw new KernelError({
              reason: "record-corrupted",
              detail: `refusing the history at commit ${commit}: it deletes the record at ${path}, and a record once written is never removed`,
              about: [commit, path],
            });
          }
          try {
            added.push({ id, record: readStoredRecord(bytes, id, kindFromPath(path)), position });
          } catch (error) {
            if (!(error instanceof RecordRefusedError)) {
              throw error;
            }
            refused.push({ id, path, reason: error.because });
          }
        }
        const judged = admission === undefined ? { added, refused } : this.judge(added, refused, commit, admission);
        const contributed: ContributedRows[] = [];
        const takenDown: Array<{ table: FoldTable; refusal: FoldRefusal | undefined }> = [];
        for (const { id, record, position } of judged.added) {
          // A record already held was answered at its first sighting, the one a backfill sees.
          if (this.holds(id)) {
            continue;
          }
          for (const extension of extensions) {
            if (refusedTables.has(extension.table.name)) {
              continue;
            }
            try {
              contributed.push({
                table: extension.table,
                record: id,
                rows: await extension.rows({ id, kind: record.kind, record, commit, position }),
              });
            } catch (error) {
              refusedTables.add(extension.table.name);
              takenDown.push({ table: extension.table, refusal: foldRefusalOf(extension.table, error) });
            }
          }
        }
        if (takenDown.length > 0) {
          land();
        }
        for (const { table, refusal } of takenDown) {
          takeFoldTableDown(this.db, table.name, refusal);
        }
        if (!open) {
          // Taken whole at the start: a read lock upgraded mid-transaction is refused, not waited.
          this.db.exec("BEGIN IMMEDIATE");
          open = true;
          this.assertStamp(admission);
        }
        if (judged.added.length === 0 && judged.refused.length === 0 && admission !== undefined) {
          // A commit of withheld records alone leaves no row, so it moves nothing a reader sees.
          this.db.prepare("UPDATE walked SET commit_sha = ? WHERE id = 0").run(commit);
        } else {
          applyCommit(
            this.db,
            { sha: commit, committedAt },
            judged.added,
            judged.refused,
            contributed.filter(({ table }) => !refusedTables.has(table.name)),
            onStep,
          );
        }
        grouped += 1;
        if (grouped === COMMITS_PER_TRANSACTION) {
          land();
        }
        if (commit === tip) {
          break;
        }
      }
    } catch (error) {
      if (open) {
        landAfterFailure(this.db);
      }
      throw error;
    }
    land();
  }

  /** Judged together, since a commit may land a record beside what it read: a record that asked
   * about one withheld after it was judged is judged again, and no other. */
  private judge(
    added: readonly FoldedRecord[],
    refused: readonly RefusedRecordPath[],
    commit: string,
    admission: Admission,
  ): Judged {
    const admitted = new Set(added.map(({ id }) => id));
    const landed = new Map(added.map((entry) => [entry.id, entry]));
    const readers = new Map<RecordId, Set<RecordId>>();
    const heldBy = (reader: RecordId) => (id: RecordId) => {
      if (!admitted.has(id)) {
        return this.holds(id);
      }
      const asked = readers.get(id) ?? new Set<RecordId>();
      readers.set(id, asked.add(reader));
      return true;
    };
    const pending: RecordId[] = [];
    const judge = ({ id, record, position }: FoldedRecord) => {
      if (!admission.admits({ id, kind: record.kind, record, commit, position }, heldBy(id))) {
        admitted.delete(id);
        for (const reader of readers.get(id) ?? []) {
          pending.push(reader);
        }
      }
    };
    for (const entry of added) {
      judge(entry);
    }
    for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
      if (admitted.has(id)) {
        judge(landed.get(id)!);
      }
    }
    const held = (id: RecordId) => admitted.has(id) || this.holds(id);
    return {
      added: added.filter(({ id }) => admitted.has(id)),
      refused: refused.filter(({ id }) => id === null || !admission.withholds(id, commit, held)),
    };
  }
}
