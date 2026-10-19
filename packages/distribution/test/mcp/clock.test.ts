import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { clockFromEnvironment } from "@musai/api-core";
import type { RecordId } from "@musai/records";
import { MUSAI_DIR, Store } from "@musai/store";
import { fixedClock } from "@musai/test-support";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, onTestFailed, test, vi } from "vitest";

const CLI_PATH = fileURLToPath(new URL("../../dist/bin/cli.js", import.meta.url));
const SERVER_PATH = fileURLToPath(new URL("../../dist/bin/mcp.js", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const CORE_MODULE = join(REPO_ROOT, "packages", "core-module");
const CASEBOOK = fileURLToPath(new URL("../../../scenarios/casebook/modules/casebook", import.meta.url));
const INSTANT = "2026-03-04T05:06:07.000Z";
const SCOPE = "default";

interface Booked {
  readonly head: string | null;
  /** The run records the soundcheck added to the scope, in id order. */
  readonly receipts: readonly RecordId[];
}

async function musai(args: readonly string[]): Promise<void> {
  await execa("node", [CLI_PATH, ...args], { env: { ...process.env, MUSAI_NOW: INSTANT } });
}

function storeAt(workspace: string): Store {
  return new Store({ ctx: { gitDir: join(workspace, MUSAI_DIR) }, scope: SCOPE, now: fixedClock(INSTANT) });
}

/** Books and soundchecks a case through the built server under the pinned instant. */
async function bookAndSoundcheck(workspace: string): Promise<Booked> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER_PATH, "--workspace", workspace, "--scope", SCOPE],
    env: { ...getDefaultEnvironment(), MUSAI_NOW: INSTANT },
    stderr: "pipe",
  });
  // The child's stderr is shown only when the test fails.
  let stderr = "";
  transport.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  onTestFailed(() => {
    console.error(`the server for ${workspace} wrote on stderr:\n${stderr}`);
  });
  const client = new Client({ name: "musai-clock-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    await client.callTool({ name: "case_book", arguments: { slug: "clock-case", kind: "fixture-casebook/report" } });
    const store = storeAt(workspace);
    const head = await store.tip();
    const before = new Set(await store.list("run"));
    await client.callTool({ name: "case_soundcheck", arguments: { case: "clock-case" } });
    const receipts = (await store.list("run")).filter((id) => !before.has(id)).sort();
    return { head, receipts };
  } finally {
    await client.close();
  }
}

describe("MUSAI_NOW — against the built MCP server", () => {
  let first: string;
  let second: string;

  beforeAll(async () => {
    first = await mkdtemp(join(tmpdir(), "musai-mcp-clock-a-"));
    second = await mkdtemp(join(tmpdir(), "musai-mcp-clock-b-"));
    for (const workspace of [first, second]) {
      await musai(["init", workspace]);
      for (const module of [CORE_MODULE, CASEBOOK]) {
        await musai([
          "lab",
          "module",
          "build",
          module,
          "--source-git-dir",
          join(REPO_ROOT, ".git"),
          "--workspace",
          workspace,
        ]);
      }
    }
  }, 120_000);

  afterAll(async () => {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  });

  test("a case booked and soundchecked through two servers under one instant leaves one scope head and mints the same receipts", async () => {
    const fromFirst = await bookAndSoundcheck(first);
    const fromSecond = await bookAndSoundcheck(second);

    expect(fromFirst.head).not.toBeNull();
    expect(fromFirst.head).toBe(fromSecond.head);
    expect(fromFirst.receipts.length).toBeGreaterThan(0);
    expect(fromFirst.receipts).toEqual(fromSecond.receipts);
  }, 120_000);
});

describe("a malformed MUSAI_NOW — against the built MCP server", () => {
  test("the server refuses to start, its whole refusal naming the variable on a piped stderr, rather than serving tools that each fail", async () => {
    vi.stubEnv("MUSAI_NOW", "bogus");
    let refusal = "";
    try {
      clockFromEnvironment();
    } catch (error) {
      refusal = (error as Error).message;
    } finally {
      vi.unstubAllEnvs();
    }
    const workspace = await mkdtemp(join(tmpdir(), "musai-mcp-clock-malformed-"));
    try {
      const result = await execa("node", [SERVER_PATH, "--workspace", workspace, "--scope", SCOPE], {
        env: { ...process.env, MUSAI_NOW: "bogus" },
        stdin: "ignore",
        stderr: "pipe",
        reject: false,
        timeout: 60_000,
      });

      expect(result.exitCode).toBe(2);
      expect(refusal).toContain("MUSAI_NOW");
      expect(refusal).toContain("bogus");
      expect(result.stderr.split("\n")).toContain(refusal);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 120_000);
});
