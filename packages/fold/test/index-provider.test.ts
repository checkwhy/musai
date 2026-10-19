import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  checkIndexProvider,
  type IndexCapability,
  type IndexConnection,
  type IndexProvider,
  openIndexProvider,
} from "../src/sqlite-provider.js";

const scratchDirs: string[] = [];

afterEach(async () => {
  for (const dir of scratchDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

/** The contract opens its file twice, so each check gets a file of its own. */
async function scratchPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "musai-index-provider-"));
  scratchDirs.push(dir);
  return join(dir, "conformance.sqlite");
}

function firstStatementOf(sql: string): string {
  const end = sql.indexOf(";");
  return end === -1 ? sql : sql.slice(0, end + 1);
}

/** The runtime's engine behind a tenant's name and capabilities, optionally refusing statements. */
function tenantProvider(options: {
  name: string;
  capabilities: readonly string[];
  refuses?: RegExp;
  runsFirstStatementOnly?: boolean;
}): IndexProvider {
  const engine = openIndexProvider();
  const refused = (sql: string): void => {
    if (options.refuses?.test(sql) === true) {
      throw new Error(`${options.name} cannot compile: ${sql}`);
    }
  };
  const guarded = (connection: IndexConnection): IndexConnection => ({
    prepare: (sql) => {
      refused(sql);
      return connection.prepare(sql);
    },
    exec: (sql) => {
      refused(sql);
      connection.exec(options.runsFirstStatementOnly === true ? firstStatementOf(sql) : sql);
    },
    close: () => {
      connection.close();
    },
  });
  return {
    name: options.name,
    capabilities: () => new Set(options.capabilities as readonly IndexCapability[]),
    open: (path) => guarded(engine.open(path)),
    openReadOnly: (path) => guarded(engine.openReadOnly(path)),
  };
}

describe("the index provider this runtime selects", () => {
  test("satisfies the contract every provider is held to", async () => {
    expect(checkIndexProvider(openIndexProvider(), await scratchPath())).toEqual([]);
  });

  test("refuses a write through a connection it opened read-only", async () => {
    const provider = openIndexProvider();
    const path = await scratchPath();
    const writable = provider.open(path);
    writable.exec("CREATE TABLE held (key TEXT PRIMARY KEY)");
    writable.close();

    const readOnly = provider.openReadOnly(path);
    try {
      expect(() => readOnly.prepare("INSERT INTO held (key) VALUES (?)").run("one")).toThrow();
      expect(() => readOnly.exec("CREATE TABLE trespass (key TEXT)")).toThrow();
      expect(readOnly.prepare("SELECT key FROM held").all()).toEqual([]);
    } finally {
      readOnly.close();
    }
  });

  test("binds a named parameter written as a bare name", async () => {
    const provider = openIndexProvider();
    const connection = provider.open(":memory:");
    try {
      connection.exec("CREATE TABLE held (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      connection.prepare("INSERT INTO held (key, value) VALUES (?, ?)").run("one", "first");
      const statement = connection.prepare("SELECT value FROM held WHERE key = :key");
      expect(statement.all({ key: "one" })).toEqual([{ value: "first" }]);
      expect(statement.get({ key: "absent" })).toBeUndefined();
    } finally {
      connection.close();
    }
  });

  test("answers how many rows a statement changed", async () => {
    const provider = openIndexProvider();
    const connection = provider.open(":memory:");
    try {
      connection.exec("CREATE TABLE held (key TEXT PRIMARY KEY)");
      const insert = connection.prepare("INSERT INTO held (key) VALUES (?) ON CONFLICT(key) DO NOTHING");
      expect(insert.run("one").changes).toBe(1);
      expect(insert.run("one").changes).toBe(0);
    } finally {
      connection.close();
    }
  });
});

describe("the index provider contract, handed a provider the suite did not construct", () => {
  test("passes a provider claiming only what its connection serves", async () => {
    const provider = tenantProvider({
      name: "tenant",
      capabilities: [...openIndexProvider().capabilities()],
    });
    expect(checkIndexProvider(provider, await scratchPath())).toEqual([]);
  });

  test("fails by name on a capability the provider claims and its connection cannot serve", async () => {
    const provider = tenantProvider({
      name: "tenant-without-fts",
      capabilities: ["fts"],
      refuses: /VIRTUAL TABLE/,
    });
    const failures = checkIndexProvider(provider, await scratchPath());
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("fts");
  });

  test("fails by name on an engine that runs the first statement of a text and silently discards the rest", async () => {
    // Such an engine admits a declaration that a whole engine refuses.
    const provider = tenantProvider({
      name: "tenant-truncating-a-text",
      capabilities: [...openIndexProvider().capabilities()],
      runsFirstStatementOnly: true,
    });

    const failures = checkIndexProvider(provider, await scratchPath());

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("sequence_first");
  });

  test("fails by name on a capability word the kernel does not admit", async () => {
    const provider = tenantProvider({ name: "tenant-inventing-a-word", capabilities: ["telepathy"] });
    const failures = checkIndexProvider(provider, await scratchPath());
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("telepathy");
  });
});
