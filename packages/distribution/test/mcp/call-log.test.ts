import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isOperationError, type OperationContext, openWorkspace } from "@musai/api-core";
import { buildModule } from "@musai/devkit";
import { IndexDb } from "@musai/fold";
import { appendCall, type CallLogRequest, type CallLogResponse, callTool, openCallLog } from "@musai/mcp";
import { initWorkspace, LOCAL_DIR, listKeys, MUSAI_DIR, mintKeyFile, Store } from "@musai/store";
import { blobStoreOf, fixedClock } from "@musai/test-support";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MUSAI } from "../../src/musai.js";
import { repoGitDir } from "../repo-git-dir.js";

const GREETER_FIXTURE_DIR = fileURLToPath(new URL("./fixtures/greeter", import.meta.url));
const KNOWN_SECRET_VALUE = "definitely-not-supposed-to-leak-mcp-call-log";
const now = fixedClock("2026-08-31T00:00:00.000Z");

function localDirOf(workspace: string): string {
  return join(workspace, MUSAI_DIR, LOCAL_DIR);
}

async function readLoggedLines(
  path: string,
): Promise<readonly { request: CallLogRequest; response: CallLogResponse }[]> {
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { request: CallLogRequest; response: CallLogResponse });
}

describe("openCallLog", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-call-log-open-"));
    await initWorkspace(workspace, { now });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("two sessions each open their own file, never appending to the other's", async () => {
    const first = await openCallLog(workspace);
    const second = await openCallLog(workspace);
    expect(first.path).not.toBe(second.path);
  });

  test("the log directory's own mode is owner-only", async () => {
    const log = await openCallLog(workspace);
    const stats = await stat(join(log.path, ".."));
    expect(stats.mode & 0o777).toBe(0o700);
  });
});

