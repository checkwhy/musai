import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FoldContributions,
  type FoldEngine,
  type FoldExtension,
  FoldRowRefusedError,
  IndexDb,
  openIndexProvider,
} from "@musai/fold";
import type { ContributionEntry, ModuleRecord } from "@musai/records";
import { CURRENT_SCHEMA_VERSIONS, recordId, versionString } from "@musai/records";
import { Store } from "@musai/store";
import {
  blobStoreOf,
  type FixtureRepo,
  makeFixtureRepo,
  manifestWithContributions,
  writeFixtureRecords,
} from "@musai/test-support";
import { afterEach, describe, expect, test } from "vitest";
import { foldExtensionsFrom, foldTableFromEntry, readFoldDeclarations } from "../src/module/fold-registry.js";
import { HOSTS } from "../src/module/hosts.js";
import {
  QueryRefusedError,
  queryDeclarationFromEntry,
  queryFor,
  readQueryDeclarations,
} from "../src/module/query-registry.js";

const MODULE_NAME = "fixture-query";
const FOLD_ID = `${MODULE_NAME}/rows`;
/** The SQL name the fold contribution's id renders to. */
const TABLE = "fixture_query_rows";

/** The engine a declaration is checked against, offering nothing beyond a scratch database. */
const engine: FoldEngine = {
  name: "fixture-engine",
  capabilities: new Set(),
  scratch: () => openIndexProvider().open(":memory:"),
};

let repos: FixtureRepo[] = [];
let dirs: string[] = [];

afterEach(async () => {
  await Promise.all(repos.map((repo) => repo.cleanup()));
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  repos = [];
  dirs = [];
});

/** The halves a `query` entry declares, all but the statement defaulted to the fixture table's. */
interface QueryHalves {
  readonly statement: string;
  readonly tables?: readonly string[];
  readonly parameters?: Record<string, unknown>;
  readonly row?: Record<string, unknown>;
  /** The names a row must carry, and whether it admits any column beyond the ones it declares. */
  readonly requiredRow?: readonly string[];
  readonly openRow?: boolean;
}

function queryEntry(id: string, halves: QueryHalves): ContributionEntry {
  return {
    kind: "query",
    id,
    version: versionString("1"),
    input: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: halves.parameters ?? {},
      statement: halves.statement,
      tables: halves.tables ?? [TABLE],
    },
    output: {
      type: "object",
      additionalProperties: false,
      required: ["rows"],
      properties: {
        rows: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: halves.openRow === true,
            required: halves.requiredRow ?? [],
            properties: halves.row ?? { kind: { type: "string" } },
          },
        },
      },
    },
    documentation: `what ${id} answers`,
  };
}

/** The fold entry declaring the fixture table: one column, the kind of the record answered for. */
const foldEntry: ContributionEntry = {
  kind: "fold",
  id: FOLD_ID,
  version: versionString("1"),
  input: true,
  output: {
    type: "object",
    additionalProperties: false,
    required: ["rows"],
    properties: {
      rows: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind"],
          properties: { kind: { type: "string" } },
        },
      },
    },
  },
  documentation: "one row per record, carrying its kind",
};

const foldTable = foldTableFromEntry(foldEntry);

/** The module declaring `entries`, sorted by id as a manifest carries them. */
function moduleDeclaring(entries: readonly ContributionEntry[]): ModuleRecord {
  const contributions = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    kind: "module",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.module,
    name: MODULE_NAME,
    version: versionString("1.0.0"),
    manifest: manifestWithContributions(contributions),
    bundle: recordId({ marker: `bundle-for-${MODULE_NAME}` }),
    build: recordId({ marker: `build-for-${MODULE_NAME}` }),
  };
}

const kindRows: FoldExtension["rows"] = async (record) => [{ kind: record.kind }];

/** The fixture table's declarations, with `rows` answering for every table asked for. */
function answering(rows: FoldExtension["rows"]): (index: IndexDb) => FoldContributions {
  return (index) => ({
    declarations: () => readFoldDeclarations(index, index.engine()).tables,
    extensions: async (tables) => ({
      extensions: tables.map((table) => ({ table, rows })),
      close: async () => {},
    }),
  });
}

const handed = answering(kindRows);

/** Row functions from a bundle the fixture never writes: the table is declared and never built,
 * as in a clone whose records arrived without their blobs. */
function throughBundles(index: IndexDb, repo: FixtureRepo): FoldContributions {
  return {
    declarations: () => readFoldDeclarations(index, index.engine()).tables,
    extensions: (tables) => foldExtensionsFrom(tables, index, blobStoreOf(repo.workspace), HOSTS),
  };
}

