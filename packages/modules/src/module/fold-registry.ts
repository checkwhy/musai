import type { IndexDb, IndexedContribution } from "@musai/fold";
import {
  type DeclaredFoldRefusal,
  type DeclaredFoldTable,
  type DeclaredFoldTables,
  type FoldColumn,
  type FoldColumnType,
  type FoldEngine,
  type FoldExtension,
  type FoldRow,
  FoldRowRefusedError,
  type FoldTable,
  type FoldTables,
  type IndexCapability,
  type IndexedRecordInput,
  isIndexCapability,
  isSafeSqlIdentifier,
  KERNEL_INDEX_TABLES,
  type LoadedFoldExtensions,
  refusedDdl,
} from "@musai/fold";
import type { ContributionEntry, ModuleRecord } from "@musai/records";
import { isKernelError, isPlainObject, KernelError } from "@musai/records";
import type { BlobStore } from "@musai/store";
import { ENVELOPE_PROTOCOL, type EnvelopeRequest, type ErrorCode, kernelPoint } from "../rule/envelope.js";
import { firstAvailableHost, type HostDescriptor, type ModuleHost } from "./hosts.js";

/** Raised when a `fold` contribution cannot become a table the workspace's engine serves. */
export class FoldRefusedError extends KernelError {
  constructor(message: string, about?: readonly string[]) {
    super({ reason: "invalid-input", detail: message, about });
    this.name = "FoldRefusedError";
  }
}

/** The top-level keys a row schema may carry, which bounds what ever reaches `compile`. */
const ADMITTED_ROW_SCHEMA_KEYS: ReadonlySet<string> = new Set([
  "type",
  "additionalProperties",
  "required",
  "properties",
  "indexes",
  "requires",
]);

/** The SQLite type each declared column type binds as; any other is refused, never coerced. */
export const COLUMN_TYPES: ReadonlyMap<string, FoldColumnType> = new Map<string, FoldColumnType>([
  ["string", "TEXT"],
  ["integer", "INTEGER"],
  ["number", "REAL"],
]);

const KERNEL_OWNED_COLUMNS: ReadonlySet<string> = new Set(["record_id", "ordinal"]);

/** Folds every character outside `[a-z0-9]` so a hyphenated or capitalised id installs. The
 * folding is lossy; the collision refusal covers that. */
function tableNameFor(contributionId: string): string {
  return contributionId.toLowerCase().replace(/[^a-z0-9]/g, "_");
}

function admitsEverything(schema: unknown): boolean {
  return schema === true || (isPlainObject(schema) && Object.keys(schema).length === 0);
}

function columnsFrom(entry: ContributionEntry, items: Record<string, unknown>): readonly FoldColumn[] {
  const properties = items["properties"];
  if (!isPlainObject(properties) || Object.keys(properties).length === 0) {
    throw new FoldRefusedError(
      `refusing to register ${entry.id}: its rows must declare at least one column as the properties of their own schema`,
      [entry.id],
    );
  }
  const requiredField = items["required"] ?? [];
  if (!Array.isArray(requiredField) || !requiredField.every((name) => typeof name === "string")) {
    throw new FoldRefusedError(
      `refusing to register ${entry.id}: the required columns of its rows must be an array of column names`,
      [entry.id],
    );
  }
  const required = new Set(requiredField as string[]);
  const columns: FoldColumn[] = [];
  for (const [name, declared] of Object.entries(properties)) {
    if (!isSafeSqlIdentifier(name)) {
      throw new FoldRefusedError(
        `refusing to register ${entry.id}: its column ${JSON.stringify(name)} is not a lowercase identifier`,
        [entry.id, name],
      );
    }
    if (KERNEL_OWNED_COLUMNS.has(name)) {
      throw new FoldRefusedError(
        `refusing to register ${entry.id}: ${name} is a column the kernel puts on every contributed table and keys it by`,
        [entry.id, name],
      );
    }
    const type = isPlainObject(declared) ? declared["type"] : undefined;
    const columnType = typeof type === "string" ? COLUMN_TYPES.get(type) : undefined;
    if (columnType === undefined) {
      throw new FoldRefusedError(
        `refusing to register ${entry.id}: its column ${name} declares the type ${JSON.stringify(type)}, which no SQLite column binds`,
        [entry.id, name],
      );
    }
    columns.push({ name, type: columnType, notNull: required.has(name) });
  }
  return columns;
}

function indexesFrom(
  entry: ContributionEntry,
  output: Record<string, unknown>,
  columns: readonly FoldColumn[],
): readonly (readonly string[])[] {
  const declared = output["indexes"] ?? [];
  if (!Array.isArray(declared)) {
    throw new FoldRefusedError(`refusing to register ${entry.id}: its indexes must be an array of column-name arrays`, [
      entry.id,
    ]);
  }
  const held = new Set(columns.map((column) => column.name));
  return declared.map((columnNames) => {
    if (!Array.isArray(columnNames) || columnNames.length === 0 || !columnNames.every((name) => held.has(name))) {
      throw new FoldRefusedError(
        `refusing to register ${entry.id}: its index ${JSON.stringify(columnNames)} names something its own columns do not`,
        [entry.id],
      );
    }
    return columnNames as string[];
  });
}

