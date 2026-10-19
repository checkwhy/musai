import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType, SQLInputValue, StatementSync } from "node:sqlite";

/** Closed by the kernel, so a pack naming an unknown word is refused by name. */
export const INDEX_CAPABILITIES = ["fts"] as const;

export type IndexCapability = (typeof INDEX_CAPABILITIES)[number];

export function isIndexCapability(value: unknown): value is IndexCapability {
  return typeof value === "string" && (INDEX_CAPABILITIES as readonly string[]).includes(value);
}

/** A capability and the statement proving it are added together; no engine is taken at its word. */
export const CAPABILITY_PROBES: ReadonlyMap<IndexCapability, string> = new Map([
  ["fts", "CREATE VIRTUAL TABLE probe USING fts5(x)"],
]);

export interface IndexChanges {
  readonly changes: number;
}

/** A missing row is `undefined`; named parameters are one plain object of unprefixed names. */
export interface IndexStatement {
  all(...parameters: unknown[]): unknown[];
  get(...parameters: unknown[]): unknown;
  run(...parameters: unknown[]): IndexChanges;
  columnNames(): readonly string[];
}

export interface IndexConnection {
  prepare(sql: string): IndexStatement;
  exec(sql: string): void;
  close(): void;
}

/** A contributed query reads through `openReadOnly`, so a write in it fails at the engine. */
export interface IndexProvider {
  readonly name: string;
  capabilities(): ReadonlySet<IndexCapability>;
  open(path: string): IndexConnection;
  openReadOnly(path: string): IndexConnection;
}

// Some bundlers rewrite `node:sqlite` to `sqlite`, which Node cannot resolve; a require escapes it.
const requireEngine = createRequire(import.meta.url);

/** Declared by hand: this repository pins no typings for Bun. */
interface BunDatabase {
  prepare(sql: string): BunStatement;
  exec(sql: string): void;
  close(): void;
}

interface BunStatement {
  all(...parameters: unknown[]): unknown[];
  get(...parameters: unknown[]): unknown;
  run(...parameters: unknown[]): void;
  readonly columnNames: readonly string[];
}

/** Probed, not looked up: the SQLite library a runtime loads belongs to the machine. */
function probedCapabilities(open: (path: string) => IndexConnection): ReadonlySet<IndexCapability> {
  const held = new Set<IndexCapability>();
  for (const [capability, probe] of CAPABILITY_PROBES) {
    const connection = open(":memory:");
    try {
      connection.exec(probe);
      held.add(capability);
    } catch {
      // An engine that cannot compile the probe lacks the capability.
    } finally {
      connection.close();
    }
  }
  return held;
}

function nodeStatement(statement: StatementSync): IndexStatement {
  return {
    all: (...parameters) => statement.all(...(parameters as SQLInputValue[])),
    get: (...parameters) => statement.get(...(parameters as SQLInputValue[])),
    run: (...parameters) => ({ changes: Number(statement.run(...(parameters as SQLInputValue[])).changes) }),
    columnNames: () => statement.columns().map((column) => column.name),
  };
}

/** Long enough to outwait another process's group transaction, a cold fold's included. */
const BUSY_TIMEOUT_MS = 60_000;

/** A writer waits for the lock another process holds rather than failing on it at once. */
function waiting(connection: IndexConnection): IndexConnection {
  connection.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return connection;
}

function nodeConnection(database: DatabaseSyncType): IndexConnection {
  return {
    prepare: (sql) => nodeStatement(database.prepare(sql)),
    exec: (sql) => {
      database.exec(sql);
    },
    close: () => {
      database.close();
    },
  };
}

