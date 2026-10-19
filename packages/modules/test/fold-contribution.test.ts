import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DeclaredFoldRefusal,
  type FoldContributions,
  type FoldEngine,
  type FoldExtension,
  FoldRowRefusedError,
  type FoldTable,
  IndexDb,
  isSafeSqlIdentifier,
  openIndexProvider,
} from "@musai/fold";
import type { ClaimRecord, ContributionEntry, ModuleRecord } from "@musai/records";
import {
  type ClaimTypeDeclaration,
  CURRENT_SCHEMA_VERSIONS,
  type RecordId,
  recordId,
  slotFor,
  versionString,
} from "@musai/records";
import type { RecordStore } from "@musai/store";
import { type GitBlobStore, Store } from "@musai/store";
import {
  blobStoreOf,
  type FixtureRepo,
  gatewaySource,
  makeFixtureRepo,
  manifestWithContributions,
  writeFixtureRecords,
} from "@musai/test-support";
import { afterEach, describe, expect, test } from "vitest";
import {
  ANSWERED_BY_THE_DECLARATION,
  FoldRefusedError,
  foldExtensionsFrom,
  foldTableFromEntry,
  foldTablesFrom,
  readFoldDeclarations,
} from "../src/module/fold-registry.js";
import { HOSTS, type HostDescriptor, type ModuleHost } from "../src/module/hosts.js";
import { type EnvelopeRequest, ERROR_CODES, type ErrorCode } from "../src/rule/envelope.js";
import { type HostInvocation, readLogForRequest } from "../src/rule/host.js";

const CLAIM_TYPE = "fixture-fold-claims/claim@1";
const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: CLAIM_TYPE, identityDimensions: ["id"] };

const MODULE_NAME = "fixture-fold";
const CONTRIBUTION_ID = `${MODULE_NAME}/rows`;
/** The SQL name that contribution id renders to. */
const TABLE = "fixture_fold_rows";

let repos: FixtureRepo[] = [];
let dirs: string[] = [];

afterEach(async () => {
  await Promise.all(repos.map((repo) => repo.cleanup()));
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  repos = [];
  dirs = [];
});

async function trackedRepo(scope: string): Promise<FixtureRepo> {
  const repo = await makeFixtureRepo(scope, [CLAIM_DECLARATION]);
  repos.push(repo);
  return repo;
}

async function trackedDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "musai-fold-contribution-"));
  dirs.push(dir);
  return dir;
}

function storeOf(repo: FixtureRepo): Store {
  return new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now, claimTypes: repo.claimTypes });
}

function claim(id: string): ClaimRecord {
  const conditions = { id };
  const slot = slotFor(CLAIM_DECLARATION, conditions);
  return {
    kind: "claim",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: CLAIM_TYPE,
    about: [`urn:example:${id}`],
    slot,
    conditions,
    canonical: { statement: `${id} holds` },
    rendering: `${id} holds.`,
    evidence: [],
    exclusiveGroup: null,
  };
}

/** A `fold` entry's output half: the row schema, with any annotations a test hangs beside it. */
function rowSchema(
  properties: Record<string, unknown>,
  required: readonly string[],
  annotations: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["rows"],
    properties: {
      rows: {
        type: "array",
        items: { type: "object", additionalProperties: false, required: [...required], properties },
      },
    },
    ...annotations,
  };
}

/** Every field of the tuple a row function is handed, so a walk handed a wrong commit, kind or
 * position answers differently from a backfill. */
const FIXTURE_COLUMNS = {
  id: { type: "string" },
  kind: { type: "string" },
  at: { type: "string" },
  position: { type: "integer" },
};

/** A `fold` entry declaring the fixture columns, `overrides` replacing the halves under test. */
function foldEntry(id: string, overrides: Partial<ContributionEntry> = {}): ContributionEntry {
  return {
    kind: "fold",
    id,
    version: versionString("1"),
    input: true,
    output: rowSchema(FIXTURE_COLUMNS, ["id", "kind", "at"]),
    documentation: `the rows ${id} contributes`,
    ...overrides,
  };
}

/** A module record declaring `entries`, naming a bundle a test writes only where it needs one. */
function moduleDeclaring(name: string, entries: readonly ContributionEntry[], bundle?: RecordId): ModuleRecord {
  return {
    kind: "module",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.module,
    name,
    version: versionString("1.0.0"),
    manifest: manifestWithContributions(entries),
    bundle: bundle ?? recordId({ marker: `bundle-for-${name}` }),
    build: recordId({ marker: `build-for-${name}` }),
  };
}

const tupleRows: FoldExtension["rows"] = async (record) =>
  record.kind === "claim" ? [{ id: record.id, kind: record.kind, at: record.commit, position: record.position }] : [];

/** The row function above for every table; varying `adjust` moves a version or module record
 * without rewriting a record. */
function handed(
  index: IndexDb,
  adjust: (tables: readonly FoldTable[]) => readonly FoldTable[] = (tables) => tables,
): FoldContributions {
  return {
    declarations: () => adjust(readFoldDeclarations(index, index.engine()).tables),
    extensions: async (tables) => ({
      extensions: tables.map((table) => ({ table, rows: tupleRows })),
      close: async () => {},
    }),
  };
}

