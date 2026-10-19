import type { MusaiRecord, RecordId } from "@musai/records";
import { writeContributedRows } from "./apply-commit.js";
import {
  ddlFor,
  dropStatementFor,
  type FoldContributions,
  type FoldExtension,
  type FoldRefusal,
  FoldRowRefusedError,
  type FoldTable,
} from "./fold-extension.js";
import type { ContributedRows } from "./rows.js";
import type { IndexConnection } from "./sqlite-provider.js";

interface FoldTableRow {
  contributionId: string;
  moduleRecord: string;
  version: string;
  ddl: string;
}

function holdsTable(db: IndexConnection, name: string): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

export function foldRefusalRows(db: IndexConnection): Map<string, FoldRefusal> {
  const rows = db
    .prepare("SELECT name, contribution_id, module_record, version, reason FROM fold_refusals ORDER BY name ASC")
    .all() as Array<{
    name: string;
    contribution_id: string;
    module_record: string;
    version: string;
    reason: string;
  }>;
  return new Map(
    rows.map((row) => [
      row.name,
      {
        name: row.name,
        contributionId: row.contribution_id,
        moduleRecord: row.module_record as RecordId,
        version: row.version,
        reason: row.reason,
        settled: true,
      },
    ]),
  );
}

export function foldTableRows(db: IndexConnection): Map<string, FoldTableRow> {
  const rows = db
    .prepare("SELECT name, contribution_id, module_record, version, ddl FROM fold_tables ORDER BY name ASC")
    .all() as Array<{
    name: string;
    contribution_id: string;
    module_record: string;
    version: string;
    ddl: string;
  }>;
  return new Map(
    rows.map((row) => [
      row.name,
      {
        contributionId: row.contribution_id,
        moduleRecord: row.module_record,
        version: row.version,
        ddl: row.ddl,
      },
    ]),
  );
}

/** The module record is compared too: a pack rebuilt at its old version may answer differently. */
export function foldTableIsCurrent(db: IndexConnection, table: FoldTable): boolean {
  const row = foldTableRows(db).get(table.name);
  return (
    row !== undefined &&
    holdsTable(db, table.name) &&
    row.moduleRecord === table.moduleRecord &&
    row.version === table.version &&
    row.ddl === ddlFor(table).join("\n")
  );
}

/** Runs before the walk: a table it skips would claim rows for records past the watermark. */
export function forgetFoldTablesOutside(db: IndexConnection, extensions: readonly FoldExtension[]): void {
  const writing = new Set(extensions.map((extension) => extension.table.name));
  for (const name of foldTableRows(db).keys()) {
    if (!writing.has(name)) {
      takeFoldTableDown(db, name);
    }
  }
}

/** Rebuilds each stale table in its own transaction. A declaration its recorded refusal still
 * matches is not retried, so the drop stays stable until a re-pin. */
export async function reconcileFoldTables(db: IndexConnection, contributions: FoldContributions): Promise<void> {
  const declared = contributions.declarations();
  forgetFoldRefusalsOutside(db, declared);
  const declaredNames = new Set(declared.map((table) => table.name));
  const stale = [...foldTableRows(db).keys()].filter((name) => !declaredNames.has(name));
  const toBuild = declared.filter((table) => !foldTableIsCurrent(db, table) && !foldTableIsRefused(db, table));
  if (stale.length === 0 && toBuild.length === 0) {
    return;
  }
  const loaded = toBuild.length === 0 ? undefined : await contributions.extensions(toBuild);
  try {
    const settled = new Set<string>();
    for (const extension of loaded?.extensions ?? []) {
      try {
        buildFoldTable(db, extension.table, await backfillRows(db, extension));
      } catch (error) {
        takeFoldTableDown(db, extension.table.name, foldRefusalOf(extension.table, error));
      }
      settled.add(extension.table.name);
    }
    for (const name of [...stale, ...toBuild.map((table) => table.name).filter((name) => !settled.has(name))]) {
      takeFoldTableDown(db, name);
    }
  } finally {
    await loaded?.close();
  }
}

