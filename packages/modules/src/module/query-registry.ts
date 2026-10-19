import type { DeclaredQuery, IndexConnection, IndexDb, QueryDeclaration } from "@musai/fold";
import {
  type DeclaredFoldTable,
  ddlFor,
  type FoldEngine,
  type FoldRefusal,
  isSafeSqlIdentifier,
  KERNEL_INDEX_TABLES,
  QUERYABLE_KERNEL_TABLES,
} from "@musai/fold";
import type { ContributionEntry } from "@musai/records";
import { isPlainObject, KernelError } from "@musai/records";
import { Ajv } from "ajv";
import { kernelPoint } from "../rule/envelope.js";
import { COLUMN_TYPES, readFoldDeclarations } from "./fold-registry.js";
import { onFirstUse } from "./on-first-use.js";

/** Raised when a `query` contribution cannot stand, or a caller names a query none declares. */
export class QueryRefusedError extends KernelError {
  constructor(message: string, about?: readonly string[]) {
    super({ reason: "invalid-input", detail: message, about });
    this.name = "QueryRefusedError";
  }
}

// Operands compile again on every fold read; registering them by `$id` would refuse that.
const ajv = new Ajv({ strict: false, allErrors: true, addUsedSchema: false });

const parameterSchema = onFirstUse(() =>
  ajv.compile<{
    readonly statement: string;
    readonly tables: readonly string[];
    readonly properties: Record<string, unknown>;
  }>(kernelPoint("query")!.input as Record<string, unknown> | boolean),
);

const rowSchema = onFirstUse(() =>
  ajv.compile<{
    readonly properties: { readonly rows: { readonly items: Record<string, unknown> } };
  }>(kernelPoint("query")!.output as Record<string, unknown> | boolean),
);

/** The types a parameter binds as, closed because a type outside them binds under one engine
 * and throws under the other. */
const BOUND_PARAMETER_TYPES: ReadonlySet<string> = new Set([...COLUMN_TYPES.keys(), "null"]);

/** The verb a statement opens with. It says nothing of what it does: a `WITH` can end in a
 * `DELETE`, which the read-only connection refuses. */
function leadingKeyword(statement: string): string {
  return /^\s*([A-Za-z]*)/.exec(statement)![1]!.toUpperCase();
}

/** The first control character but tab, newline or return: an engine stops reading there. */
function controlCharacterIn(statement: string): string | undefined {
  for (const character of statement) {
    const point = character.codePointAt(0)!;
    if (point !== 9 && point !== 10 && point !== 13 && (point < 32 || point === 127)) {
      return character;
    }
  }
  return undefined;
}

/** The statement with comments, literals and quoted identifiers blanked in place, so an index
 * into it is an index into the statement and a colon in `'sha256:%'` binds nothing. */
function sqlCodeOnly(statement: string): string {
  const out = statement.split("");
  const blank = (from: number, to: number): void => {
    for (let at = from; at < to; at += 1) {
      if (out[at] !== "\n") {
        out[at] = " ";
      }
    }
  };
  const endOf = (opener: string, from: number): number => {
    const close = statement.indexOf(opener, from);
    return close === -1 ? statement.length : close;
  };
  let at = 0;
  while (at < statement.length) {
    const char = statement[at]!;
    if (char === "-" && statement[at + 1] === "-") {
      const stop = endOf("\n", at);
      blank(at, stop);
      at = stop;
    } else if (char === "/" && statement[at + 1] === "*") {
      const close = statement.indexOf("*/", at + 2);
      const stop = close === -1 ? statement.length : close + 2;
      blank(at, stop);
      at = stop;
    } else if (char === "'" || char === '"' || char === "`") {
      at += 1;
      const start = at;
      // A doubled quote is that quote's own character, so a run ends at an undoubled quote.
      while (at < statement.length && !(statement[at] === char && statement[at + 1] !== char)) {
        at += statement[at] === char ? 2 : 1;
      }
      blank(start, at);
      at += 1;
    } else if (char === "[") {
      const close = endOf("]", at + 1);
      blank(at + 1, close);
      at = close + 1;
    } else {
      at += 1;
    }
  }
  return out.join("");
}

