import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  type ClientCapabilities,
  ElicitRequestSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  type JsonSchema,
  type OperationContext,
  type OperationDescriptor,
  runHandler,
  validateAgainstSchema,
} from "@musai/api-core";
import { createMcpServer, type McpDistribution, toolsFromRegistry } from "@musai/mcp";
import {
  type CaseRecord,
  type ClaimRecord,
  type ClaimTypeDeclaration,
  CURRENT_SCHEMA_VERSIONS,
  claimTypesFrom,
  type RecordId,
  recordId,
  slotFor,
  versionString,
} from "@musai/records";
import { initWorkspace, Store } from "@musai/store";
import { declareClaimTypes, fixedClock, installEmptyModule } from "@musai/test-support";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { REGISTRY } from "../../src/index.js";
import { MUSAI_MCP } from "../../src/mcp/extension.js";
import { GATE_ANSWER_ELICITATION_TOOL } from "../../src/mcp/gate-tool.js";
import { RERUN_CONFIRMATION_TOOL_NAME } from "../../src/mcp/rerun-tool.js";
import { GATE_ANSWER_OUTPUT_SCHEMA } from "../../src/ops/gate.js";
import { RERUN_OUTPUT_SCHEMA } from "../../src/ops/rerun.js";

const now = fixedClock("2026-01-01T00:00:00.000Z");
const GATE_DECLARATION: ClaimTypeDeclaration = {
  type: "musai.mcp-extension-test/claim@1",
  identityDimensions: ["id"],
};