function columnsOf(path: string, table: string): readonly string[] {
  const raw = openIndexProvider().open(path);
  try {
    return raw.prepare(`SELECT * FROM ${table}`).columnNames();
  } finally {
    raw.close();
  }
}

function rowsOf(path: string, table: string): Array<Record<string, unknown>> {
  const raw = openIndexProvider().open(path);
  try {
    return raw.prepare(`SELECT * FROM ${table} ORDER BY record_id ASC, ordinal ASC`).all() as Array<
      Record<string, unknown>
    >;
  } finally {
    raw.close();
  }
}

function holdsTable(path: string, table: string): boolean {
  const raw = openIndexProvider().open(path);
  try {
    return raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
  } finally {
    raw.close();
  }
}

/** Runs `statement` against the file around the fold, as a test drops a table from under it. */
function around(path: string, statement: string): void {
  const raw = openIndexProvider().open(path);
  try {
    raw.exec(statement);
  } finally {
    raw.close();
  }
}

/** Every table but the contributed one and its bookkeeping, sorted, so two dumps compare by
 * content: a rebuild of one table must leave these exactly where they were. */
function kernelTablesHeld(path: string): Record<string, string[]> {
  const raw = openIndexProvider().open(path);
  try {
    const tables = raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' " +
          "AND name NOT IN (?, 'fold_tables', 'fold_refusals') ORDER BY name ASC",
      )
      .all(TABLE) as Array<{ name: string }>;
    const held: Record<string, string[]> = {};
    for (const { name } of tables) {
      const rows = raw.prepare(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>;
      held[name] = rows.map((row) => JSON.stringify(row)).sort();
    }
    return held;
  } finally {
    raw.close();
  }
}

/** A scope with two claims and the module declaring the fold table, folded into a file. */
async function scopeWithFoldModule(
  scope: string,
  entries: readonly ContributionEntry[] = [foldEntry(CONTRIBUTION_ID)],
  moduleName = MODULE_NAME,
): Promise<{ repo: FixtureRepo; store: Store; index: IndexDb; path: string }> {
  const repo = await trackedRepo(scope);
  await writeFixtureRecords(repo, [
    { kind: "claim", value: claim("first") },
    { kind: "claim", value: claim("second") },
  ]);
  await writeFixtureRecords(repo, [{ kind: "module", value: moduleDeclaring(moduleName, entries) }]);
  const path = join(await trackedDir(), "index.sqlite");
  return { repo, store: storeOf(repo), index: new IndexDb(path), path };
}

describe("a fold contribution's declared table", () => {
  test("is created with the kernel's own key columns ahead of the declared ones and a row per record the function answered for", async () => {
    const { store, index, path } = await scopeWithFoldModule("fold-created");

    await index.fold(store, undefined, handed(index));

    // Columns follow the record's canonical key order, so two folds of one record build one table.
    expect(columnsOf(path, TABLE)).toEqual(["record_id", "ordinal", "at", "id", "kind", "position"]);
    const rows = rowsOf(path, TABLE);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row["ordinal"]).toBe(0);
      expect(row["id"]).toBe(row["record_id"]);
      expect(row["kind"]).toBe("claim");
    }
  });

  test("is folded under the name a hyphenated module renders, since the packs this repository ships are named that way", async () => {
    const { store, index, path } = await scopeWithFoldModule(
      "fold-hyphenated",
      [foldEntry("fixture-casebook/entries")],
      "fixture-casebook",
    );

    await index.fold(store, undefined, handed(index));

    expect(holdsTable(path, "fixture_casebook_entries")).toBe(true);
    expect(rowsOf(path, "fixture_casebook_entries")).toHaveLength(2);
  });

  test("holds, for the records a walk wrote, exactly what a fold from nothing answers for them", async () => {
    const { repo, store, index, path } = await scopeWithFoldModule("fold-walked-rows");
    await index.fold(store, undefined, handed(index));
    const folded = rowsOf(path, TABLE);
    const settled = folded[0]!["record_id"] as RecordId;

    // Two records in one commit, so a row carrying the other's position differs from its own.
    const [first, second] = await writeFixtureRecords(repo, [
      { kind: "claim", value: claim("walked-first") },
      { kind: "claim", value: claim("walked-second") },
    ]);

    // The table is current, so this pass writes inside each record's transaction, not by backfill.
    await index.fold(store, undefined, handed(index));

    // A fresh fold backfills from `records`, so the two compare the walk's tuple with the log's.
    const freshPath = join(await trackedDir(), "fresh.sqlite");
    const fresh = new IndexDb(freshPath);
    await fresh.fold(store, undefined, handed(fresh));

    const walked = rowsOf(path, TABLE);
    expect(walked.filter((row) => row["record_id"] === first || row["record_id"] === second)).toHaveLength(2);
    expect(new Set(walked.map((row) => row["position"])).size).toBeGreaterThan(1);
    expect(walked.find((row) => row["record_id"] === settled)).toEqual(folded[0]);
    expect(walked).toEqual(rowsOf(freshPath, TABLE));
  });

  test("is built and backfilled by the very pass that folds the commit declaring it, not by the next one", async () => {
    const repo = await trackedRepo("fold-same-pass");
    await writeFixtureRecords(repo, [{ kind: "claim", value: claim("before") }]);
    const path = join(await trackedDir(), "index.sqlite");
    const index = new IndexDb(path);
    const store = storeOf(repo);
    await index.fold(store, undefined, handed(index));
    expect(holdsTable(path, TABLE)).toBe(false);

    await writeFixtureRecords(repo, [
      { kind: "module", value: moduleDeclaring(MODULE_NAME, [foldEntry(CONTRIBUTION_ID)]) },
    ]);
    await index.fold(store, undefined, handed(index));

    // The claim's commit predates the declaration, so a row proves the backfill replayed records.
    expect(rowsOf(path, TABLE)).toHaveLength(1);
  });
});