/** A workspace folded into a file, since a query reads through a second connection to it. */
async function foldedWorkspace(
  scope: string,
  entries: readonly ContributionEntry[],
  contributions: (index: IndexDb, repo: FixtureRepo) => FoldContributions = handed,
): Promise<IndexDb> {
  const repo = await makeFixtureRepo(scope);
  repos.push(repo);
  await writeFixtureRecords(repo, [{ kind: "module", value: moduleDeclaring(entries) }]);
  const dir = await mkdtemp(join(tmpdir(), "musai-query-contribution-"));
  dirs.push(dir);
  const index = new IndexDb(join(dir, "index.sqlite"));
  await index.fold(
    new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }),
    undefined,
    contributions(index, repo),
  );
  return index;
}

/** The refusal `attempt` raised, so a test reads its message rather than only its type. */
function refusalFrom(attempt: () => unknown): Error {
  try {
    attempt();
  } catch (error) {
    return error as Error;
  }
  throw new Error("the declaration was admitted");
}

describe("what a query declaration is refused for", () => {
  test("a statement that is not a read is refused by name, whatever the tables it declares", () => {
    const entry = queryEntry(`${MODULE_NAME}/writes`, { statement: `INSERT INTO ${TABLE} (kind) VALUES ('claim')` });

    const refusal = refusalFrom(() => queryDeclarationFromEntry(entry, [], engine));

    expect(refusal).toBeInstanceOf(QueryRefusedError);
    expect(refusal.message).toContain(`${MODULE_NAME}/writes`);
    expect(refusal.message).toContain("INSERT");
  });

  test("a statement carrying a second one is refused by name, since an engine compiles the first and discards the rest", () => {
    const entry = queryEntry(`${MODULE_NAME}/two`, { statement: `SELECT kind FROM ${TABLE}; DROP TABLE ${TABLE}` });

    const refusal = refusalFrom(() => queryDeclarationFromEntry(entry, [], engine));

    expect(refusal).toBeInstanceOf(QueryRefusedError);
    expect(refusal.message).toContain(`${MODULE_NAME}/two`);
    expect(refusal.message).toContain("discards the rest");
  });

  test("a declared parameter the statement binds under another spelling is refused by name, since one engine takes it and the other does not", () => {
    const entry = queryEntry(`${MODULE_NAME}/dollar`, {
      statement: "SELECT kind FROM records WHERE kind = $kind",
      tables: ["records"],
      parameters: { kind: { type: "string" } },
    });

    const refusal = refusalFrom(() => queryDeclarationFromEntry(entry, [], engine));

    expect(refusal).toBeInstanceOf(QueryRefusedError);
    expect(refusal.message).toContain(`${MODULE_NAME}/dollar`);
    expect(refusal.message).toContain(":kind");
  });

  test("a parameter the statement binds and the declaration does not declare is refused by name, since nothing could ever bind it", () => {
    const entry = queryEntry(`${MODULE_NAME}/undeclared-parameter`, {
      statement: "SELECT kind FROM records WHERE kind = :sneaky",
      tables: ["records"],
    });

    const refusal = refusalFrom(() => queryDeclarationFromEntry(entry, [], engine));

    expect(refusal).toBeInstanceOf(QueryRefusedError);
    expect(refusal.message).toContain(`${MODULE_NAME}/undeclared-parameter`);
    expect(refusal.message).toContain(":sneaky");
  });

  test("a control character is refused by name, since an engine reads a statement's text no further than the first of them", () => {
    const entry = queryEntry(`${MODULE_NAME}/truncated`, {
      statement: `SELECT id FROM records ${String.fromCodePoint(0)} WHERE kind = 'module'`,
      tables: ["records"],
      row: { id: { type: "string" } },
    });

    const refusal = refusalFrom(() => queryDeclarationFromEntry(entry, [], engine));

    expect(refusal).toBeInstanceOf(QueryRefusedError);
    expect(refusal.message).toContain(`${MODULE_NAME}/truncated`);
    expect(refusal.message).toContain("U+0000");
  });

  test("a control character before a parameter is refused as the truncation it is, rather than passing as a statement that binds it", () => {
    // An engine never reads past the character, so a mention there must not count as binding.
    const entry = queryEntry(`${MODULE_NAME}/truncated-parameter`, {
      statement: `SELECT id FROM records ${String.fromCodePoint(0)} WHERE kind = :kind`,
      tables: ["records"],
      parameters: { kind: { type: "string" } },
      row: { id: { type: "string" } },
    });

    const refusal = refusalFrom(() => queryDeclarationFromEntry(entry, [], engine));

    expect(refusal).toBeInstanceOf(QueryRefusedError);
    expect(refusal.message).toContain("U+0000");
    expect(refusal.message).not.toContain("never binds");
  });

  test("a placeholder's punctuation inside a string literal, a quoted identifier or a comment binds nothing, so a statement carrying only those is admitted", () => {
    const entry = queryEntry(`${MODULE_NAME}/prefixed`, {
      statement:
        'SELECT kind AS "a:b", id AS [c:d] FROM records -- an id reads sha256:hex, never @name, $name or ?\n' +
        "WHERE id LIKE 'sha256:%' AND id <> 'a''b:e' AND id <> 'a?b@c$d' /* a scope like a:f */",
      tables: ["records"],
      row: { "a:b": { type: "string" }, "c:d": { type: "string" } },
    });

    expect(() => queryDeclarationFromEntry(entry, [], engine)).not.toThrow();
  });

  test("a name bound the way one engine spells it is refused under the token it was found as", () => {
    for (const token of ["@sneaky", "$sneaky"]) {
      const entry = queryEntry(`${MODULE_NAME}/${token.slice(1)}`, {
        statement: `SELECT kind FROM records WHERE kind = ${token}`,
        tables: ["records"],
      });

      const refusal = refusalFrom(() => queryDeclarationFromEntry(entry, [], engine));

      expect(refusal).toBeInstanceOf(QueryRefusedError);
      expect(refusal.message).toContain(token);
      expect(refusal.message).toContain(":sneaky");
    }
  });

  test("a parameter bound by position is refused as the mechanism it is, not as a misspelled name", () => {
    for (const token of ["?", "?1"]) {
      const entry = queryEntry(`${MODULE_NAME}/positional`, {
        statement: `SELECT kind FROM records WHERE kind = ${token}`,
        tables: ["records"],
      });

      const refusal = refusalFrom(() => queryDeclarationFromEntry(entry, [], engine));

      expect(refusal).toBeInstanceOf(QueryRefusedError);
      expect(refusal.message).toContain(`binds ${token}`);
      expect(refusal.message).toContain("by position");
    }
  });

  test("a declared parameter whose only appearance is inside a literal is refused as one the statement never binds, because it does not", () => {
    const entry = queryEntry(`${MODULE_NAME}/mentioned`, {
      statement: "SELECT kind FROM records WHERE id LIKE 'sha256:kind'",
      tables: ["records"],
      parameters: { kind: { type: "string" } },
    });

    const refusal = refusalFrom(() => queryDeclarationFromEntry(entry, [], engine));

    expect(refusal).toBeInstanceOf(QueryRefusedError);
    expect(refusal.message).toContain("never binds as :kind");
  });

  test("a semicolon inside a literal ends no statement, so it is not what the second-statement refusal is about", () => {
    const entry = queryEntry(`${MODULE_NAME}/semicolon`, {
      statement: "SELECT kind FROM records WHERE id LIKE 'a;b'",
      tables: ["records"],
    });

    expect(() => queryDeclarationFromEntry(entry, [], engine)).not.toThrow();
  });

  test("a table the kernel keeps its own bookkeeping in is refused by name as one no query may declare", () => {
    const entry = queryEntry(`${MODULE_NAME}/watermark`, {
      statement: "SELECT commit_sha FROM watermark",
      tables: ["watermark"],
    });

    const refusal = refusalFrom(() => queryDeclarationFromEntry(entry, [], engine));

    expect(refusal).toBeInstanceOf(QueryRefusedError);
    expect(refusal.message).toContain("watermark");
    expect(refusal.message).toContain("nor a table a fold contribution declares");
  });

  test("a statement reading a table it did not declare is refused quoting the engine's own message", () => {
    const entry = queryEntry(`${MODULE_NAME}/joins`, {
      statement: "SELECT records.id FROM records JOIN claims ON claims.record_id = records.id",
      tables: ["records"],
    });

    const refusal = refusalFrom(() => queryDeclarationFromEntry(entry, [], engine));

    expect(refusal).toBeInstanceOf(QueryRefusedError);
    expect(refusal.message).toContain("no such table: claims");
  });

  test("a column the statement projects and the row declares no property for is refused by name, since no row it answers could validate", () => {
    const entry = queryEntry(`${MODULE_NAME}/wide`, { statement: `SELECT kind, record_id FROM ${TABLE}` });

    const refusal = refusalFrom(() => queryDeclarationFromEntry(entry, [foldTable], engine));

    expect(refusal).toBeInstanceOf(QueryRefusedError);
    expect(refusal.message).toContain(`${MODULE_NAME}/wide`);
    expect(refusal.message).toContain("record_id");
  });

  test("a name the row requires and the statement projects no column for is refused by name, since every row would be missing it", () => {
    const entry = queryEntry(`${MODULE_NAME}/short`, {
      statement: `SELECT kind FROM ${TABLE}`,
      row: { kind: { type: "string" }, ordinal: { type: "integer" } },
      requiredRow: ["kind", "ordinal"],
    });

    const refusal = refusalFrom(() => queryDeclarationFromEntry(entry, [foldTable], engine));

    expect(refusal).toBeInstanceOf(QueryRefusedError);
    expect(refusal.message).toContain("ordinal");
  });

  test("a row that admits columns beyond the ones it declares means it, so its statement's own columns are not compared", () => {
    const entry = queryEntry(`${MODULE_NAME}/open`, {
      statement: `SELECT kind, record_id FROM ${TABLE}`,
      openRow: true,
    });

    expect(() => queryDeclarationFromEntry(entry, [foldTable], engine)).not.toThrow();
  });

  test("a parameter declaring a type no value binds as is refused by name, since one engine binds it and the other throws", () => {
    const entry = queryEntry(`${MODULE_NAME}/flagged`, {
      statement: `SELECT kind FROM ${TABLE} WHERE :flag IS NULL OR kind = :flag`,
      parameters: { flag: { type: "boolean" } },
    });

    const refusal = refusalFrom(() => queryDeclarationFromEntry(entry, [], engine));

    expect(refusal).toBeInstanceOf(QueryRefusedError);
    expect(refusal.message).toContain(`${MODULE_NAME}/flagged`);
    expect(refusal.message).toContain("flag");
    expect(refusal.message).toContain("boolean");
  });

  test("an input that is not the schema its own parameters satisfy is refused by name", () => {
    const entry: ContributionEntry = {
      ...queryEntry(`${MODULE_NAME}/shapeless`, { statement: `SELECT kind FROM ${TABLE}` }),
      input: { statement: `SELECT kind FROM ${TABLE}`, tables: [TABLE] },
    };

    const refusal = refusalFrom(() => queryDeclarationFromEntry(entry, [], engine));

    expect(refusal).toBeInstanceOf(QueryRefusedError);
    expect(refusal.message).toContain(`${MODULE_NAME}/shapeless`);
  });
});