/** Reads the fold in the walk's log order, so a rebuilt table matches a walked one. */
async function backfillRows(db: IndexConnection, extension: FoldExtension): Promise<ContributedRows[]> {
  const rows = db
    .prepare(
      "SELECT records.id AS id, records.kind AS kind, records.record_json AS record_json, " +
        "records.commit_sha AS commit_sha, records.position AS position FROM records " +
        "JOIN commits ON commits.sha = records.commit_sha ORDER BY commits.seq ASC, records.position ASC",
    )
    .all() as Array<{ id: string; kind: string; record_json: string; commit_sha: string; position: number }>;
  const contributed: ContributedRows[] = [];
  for (const row of rows) {
    const id = row.id as RecordId;
    contributed.push({
      table: extension.table,
      record: id,
      rows: await extension.rows({
        id,
        kind: row.kind,
        record: JSON.parse(row.record_json) as MusaiRecord,
        commit: row.commit_sha,
        position: row.position,
      }),
    });
  }
  return contributed;
}

function buildFoldTable(db: IndexConnection, table: FoldTable, contributed: readonly ContributedRows[]): void {
  const ddl = ddlFor(table);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(dropStatementFor(table.name));
    for (const statement of ddl) {
      db.exec(statement);
    }
    for (const { record, rows } of contributed) {
      writeContributedRows(db, table, record, rows);
    }
    db.prepare(
      "INSERT INTO fold_tables (name, contribution_id, module_record, version, ddl) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(name) DO UPDATE SET contribution_id = excluded.contribution_id, " +
        "module_record = excluded.module_record, version = excluded.version, ddl = excluded.ddl",
    ).run(table.name, table.contributionId, table.moduleRecord, table.version, ddl.join("\n"));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** With no refusal nothing is recorded, so a table this machine could not fill is retried. */
export function takeFoldTableDown(db: IndexConnection, name: string, refusal?: FoldRefusal): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(dropStatementFor(name));
    db.prepare("DELETE FROM fold_tables WHERE name = ?").run(name);
    if (refusal !== undefined) {
      db.prepare(
        "INSERT INTO fold_refusals (name, contribution_id, module_record, version, reason) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(name) DO UPDATE SET contribution_id = excluded.contribution_id, " +
          "module_record = excluded.module_record, version = excluded.version, reason = excluded.reason",
      ).run(refusal.name, refusal.contributionId, refusal.moduleRecord, refusal.version, refusal.reason);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function foldTableIsRefused(db: IndexConnection, table: FoldTable): boolean {
  return answersDeclaration(foldRefusalRows(db).get(table.name), table);
}

/** A re-pin changes the module record and so clears its refusal: the one recovery a person has. */
function forgetFoldRefusalsOutside(db: IndexConnection, declared: readonly FoldTable[]): void {
  const held = foldRefusalRows(db);
  const standing = new Set(
    declared.filter((table) => answersDeclaration(held.get(table.name), table)).map((table) => table.name),
  );
  for (const name of held.keys()) {
    if (!standing.has(name)) {
      db.prepare("DELETE FROM fold_refusals WHERE name = ?").run(name);
    }
  }
}

function answersDeclaration(refusal: FoldRefusal | undefined, table: FoldTable): boolean {
  return refusal !== undefined && refusal.moduleRecord === table.moduleRecord && refusal.version === table.version;
}

/** `undefined` for a host failure: only the declaration's own refusal is remembered, since a
 * machine's bad moment written down would be permanent. */
export function foldRefusalOf(table: FoldTable, error: unknown): FoldRefusal | undefined {
  if (!(error instanceof FoldRowRefusedError)) {
    return undefined;
  }
  return {
    name: table.name,
    contributionId: table.contributionId,
    moduleRecord: table.moduleRecord,
    version: table.version,
    reason: error.message,
    settled: true,
  };
}