describe("what a change to a fold declaration does to its table", () => {
  test("a version bump rebuilds that table and leaves every other table and the watermark where they were", async () => {
    const { store, index, path } = await scopeWithFoldModule("fold-version-bump");
    await index.fold(store, undefined, handed(index));
    const kernelTables = kernelTablesHeld(path);
    const watermark = index.watermark();
    around(path, `DELETE FROM ${TABLE}`);

    await index.fold(
      storeRefusingItsLog(store),
      undefined,
      handed(index, (tables) => tables.map((table) => ({ ...table, version: versionString("2") }))),
    );

    expect(rowsOf(path, TABLE)).toHaveLength(2);
    expect(kernelTablesHeld(path)).toEqual(kernelTables);
    expect(index.watermark()).toBe(watermark);
  });

  test("a module record that changed at one version rebuilds it too, since a rebuilt pack's rows may differ", async () => {
    const { store, index, path } = await scopeWithFoldModule("fold-record-changed");
    await index.fold(store, undefined, handed(index));
    around(path, `DELETE FROM ${TABLE}`);

    await index.fold(
      store,
      undefined,
      handed(index, (tables) =>
        tables.map((table) => ({ ...table, moduleRecord: recordId({ marker: "a pack rebuilt" }) })),
      ),
    );

    expect(rowsOf(path, TABLE)).toHaveLength(2);
  });

  test("a declaration nothing carries any more drops its table", async () => {
    const { store, index, path } = await scopeWithFoldModule("fold-declaration-removed");
    await index.fold(store, undefined, handed(index));
    expect(holdsTable(path, TABLE)).toBe(true);

    await index.fold(
      store,
      undefined,
      handed(index, () => []),
    );

    expect(holdsTable(path, TABLE)).toBe(false);
  });

  test("a pass at an unchanged head still reads the declarations and puts back a table dropped from under it", async () => {
    const { store, index, path } = await scopeWithFoldModule("fold-unchanged-head");
    await index.fold(store, undefined, handed(index));
    around(path, `DROP TABLE ${TABLE}`);

    await index.fold(store, undefined, handed(index));

    expect(holdsTable(path, TABLE)).toBe(true);
    expect(rowsOf(path, TABLE)).toHaveLength(2);
  });
});

describe("a fold pass handed no row functions", () => {
  test("drops a table whose row would otherwise claim a walk it was not part of", async () => {
    const { repo, store, index, path } = await scopeWithFoldModule("fold-pairless-walk");
    await index.fold(store, undefined, handed(index));
    expect(rowsOf(path, TABLE)).toHaveLength(2);

    await writeFixtureRecords(repo, [{ kind: "claim", value: claim("third") }]);
    await index.fold(store);

    // The watermark passed a record no row function saw, so the table is dropped, not left short.
    expect(holdsTable(path, TABLE)).toBe(false);

    await index.fold(store, undefined, handed(index));

    expect(rowsOf(path, TABLE)).toHaveLength(3);
  });
});

/** A store whose tip answers and whose log throws, so a backfill reaching for the log fails. */
function storeRefusingItsLog(store: Store): RecordStore {
  return {
    tip: () => store.tip(),
    putMany: (items, hooks) => store.putMany(items, hooks),
    readBytes: (id, kind) => store.readBytes(id, kind),
    readSidecar: (id) => store.readSidecar(id),
    swapRef: (build, hooks) => store.swapRef(build, hooks),
    descends: (from, to) => store.descends(from, to),
    changesSince: () => {
      throw new Error("a backfill reached for the log");
    },
  };
}