describe("musai's MCP server, built from MUSAI_MCP", () => {
  let workspace: string;
  const scope = "default";
  let context: OperationContext;
  let server: Server;
  let client: Client;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-mcp-extension-"));
    await initWorkspace(workspace, { now });
    context = { workspace, scope, now };
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    await rm(workspace, { recursive: true, force: true });
  });

  /** A client with `capabilities`, connected in memory to a fresh server over `distribution`. */
  async function connect(
    distribution: McpDistribution = MUSAI_MCP,
    capabilities: ClientCapabilities = {},
  ): Promise<void> {
    server = createMcpServer(distribution, context, { lab: true });
    client = new Client({ name: "musai-extension-client", version: "1.0.0" }, { capabilities });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  }

  /** Books `slug` citing one unruled gate claim, the one pending gate; answers that claim's id. */
  async function openPendingGate(slug: string): Promise<RecordId> {
    const store = new Store({
      ctx: { gitDir: join(workspace, ".musai") },
      scope,
      now,
      claimTypes: claimTypesFrom([GATE_DECLARATION]),
    });
    await declareClaimTypes(store, [GATE_DECLARATION]);
    const conditions = { id: "extension-gate", gateClass: "intent" };
    const claim: ClaimRecord = {
      kind: "claim",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
      type: GATE_DECLARATION.type,
      about: [],
      slot: slotFor(GATE_DECLARATION, conditions),
      conditions,
      canonical: conditions,
      rendering: "the extension's own gate holds",
      evidence: [],
      exclusiveGroup: null,
    };
    const [claimId] = await store.putMany([{ kind: "claim", value: claim }]);
    const caseRecord: CaseRecord = {
      kind: "case",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.case,
      type: null,
      slug,
      claims: [claimId!],
      preset: {
        module: "musai.core",
        contribution: "musai.core/bare",
        moduleRecord: recordId({ marker: "mcp-extension" }),
      },
      projectCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      overrides: {},
      evaluatorVersion: versionString("1"),
    };
    await store.putMany([{ kind: "case", value: caseRecord }]);
    return claimId!;
  }

  test("declares the tools, resources and prompts capabilities", async () => {
    await connect();

    expect(client.getServerCapabilities()).toEqual({ tools: {}, resources: {}, prompts: {} });
  });

  test("lists gates://pending as its one resource, and the case and claim templates", async () => {
    await connect();

    const { resources } = await client.listResources();
    const { resourceTemplates } = await client.listResourceTemplates();

    expect(resources).toEqual([{ uri: "gates://pending", name: "pending gates", mimeType: "application/json" }]);
    expect(resourceTemplates).toEqual([
      { uriTemplate: "case://{slug}", name: "case", mimeType: "text/markdown" },
      { uriTemplate: "claim://{slot}", name: "claim", mimeType: "application/json" },
    ]);
  });

  test("answers a read of gates://pending over the wire naming the workspace's one pending gate, as gate.pending@1 answers", async () => {
    const claim = await openPendingGate("extension-gate-case");
    await connect();

    const { contents } = await client.readResource({ uri: "gates://pending" });

    expect(contents).toHaveLength(1);
    const [content] = contents;
    if (content === undefined || !("text" in content)) {
      throw new Error("a read of gates://pending answered with no text content");
    }
    expect(content.uri).toBe("gates://pending");
    expect(content.mimeType).toBe("application/json");
    const read: unknown = JSON.parse(content.text);
    expect(read).toEqual({ gates: [{ case: "extension-gate-case", claim, gateClass: "intent" }] });
    const pending = await runHandler(REGISTRY.get("gate.pending@1")!, {}, context);
    expect(read).toEqual(pending);
  });

  test("lists one gate_answer, the elicitation tool taking no choice, where the projected gate_answer stands", async () => {
    await connect();

    const { tools } = await client.listTools();

    const names = tools.map((tool) => tool.name);
    expect(names.filter((name) => name === "gate_answer")).toHaveLength(1);
    const projectedAt = toolsFromRegistry(REGISTRY).findIndex((tool) => tool.name === "gate_answer");
    expect(projectedAt).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("gate_answer")).toBe(projectedAt);
    const gateAnswer = tools[projectedAt]!;
    expect(gateAnswer).toEqual(GATE_ANSWER_ELICITATION_TOOL);
    expect(Object.keys(gateAnswer.inputSchema.properties ?? {}).sort()).toEqual(["brief", "pending", "reason"]);
  });

  test("lists gate_answer with gate.answer's own closed output schema or the closed non-answer", async () => {
    await connect();

    const { tools } = await client.listTools();

    const gateAnswer = tools.find((tool) => tool.name === "gate_answer");
    expect(REGISTRY.get("gate.answer@2")?.output).toBe(GATE_ANSWER_OUTPUT_SCHEMA);
    expect(gateAnswer?.outputSchema).toEqual({
      type: "object",
      oneOf: [
        GATE_ANSWER_OUTPUT_SCHEMA,
        {
          type: "object",
          additionalProperties: false,
          required: ["answered", "action", "message"],
          properties: {
            answered: { const: false },
            action: { enum: ["decline", "cancel", "expired"] },
            message: { type: "string" },
          },
        },
      ],
    });
  });

  test("answers a declined gate_answer elicitation with a non-answer its output schema holds, refusing a stray field", async () => {
    const claim = await openPendingGate("declined-gate-case");
    await connect(MUSAI_MCP, { elicitation: { form: {} } });
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "decline" }));
    const { tools } = await client.listTools();
    const schema = tools.find((tool) => tool.name === "gate_answer")?.outputSchema as JsonSchema;

    const result = await client.callTool({ name: "gate_answer", arguments: { pending: claim, brief: "unused" } });

    const answer = result.structuredContent as Record<string, unknown>;
    expect(answer).toMatchObject({ answered: false, action: "decline" });
    expect(validateAgainstSchema(schema, answer)).toEqual({ ok: true });
    for (const stray of [
      { ...answer, stray: 1 },
      { ...answer, action: "accept" },
      { minted: [], answered: false },
    ]) {
      expect(validateAgainstSchema(schema, stray)).toMatchObject({ ok: false });
    }
  });

  test("refuses a recorded gate_answer whose output carries a field the tool's output schema does not", async () => {
    const claim = await openPendingGate("stray-gate-case");
    const gateAnswer = REGISTRY.get("gate.answer@2")!;
    await connect(
      replacingOne("gate.answer@2", {
        ...gateAnswer,
        output: { type: "object" },
        handler: async () => ({ minted: [], stray: 1 }),
      }),
      { elicitation: { form: {} } },
    );
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { answer: "holds" } }));

    const result = await client.callTool({ name: "gate_answer", arguments: { pending: claim, brief: "unused" } });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("invalid-output");
  });

  test("lists bundle_rerun with rerun's closed output schema, the person's confirmation described in it", async () => {
    await connect();

    const { tools } = await client.listTools();

    const rerun = tools.find((tool) => tool.name === RERUN_CONFIRMATION_TOOL_NAME);
    expect(rerun?.outputSchema).toEqual({
      ...RERUN_OUTPUT_SCHEMA,
      properties: {
        ...RERUN_OUTPUT_SCHEMA.properties,
        confirmation: { enum: ["keep", "decline", "cancel", "expired"] },
      },
    });
  });

  test("after an install, sends the tools, resources and prompts list-changed notifications", async () => {
    await installEmptyModule(workspace, scope, "musai-extension-fixture", now);
    await connect();
    const received: string[] = [];
    client.setNotificationHandler(ToolListChangedNotificationSchema, (notification) => {
      received.push(notification.method);
    });
    client.setNotificationHandler(ResourceListChangedNotificationSchema, (notification) => {
      received.push(notification.method);
    });
    client.setNotificationHandler(PromptListChangedNotificationSchema, (notification) => {
      received.push(notification.method);
    });

    await client.listTools();
    await client.ping();

    expect(received).toEqual([
      "notifications/tools/list_changed",
      "notifications/resources/list_changed",
      "notifications/prompts/list_changed",
    ]);
  });

  /** `MUSAI_MCP` with the registry entry `key` replaced, so its registry and musai's differ. */
  function replacingOne(key: string, descriptor: OperationDescriptor): McpDistribution {
    return { ...MUSAI_MCP, registry: new Map(REGISTRY).set(key, descriptor) };
  }

  test("reads gates://pending through the registry of the distribution the server was built from", async () => {
    await openPendingGate("session-registry-case");
    const asked: string[] = [];
    const pending = REGISTRY.get("gate.pending@1")!;
    await connect(
      replacingOne("gate.pending@1", {
        ...pending,
        handler: async () => {
          asked.push("gate.pending@1");
          return { gates: [] };
        },
      }),
    );

    const { contents } = await client.readResource({ uri: "gates://pending" });

    const [content] = contents;
    if (content === undefined || !("text" in content)) {
      throw new Error("a read of gates://pending answered with no text content");
    }
    expect(JSON.parse(content.text)).toEqual({ gates: [] });
    expect(asked).toEqual(["gate.pending@1"]);
  });

  test("answers gate_answer's accepted elicitation through the registry of the distribution the server was built from", async () => {
    const claim = await openPendingGate("session-registry-gate");
    const brief = `sha256:${"0".repeat(64)}`;
    const answered: unknown[] = [];
    const gateAnswer = REGISTRY.get("gate.answer@2")!;
    await connect(
      replacingOne("gate.answer@2", {
        ...gateAnswer,
        handler: async (input, handed) => {
          answered.push(input);
          return gateAnswer.handler(input, handed);
        },
      }),
      { elicitation: { form: {} } },
    );
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { answer: "holds" } }));

    await client.callTool({ name: "gate_answer", arguments: { pending: claim, brief } });

    expect(answered).toHaveLength(1);
    expect(answered[0]).toMatchObject({ pending: claim, brief, choice: "holds" });
  });
});