/** Every placeholder form an engine binds, not only `:name`, so the others can be refused. */
function placeholdersIn(code: string): readonly string[] {
  return code.match(/[:@$][A-Za-z0-9_]+|\?[0-9]*/g) ?? [];
}

/** Refuses a statement that is not one whole `SELECT` or `WITH`, or that binds a value by any
 * spelling but a declared `:name`: the others bind under one engine only, or bind nothing. */
function assertStatementShape(entry: ContributionEntry, statement: string, parameters: Record<string, unknown>) {
  const code = sqlCodeOnly(statement);
  const keyword = leadingKeyword(statement);
  if (keyword !== "SELECT" && keyword !== "WITH") {
    throw new QueryRefusedError(
      `refusing to register ${entry.id}: a query's statement must begin with SELECT or WITH, and this one begins ${JSON.stringify(keyword)}`,
      [entry.id, keyword],
    );
  }
  // Read off the statement, not its code: an engine stops at a control character in a literal too.
  const control = controlCharacterIn(statement);
  if (control !== undefined) {
    const point = `U+${control.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
    throw new QueryRefusedError(
      `refusing to register ${entry.id}: its statement carries the control character ${point}, and an engine reads a statement's text up to the first of those and no further, so the text a workspace ran would be a prefix of the text it declared with nothing to say so`,
      [entry.id, point],
    );
  }
  if (code.includes(";")) {
    throw new QueryRefusedError(
      `refusing to register ${entry.id}: its statement carries a ";", and an engine compiles the first statement of a text and discards the rest, so the text a workspace ran would not be the text it declared`,
      [entry.id],
    );
  }
  const placeholders = placeholdersIn(code);
  const bound = new Set(placeholders.filter((token) => token.startsWith(":")).map((token) => token.slice(1)));
  const declared = new Set(Object.keys(parameters));
  for (const name of declared) {
    if (!bound.has(name)) {
      throw new QueryRefusedError(
        `refusing to register ${entry.id}: it declares the parameter ${name}, which its statement never binds as :${name}, the one spelling every engine this kernel runs on binds a name by`,
        [entry.id, name],
      );
    }
  }
  for (const token of placeholders) {
    if (token.startsWith("?")) {
      throw new QueryRefusedError(
        `refusing to register ${entry.id}: its statement binds ${token}, which an engine binds by position and a declaration describes its parameters by name, so nothing a caller passes could ever reach it; a query binds each value as :name`,
        [entry.id, token],
      );
    }
    if (!token.startsWith(":")) {
      throw new QueryRefusedError(
        `refusing to register ${entry.id}: its statement binds ${token}, and :${token.slice(1)} is the spelling every engine this kernel runs on binds a name by`,
        [entry.id, token],
      );
    }
  }
  for (const name of bound) {
    if (!declared.has(name)) {
      throw new QueryRefusedError(
        `refusing to register ${entry.id}: its statement binds :${name}, which it declares no parameter for, so every call would bind it as nothing and no caller could see it in the parameters this query advertises`,
        [entry.id, name],
      );
    }
  }
}

/** Refuses a parameter typed outside the bound vocabulary, or untyped, which binds any shape. */
function assertParametersBind(entry: ContributionEntry, parameters: Record<string, unknown>): void {
  for (const [name, declared] of Object.entries(parameters)) {
    const type = isPlainObject(declared) ? declared["type"] : undefined;
    const declaredTypes = Array.isArray(type) ? type : [type];
    const bindable =
      declaredTypes.length > 0 &&
      declaredTypes.every((one) => typeof one === "string" && BOUND_PARAMETER_TYPES.has(one));
    if (!bindable) {
      throw new QueryRefusedError(
        `refusing to register ${entry.id}: its parameter ${name} declares the type ${JSON.stringify(type)}, ` +
          `and a value a caller passes is bound as one of ${[...BOUND_PARAMETER_TYPES].join(", ")}, or as an array of those where it may be absent`,
        [entry.id, name],
      );
    }
  }
}