function requiresFrom(entry: ContributionEntry, output: Record<string, unknown>): readonly IndexCapability[] {
  const declared = output["requires"] ?? [];
  if (!Array.isArray(declared) || !declared.every(isIndexCapability)) {
    throw new FoldRefusedError(
      `refusing to register ${entry.id}: what it requires of the engine must be an array of capabilities this kernel admits`,
      [entry.id],
    );
  }
  return declared;
}

/** The table one `fold` entry declares; its input must narrow nothing. A row omits a column to
 * leave it `NULL`, since an explicit `null` fails the schema the entry published. */
export function foldTableFromEntry(entry: ContributionEntry): DeclaredFoldTable {
  if (!admitsEverything(entry.input)) {
    throw new FoldRefusedError(
      `refusing to register ${entry.id}: a row function sees every record, so its input must narrow nothing`,
      [entry.id],
    );
  }
  if (!isPlainObject(entry.output)) {
    throw new FoldRefusedError(`refusing to register ${entry.id}: a fold must declare its rows as its output`, [
      entry.id,
    ]);
  }
  for (const key of Object.keys(entry.output)) {
    if (!ADMITTED_ROW_SCHEMA_KEYS.has(key)) {
      throw new FoldRefusedError(
        `refusing to register ${entry.id}: its output carries ${JSON.stringify(key)}, which is outside ${[...ADMITTED_ROW_SCHEMA_KEYS].join(", ")}`,
        [entry.id, key],
      );
    }
  }
  const properties = entry.output["properties"];
  const rows = isPlainObject(properties) ? properties["rows"] : undefined;
  const items = isPlainObject(rows) ? rows["items"] : undefined;
  if (!isPlainObject(items)) {
    throw new FoldRefusedError(
      `refusing to register ${entry.id}: its output must declare the schema one row satisfies as the items of its rows`,
      [entry.id],
    );
  }
  const columns = columnsFrom(entry, items);
  const name = tableNameFor(entry.id);
  if (!isSafeSqlIdentifier(name)) {
    throw new FoldRefusedError(
      `refusing to register ${entry.id}: it renders the table name ${JSON.stringify(name)}, which is not a lowercase identifier`,
      [entry.id, name],
    );
  }
  if (KERNEL_INDEX_TABLES.has(name)) {
    throw new FoldRefusedError(`refusing to register ${entry.id}: ${name} is a table the kernel's own fold holds`, [
      entry.id,
      name,
    ]);
  }
  return {
    name,
    columns,
    indexes: indexesFrom(entry, entry.output, columns),
    requires: requiresFrom(entry, entry.output),
    version: entry.version,
    contributionId: entry.id,
  };
}

/** Takes the engine rather than fetching it, so the refusal is provable on any machine. */
function assertCapabilitiesAvailable(table: DeclaredFoldTable, moduleName: string, engine: FoldEngine): void {
  for (const capability of table.requires) {
    if (!engine.capabilities.has(capability)) {
      throw new FoldRefusedError(
        `refusing to fold ${table.name}, contributed by ${moduleName} at ${table.contributionId}: ` +
          `it requires ${capability}, which this workspace's index provider ${engine.name} does not offer`,
        [table.name, moduleName, table.contributionId, capability],
      );
    }
  }
}

/** Every `fold` declaration as a table, or a refusal; nothing is thrown for the set. A collision
 * refuses whichever row comes second, so both callers keep `contributionsOf` order. */
export function foldTablesFrom(
  rows: readonly Pick<IndexedContribution, "entry" | "moduleName">[],
  engine: FoldEngine,
): DeclaredFoldTables {
  const byName = new Map<string, string>();
  const declaredBy = new Map<string, string>(rows.map(({ entry, moduleName }) => [entry.id, moduleName]));
  const tables: DeclaredFoldTable[] = [];
  const refused: DeclaredFoldRefusal[] = [];
  for (const { entry, moduleName } of rows) {
    try {
      const table = foldTableFromEntry(entry);
      const held = byName.get(table.name);
      if (held !== undefined) {
        throw new FoldRefusedError(
          `refusing to register ${entry.id}: it renders the table name ${table.name}, which ${held} already renders`,
          [entry.id, held, table.name],
        );
      }
      assertCapabilitiesAvailable(table, moduleName, engine);
      byName.set(table.name, entry.id);
      tables.push(table);
    } catch (error) {
      if (!(error instanceof FoldRefusedError)) {
        throw error;
      }
      refused.push({
        name: tableNameFor(entry.id),
        contributionId: entry.id,
        version: entry.version,
        reason: error.detail,
        settled: true,
      });
    }
  }
  // With no table there is nothing to render, so the common fold opens no scratch database.
  if (tables.length === 0) {
    return { tables, refused };
  }
  const refusedStatements = refusedDdl(tables, engine.scratch);
  for (const { table, statement, reason } of refusedStatements) {
    refused.push({
      name: table.name,
      contributionId: table.contributionId,
      version: table.version,
      settled: true,
      reason:
        `refusing to fold ${table.name}, contributed by ${declaredBy.get(table.contributionId)} at ${table.contributionId}: ` +
        `${engine.name} refuses the statement it renders, ${statement}: ${reason}`,
    });
  }
  const refusedNames = new Set(refusedStatements.map(({ table }) => table.name));
  return { tables: tables.filter((table) => !refusedNames.has(table.name)), refused };
}

