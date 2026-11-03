import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordId } from "@musai/records";
import { expect, onTestFinished, test, vi } from "vitest";
import { INDEX_SCHEMA_VERSION, IndexDb } from "../src/index-db.js";
import type { QueryDeclaration } from "../src/rows.js";
import { type IndexConnection, openIndexProvider } from "../src/sqlite-provider.js";

async function foldPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "musai-index-open-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "index.sqlite");
}

test("an index whose schema cannot be reset refuses the open and leaves no connection behind", async () => {
  const path = await foldPath();
  const squatter = openIndexProvider().open(path);
  squatter.exec("CREATE VIEW records AS SELECT 1 AS id");
  squatter.close();
  const open = vi.spyOn(openIndexProvider(), "open");
  onTestFinished(() => open.mockRestore());

  expect(() => new IndexDb(path)).toThrow(/view/i);

  const [opened] = open.mock.results.map((result) => result.value as IndexConnection);
  expect(() => opened!.exec("SELECT 1")).toThrow(/not open/);
});

test("a fold file that is not a SQLite database is rebuilt, not refused", async () => {
  const path = await foldPath();
  await writeFile(path, "a fold this is not, though it stands where one is kept\n".repeat(8));

  using index = new IndexDb(path);

  expect(index.watermark()).toBeNull();
  const reader = openIndexProvider().openReadOnly(path);
  onTestFinished(() => reader.close());
  expect(reader.prepare("SELECT version FROM schema_meta WHERE id = 0").get()).toEqual({
    version: INDEX_SCHEMA_VERSION,
  });
});

test("an index at another schema version is rebuilt holding no byte its freed pages held", async () => {
  const path = await foldPath();
  new IndexDb(path).close();
  const canary = "canary: a row an index freed before it overwrote what it freed";
  const older = openIndexProvider().open(path);
  older.exec("PRAGMA secure_delete = OFF");
  older.exec("CREATE TABLE freed (held TEXT)");
  older.prepare("INSERT INTO freed (held) VALUES (?)").run(canary.repeat(64));
  older.exec("DROP TABLE freed");
  older.exec(`UPDATE schema_meta SET version = ${INDEX_SCHEMA_VERSION - 1} WHERE id = 0`);
  older.close();
  expect((await readFile(path)).includes(canary)).toBe(true);

  new IndexDb(path).close();

  expect((await readFile(path)).includes(canary)).toBe(false);
});

test("an index closed twice stays closed without throwing", async () => {
  const index = new IndexDb(await foldPath());

  index.close();

  expect(() => index.close()).not.toThrow();
  expect(() => index.watermark()).toThrow();
});

const COUNT_RECORDS: QueryDeclaration = {
  id: "musai.index-open-test/records",
  version: "1",
  statement: "SELECT COUNT(*) AS n FROM records",
  tables: ["records"],
  parameters: {},
  rows: {},
  moduleRecord: recordId({ marker: "index-open-test" }),
};

test("a closed index refuses a declared query without opening a connection", async () => {
  const index = new IndexDb(await foldPath());
  index.close();
  const openReadOnly = vi.spyOn(openIndexProvider(), "openReadOnly");
  onTestFinished(() => openReadOnly.mockRestore());

  expect(() => index.runQuery(COUNT_RECORDS, {})).toThrow(/closed/);
  expect(openReadOnly).not.toHaveBeenCalled();
});

test("an index whose query connection fails to close still closes its fold", async () => {
  const provider = openIndexProvider();
  const openReadOnly = provider.openReadOnly.bind(provider);
  const spied = vi.spyOn(provider, "openReadOnly").mockImplementation((location) => {
    const reader = openReadOnly(location);
    const close = reader.close.bind(reader);
    reader.close = () => {
      close();
      throw new Error("the reader would not close");
    };
    return reader;
  });
  onTestFinished(() => spied.mockRestore());
  const index = new IndexDb(await foldPath());
  index.runQuery(COUNT_RECORDS, {});

  expect(() => index.close()).toThrow(/would not close/);
  expect(() => index.watermark()).toThrow();
  expect(() => index.close()).not.toThrow();
});
