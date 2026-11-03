import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { runHandler, Workspace } from "@musai/api-core";
import { type CallToolResult, createMcpServer, type McpDistribution, type McpExtensionTool } from "@musai/mcp";
import { initWorkspace } from "@musai/store";
import { fixedClock } from "@musai/test-support";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { REGISTRY } from "../../src/index.js";
import { MUSAI_MCP } from "../../src/mcp/extension.js";

const now = fixedClock("2026-01-01T00:00:00.000Z");

let workspace: string;
let sessions: { readonly server: Server; readonly client: Client }[];

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "musai-mcp-no-workspace-"));
  sessions = [];
});

afterEach(async () => {
  for (const { server, client } of sessions) {
    await client.close();
    await server.close();
  }
  await rm(workspace, { recursive: true, force: true });
});

async function connect(lab: boolean, distribution: McpDistribution = MUSAI_MCP): Promise<Client> {
  const server = createMcpServer(distribution, { workspace, scope: "default", now }, { lab });
  const client = new Client({ name: "musai-no-workspace-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  sessions.push({ server, client });
  return client;
}

async function called(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function refusalOf(result: CallToolResult): { reason: string; detail: string } {
  expect(result.isError).toBe(true);
  return JSON.parse((result.content[0] as { text: string }).text) as { reason: string; detail: string };
}

/** A lab tool that waits for `release`, then reports a fold refusal through the session's sink. */
function heldDistribution(): { readonly distribution: McpDistribution; entered: Promise<void>; release(): void } {
  let entered!: () => void;
  let release!: () => void;
  const enteredOnce = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held: McpExtensionTool = {
    tool: { name: "fixture_held", description: "Waits, then reports.", inputSchema: { type: "object" } },
    call: async (session) => {
      entered();
      await released;
      await session.context.reportRefusal?.({ id: null, commit: "c".repeat(40), path: "held", reason: "held" });
      return { content: [{ type: "text", text: "released" }] };
    },
  };
  const mcp = MUSAI_MCP.extensions!.mcp!;
  const distribution = { ...MUSAI_MCP, extensions: { mcp: { ...mcp, tools: [...mcp.tools, held] } } };
  return { distribution, entered: enteredOnce, release };
}

async function loggedIds(): Promise<string[]> {
  const callsDir = join(workspace, ".musai", "local", "calls");
  const ids: string[] = [];
  for (const file of await readdir(callsDir)) {
    const lines = (await readFile(join(callsDir, file), "utf8")).split("\n").filter((line) => line !== "");
    ids.push(...lines.map((line) => (JSON.parse(line) as { request: { id: string } }).request.id));
  }
  return ids;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

test("before a workspace exists the server lists and runs workspace_init alone", async () => {
  for (const lab of [false, true]) {
    const client = await connect(lab);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["workspace_init"]);
    for (const name of ["bundle_rerun", "events_since", "module_new", "store_relayout", "key_list"]) {
      expect([name, refusalOf(await called(client, name, { yes: true })).reason]).toEqual([name, "unknown-operation"]);
    }
  }
  expect(await exists(join(workspace, ".musai"))).toBe(false);

  const init = await called(sessions[0]!.client, "workspace_init");
  expect(init.isError).not.toBe(true);
  expect(init.structuredContent).toEqual({ gitDir: join(workspace, ".musai"), registered: null });
});

test("before a workspace exists a refused name says none stands here yet and workspace_init makes one", async () => {
  const client = await connect(false);
  const refusal = refusalOf(await called(client, "events_since"));
  expect(refusal.reason).toBe("unknown-operation");
  expect(refusal.detail).toContain(`no workspace stands at ${workspace} yet`);
  expect(refusal.detail).toContain("workspace_init makes one");
});

test("before a workspace exists the server lists no resource and a read says workspace_init makes one", async () => {
  const client = await connect(false);
  const open = vi.spyOn(Workspace, "open");
  try {
    expect(await client.listResources()).toEqual({ resources: [] });
    expect(await client.listResourceTemplates()).toEqual({ resourceTemplates: [] });
    for (const uri of ["case://anything", "claim://anything", "gates://pending"]) {
      await expect(client.readResource({ uri })).rejects.toMatchObject({
        data: { reason: "no-such-record", about: [uri], detail: expect.stringContaining("workspace_init makes one") },
      });
    }
    expect(open).not.toHaveBeenCalled();
  } finally {
    open.mockRestore();
  }
  expect(await exists(join(workspace, ".musai"))).toBe(false);
});

test("before a workspace exists the server lists no prompt and a get says workspace_init makes one", async () => {
  const client = await connect(false);
  const open = vi.spyOn(Workspace, "open");
  try {
    expect(await client.listPrompts()).toEqual({ prompts: [] });
    await expect(client.getPrompt({ name: "anything" })).rejects.toMatchObject({
      data: {
        reason: "no-such-record",
        about: ["anything"],
        detail: expect.stringContaining("workspace_init makes one"),
      },
    });
    expect(open).not.toHaveBeenCalled();
  } finally {
    open.mockRestore();
  }
  expect(await exists(join(workspace, ".musai"))).toBe(false);
});

test("a server started on a directory that is not a workspace lists and runs workspace_init, then serves the workspace it made", async () => {
  const client = await connect(true);
  const notified: string[] = [];
  client.setNotificationHandler(ToolListChangedNotificationSchema, (notification) => {
    notified.push(notification.method);
  });

  expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("workspace_init");
  expect(notified).toEqual([]);

  const init = await called(client, "workspace_init");
  expect(init.isError).not.toBe(true);

  const after = (await client.listTools()).tools.map((tool) => tool.name);
  await client.ping();
  expect(notified).toEqual(["notifications/tools/list_changed"]);
  expect(after).toContain("events_since");

  const log = await called(client, "events_since");
  expect(log.isError).not.toBe(true);
  const { events } = log.structuredContent as { events: readonly { kind: string }[] };
  expect(events.map((event) => event.kind)).toContain("module.installed");
});

test("a workspace_init over MCP is the first entry in the call log it made", async () => {
  const client = await connect(false);
  refusalOf(await called(client, "events_since"));
  await called(client, "workspace_init");

  const callsDir = join(workspace, ".musai", "local", "calls");
  const files = await readdir(callsDir);
  expect(files).toHaveLength(1);
  const [first] = (await readFile(join(callsDir, files[0]!), "utf8")).trim().split("\n");
  const entry = JSON.parse(first!) as { request: unknown; response: { ok: boolean } };
  expect(entry.request).toEqual({ contribution: "operation", id: "workspace.init", version: "1", input: {} });
  expect(entry.response.ok).toBe(true);
});

test("a workspace removed under the session leaves a fresh directory the session serves as it would at its start", async () => {
  const client = await connect(true);
  await called(client, "workspace_init");
  expect((await called(client, "events_since")).isError).not.toBe(true);

  await rm(join(workspace, ".musai"), { recursive: true, force: true });
  const notified: string[] = [];
  client.setNotificationHandler(ToolListChangedNotificationSchema, (notification) => {
    notified.push(notification.method);
  });

  expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["workspace_init"]);
  expect(await client.listPrompts()).toEqual({ prompts: [] });
  expect(await client.listResources()).toEqual({ resources: [] });
  const refusal = refusalOf(await called(client, "events_since"));
  expect(refusal.reason).toBe("unknown-operation");
  expect(refusal.detail).toContain("workspace_init makes one");
  expect(await exists(join(workspace, ".musai"))).toBe(false);

  const init = await called(client, "workspace_init");
  expect(init.isError).not.toBe(true);
  expect((await called(client, "events_since")).isError).not.toBe(true);
  await client.ping();
  expect(notified).toEqual(["notifications/tools/list_changed"]);

  const callsDir = join(workspace, ".musai", "local", "calls");
  const files = await readdir(callsDir);
  expect(files).toHaveLength(1);
  const [first] = (await readFile(join(callsDir, files[0]!), "utf8")).trim().split("\n");
  expect((JSON.parse(first!) as { request: { id: string } }).request.id).toBe("workspace.init");
});

test("a request in flight across the workspace's removal leaves no .musai behind", async () => {
  const { distribution, entered, release } = heldDistribution();
  const client = await connect(true, distribution);
  await called(client, "workspace_init");
  const held = called(client, "fixture_held");
  await entered;

  await rm(join(workspace, ".musai"), { recursive: true, force: true });
  await client.listTools();
  release();
  await held;

  expect(await exists(join(workspace, ".musai"))).toBe(false);
  expect((await called(client, "workspace_init")).isError).not.toBe(true);
});

test("an entry from a request begun before the workspace's removal never lands in the log made after it", async () => {
  const { distribution, entered, release } = heldDistribution();
  const client = await connect(true, distribution);
  await called(client, "workspace_init");
  const held = called(client, "fixture_held");
  await entered;

  await rm(join(workspace, ".musai"), { recursive: true, force: true });
  expect((await called(client, "workspace_init")).isError).not.toBe(true);
  release();
  await held;

  expect(await loggedIds()).toEqual(["workspace.init"]);
});

test("a workspace removed and made again between two requests gets a fresh log and its calls succeed", async () => {
  const client = await connect(true);
  await called(client, "workspace_init");
  expect((await called(client, "events_since")).isError).not.toBe(true);

  await rm(join(workspace, ".musai"), { recursive: true, force: true });
  await initWorkspace(workspace, { now });

  expect((await called(client, "events_since")).isError).not.toBe(true);
  expect(await loggedIds()).toEqual(["events.since"]);
});

/** Makes the workspace as `workspace_init` would, outside any session, so no session logs it. */
async function initOutsideTheSession(): Promise<void> {
  await runHandler(REGISTRY.get("workspace.init@1")!, {}, { workspace, scope: "default", now });
}

test("a workspace made again before the session's first log entry is read from its start", async () => {
  await initOutsideTheSession();
  const client = await connect(false);
  const notified: string[] = [];
  client.setNotificationHandler(ToolListChangedNotificationSchema, (notification) => {
    notified.push(notification.method);
  });
  await client.listTools();
  await client.ping();
  expect(notified).toEqual(["notifications/tools/list_changed"]);

  await rm(join(workspace, ".musai"), { recursive: true, force: true });
  await initOutsideTheSession();
  await client.listTools();
  await client.ping();

  expect(notified).toEqual(["notifications/tools/list_changed", "notifications/tools/list_changed"]);
});