describe("what a declared query answers", () => {
  test("reads the table a fold contribution of its own module declares", async () => {
    const index = await foldedWorkspace("query-contributed-table", [
      foldEntry,
      queryEntry(`${MODULE_NAME}/kinds`, { statement: `SELECT kind FROM ${TABLE} ORDER BY kind ASC` }),
    ]);

    const rows = index.runQuery(queryFor(`${MODULE_NAME}/kinds`, readQueryDeclarations(index)), {});

    expect(rows).toEqual([{ kind: "module" }]);
  });

  test("answers differently for a parameter bound to a value and the same parameter bound to nothing", async () => {
    const index = await foldedWorkspace("query-bound-parameter", [
      queryEntry(`${MODULE_NAME}/records`, {
        statement: "SELECT id FROM records WHERE :kind IS NULL OR kind = :kind ORDER BY id ASC",
        tables: ["records"],
        parameters: { kind: { type: ["string", "null"] } },
        row: { id: { type: "string" } },
      }),
    ]);
    const declaration = queryFor(`${MODULE_NAME}/records`, readQueryDeclarations(index));

    expect(index.runQuery(declaration, { kind: null })).toHaveLength(1);
    expect(index.runQuery(declaration, { kind: "module" })).toHaveLength(1);
    expect(index.runQuery(declaration, { kind: "claim" })).toHaveLength(0);
  });

  test("a write the declaration's own guards admit still fails at the engine, on a connection that cannot write", async () => {
    // A write dressed as a read passes the first two guards; only the connection refuses it.
    const index = await foldedWorkspace("query-read-only", [
      foldEntry,
      queryEntry(`${MODULE_NAME}/smuggled`, {
        statement: `WITH smuggled AS (SELECT 1) INSERT INTO ${TABLE} (record_id, ordinal, kind) SELECT 'x', 0, 'y' FROM smuggled`,
      }),
    ]);
    const declaration = queryFor(`${MODULE_NAME}/smuggled`, readQueryDeclarations(index));

    expect(() => index.runQuery(declaration, {})).toThrow("readonly database");
  });
});