/** A scratch database holding only the declared tables, so the engine refuses a statement
 * reading any other. It bounds rows, not the schema: the catalogue stays readable. */
function schemaOfDeclaredTables(
  tables: readonly string[],
  contributed: readonly DeclaredFoldTable[],
  scratch: () => IndexConnection,
): IndexConnection {
  const connection = scratch();
  try {
    // A table named twice means what it meant once.
    for (const name of new Set(tables)) {
      const kernelTable = KERNEL_INDEX_TABLES.get(name);
      if (kernelTable !== undefined) {
        for (const statement of kernelTable) {
          connection.exec(statement);
        }
        continue;
      }
      for (const statement of ddlFor(contributed.find((table) => table.name === name)!)) {
        connection.exec(statement);
      }
    }
    return connection;
  } catch (error) {
    connection.close();
    throw error;
  }
}

/** Refuses a table no query may declare, then compiles the statement against the declared
 * tables alone; answers the columns it projects. */
function assertStatementReadsDeclaredTables(
  entry: ContributionEntry,
  statement: string,
  tables: readonly string[],
  contributed: readonly DeclaredFoldTable[],
  engine: FoldEngine,
): readonly string[] {
  for (const name of tables) {
    if (!isSafeSqlIdentifier(name)) {
      throw new QueryRefusedError(
        `refusing to register ${entry.id}: it declares the table ${JSON.stringify(name)}, which is not a lowercase identifier`,
        [entry.id, name],
      );
    }
    if (!QUERYABLE_KERNEL_TABLES.has(name) && !contributed.some((table) => table.name === name)) {
      throw new QueryRefusedError(
        `refusing to register ${entry.id}: it declares the table ${name}, which is neither one of the kernel's own queryable tables ` +
          `(${[...QUERYABLE_KERNEL_TABLES].join(", ")}) nor a table a fold contribution declares`,
        [entry.id, name],
      );
    }
  }
  const connection = schemaOfDeclaredTables(tables, contributed, engine.scratch);
  try {
    return connection.prepare(statement).columnNames();
  } catch (error) {
    throw new QueryRefusedError(
      `refusing to register ${entry.id}: ${engine.name} refuses its statement against the tables it declares, ${tables.join(", ")}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      [entry.id],
    );
  } finally {
    connection.close();
  }
}

/** Where the row admits no other property, refuses a statement whose columns are not that row. */
function assertColumnsAnswerDeclaredRow(
  entry: ContributionEntry,
  columns: readonly string[],
  row: Record<string, unknown>,
): void {
  if (row["additionalProperties"] !== false) {
    return;
  }
  const properties = row["properties"];
  const declared = new Set(isPlainObject(properties) ? Object.keys(properties) : []);
  const undeclared = columns.filter((column) => !declared.has(column));
  if (undeclared.length > 0) {
    throw new QueryRefusedError(
      `refusing to register ${entry.id}: its statement projects ${undeclared.join(", ")}, which its own row declares no property for ` +
        `and admits no column outside the ones it lists (${[...declared].join(", ")})`,
      [entry.id, ...undeclared],
    );
  }
  const requiredField = row["required"];
  const required = Array.isArray(requiredField) ? requiredField.filter((name) => typeof name === "string") : [];
  const absent = required.filter((name) => !columns.includes(name));
  if (absent.length > 0) {
    throw new QueryRefusedError(
      `refusing to register ${entry.id}: its own row requires ${absent.join(", ")}, which its statement projects no column for, ` +
        `so no row it answers could ever carry them`,
      [entry.id, ...absent],
    );
  }
}

/** The query one entry declares. `contributed` is taken rather than fetched, so one install can
 * declare a fold table and a query over it. */
export function queryDeclarationFromEntry(
  entry: ContributionEntry,
  contributed: readonly DeclaredFoldTable[],
  engine: FoldEngine,
): DeclaredQuery {
  const validateParameterSchema = parameterSchema();
  const validateRowSchema = rowSchema();
  if (!validateParameterSchema(entry.input)) {
    throw new QueryRefusedError(
      `refusing to register ${entry.id}: a query's input must be the schema its own parameters satisfy, carrying the statement it runs and the tables that statement reads: ${ajv.errorsText(validateParameterSchema.errors ?? [])}`,
      [entry.id],
    );
  }
  if (!validateRowSchema(entry.output)) {
    throw new QueryRefusedError(
      `refusing to register ${entry.id}: a query's output must declare the row its answer's items take under rows: ${ajv.errorsText(validateRowSchema.errors ?? [])}`,
      [entry.id],
    );
  }
  const parameters = entry.input.properties;
  assertParametersBind(entry, parameters);
  assertStatementShape(entry, entry.input.statement, parameters);
  const columns = assertStatementReadsDeclaredTables(
    entry,
    entry.input.statement,
    entry.input.tables,
    contributed,
    engine,
  );
  assertColumnsAnswerDeclaredRow(entry, columns, entry.output.properties.rows.items);
  return {
    id: entry.id,
    version: entry.version,
    statement: entry.input.statement,
    tables: entry.input.tables,
    parameters,
    rows: entry.output.properties.rows.items,
  };
}