describe("what a fold declaration is refused for", () => {
  const engine: FoldEngine = {
    name: "fixture-engine",
    capabilities: new Set(),
    scratch: () => openIndexProvider().open(":memory:"),
  };

  /** The one refusal `rows` answered, so a test reads its sentence, not only its presence. */
  function refusalOf(rows: readonly { entry: ContributionEntry; moduleName: string }[]): DeclaredFoldRefusal {
    const refused = foldTablesFrom(rows, engine).refused;
    expect(refused).toHaveLength(1);
    return refused[0]!;
  }

  test("a column named for one the kernel owns is refused by name", () => {
    const entry = foldEntry(CONTRIBUTION_ID, { output: rowSchema({ record_id: { type: "string" } }, ["record_id"]) });
    expect(() => foldTableFromEntry(entry)).toThrow(FoldRefusedError);
    expect(() => foldTableFromEntry(entry)).toThrow("record_id");
  });

  test("a column declaring a type no SQLite column binds is refused by name", () => {
    const entry = foldEntry(CONTRIBUTION_ID, { output: rowSchema({ tag: { type: "array" } }, []) });
    expect(() => foldTableFromEntry(entry)).toThrow("array");
  });

  test("a contribution id rendering the name of a kernel table is refused by name", () => {
    expect(() => foldTableFromEntry(foldEntry("claims"))).toThrow("claims");
  });

  test("an input that narrows anything is refused by name, since a row function sees every record", () => {
    const entry = foldEntry(CONTRIBUTION_ID, { input: { type: "object" } });
    expect(() => foldTableFromEntry(entry)).toThrow("every record");
  });

  test("a key on the output outside the admitted six is refused by name", () => {
    const entry = foldEntry(CONTRIBUTION_ID, {
      output: rowSchema({ tag: { type: "string" } }, [], { statement: "SELECT 1" }),
    });
    expect(() => foldTableFromEntry(entry)).toThrow("statement");
  });

  test("an index naming something the declared columns do not is refused by name", () => {
    const entry = foldEntry(CONTRIBUTION_ID, {
      output: rowSchema({ tag: { type: "string" } }, [], { indexes: [["absent"]] }),
    });
    expect(() => foldTableFromEntry(entry)).toThrow("absent");
  });

  test("a column named for a word the engine reserves is refused by name, whatever the identifier rule admits", () => {
    expect(isSafeSqlIdentifier("order")).toBe(true);
    const entry = foldEntry(CONTRIBUTION_ID, { output: rowSchema({ order: { type: "string" } }, []) });

    expect(refusalOf([{ entry, moduleName: MODULE_NAME }]).reason).toContain(TABLE);
  });

  test("a nullable column the engine takes in a table but not in an insert is refused by name", () => {
    // `CREATE TABLE` reads this word as a constraint and `INSERT` cannot, so both are compiled.
    const entry = foldEntry(CONTRIBUTION_ID, { output: rowSchema({ constraint: { type: "string" } }, []) });

    expect(refusalOf([{ entry, moduleName: MODULE_NAME }]).reason).toContain("INSERT INTO");
  });

  test("a table name one of the kernel's own indexes occupies is refused by name, since an engine keeps both in one namespace", () => {
    // An index of the kernel's schema, not a table, so only the engine refuses the name.
    const entry = foldEntry("records-by-kind");
    expect(() => foldTableFromEntry(entry)).not.toThrow();

    expect(refusalOf([{ entry, moduleName: MODULE_NAME }]).reason).toContain("records_by_kind");
  });

  test("two declared indexes rendering one index name are refused by name", () => {
    const entry = foldEntry(CONTRIBUTION_ID, {
      output: rowSchema(FIXTURE_COLUMNS, ["id"], { indexes: [["id"], ["id"]] }),
    });

    expect(refusalOf([{ entry, moduleName: MODULE_NAME }]).contributionId).toBe(CONTRIBUTION_ID);
  });

  test("two ids rendering one table name are refused by name, since the rendering is lossy", () => {
    const rows = [
      { entry: foldEntry("fixture-fold/rows"), moduleName: MODULE_NAME },
      { entry: foldEntry("fixture.fold/rows"), moduleName: MODULE_NAME },
    ];
    const { tables, refused } = foldTablesFrom(rows, engine);

    // The one that rendered the name first stands; only the second is refused.
    expect(tables.map((table) => table.contributionId)).toEqual(["fixture-fold/rows"]);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.contributionId).toBe("fixture.fold/rows");
    expect(refused[0]!.reason).toContain(TABLE);
  });

  test("a capability the engine does not offer is refused by name, naming the table, the module and the engine", () => {
    const rows = [
      {
        entry: foldEntry(CONTRIBUTION_ID, {
          output: rowSchema({ tag: { type: "string" } }, [], { requires: ["fts"] }),
        }),
        moduleName: MODULE_NAME,
      },
    ];
    const refusal = refusalOf(rows);

    expect(refusal.reason).toContain(TABLE);
    expect(refusal.reason).toContain(MODULE_NAME);
    expect(refusal.reason).toContain("fts");
    expect(refusal.reason).toContain("fixture-engine");
  });

  test("a declaration that cannot stand costs its own table and leaves every other declaration standing", () => {
    const rows = [
      {
        entry: foldEntry(CONTRIBUTION_ID, { output: rowSchema({ tag: { type: "array" } }, []) }),
        moduleName: MODULE_NAME,
      },
      { entry: foldEntry("fixture-casebook/entries"), moduleName: "fixture-casebook" },
    ];

    const { tables, refused } = foldTablesFrom(rows, engine);

    expect(tables.map((table) => table.name)).toEqual(["fixture_casebook_entries"]);
    expect(refused.map((refusal) => refusal.contributionId)).toEqual([CONTRIBUTION_ID]);
  });
});