/** The tables the installed modules declare, read from the fold without running module code. */
export function readFoldDeclarations(index: IndexDb, engine: FoldEngine): FoldTables {
  const rows = index.contributionsOf("fold");
  const declaredIn = new Map(rows.map((row) => [row.entry.id, row.moduleRecord]));
  const declared = foldTablesFrom(rows, engine);
  return {
    tables: declared.tables.map((table) => ({ ...table, moduleRecord: declaredIn.get(table.contributionId)! })),
    refused: declared.refused.map((refusal) => ({
      ...refusal,
      moduleRecord: declaredIn.get(refusal.contributionId)!,
    })),
  };
}

/** Whether a fold remembers a failure with this code: only one the bundle alone answers, since
 * only a re-pin clears the memory. */
export const ANSWERED_BY_THE_DECLARATION: Record<ErrorCode, boolean> = {
  // The bundle answering about itself: a re-pin is the event that can change the answer.
  "unknown-contribution": true,
  "invalid-output": true,
  "contribution-threw": true,
  // A kernel, host, machine or environment change can flip these with no re-pin.
  "invalid-input": false,
  "protocol-mismatch": false,
  "time-limit": false,
  "memory-limit": false,
  "need-refused": false,
  "unsupported-need": false,
  stall: false,
};

/** `null` where the host cannot load the bundle, as when its blob never arrived. The first pass
 * that can load it builds the table. */
async function loadedThrough(host: ModuleHost, modulePath: string): Promise<{ handle: unknown } | null> {
  try {
    return { handle: await host.load(modulePath, "invoke") };
  } catch {
    return null;
  }
}

/** `undefined` for a module with no bundle, or one whose blob never arrived. */
async function bundlePathOf(index: IndexDb, blobs: BlobStore, table: FoldTable): Promise<string | undefined> {
  const held = index.recordById(table.moduleRecord);
  const bundle = held?.record.kind === "module" ? (held.record as ModuleRecord).bundle : null;
  if (bundle === null) {
    return undefined;
  }
  try {
    return await blobs.materialise(bundle);
  } catch (error) {
    if (isKernelError(error) && error.reason === "no-such-record") {
      return undefined;
    }
    throw error;
  }
}

/** One extension per table, each module loaded once per pass rather than once per record. A
 * table this machine cannot run gets none and waits for a pass that can. */
export async function foldExtensionsFrom(
  tables: readonly FoldTable[],
  index: IndexDb,
  blobs: BlobStore,
  hosts: readonly HostDescriptor[],
): Promise<LoadedFoldExtensions> {
  if (tables.length === 0) {
    return { extensions: [], close: async () => {} };
  }
  const descriptor = await firstAvailableHost(hosts);
  if (descriptor === undefined) {
    return { extensions: [], close: async () => {} };
  }
  const point = kernelPoint("fold")!;
  const entries = new Map(index.contributionsOf("fold").map((row) => [row.entry.id, row.entry]));
  const host: ModuleHost = descriptor.create();
  const loaded = new Map<string, { handle: unknown } | null>();
  const extensions: FoldExtension[] = [];
  try {
    for (const table of tables) {
      const entry = entries.get(table.contributionId);
      const modulePath = await bundlePathOf(index, blobs, table);
      // A table with no declaration or no bundle takes no extension, so the fold drops it.
      if (entry === undefined || modulePath === undefined) {
        continue;
      }
      if (!loaded.has(modulePath)) {
        loaded.set(modulePath, await loadedThrough(host, modulePath));
      }
      const held = loaded.get(modulePath) ?? null;
      if (held === null) {
        continue;
      }
      extensions.push({
        table,
        rows: async (record: IndexedRecordInput) => {
          const request: EnvelopeRequest = {
            protocol: ENVELOPE_PROTOCOL,
            contribution: entry.kind,
            id: entry.id,
            version: entry.version,
            input: record,
          };
          // The declaration's own failure is written down; any other is retried at the next open.
          const { response } = await host.invoke(held.handle, request, { entry, point });
          if (!response.ok) {
            const about = [table.name, entry.id, record.id];
            const detail = `refusing to fold ${table.name}, contributed at ${entry.id}, over the record ${record.id}: ${response.error.message}`;
            if (!ANSWERED_BY_THE_DECLARATION[response.error.code]) {
              throw new KernelError({ reason: "tool-unavailable", detail, about });
            }
            throw new FoldRowRefusedError(detail, about);
          }
          return (response.output as { rows: readonly FoldRow[] }).rows;
        },
      });
    }
  } catch (error) {
    await host.close?.();
    throw error;
  }
  return {
    extensions,
    close: async () => {
      await host.close?.();
    },
  };
}
