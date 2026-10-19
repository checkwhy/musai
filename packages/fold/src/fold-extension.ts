import type { MusaiRecord, RecordId } from "@musai/records";
import { KernelError } from "@musai/records";
import { KERNEL_INDEX_TABLES } from "./schema.js";
import type { IndexCapability, IndexConnection } from "./sqlite-provider.js";

/** A refusal the declaration answers for, the only one a fold remembers: the same bundle refuses
 * the same record every time. */
export class FoldRowRefusedError extends KernelError {
  constructor(message: string, about: readonly string[]) {
    super({ reason: "invalid-input", detail: message, about });
    this.name = "FoldRowRefusedError";
  }
}

/** One SQLite type per JSON Schema type a row value may carry. */
export type FoldColumnType = "TEXT" | "INTEGER" | "REAL";

export interface FoldColumn {
  readonly name: string;
  readonly type: FoldColumnType;
  readonly notNull: boolean;
}

/** The table one `fold` contribution declares; a change to its version rebuilds it. */
export interface DeclaredFoldTable {
  readonly name: string;
  readonly columns: readonly FoldColumn[];
  readonly indexes: readonly (readonly string[])[];
  readonly requires: readonly IndexCapability[];
  readonly version: string;
  readonly contributionId: string;
}

/** A declared table with its module record, which tells a rebuilt bundle from an unchanged one. */
export interface FoldTable extends DeclaredFoldTable {
  readonly moduleRecord: RecordId;
}

/** A declaration that could not stand; it costs its own table or query and nothing else. */
export interface DeclaredFoldRefusal {
  readonly name: string;
  readonly contributionId: string;
  readonly version: string;
  readonly reason: string;
  /** Whether the fold stops asking; a table this machine could not build is retried instead. */
  readonly settled: boolean;
}

/** A refusal with its module record; once a re-pin moves the record, the table is built afresh. */
export interface FoldRefusal extends DeclaredFoldRefusal {
  readonly moduleRecord: RecordId;
}

export interface DeclaredFoldTables {
  readonly tables: readonly DeclaredFoldTable[];
  readonly refused: readonly DeclaredFoldRefusal[];
}

export interface FoldTables {
  readonly tables: readonly FoldTable[];
  readonly refused: readonly FoldRefusal[];
}

/** Keyed by declared column name; a column the row leaves out lands as SQL `NULL`. */
export type FoldRow = Record<string, unknown>;

/** `commit` and `position` are the first sighting, so a walk and a backfill agree. */
export interface IndexedRecordInput {
  readonly id: RecordId;
  readonly kind: string;
  readonly record: MusaiRecord;
  readonly commit: string;
  readonly position: number;
}

/** `rows` raises `FoldRowRefusedError` for the declaration's own failure, which is remembered, and
 * anything else for this machine's, which is retried at the next open. */
export interface FoldExtension {
  readonly table: FoldTable;
  readonly rows: (record: IndexedRecordInput) => Promise<readonly FoldRow[]>;
}

/** Read from contributions the fold holds, opening no bundle, so a second read costs a query. */
export type FoldDeclarations = () => readonly FoldTable[];

export interface LoadedFoldExtensions {
  readonly extensions: readonly FoldExtension[];
  readonly close: () => Promise<void>;
}

/** Called with the tables a pass will write, so a bundle loads only when a row is due. */
export type FoldExtensions = (tables: readonly FoldTable[]) => Promise<LoadedFoldExtensions>;

export interface FoldContributions {
  readonly declarations: FoldDeclarations;
  readonly extensions: FoldExtensions;
}

/** `scratch` opens a database for a declaration to be rendered into before it is admitted. */
export interface FoldEngine {
  readonly name: string;
  readonly capabilities: ReadonlySet<IndexCapability>;
  readonly scratch: () => IndexConnection;
}

export function ddlFor(table: DeclaredFoldTable): readonly string[] {
  const declared = table.columns.map(
    (column) => `        ${column.name} ${column.type}${column.notNull ? " NOT NULL" : ""}`,
  );
  const statements = [
    [
      `CREATE TABLE ${table.name} (`,
      "        record_id TEXT NOT NULL,",
      "        ordinal INTEGER NOT NULL,",
      ...declared.map((line) => `${line},`),
      "        PRIMARY KEY (record_id, ordinal)",
      "      );",
    ].join("\n"),
  ];
  for (const columns of table.indexes) {
    statements.push(`CREATE INDEX ${table.name}_by_${columns.join("_")} ON ${table.name} (${columns.join(", ")});`);
  }
  return statements;
}

export interface FoldRowStatements {
  readonly remove: string;
  readonly insert: string;
}

/** Rendered beside `ddlFor`, so the declaration check compiles every statement naming a column. */
export function rowStatementsFor(table: DeclaredFoldTable): FoldRowStatements {
  const columns = table.columns.map((column) => column.name);
  const placeholders = ["?", "?", ...columns.map(() => "?")].join(", ");
  return {
    remove: `DELETE FROM ${table.name} WHERE record_id = ?`,
    insert: `INSERT INTO ${table.name} (record_id, ordinal, ${columns.join(", ")}) VALUES (${placeholders})`,
  };
}

/** Takes a name, not a declaration: a table nothing declares any more is dropped by name. */
export function dropStatementFor(table: string): string {
  return `DROP TABLE IF EXISTS ${table};`;
}

export interface RefusedDdl {
  readonly table: DeclaredFoldTable;
  readonly statement: string;
  readonly reason: string;
}

/** The engine, not a word list, decides. Every rendered statement is checked, since a column name a
 * `CREATE TABLE` accepts an `INSERT` can still refuse. */
export function refusedDdl(tables: readonly DeclaredFoldTable[], scratch: () => IndexConnection): RefusedDdl[] {
  const refused: RefusedDdl[] = [];
  const connection = scratch();
  try {
    for (const statements of KERNEL_INDEX_TABLES.values()) {
      for (const statement of statements) {
        connection.exec(statement);
      }
    }
    for (const table of tables) {
      const held = firstStatementRefused(table, connection);
      if (held !== undefined) {
        refused.push(held);
      }
    }
    return refused;
  } finally {
    connection.close();
  }
}

/** The writes are compiled, not run: a check has no row to write. */
function firstStatementRefused(table: DeclaredFoldTable, connection: IndexConnection): RefusedDdl | undefined {
  const written = rowStatementsFor(table);
  for (const statement of ddlFor(table)) {
    try {
      connection.exec(statement);
    } catch (error) {
      return { table, statement, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  for (const statement of [written.remove, written.insert, dropStatementFor(table.name)]) {
    try {
      connection.prepare(statement);
    } catch (error) {
      return { table, statement, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  return undefined;
}