/** A bundle whose row function returns the expression `answer` for each record. */
function foldBundle(answer: string): Uint8Array {
  return new TextEncoder().encode(gatewaySource("invoke", `    return { rows: ${answer} };`));
}

/** A workspace holding one written bundle, its module record and one claim to answer for. */
async function scopeWithBundle(
  scope: string,
  bundle: Uint8Array,
): Promise<{
  repo: FixtureRepo;
  store: Store;
  index: IndexDb;
  blobs: GitBlobStore;
  path: string;
  entry: ContributionEntry;
}> {
  const repo = await trackedRepo(scope);
  const blobs = blobStoreOf(repo.workspace);
  const bundleId = await blobs.put(bundle);
  await writeFixtureRecords(repo, [{ kind: "claim", value: claim("only") }]);
  // Both annotations ride on the row schema, so rows are refused if Ajv stops ignoring either.
  const entry = foldEntry(CONTRIBUTION_ID, {
    output: rowSchema(FIXTURE_COLUMNS, ["id", "kind", "at"], {
      indexes: [["id"]],
      requires: [],
    }),
  });
  await writeFixtureRecords(repo, [{ kind: "module", value: moduleDeclaring(MODULE_NAME, [entry], bundleId) }]);
  const path = join(await trackedDir(), "index.sqlite");
  return { repo, store: storeOf(repo), index: new IndexDb(path), blobs, path, entry };
}

/** The pair a fold is handed when its row functions come from a bundle loaded through a host. */
function loaded(index: IndexDb, blobs: GitBlobStore, hosts: readonly HostDescriptor[] = HOSTS): FoldContributions {
  return {
    declarations: () => readFoldDeclarations(index, index.engine()).tables,
    extensions: (tables) => foldExtensionsFrom(tables, index, blobs, hosts),
  };
}

describe("a row function reached through a host", () => {
  test("answering a row the declared columns refuse costs that table alone and is recorded against the declaration", async () => {
    const { store, index, blobs, path } = await scopeWithBundle(
      "fold-row-refused",
      foldBundle("[{ id: 7, kind: 'claim', at: 'a commit', position: 0 }]"),
    );

    await index.fold(store, undefined, loaded(index, blobs));

    expect(holdsTable(path, TABLE)).toBe(false);
    const refusals = index.foldRefusals();
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.name).toBe(TABLE);
    expect(refusals[0]!.contributionId).toBe(CONTRIBUTION_ID);
    expect(refusals[0]!.reason).toContain("output");
  });

  test("answering rows the declared columns admit builds the table from the bundle's own answer", async () => {
    const { store, index, blobs, path } = await scopeWithBundle(
      "fold-row-admitted",
      foldBundle(
        "input.kind === 'claim' ? [{ id: input.id, kind: input.kind, at: input.commit, position: input.position }] : []",
      ),
    );

    await index.fold(store, undefined, loaded(index, blobs));

    expect(rowsOf(path, TABLE)).toHaveLength(1);
  });
});

describe("a bundle this workspace cannot load", () => {
  test("leaves the workspace foldable, the kernel's own tables current and the contributed table unbuilt", async () => {
    // The bundle is named but never written, as when records arrive without their blobs.
    const { repo, store, index, path } = await scopeWithFoldModule("fold-absent-bundle");
    const blobs = blobStoreOf(repo.workspace);

    await index.fold(store, undefined, loaded(index, blobs));

    expect(index.watermark()).not.toBeNull();
    expect(index.contributionsOf("fold")).toHaveLength(1);
    expect(holdsTable(path, TABLE)).toBe(false);
  });

  test("has its already-built table dropped rather than left standing on an answer nothing can produce again", async () => {
    const { repo, store, index, path } = await scopeWithFoldModule("fold-unloadable-rebuild");
    const blobs = blobStoreOf(repo.workspace);
    await index.fold(store, undefined, handed(index));
    expect(holdsTable(path, TABLE)).toBe(true);

    // A new version puts the table in the build set, and its bundle was never written.
    await index.fold(store, undefined, {
      declarations: () =>
        readFoldDeclarations(index, index.engine()).tables.map((table) => ({ ...table, version: versionString("2") })),
      extensions: (tables) => foldExtensionsFrom(tables, index, blobs, HOSTS),
    });

    expect(holdsTable(path, TABLE)).toBe(false);
  });
});

/** The one host the counting rows below are invoked through, and what it was asked to do. */
interface CountingHost {
  readonly hosts: readonly HostDescriptor[];
  readonly counts: { loads: number; invocations: number; closes: number };
}

/** The fixture row functions' refusal, so a test reads the reason back rather than a type. */
const REFUSAL = "the row function refused this record";

/** What one counted invocation answers: rows, or the code its envelope refuses the record with. */
type CountedAnswer = { readonly rows: unknown } | { readonly refusal: ErrorCode };

