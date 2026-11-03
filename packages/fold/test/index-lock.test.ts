import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, onTestFinished, test } from "vitest";
import { INDEX_SCHEMA_VERSION, IndexDb } from "../src/index-db.js";
import { openIndexProvider } from "../src/sqlite-provider.js";

/** Holds the file's write lock from another process for `holdMs`, answering once it is held; the
 * release is wrapped, since an async function's returned promise would be awaited with it. */
async function lockedByAnotherProcess(path: string, holdMs: number): Promise<{ released: Promise<void> }> {
  const holder = spawn(process.execPath, [
    "-e",
    `const { DatabaseSync } = require("node:sqlite");
     const db = new DatabaseSync(${JSON.stringify(path)});
     db.exec("BEGIN EXCLUSIVE");
     console.log("held");
     setTimeout(() => { db.exec("COMMIT"); db.close(); }, ${holdMs});`,
  ]);
  const released = new Promise<void>((resolve) => holder.on("exit", () => resolve()));
  for await (const line of createInterface({ input: holder.stdout })) {
    if (line === "held") {
      break;
    }
  }
  return { released };
}

test("an index another process holds the write lock on is waited for, not refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "musai-index-lock-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "index.sqlite");
  new IndexDb(path).close();
  const raw = openIndexProvider().open(path);
  raw.exec("UPDATE schema_meta SET version = 0 WHERE id = 0");
  raw.close();

  const { released } = await lockedByAnotherProcess(path, 500);
  new IndexDb(path).close();
  await released;

  const reopened = openIndexProvider().open(path);
  onTestFinished(() => reopened.close());
  expect(reopened.prepare("SELECT version FROM schema_meta WHERE id = 0").get()).toEqual({
    version: INDEX_SCHEMA_VERSION,
  });
}, 30_000);
