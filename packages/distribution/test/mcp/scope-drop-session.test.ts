import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type OperationContext, openWorkspace, runHandler } from "@musai/api-core";
import { createMcpServer } from "@musai/mcp";
import { CURRENT_SCHEMA_VERSIONS, slotFor, TRIPLE_DECLARATION } from "@musai/records";
import { initWorkspace, LOCAL_DIR, MUSAI_DIR } from "@musai/store";
import { fixedClock } from "@musai/test-support";
import { afterEach, beforeEach, expect, test } from "vitest";
import { REGISTRY } from "../../src/index.js";
import { MUSAI_MCP } from "../../src/mcp/extension.js";

const now = fixedClock("2026-10-13T00:00:00.000Z");
const SANDBOX = "sandbox";

function claimDraft(subject: string): Record<string, unknown> {
  const conditions = { subject, predicate: "asserts", object: "a-fixture-object" };
  return {
    kind: "claim",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: "triple@1",
    about: [],
    slot: slotFor(TRIPLE_DECLARATION, conditions),
    conditions,
    canonical: conditions,
    rendering: `${subject} asserts a-fixture-object`,
    evidence: [],
    exclusiveGroup: null,
  };
}

let workspace: string;
let owner: OperationContext;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "musai-mcp-scope-drop-"));
  await initWorkspace(workspace, { now });
  owner = { workspace, scope: "default", now, via: "tty", principalName: "a-person", mode: "perform" };
  await (await openWorkspace(owner)).put([{ kind: "claim", value: claimDraft("held") }]);
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

async function fork(): Promise<string> {
  const forked = (await runHandler(REGISTRY.get("scope.fork@1")!, { name: SANDBOX }, owner)) as { tip: string };
  return forked.tip;
}

async function drop(tip: string): Promise<void> {
  await runHandler(REGISTRY.get("scope.drop@1")!, { name: SANDBOX, tip }, owner);
}

async function callLogResponses(): Promise<Array<{ ok: boolean; error?: { code: string } }>> {
  const dir = join(workspace, MUSAI_DIR, LOCAL_DIR, "calls");
  const rows: Array<{ response: { ok: boolean; error?: { code: string } } }> = [];
  for (const file of await readdir(dir)) {
    const lines = (await readFile(join(dir, file), "utf8")).split("\n").filter((line) => line !== "");
    rows.push(...lines.map((line) => JSON.parse(line)));
  }
  return rows.map((row) => row.response);
}

function refusalOf(result: CallToolResult): { reason: string; about: string[]; detail: string } {
  expect(result.isError).toBe(true);
  const [item] = result.content;
  return JSON.parse((item as { text: string }).text);
}

test("a session on a scope dropped under it answers a refusal naming the drop until the scope is made again", async () => {
  const tip = await fork();
  const server = createMcpServer(MUSAI_MCP, { workspace, scope: SANDBOX, now }, { lab: true });
  const client = new Client({ name: "scope-drop-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    expect(((await client.callTool({ name: "key_list", arguments: {} })) as CallToolResult).isError).not.toBe(true);

    await drop(tip);

    for (const attempt of [1, 2]) {
      const refusal = refusalOf((await client.callTool({ name: "key_list", arguments: {} })) as CallToolResult);
      expect(refusal.reason, `attempt ${attempt}`).toBe("workspace-incomplete");
      expect(refusal.about).toEqual([SANDBOX]);
      expect(refusal.detail).toContain(`scope ${SANDBOX} was dropped`);
    }
    for (const read of [
      () => client.listTools(),
      () => client.listPrompts(),
      () => client.readResource({ uri: "case://anything" }),
      () => client.getPrompt({ name: "anything" }),
    ]) {
      await expect(read()).rejects.toMatchObject({
        data: { reason: "workspace-incomplete", about: [SANDBOX] },
      });
    }
    await expect(access(join(workspace, ".musai", "local", "scopes", SANDBOX))).rejects.toThrow();
    expect(
      (await callLogResponses()).filter((response) => response.error?.code === "workspace-incomplete"),
    ).toHaveLength(2);

    await fork();

    expect(((await client.callTool({ name: "key_list", arguments: {} })) as CallToolResult).isError).not.toBe(true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("a session that has only listed prompts is refused as dropped once the scope is", async () => {
  const tip = await fork();
  const server = createMcpServer(MUSAI_MCP, { workspace, scope: SANDBOX, now }, { lab: true });
  const client = new Client({ name: "scope-drop-lister", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.listPrompts();

    await drop(tip);

    await expect(client.listPrompts()).rejects.toMatchObject({
      data: { reason: "workspace-incomplete", about: [SANDBOX] },
    });
    await expect(access(join(workspace, ".musai", "local", "scopes", SANDBOX))).rejects.toThrow();
  } finally {
    await client.close();
    await server.close();
  }
});

test("a session on a scope that holds no ref yet is not refused as dropped", async () => {
  const server = createMcpServer(MUSAI_MCP, { workspace, scope: SANDBOX, now }, { lab: true });
  const client = new Client({ name: "scope-new-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    for (let call = 0; call < 2; call += 1) {
      expect(((await client.callTool({ name: "key_list", arguments: {} })) as CallToolResult).isError).not.toBe(true);
    }
  } finally {
    await client.close();
    await server.close();
  }
});