export function nodeSqliteProvider(): IndexProvider {
  const { DatabaseSync } = requireEngine("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };
  const open = (path: string): IndexConnection => waiting(nodeConnection(new DatabaseSync(path)));
  let capabilities: ReadonlySet<IndexCapability> | undefined;
  return {
    name: "node:sqlite",
    capabilities: () => (capabilities ??= probedCapabilities(open)),
    open,
    openReadOnly: (path) => waiting(nodeConnection(new DatabaseSync(path, { readOnly: true }))),
  };
}

/** `null` and an object with a prototype of its own are bound as values, not as names. */
function isNamedParameters(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/** Bun binds a named parameter only by its prefixed name. */
function bunParameters(parameters: unknown[]): unknown[] {
  return parameters.map((parameter) =>
    isNamedParameters(parameter)
      ? Object.fromEntries(Object.entries(parameter).map(([name, value]) => [`:${name}`, value]))
      : parameter,
  );
}

function bunStatement(statement: BunStatement, changes: () => number): IndexStatement {
  return {
    all: (...parameters) => statement.all(...bunParameters(parameters)),
    // Callers read a missing row as `undefined`; Bun answers `null`.
    get: (...parameters) => statement.get(...bunParameters(parameters)) ?? undefined,
    run: (...parameters) => {
      statement.run(...bunParameters(parameters));
      return { changes: changes() };
    },
    columnNames: () => statement.columnNames,
  };
}

function bunConnection(database: BunDatabase): IndexConnection {
  // Bun's `run` answers no row count, so it is read from SQLite's `changes()`.
  let counter: BunStatement | undefined;
  const changes = (): number => {
    counter ??= database.prepare("SELECT changes() AS changes");
    return Number((counter.get() as { changes: number } | null)?.changes ?? 0);
  };
  return {
    prepare: (sql) => bunStatement(database.prepare(sql), changes),
    exec: (sql) => {
      database.exec(sql);
    },
    close: () => {
      database.close();
    },
  };
}

export function bunSqliteProvider(): IndexProvider {
  const { Database } = requireEngine("bun:sqlite") as {
    Database: new (path: string, options?: unknown) => BunDatabase;
  };
  const open = (path: string): IndexConnection => waiting(bunConnection(new Database(path)));
  let capabilities: ReadonlySet<IndexCapability> | undefined;
  return {
    name: "bun:sqlite",
    capabilities: () => (capabilities ??= probedCapabilities(open)),
    open,
    openReadOnly: (path) => waiting(bunConnection(new Database(path, { readonly: true }))),
  };
}

let selected: IndexProvider | undefined;

/** The running runtime's engine; `process.versions` is typed under both where `Bun` is not. */
export function openIndexProvider(): IndexProvider {
  selected ??= typeof process.versions.bun === "string" ? bunSqliteProvider() : nodeSqliteProvider();
  return selected;
}

function threw(attempt: () => void): boolean {
  try {
    attempt();
    return false;
  } catch {
    return true;
  }
}

/** Checks a tenant's provider on the shipped two's terms; each claimed capability is probed. */
export function checkIndexProvider(provider: IndexProvider, scratchPath: string): readonly string[] {
  const failures: string[] = [];
  const named = (detail: string): void => {
    failures.push(`${provider.name}: ${detail}`);
  };

  const writable = provider.open(scratchPath);
  try {
    writable.exec("CREATE TABLE conformance (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const insert = writable.prepare("INSERT INTO conformance (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING");
    const landed = insert.run("one", "first").changes;
    if (landed !== 1) {
      named(`an insert writing one row answered ${landed} changed rows`);
    }
    const repeated = insert.run("one", "first").changes;
    if (repeated !== 0) {
      named(`an insert writing no row answered ${repeated} changed rows`);
    }
    const statement = writable.prepare("SELECT key, value FROM conformance WHERE key = :key");
    const rows = statement.all({ key: "one" });
    if (rows.length !== 1 || (rows[0] as { value?: unknown }).value !== "first") {
      named(`a row bound by name read back as ${JSON.stringify(rows)}`);
    }
    if ((statement.get({ key: "one" }) as { value?: unknown } | undefined)?.value !== "first") {
      named("a single row bound by name did not read back");
    }
    if (statement.get({ key: "absent" }) !== undefined) {
      named("a query matching no row answered something other than undefined");
    }
    const columns = statement.columnNames();
    if (columns.join(",") !== "key,value") {
      named(`the columns of a two-column statement read as ${JSON.stringify(columns)}`);
    }
    // The kernel never relies on this, but an engine that drops a second statement is named here.
    writable.exec("CREATE TABLE sequence_first (key TEXT); CREATE TABLE sequence_second (key TEXT);");
    const built = writable
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'sequence_%' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    if (built.join(",") !== "sequence_first,sequence_second") {
      named(`a text of two statements executed built ${JSON.stringify(built)}`);
    }
  } finally {
    writable.close();
  }

  const readOnly = provider.openReadOnly(scratchPath);
  try {
    if (!threw(() => readOnly.prepare("INSERT INTO conformance (key, value) VALUES (?, ?)").run("two", "second"))) {
      named("an insert through a read-only connection was accepted");
    }
    if (!threw(() => readOnly.exec("CREATE TABLE trespass (key TEXT)"))) {
      named("a create through a read-only connection was accepted");
    }
    try {
      const held = readOnly.prepare("SELECT key, value FROM conformance").all();
      if (held.length !== 1 || (held[0] as { value?: unknown }).value !== "first") {
        named(`a read-only connection answered ${JSON.stringify(held)} for the one row the writing connection landed`);
      }
    } catch (error) {
      named(`a read through a read-only connection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    readOnly.close();
  }

  for (const capability of provider.capabilities()) {
    const probe = isIndexCapability(capability) ? CAPABILITY_PROBES.get(capability) : undefined;
    if (probe === undefined) {
      named(`claims ${JSON.stringify(capability)}, which is not a capability this kernel admits`);
      continue;
    }
    const connection = provider.open(":memory:");
    try {
      connection.exec(probe);
    } catch (error) {
      named(`claims ${capability}, whose probe failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      connection.close();
    }
  }

  return failures;
}