describe("a query this workspace cannot stand up", () => {
  test("costs that query alone, and is refused by its own reason with nothing said about any other", async () => {
    const index = await foldedWorkspace("query-refused-one", [
      foldEntry,
      queryEntry(`${MODULE_NAME}/kinds`, { statement: `SELECT kind FROM ${TABLE} ORDER BY kind ASC` }),
      queryEntry(`${MODULE_NAME}/absent`, { statement: "SELECT nothing FROM claims", tables: ["claims"] }),
    ]);

    const declarations = readQueryDeclarations(index);

    expect(declarations.queries.map((query) => query.id)).toEqual([`${MODULE_NAME}/kinds`]);
    expect(declarations.refused.map((refusal) => refusal.name)).toEqual([`${MODULE_NAME}/absent`]);
    expect(index.runQuery(queryFor(`${MODULE_NAME}/kinds`, declarations), {})).toEqual([{ kind: "module" }]);

    const refusal = refusalFrom(() => queryFor(`${MODULE_NAME}/absent`, declarations));

    expect(refusal).toBeInstanceOf(QueryRefusedError);
    expect(refusal.message).toContain(`${MODULE_NAME}/absent`);
    expect(refusal.message).not.toContain(`${MODULE_NAME}/kinds`);
  });

  test("is what a query over a table this machine could not build becomes, rather than a statement that fails at the call", async () => {
    // The row function failed as the machine, so nothing was written down about this table.
    const index = await foldedWorkspace(
      "query-over-unbuilt-table",
      [foldEntry, queryEntry(`${MODULE_NAME}/kinds`, { statement: `SELECT kind FROM ${TABLE} ORDER BY kind ASC` })],
      answering(async () => {
        throw new Error("the host gave out");
      }),
    );
    expect(index.foldRefusals()).toEqual([]);
    expect(index.foldTablesHeld().has(TABLE)).toBe(false);

    const declarations = readQueryDeclarations(index);

    expect(declarations.queries).toEqual([]);
    const refusal = refusalFrom(() => queryFor(`${MODULE_NAME}/kinds`, declarations));
    expect(refusal.message).toContain(TABLE);
    expect(refusal.message).toContain("did not answer here");
    expect(refusal.message).not.toContain("refused a record");
  });

  test("is what a query over a table whose bundle this workspace never had becomes, since nothing could build it either", async () => {
    const index = await foldedWorkspace(
      "query-over-bundleless-table",
      [foldEntry, queryEntry(`${MODULE_NAME}/kinds`, { statement: `SELECT kind FROM ${TABLE} ORDER BY kind ASC` })],
      throughBundles,
    );
    expect(index.foldTablesHeld().has(TABLE)).toBe(false);

    const declarations = readQueryDeclarations(index);

    expect(declarations.queries).toEqual([]);
    expect(refusalFrom(() => queryFor(`${MODULE_NAME}/kinds`, declarations)).message).toContain(TABLE);
  });

  test("is refused for what its own parameter declares, not for the table, when it declares both badly", async () => {
    // Parameters are read before tables, so the refusal names the type, not the missing table.
    const index = await foldedWorkspace(
      "query-bad-parameter-over-absent-table",
      [
        foldEntry,
        queryEntry(`${MODULE_NAME}/flagged`, {
          statement: `SELECT kind FROM ${TABLE} WHERE :flag IS NULL OR kind = :flag`,
          parameters: { flag: { type: "boolean" } },
        }),
      ],
      answering(async () => {
        throw new FoldRowRefusedError("the row function refused this record", [TABLE]);
      }),
    );

    const refusal = readQueryDeclarations(index).refused[0]!;

    expect(refusal.reason).toContain("boolean");
    expect(refusal.reason).not.toContain("does not hold");
  });

  test("is what a query over a table whose own row function refused becomes, rather than a statement that fails at the call", async () => {
    const index = await foldedWorkspace(
      "query-over-refused-table",
      [foldEntry, queryEntry(`${MODULE_NAME}/kinds`, { statement: `SELECT kind FROM ${TABLE} ORDER BY kind ASC` })],
      answering(async () => {
        throw new FoldRowRefusedError("the row function refused this record", [TABLE]);
      }),
    );
    expect(index.foldRefusals().map((refusal) => refusal.name)).toEqual([TABLE]);

    const declarations = readQueryDeclarations(index);

    expect(declarations.queries).toEqual([]);
    expect(refusalFrom(() => queryFor(`${MODULE_NAME}/kinds`, declarations)).message).toContain(TABLE);
  });
});