/** A host answering `answer` for every record and counting what it was asked; an `answer` that
 * throws is the host giving out, which reaches no envelope and leaves nothing to remember. */
function countingHost(answer: (request: EnvelopeRequest) => CountedAnswer): CountingHost {
  const counts = { loads: 0, invocations: 0, closes: 0 };
  const host: ModuleHost = {
    load: async () => {
      counts.loads += 1;
      return { handle: counts.loads };
    },
    invoke: async (_loaded, request): Promise<HostInvocation> => {
      counts.invocations += 1;
      const answered = answer(request);
      return {
        response:
          "refusal" in answered
            ? { ok: false, error: { code: answered.refusal, data: null, message: REFUSAL } }
            : { ok: true, output: { rows: answered.rows }, diagnostics: [] },
        readLog: readLogForRequest(request),
      };
    },
    close: async () => {
      counts.closes += 1;
    },
  };
  return { hosts: [{ name: "counting", available: () => true, create: () => host }], counts };
}

describe("what a fold pass asks of a host", () => {
  test("loads each contributing module once for the pass and invokes its row function once per record", async () => {
    const { store, index, blobs } = await scopeWithBundle("fold-load-once", foldBundle("[]"));
    const counting = countingHost((request) => ({
      rows: [{ ...(request.input as Record<string, unknown>), at: "a commit" }],
    }));

    await index.fold(store, undefined, loaded(index, blobs, counting.hosts));

    // The walk and the reconcile together load the module once, not once per record.
    expect(counting.counts.loads).toBe(1);
    expect(counting.counts.invocations).toBe(3);
    expect(counting.counts.closes).toBe(1);
  });

  test("hands a row function no record the fold already holds, however far back its walk resumes", async () => {
    const { store, index, blobs, path } = await scopeWithBundle("fold-rewalked", foldBundle("[]"));
    const counting = countingHost(() => ({ rows: [] }));
    await index.fold(store, undefined, loaded(index, blobs, counting.hosts));
    const invoked = counting.counts.invocations;
    expect(invoked).toBeGreaterThan(0);

    // A stale position walks every record again; a record's rows are not answered twice.
    around(path, "UPDATE walked SET commit_sha = NULL WHERE id = 0");

    await index.fold(store, undefined, loaded(index, blobs, counting.hosts));

    expect(counting.counts.invocations).toBe(invoked);
  });

  test("releases every handle it opened when a row function gives out partway through", async () => {
    const { repo, store, index, blobs } = await scopeWithBundle("fold-close-on-throw", foldBundle("[]"));
    // A first pass builds the table, so the pass that throws is a walk holding a handle.
    const building = countingHost(() => ({ rows: [] }));
    await index.fold(store, undefined, loaded(index, blobs, building.hosts));
    const failing = countingHost(() => {
      throw new Error("the row function gave out");
    });
    await writeFixtureRecords(repo, [{ kind: "claim", value: claim("later") }]);

    await index.fold(store, undefined, loaded(index, blobs, failing.hosts));

    // Every handle opened is closed, however many passes the failure costs.
    expect(failing.counts.loads).toBeGreaterThan(0);
    expect(failing.counts.closes).toBe(failing.counts.loads);
  });
});

/** A second pack's table, so a refusal has something beside it to leave standing. */
const SECOND_TABLE = "fixture_casebook_entries";

/** A row function refusing every record: the declaration's own answer, which a fold remembers. */
const refusingRows: FoldExtension["rows"] = async () => {
  throw new FoldRowRefusedError(REFUSAL, [TABLE]);
};