describe("appendCall", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-call-log-append-"));
    await initWorkspace(workspace, { now });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("a line parses as the operation message envelope's own request and response halves", async () => {
    const log = await openCallLog(workspace);
    await appendCall(
      log,
      workspace,
      { contribution: "parser", id: "pack/parses", version: "1", input: { x: "y" } },
      { ok: true, output: { z: "w" }, diagnostics: [] },
    );
    const [line] = await readLoggedLines(log.path);
    expect(line).toEqual({
      request: { contribution: "parser", id: "pack/parses", version: "1", input: { x: "y" } },
      response: { ok: true, output: { z: "w" }, diagnostics: [] },
    });
  });

  test("a refused call appears in the log with its reason, not omitted", async () => {
    const log = await openCallLog(workspace);
    await appendCall(
      log,
      workspace,
      { contribution: "parser", id: "pack/parses", version: "1", input: {} },
      {
        ok: false,
        error: {
          code: "unknown-contribution",
          data: {},
          message: "pack/parses names a contribution this module does not answer",
        },
      },
    );
    const [line] = await readLoggedLines(log.path);
    expect(line!.response).toEqual({
      ok: false,
      error: {
        code: "unknown-contribution",
        data: {},
        message: "pack/parses names a contribution this module does not answer",
      },
    });
  });

  test("a value the workspace marks secret is replaced the way a receipt represents one, and the plaintext appears nowhere in the log file's bytes", async () => {
    await mintKeyFile(localDirOf(workspace), { now });
    await writeFile(
      join(localDirOf(workspace), "bindings.json"),
      JSON.stringify({ MY_TOKEN: { secret: true, value: KNOWN_SECRET_VALUE } }),
      {
        mode: 0o600,
      },
    );

    const log = await openCallLog(workspace);
    await appendCall(
      log,
      workspace,
      { contribution: "parser", id: "pack/echoes", version: "1", input: { token: KNOWN_SECRET_VALUE } },
      { ok: true, output: { token: KNOWN_SECRET_VALUE }, diagnostics: [] },
    );

    const rawBytes = await readFile(log.path, "utf8");
    expect(rawBytes).not.toContain(KNOWN_SECRET_VALUE);

    const [line] = await readLoggedLines(log.path);
    const requestInput = line!.request.input as { token: unknown };
    expect(requestInput.token).not.toBe(KNOWN_SECRET_VALUE);
    expect(requestInput.token).toMatchObject({ name: "MY_TOKEN" });
  });

  test("a secret handed back in a module's diagnostics or in a refusal is replaced there too, not only in the output", async () => {
    await mintKeyFile(localDirOf(workspace), { now });
    await writeFile(
      join(localDirOf(workspace), "bindings.json"),
      JSON.stringify({ MY_TOKEN: { secret: true, value: KNOWN_SECRET_VALUE } }),
      {
        mode: 0o600,
      },
    );

    const log = await openCallLog(workspace);
    await appendCall(
      log,
      workspace,
      { contribution: "parser", id: "pack/diagnoses", version: "1", input: {} },
      { ok: true, output: null, diagnostics: [{ level: "warn", saw: KNOWN_SECRET_VALUE }] },
    );
    await appendCall(
      log,
      workspace,
      { contribution: "parser", id: "pack/refuses", version: "1", input: {} },
      { ok: false, error: { code: "refused", data: { echoed: KNOWN_SECRET_VALUE }, message: KNOWN_SECRET_VALUE } },
    );

    const rawBytes = await readFile(log.path, "utf8");
    expect(rawBytes).not.toContain(KNOWN_SECRET_VALUE);
  });

  test("a secret is withheld from the log before the workspace has a key, and logging mints none", async () => {
    await writeFile(
      join(localDirOf(workspace), "bindings.json"),
      JSON.stringify({ MY_TOKEN: { secret: true, value: KNOWN_SECRET_VALUE } }),
      { mode: 0o600 },
    );

    const log = await openCallLog(workspace);
    await appendCall(
      log,
      workspace,
      { contribution: "parser", id: "pack/echoes", version: "1", input: { token: KNOWN_SECRET_VALUE } },
      { ok: true, output: { token: KNOWN_SECRET_VALUE }, diagnostics: [{ saw: KNOWN_SECRET_VALUE }] },
    );
    await appendCall(
      log,
      workspace,
      { contribution: "parser", id: "pack/refuses", version: "1", input: {} },
      { ok: false, error: { code: "refused", data: { echoed: KNOWN_SECRET_VALUE }, message: KNOWN_SECRET_VALUE } },
    );

    expect(await readFile(log.path, "utf8")).not.toContain(KNOWN_SECRET_VALUE);
    const [line] = await readLoggedLines(log.path);
    expect((line!.request.input as { token: unknown }).token).toEqual({ name: "MY_TOKEN", secret: true });
    expect(await listKeys(localDirOf(workspace))).toEqual([]);
  });

  test("nothing here writes to the record store, and no stored record's bytes name the log's own path", async () => {
    const opened = await openWorkspace({ workspace, scope: "default", now });
    const before = await opened.store.list("case");

    const log = await openCallLog(workspace);
    await appendCall(
      log,
      workspace,
      { contribution: "parser", id: "pack/parses", version: "1", input: {} },
      { ok: true, output: {}, diagnostics: [] },
    );

    const reopened = await openWorkspace({ workspace, scope: "default", now });
    const after = await reopened.store.list("case");
    expect(after).toEqual(before);

    for (const id of await reopened.store.list("module")) {
      const record = JSON.stringify(reopened.read(id));
      expect(record).not.toContain(log.path);
    }
  });
});

describe("a real, genuinely esbuild-bundled contribution call, logged through callTool", () => {
  let workspace: string;
  let context: OperationContext;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-call-log-real-"));
    await initWorkspace(workspace, { now });
    context = { workspace, scope: "default", now };
    const sourceGitDir = await repoGitDir();
    const store = new Store({ ctx: { gitDir: join(workspace, MUSAI_DIR) }, scope: "default", now });
    const index = new IndexDb(":memory:");
    await index.fold(store);
    await buildModule(GREETER_FIXTURE_DIR, store, {
      blobs: blobStoreOf(workspace),
      index,
      sourceGitDir,
      now,
    });
  }, 30_000);

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("a successful call is logged with the contribution's own kind, id and version", async () => {
    const log = await openCallLog(workspace);
    await callTool(MUSAI, context, "greeter_greets", { name: "world" }, log);

    const [line] = await readLoggedLines(log.path);
    expect(line!.request).toEqual({
      contribution: "parser",
      id: "greeter/greets",
      version: "1",
      input: { name: "world" },
    });
    expect(line!.response).toEqual({ ok: true, output: { greeting: "hello, world" }, diagnostics: [] });
  }, 15_000);

  test("a refused call — arguments failing the tool's own schema — is still logged, with its refusal", async () => {
    const log = await openCallLog(workspace);
    const error = await callTool(MUSAI, context, "greeter_greets", {}, log).catch((caught: unknown) => caught);
    expect(isOperationError(error)).toBe(true);

    const [line] = await readLoggedLines(log.path);
    expect(line!.response.ok).toBe(false);
  }, 15_000);
});