/** The queries that stand, and one refusal per declaration that cannot. */
export interface QueryDeclarations {
  readonly queries: readonly QueryDeclaration[];
  readonly refused: readonly FoldRefusal[];
}

/** Every declared query, rechecked on each read against the tables the fold holds rather than
 * those declared, since a declared table may never have been built on this machine. */
export function readQueryDeclarations(index: IndexDb): QueryDeclarations {
  const engine = index.engine();
  const held = index.foldTablesHeld();
  const declared = readFoldDeclarations(index, engine).tables;
  const contributed = declared.filter((table) => held.has(table.name));
  const absent = declared.filter((table) => !held.has(table.name)).map((table) => table.name);
  const written = new Set(index.foldRefusals().map((refusal) => refusal.name));
  const queries: QueryDeclaration[] = [];
  const refused: FoldRefusal[] = [];
  for (const row of index.contributionsOf("query")) {
    try {
      queries.push({
        ...queryDeclarationFromEntry(row.entry, contributed, engine),
        moduleRecord: row.moduleRecord,
      });
    } catch (error) {
      if (!(error instanceof QueryRefusedError)) {
        throw error;
      }
      // A query over a declared table this fold lacks is refused for that, not as undeclared.
      const missing = absent.find((table) => error.about.includes(table));
      refused.push({
        name: row.entry.id,
        contributionId: row.entry.id,
        moduleRecord: row.moduleRecord,
        version: row.entry.version,
        reason: missing === undefined ? error.detail : missingTableReason(row.entry.id, missing, written.has(missing)),
        // Inherits the missing table's own answer to what clears it.
        settled: missing === undefined || written.has(missing),
      });
    }
  }
  return { queries, refused };
}

function missingTableReason(id: string, table: string, written: boolean): string {
  const because = written
    ? "because that table's own row function refused a record"
    : "because its row function did not answer here, so the table was never built";
  return `refusing to register ${id}: it declares the table ${table}, which a fold contribution declares and this fold does not hold, ${because}`;
}

/** The declaration `id` names; a refused one is refused by its own reason and no other. */
export function queryFor(id: string, declarations: QueryDeclarations): QueryDeclaration {
  const held = declarations.queries.find((declaration) => declaration.id === id);
  if (held !== undefined) {
    return held;
  }
  const refused = declarations.refused.find((refusal) => refusal.name === id);
  if (refused !== undefined) {
    throw new QueryRefusedError(refused.reason, [id]);
  }
  throw new QueryRefusedError(`refusing to run ${id}: no installed module declares a query under that id`, [id]);
}