describe("a contributed table whose row function refuses", () => {
  test("costs its own table, and a second open neither rebuilds it nor asks the row function again", async () => {
    const { store, index, blobs, path } = await scopeWithBundle("fold-refusal-settled", foldBundle("[]"));
    const counting = countingHost(() => ({ refusal: "contribution-threw" }));

    await index.fold(store, undefined, loaded(index, blobs, counting.hosts));

    expect(holdsTable(path, TABLE)).toBe(false);
    expect(index.foldRefusals().map((refusal) => refusal.name)).toEqual([TABLE]);
    expect(index.foldRefusals()[0]!.contributionId).toBe(CONTRIBUTION_ID);
    // The reason names the table and contribution, not only what the row function said.
    expect(index.foldRefusals()[0]!.reason).toContain(TABLE);
    expect(index.foldRefusals()[0]!.reason).toContain(CONTRIBUTION_ID);
    expect(index.foldRefusals()[0]!.reason).toContain(REFUSAL);
    const asked = counting.counts.invocations;
    expect(asked).toBeGreaterThan(0);

    // A second connection reads what was written, not what the first index remembered.
    const second = new IndexDb(path);
    await second.fold(store, undefined, loaded(second, blobs, counting.hosts));

    expect(holdsTable(path, TABLE)).toBe(false);
    expect(second.foldRefusals().map((refusal) => refusal.name)).toEqual([TABLE]);
    expect(counting.counts.invocations).toBe(asked);
  });

  test("is built again by a re-pin to a bundle whose rows its declaration admits", async () => {
    const { repo, store, index, blobs, path, entry } = await scopeWithBundle(
      "fold-refusal-repinned",
      foldBundle("[{ id: 7, kind: 'claim', at: 'a commit', position: 0 }]"),
    );
    await index.fold(store, undefined, loaded(index, blobs));
    expect(index.foldRefusals().map((refusal) => refusal.name)).toEqual([TABLE]);

    // The same declaration from a record whose bundle answers; the refusal was keyed to the record.
    const answering = await blobs.put(
      foldBundle(
        "input.kind === 'claim' ? [{ id: input.id, kind: input.kind, at: input.commit, position: input.position }] : []",
      ),
    );
    await writeFixtureRecords(repo, [{ kind: "module", value: moduleDeclaring(MODULE_NAME, [entry], answering) }]);

    await index.fold(store, undefined, loaded(index, blobs));

    expect(holdsTable(path, TABLE)).toBe(true);
    expect(rowsOf(path, TABLE)).toHaveLength(1);
    expect(index.foldRefusals()).toEqual([]);
  });

  test("comes down before the commit that broke it is applied, so a crash between the two leaves no table claiming to hold it", async () => {
    // A crash inside the refusing commit's transaction stands in for one between commit and drop.
    const repo = await trackedRepo("fold-refusal-crash");
    const store = storeOf(repo);
    await writeFixtureRecords(repo, [{ kind: "claim", value: claim("first") }]);
    await writeFixtureRecords(repo, [
      { kind: "module", value: moduleDeclaring(MODULE_NAME, [foldEntry(CONTRIBUTION_ID)]) },
    ]);
    const path = join(await trackedDir(), "index.sqlite");
    const index = new IndexDb(path);
    await index.fold(store, undefined, handed(index));
    const before = index.watermark();

    let invocations = 0;
    const refusing: FoldContributions = {
      declarations: () => readFoldDeclarations(index, index.engine()).tables,
      extensions: async (tables) => ({
        extensions: tables.map((table) => ({
          table,
          rows: async (record) => {
            invocations += 1;
            return refusingRows(record);
          },
        })),
        close: async () => {},
      }),
    };
    await writeFixtureRecords(repo, [{ kind: "claim", value: claim("second") }]);
    const tip = await store.tip();

    const crashed = await index
      .fold(
        store,
        (event) => {
          if (event.phase === "mid-transaction" && event.commit === tip) {
            throw new Error("a crash inside the commit that broke the table");
          }
        },
        refusing,
      )
      .catch((error: unknown) => (error as Error).message);

    expect(crashed).toContain("a crash inside the commit that broke the table");
    expect(holdsTable(path, TABLE)).toBe(false);
    expect(index.foldRefusals().map((refusal) => refusal.name)).toEqual([TABLE]);
    expect(index.watermark()).toBe(before);

    const asked = invocations;
    await index.fold(store, undefined, refusing);

    expect(invocations).toBe(asked);
    expect(index.watermark()).toBe(tip);
  });

  test("leaves the kernel's own tables, a second pack's table and the watermark where a pass that refused nothing leaves them", async () => {
    const repo = await trackedRepo("fold-refusal-isolated");
    const store = storeOf(repo);
    await writeFixtureRecords(repo, [{ kind: "claim", value: claim("first") }]);
    await writeFixtureRecords(repo, [
      { kind: "module", value: moduleDeclaring(MODULE_NAME, [foldEntry(CONTRIBUTION_ID)]) },
      { kind: "module", value: moduleDeclaring("fixture-casebook", [foldEntry("fixture-casebook/entries")]) },
    ]);
    const path = join(await trackedDir(), "index.sqlite");
    const index = new IndexDb(path);
    // Both tables current first, so the pass meeting the refusal is a walk, not a reconcile.
    await index.fold(store, undefined, handed(index));
    expect(holdsTable(path, TABLE)).toBe(true);

    await writeFixtureRecords(repo, [{ kind: "claim", value: claim("second") }]);
    await index.fold(store, undefined, {
      declarations: () => readFoldDeclarations(index, index.engine()).tables,
      extensions: async (tables) => ({
        extensions: tables.map((table) => ({ table, rows: table.name === TABLE ? refusingRows : tupleRows })),
        close: async () => {},
      }),
    });

    expect(holdsTable(path, TABLE)).toBe(false);
    expect(index.foldRefusals().map((refusal) => refusal.name)).toEqual([TABLE]);
    expect(index.watermark()).toBe(await store.tip());
    expect(rowsOf(path, SECOND_TABLE)).toHaveLength(2);
    expect(kernelTablesHeld(path)["claims"]).toHaveLength(2);
  });
});

describe("what an envelope's own failure code costs a contributed table", () => {
  /** Folds a workspace whose row function answers `code` for every record. */
  async function foldedRefusing(scope: string, code: ErrorCode) {
    const { store, index, blobs, path } = await scopeWithBundle(scope, foldBundle("[]"));
    const counting = countingHost(() => ({ refusal: code }));

    await index.fold(store, undefined, loaded(index, blobs, counting.hosts));

    return { store, index, blobs, path, counting };
  }

  test.each(["time-limit", "memory-limit"] as const)(
    "%s takes the table down and is not written down, so the next open asks the row function again",
    async (code) => {
      const { store, index, blobs, path } = await foldedRefusing(`fold-${code}`, code);

      // A deadline or a ceiling is a fact about this machine now, never about the pack.
      expect(holdsTable(path, TABLE)).toBe(false);
      expect(index.foldRefusals()).toEqual([]);

      const answering = countingHost((request) => ({
        rows: [{ ...(request.input as Record<string, unknown>), at: "a commit" }],
      }));
      const second = new IndexDb(path);
      await second.fold(store, undefined, loaded(second, blobs, answering.hosts));

      expect(answering.counts.invocations).toBeGreaterThan(0);
      expect(holdsTable(path, TABLE)).toBe(true);
    },
  );

  test("every code the envelope can carry is classified, so an eleventh cannot arrive without someone saying which it is", () => {
    expect([...Object.keys(ANSWERED_BY_THE_DECLARATION)].sort()).toEqual([...ERROR_CODES].sort());
    // Remembered only for a fact about the bundle alone, since only a re-pin clears it.
    expect(ERROR_CODES.filter((code) => ANSWERED_BY_THE_DECLARATION[code])).toEqual([
      "unknown-contribution",
      "invalid-output",
      "contribution-threw",
    ]);
  });

  test("a bundle that throws is remembered through the host this machine folds with, and a later open does not ask it again", async () => {
    const { store, index, blobs, path } = await scopeWithBundle(
      "fold-bundle-threw",
      foldBundle("(() => { throw new Error('the bundle threw'); })()"),
    );

    await index.fold(store, undefined, loaded(index, blobs));

    expect(holdsTable(path, TABLE)).toBe(false);
    expect(index.foldRefusals().map((refusal) => refusal.name)).toEqual([TABLE]);
    expect(index.foldRefusals()[0]!.reason).toContain("the bundle threw");

    // With the refusal settled nothing is built, so no module is loaded.
    const counting = countingHost(() => ({ rows: [] }));
    const second = new IndexDb(path);
    await second.fold(store, undefined, loaded(second, blobs, counting.hosts));

    expect(counting.counts.loads).toBe(0);
    expect(second.foldRefusals().map((refusal) => refusal.name)).toEqual([TABLE]);
  });

  test("a bundle that never answers inside its time limit is not remembered, so the next open asks it again", async () => {
    const { store, index, blobs, path } = await scopeWithBundle(
      "fold-bundle-timed-out",
      foldBundle("await new Promise(() => {})"),
    );

    await index.fold(store, undefined, loaded(index, blobs));

    expect(holdsTable(path, TABLE)).toBe(false);
    expect(index.foldRefusals()).toEqual([]);

    const answering = countingHost((request) => ({
      rows: [{ ...(request.input as Record<string, unknown>), at: "a commit" }],
    }));
    const second = new IndexDb(path);
    await second.fold(store, undefined, loaded(second, blobs, answering.hosts));

    expect(answering.counts.invocations).toBeGreaterThan(0);
    expect(holdsTable(path, TABLE)).toBe(true);
  });

  test("contribution-threw is the declaration's own answer, so it is written down and the next open does not ask again", async () => {
    const { store, index, blobs, path, counting } = await foldedRefusing(
      "fold-contribution-threw",
      "contribution-threw",
    );

    expect(holdsTable(path, TABLE)).toBe(false);
    expect(index.foldRefusals().map((refusal) => refusal.name)).toEqual([TABLE]);
    expect(index.foldRefusals()[0]!.settled).toBe(true);
    const asked = counting.counts.invocations;

    const second = new IndexDb(path);
    await second.fold(store, undefined, loaded(second, blobs, counting.hosts));

    expect(counting.counts.invocations).toBe(asked);
    expect(second.foldRefusals().map((refusal) => refusal.name)).toEqual([TABLE]);
  });
});

describe("a contributed table whose host gives out", () => {
  test("is taken down with nothing written about it, so the next open asks the row function again", async () => {
    const { store, index, blobs, path } = await scopeWithBundle("fold-host-gave-out", foldBundle("[]"));
    const failing = countingHost(() => {
      throw new Error("the host gave out");
    });

    await index.fold(store, undefined, loaded(index, blobs, failing.hosts));

    // Nothing about the declaration was answered, so nothing is remembered.
    expect(holdsTable(path, TABLE)).toBe(false);
    expect(index.foldRefusals()).toEqual([]);
    expect(failing.counts.invocations).toBeGreaterThan(0);

    const answering = countingHost((request) => ({
      rows: [{ ...(request.input as Record<string, unknown>), at: "a commit" }],
    }));
    const second = new IndexDb(path);
    await second.fold(store, undefined, loaded(second, blobs, answering.hosts));

    expect(answering.counts.invocations).toBeGreaterThan(0);
    expect(holdsTable(path, TABLE)).toBe(true);
    expect(second.foldRefusals()).toEqual([]);
  });
});
