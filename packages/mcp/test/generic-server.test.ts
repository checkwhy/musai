import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  type CallToolResult,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  type OperationContext,
  type OperationDescriptor,
  OperationError,
  runHandler,
  type SubscriptionTrace,
} from "@musai/api-core";
import { type Audience, type ContributionEntry, recordId, recordPath, versionString } from "@musai/records";
import { CALL_LOG_DIR, initWorkspace, LOCAL_DIR, MUSAI_DIR } from "@musai/store";
import {
  commitAroundTheStore,
  fixedClock,
  fixtureRunRecord,
  installEmptyModule,
  installModuleRecord,
  writeTrustFile,
} from "@musai/test-support";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { openCallLog } from "../src/call-log.js";
import type {
  McpDistribution,
  McpExtensionTool,
  McpResourceSession,
  McpResources,
  McpToolSession,
} from "../src/extension.js";
import { callTool, createMcpServer } from "../src/server.js";

const now = fixedClock("2026-01-01T00:00:00.000Z");

/** Answers a constant, so a call touches no record. */
const GREET: OperationDescriptor = {
  id: "fixture.greet",
  version: versionString("1"),
  input: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  output: {
    type: "object",
    additionalProperties: false,
    required: ["greeting", "count"],
    properties: {
      greeting: { type: "string" },
      count: { type: "number" },
    },
  },
  effect: "read",
  authority: null,
  plans: true,
  reasons: ["invalid-input"],
  documentation: "Answers one constant greeting.",
  cli: {
    verb: "greet",
    positional: [],
    flags: [],
    describe: "answer one constant greeting",
  },
  renderText: () => "hello, twice",
  exitCode: () => 0,
  handler: async () => ({ greeting: "hello", count: 2 }),
};

/** Projected after `GREET`, so a tool standing in `GREET`'s place is seen to keep its position. */
const PART: OperationDescriptor = {
  ...GREET,
  id: "fixture.part",
  documentation: "Answers one constant farewell.",
  cli: { ...GREET.cli, verb: "part", describe: "answer one constant farewell" },
  renderText: () => "goodbye, once",
  handler: async () => ({ greeting: "goodbye", count: 1 }),
};

const WHOAMI: OperationDescriptor = {
  ...GREET,
  id: "fixture.whoami",
  output: {
    type: "object",
    additionalProperties: false,
    required: ["principalName"],
    properties: { principalName: { type: ["string", "null"] } },
  },
  documentation: "Answers the name the call runs under.",
  cli: { ...GREET.cli, verb: "whoami", describe: "answer the name the call runs under" },
  renderText: () => "whoami",
  handler: async (_input, context) => ({ principalName: context.principalName ?? null }),
};

const waved: { readonly session: McpToolSession; readonly args: Record<string, unknown> }[] = [];

const WAVE: McpExtensionTool = {
  tool: {
    name: "fixture_wave",
    description: "Waves, from the extension rather than the registry.",
    inputSchema: { type: "object", properties: { at: { type: "string" } } },
  },
  call: async (session, args) => {
    waved.push({ session, args });
    return { content: [{ type: "text", text: `waved at ${String(args["at"])}` }] };
  },
};

const greetedInstead: { readonly session: McpToolSession; readonly args: Record<string, unknown> }[] = [];

const GREET_INSTEAD: McpExtensionTool = {
  tool: {
    name: "fixture_greet",
    description: "Greets from the extension, in the projected greeting's place.",
    inputSchema: { type: "object", properties: { whom: { type: "string" } } },
  },
  call: async (session, args) => {
    greetedInstead.push({ session, args });
    return { content: [{ type: "text", text: `greeted ${String(args["whom"])} instead` }] };
  },
};

const readUris: { readonly uri: string; readonly session: McpResourceSession }[] = [];

const RESOURCES: McpResources = {
  resources: [{ uri: "fixture://greeting", name: "greeting", mimeType: "text/plain" }],
  templates: [{ uriTemplate: "fixture://{name}", name: "named", mimeType: "text/plain" }],
  read: async (session, uri) => {
    readUris.push({ uri, session });
    return { contents: [{ uri, mimeType: "text/plain", text: `read ${uri}` }] };
  },
};

const REFUSING_RESOURCES: McpResources = {
  resources: [],
  templates: [{ uriTemplate: "fixture://{name}", name: "named", mimeType: "text/plain" }],
  read: async (_session, uri) => {
    throw new OperationError({ reason: "no-such-record", about: [uri], detail: `nothing is held at ${uri}` });
  },
};

const BARE: McpDistribution = {
  name: "fixture",
  version: "1.2.3",
  registry: new Map([[`${GREET.id}@${GREET.version}`, GREET]]),
  admitDrafts: async () => {
    throw new Error("the fixture's registry holds no pack's operation, so nothing it runs drafts a record to admit");
  },
};

const FIXTURE: McpDistribution = { ...BARE, extensions: { mcp: { tools: [WAVE] } } };

const nodded: Record<string, unknown>[] = [];

const NOD: McpExtensionTool = {
  tool: {
    name: "fixture_nod",
    description: "Nods at one named party.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["at"],
      properties: { at: { type: "string" } },
    },
  },
  call: async (_session, args) => {
    nodded.push(args);
    return {
      content: [{ type: "text", text: `nodded at ${String(args["at"])}` }],
      structuredContent: { at: args["at"] },
    };
  },
};

const REFUSING: McpDistribution = { ...BARE, extensions: { mcp: { tools: [], resources: REFUSING_RESOURCES } } };

const FAILING_TOOLS: McpDistribution = {
  ...BARE,
  extensions: {
    mcp: {
      tools: [
        {
          tool: {
            name: "fixture_answers_error",
            description: "Answers an error result.",
            inputSchema: { type: "object" },
          },
          call: async () => ({ isError: true, content: [{ type: "text", text: "the fixture could not" }] }),
        },
        {
          tool: { name: "fixture_throws_refusal", description: "Throws a refusal.", inputSchema: { type: "object" } },
          call: async () => {
            throw new OperationError({ reason: "no-such-record", about: ["fixture"], detail: "nothing is held" });
          },
        },
      ],
    },
  },
};

const NODDING: McpDistribution = { ...BARE, extensions: { mcp: { tools: [NOD] } } };

const REPLACING: McpDistribution = {
  ...BARE,
  registry: new Map([
    [`${GREET.id}@${GREET.version}`, GREET],
    [`${PART.id}@${PART.version}`, PART],
  ]),
  extensions: { mcp: { tools: [GREET_INSTEAD] } },
};

/** Answers the projected greeting with one field more, under an output schema of its own. */
const GREET_WIDER: McpExtensionTool = {
  tool: {
    name: "fixture_greet",
    description: "Greets as the projected greeting does, and says from where.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["greeting", "count", "from"],
      properties: { greeting: { type: "string" }, count: { type: "number" }, from: { type: "string" } },
    },
  },
  call: async () => {
    const answer = { greeting: "hello", count: 2, from: "the extension" };
    return { content: [{ type: "text", text: JSON.stringify(answer) }], structuredContent: answer };
  },
};

const PUBLIC_WIDENED: McpDistribution = {
  ...REPLACING,
  publicOperations: new Set([`${GREET.id}@${GREET.version}`, `${PART.id}@${PART.version}`]),
  extensions: { mcp: { tools: [GREET_WIDER] } },
};

/** Offers the greeting alone outside `lab`; its lab listing adds a farewell and a wave. */
const PUBLIC_GREETING: McpDistribution = {
  ...REPLACING,
  publicOperations: new Set([`${GREET.id}@${GREET.version}`]),
  extensions: { mcp: { tools: [WAVE] } },
};

const MOUNTING: McpDistribution = { ...BARE, extensions: { mcp: { tools: [WAVE], resources: RESOURCES } } };

const keptRuns: string[] = [];

/** Works in what the machine keeps for its author, so any clearance withholds it. */
const KEEP: OperationDescriptor = {
  ...GREET,
  id: "fixture.keep",
  effect: "write",
  authorOnly: true,
  documentation: "Answers from what the author keeps.",
  cli: { ...GREET.cli, verb: "keep", describe: "answer from what the author keeps" },
  renderText: () => "kept",
  handler: async () => {
    keptRuns.push("ran");
    return { greeting: "kept", count: 0 };
  },
};

const keptInstead: Record<string, unknown>[] = [];

const KEEP_INSTEAD: McpExtensionTool = {
  tool: {
    name: "fixture_keep",
    description: "Answers in the place of the author's own operation.",
    inputSchema: { type: "object", properties: {} },
  },
  call: async (_session, args) => {
    keptInstead.push(args);
    return { content: [{ type: "text", text: "kept instead" }] };
  },
};

/** Offers the author's own operation publicly, an extension standing over it. */
const PUBLIC_KEEPING: McpDistribution = {
  ...BARE,
  registry: new Map([
    [`${GREET.id}@${GREET.version}`, GREET],
    [`${KEEP.id}@${KEEP.version}`, KEEP],
  ]),
  publicOperations: new Set([`${GREET.id}@${GREET.version}`, `${KEEP.id}@${KEEP.version}`]),
  extensions: { mcp: { tools: [KEEP_INSTEAD] } },
};

const WRITER = "writer" as Audience;

const namingToolSessions: McpToolSession[] = [];

const NAMING_TOOL: McpExtensionTool = {
  tool: {
    name: "fixture_distribution",
    description: "Answers the name of the distribution the session carries.",
    inputSchema: { type: "object", properties: {} },
  },
  call: async (session) => {
    namingToolSessions.push(session);
    return { content: [{ type: "text", text: session.distribution.name }] };
  },
};

const namingReadSessions: McpResourceSession[] = [];

const NAMING_RESOURCES: McpResources = {
  resources: [],
  templates: [{ uriTemplate: "fixture://{name}", name: "named", mimeType: "text/plain" }],
  read: async (session, uri) => {
    namingReadSessions.push(session);
    return { contents: [{ uri, mimeType: "text/plain", text: session.distribution.name }] };
  },
};

const NAMING: McpDistribution = {
  ...BARE,
  registry: new Map([
    [`${GREET.id}@${GREET.version}`, GREET],
    [`${WHOAMI.id}@${WHOAMI.version}`, WHOAMI],
  ]),
  extensions: { mcp: { tools: [NAMING_TOOL], resources: NAMING_RESOURCES } },
};

/** What an extension reads is this distribution, never the constant it was spread from. */
const SPREAD: McpDistribution = { ...NAMING, name: "fixture-spread" };

/** Hands the trace it is called with to the session's sink, as a write's subscription would. */
const REPORT_TOOL: McpExtensionTool = {
  tool: {
    name: "fixture_report",
    description: "Reports a subscription's refused answer through the session's sink.",
    inputSchema: { type: "object", properties: { trace: { type: "object" } } },
  },
  call: async (session, args) => {
    await session.context.reportSubscription!(args["trace"] as SubscriptionTrace);
    return { content: [{ type: "text", text: "reported" }] };
  },
};

const REPORTING: McpDistribution = { ...BARE, extensions: { mcp: { tools: [REPORT_TOOL] } } };

/** Its kind names no contribution point, so invoking it is refused before any host is reached. */
const UNPLACED: ContributionEntry = {
  kind: "fixture-unplaced",
  id: "generic-server-pack/unplaced",
  version: versionString("1"),
  input: { type: "object", additionalProperties: false, properties: {} },
  output: { type: "object" },
  documentation: "A contribution at a point no workspace declares.",
};

/** The session's context as the server serves it: the caller's own, plus the sinks for a refused
 * file and for a subscription's refused answer, and no channel or principal. */
function asServed(context: OperationContext): OperationContext {
  return {
    ...context,
    reportRefusal: expect.any(Function) as unknown as OperationContext["reportRefusal"],
    reportSubscription: expect.any(Function) as unknown as OperationContext["reportSubscription"],
  };
}

async function callLogRows(workspace: string): Promise<Record<string, unknown>[]> {
  const dir = join(workspace, MUSAI_DIR, LOCAL_DIR, CALL_LOG_DIR);
  const rows: Record<string, unknown>[] = [];
  for (const file of (await readdir(dir)).sort()) {
    const text = await readFile(join(dir, file), "utf8");
    rows.push(
      ...text
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    );
  }
  return rows;
}

async function subscriptionRows(workspace: string): Promise<Record<string, unknown>[]> {
  return (await callLogRows(workspace)).filter(
    (row) => (row["request"] as { contribution: string }).contribution === "subscription",
  );
}

describe("a server built from the distribution it is handed", () => {
  let workspace: string;
  const scope = "default";
  let context: OperationContext;
  let server: Server;
  let client: Client;

  beforeEach(async () => {
    waved.length = 0;
    greetedInstead.length = 0;
    nodded.length = 0;
    keptInstead.length = 0;
    keptRuns.length = 0;
    readUris.length = 0;
    namingToolSessions.length = 0;
    namingReadSessions.length = 0;
    workspace = await mkdtemp(join(tmpdir(), "musai-mcp-generic-server-"));
    await initWorkspace(workspace, { now });
    context = { workspace, scope, now };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await client.close();
    await server.close();
    await rm(workspace, { recursive: true, force: true });
  });

  async function connect(distribution: McpDistribution = FIXTURE, lab = false): Promise<void> {
    server = createMcpServer(distribution, context, { lab });
    client = new Client({ name: "generic-server-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  }

  test("lists the registry's projected tools first and an extension tool whose name nothing projects after them", async () => {
    await connect();

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(["fixture_greet", "fixture_wave"]);
    expect(tools[1]).toEqual(WAVE.tool);
    expect(client.getServerVersion()).toEqual({ name: "fixture", version: "1.2.3" });
  });

  test("routes a projected tool's call through the registry and an extension tool's call to its own handler, under the session's context as it stands", async () => {
    await connect();

    const greeted = (await client.callTool({ name: "fixture_greet", arguments: {} })) as CallToolResult;
    const wave = (await client.callTool({ name: "fixture_wave", arguments: { at: "the fixture" } })) as CallToolResult;

    expect(greeted.structuredContent).toEqual({ greeting: "hello", count: 2 });
    expect(wave.content).toEqual([{ type: "text", text: "waved at the fixture" }]);
    expect(waved).toHaveLength(1);
    expect(waved[0]!.session.context).toEqual(asServed(context));
    expect(waved[0]!.args).toEqual({ at: "the fixture" });
  });

  test("hands an extension tool the distribution the server was built from", async () => {
    await connect(SPREAD);

    const answered = (await client.callTool({ name: "fixture_distribution", arguments: {} })) as CallToolResult;

    expect(answered.content).toEqual([{ type: "text", text: "fixture-spread" }]);
    expect(namingToolSessions).toHaveLength(1);
    expect(namingToolSessions[0]!.distribution).toBe(SPREAD);
    expect(namingToolSessions[0]!.context).toEqual(asServed(context));
  });

  test("hands a resource read the distribution the server was built from", async () => {
    await connect(SPREAD);

    const { contents } = await client.readResource({ uri: "fixture://anyone" });

    expect(contents).toEqual([{ uri: "fixture://anyone", mimeType: "text/plain", text: "fixture-spread" }]);
    expect(namingReadSessions).toHaveLength(1);
    expect(namingReadSessions[0]!.distribution).toBe(SPREAD);
    expect(namingReadSessions[0]!.context).toEqual(asServed(context));
  });

  test("hands an extension tool the server's elicitation and the client's handshake and nothing else of the server, and a resource read none of it", async () => {
    await connect(SPREAD);

    await client.callTool({ name: "fixture_distribution", arguments: {} });
    await client.readResource({ uri: "fixture://anyone" });

    const handed = namingToolSessions[0]!.server;
    expect(Object.keys(handed).sort()).toEqual(["elicitInput", "getClientCapabilities", "getClientVersion"]);
    expect("setRequestHandler" in handed).toBe(false);
    expect(handed.getClientVersion()).toEqual({ name: "generic-server-client", version: "1.0.0" });
    expect(handed.getClientCapabilities()).toEqual(server.getClientCapabilities());
    expect(Object.keys(namingReadSessions[0]!).sort()).toEqual(["context", "distribution"]);
  });

  test("a call runs under the name MUSAI_PRINCIPAL gives, and the client's handshake name never stands for one", async () => {
    vi.stubEnv("MUSAI_PRINCIPAL", undefined);
    await connect(SPREAD);
    const unnamed = (await client.callTool({ name: "fixture_whoami", arguments: {} })) as CallToolResult;
    expect(unnamed.structuredContent).toEqual({ principalName: null });

    vi.stubEnv("MUSAI_PRINCIPAL", "florin");
    const named = (await client.callTool({ name: "fixture_whoami", arguments: {} })) as CallToolResult;
    expect(named.structuredContent).toEqual({ principalName: "florin" });
  });

  test("hands an extension tool copies of the client's handshake, so a write to them moves neither the server's own nor the name a later projected call runs under", async () => {
    vi.stubEnv("MUSAI_PRINCIPAL", undefined);
    await connect(SPREAD);
    await client.callTool({ name: "fixture_distribution", arguments: {} });
    const handed = namingToolSessions[0]!.server;

    handed.getClientVersion()!.name = "rewritten";
    handed.getClientCapabilities()!.elicitation = { form: {} };
    const whoami = (await client.callTool({ name: "fixture_whoami", arguments: {} })) as CallToolResult;

    expect(whoami.structuredContent).toEqual({ principalName: null });
    expect(server.getClientVersion()).toEqual({ name: "generic-server-client", version: "1.0.0" });
    expect(server.getClientCapabilities()?.elicitation).toBeUndefined();
    await expect(
      handed.elicitInput({
        message: "a question no client here can answer",
        requestedSchema: { type: "object", properties: {} },
      }),
    ).rejects.toThrow(/does not support form elicitation/);
  });

  test("hands every extension tool call the one session the server built, and freezes that session, its server surface and a resource read's session at their top level", async () => {
    await connect(SPREAD);

    await client.callTool({ name: "fixture_distribution", arguments: {} });
    await client.callTool({ name: "fixture_distribution", arguments: {} });
    await client.readResource({ uri: "fixture://anyone" });

    const [first, second] = namingToolSessions;
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first!.server)).toBe(true);
    expect(Object.isFrozen(namingReadSessions[0])).toBe(true);
  });

  test("a pack's tool that is no operation, refused by the invoker, answers as an error result and leaves a row in the call log naming the contribution and the refusal's reason", async () => {
    await installModuleRecord(workspace, scope, "generic-server-pack", [UNPLACED], now);
    await connect(BARE);

    const answered = (await client.callTool({ name: "generic-server-pack_unplaced", arguments: {} })) as CallToolResult;

    expect(answered.isError).toBe(true);
    const [item] = answered.content as readonly { readonly type: string; readonly text: string }[];
    expect(JSON.parse(item!.text)).toMatchObject({ reason: "no-such-record", about: [UNPLACED.id, UNPLACED.kind] });
    expect(await callLogRows(workspace)).toEqual([
      {
        request: { contribution: UNPLACED.kind, id: UNPLACED.id, version: "1", input: {} },
        response: {
          ok: false,
          error: { code: "no-such-record", data: { about: [UNPLACED.id, UNPLACED.kind] }, message: expect.any(String) },
        },
      },
    ]);
  });

  test("declares no resources capability for a distribution whose extension brings no resources", async () => {
    await connect();

    expect(client.getServerCapabilities()).toEqual({ tools: {}, prompts: {} });
  });

  test("after an install, a session over a distribution with no resources sends the tools and prompts list-changed notifications and no resources one, and raises nothing", async () => {
    await installEmptyModule(workspace, scope, "generic-server-fixture", now);
    await connect();
    const received: string[] = [];
    client.setNotificationHandler(ToolListChangedNotificationSchema, (notification) => {
      received.push(notification.method);
    });
    client.setNotificationHandler(PromptListChangedNotificationSchema, (notification) => {
      received.push(notification.method);
    });
    client.setNotificationHandler(ResourceListChangedNotificationSchema, (notification) => {
      received.push(notification.method);
    });

    const { tools } = await client.listTools();
    await client.ping();

    expect(tools.map((tool) => tool.name)).toEqual(["fixture_greet", "fixture_wave"]);
    expect(received).toEqual(["notifications/tools/list_changed", "notifications/prompts/list_changed"]);
  });

  test("an extension tool sharing a projected tool's name stands in that tool's place, and its call reaches its own handler rather than the registry", async () => {
    await connect(REPLACING);

    const { tools } = await client.listTools();
    const greeted = (await client.callTool({
      name: "fixture_greet",
      arguments: { whom: "the fixture" },
    })) as CallToolResult;
    const parted = (await client.callTool({ name: "fixture_part", arguments: {} })) as CallToolResult;

    expect(tools.map((tool) => tool.name)).toEqual(["fixture_greet", "fixture_part"]);
    expect(tools[0]).toEqual(GREET_INSTEAD.tool);
    expect(greeted.content).toEqual([{ type: "text", text: "greeted the fixture instead" }]);
    expect(greeted.structuredContent).toBeUndefined();
    expect(greetedInstead).toHaveLength(1);
    expect(greetedInstead[0]!.session.context).toEqual(asServed(context));
    expect(parted.structuredContent).toEqual({ greeting: "goodbye", count: 1 });
  });

  test("outside lab, every listed tool answers within its listed output schema, an extension's in the place of the projection it stands over", async () => {
    await connect(PUBLIC_WIDENED);

    const { tools } = await client.listTools();
    const answers = [];
    for (const tool of tools) {
      answers.push(((await client.callTool({ name: tool.name, arguments: {} })) as CallToolResult).structuredContent);
    }

    expect(tools.map((tool) => tool.name)).toEqual(["fixture_greet", "fixture_part"]);
    expect(tools[0]).toEqual(GREET_WIDER.tool);
    expect(answers).toEqual([
      { greeting: "hello", count: 2, from: "the extension" },
      { greeting: "goodbye", count: 1 },
    ]);
  });

  test("outside lab, a call by a name the listing leaves out is refused as no tool, logged under the name sent", async () => {
    await connect(PUBLIC_GREETING);

    const { tools } = await client.listTools();
    const greeted = (await client.callTool({ name: "fixture_greet", arguments: {} })) as CallToolResult;
    const refused = [];
    for (const name of ["fixture_part", "fixture_wave"]) {
      const result = (await client.callTool({ name, arguments: {} })) as CallToolResult;
      refused.push({ isError: result.isError, refusal: JSON.parse((result.content[0] as { text: string }).text) });
    }

    expect(tools.map((tool) => tool.name)).toEqual(["fixture_greet"]);
    expect(greeted.structuredContent).toEqual({ greeting: "hello", count: 2 });
    expect(refused).toEqual(
      ["fixture_part", "fixture_wave"].map((name) => ({
        isError: true,
        refusal: expect.objectContaining({ reason: "unknown-operation", about: [name] }),
      })),
    );
    expect(waved).toEqual([]);
    expect((await callLogRows(workspace)).slice(1)).toEqual(
      ["fixture_part", "fixture_wave"].map((name) => ({
        request: { contribution: "operation", id: name, version: "0", input: {} },
        response: expect.objectContaining({ ok: false }),
      })),
    );
  });

  test("in lab, every tool the listing holds is callable, the ones outside lab leaves out among them", async () => {
    await connect(PUBLIC_GREETING, true);

    const { tools } = await client.listTools();
    const results = [];
    for (const tool of tools) {
      results.push(((await client.callTool({ name: tool.name, arguments: {} })) as CallToolResult).isError);
    }

    expect(tools.map((tool) => tool.name)).toEqual(["fixture_greet", "fixture_part", "fixture_wave"]);
    expect(results).toEqual([undefined, undefined, undefined]);
  });

  async function clearedToWriter(): Promise<void> {
    await writeTrustFile({ gitDir: join(workspace, MUSAI_DIR) }, "audiences", `${WRITER}\n`);
    context = { ...context, clearance: WRITER };
  }

  test.each([
    ["outside lab", false],
    ["in lab", true],
  ])("%s, an extension over an operation the clearance withholds is neither listed nor callable", async (_, lab) => {
    await clearedToWriter();
    await connect(PUBLIC_KEEPING, lab);

    const { tools } = await client.listTools();
    const refused = (await client.callTool({ name: "fixture_keep", arguments: {} })) as CallToolResult;

    expect(tools.map((tool) => tool.name)).toEqual(["fixture_greet"]);
    expect(refused.isError).toBe(true);
    expect(JSON.parse((refused.content[0] as { text: string }).text)).toMatchObject({
      reason: "invalid-input",
      about: [`${KEEP.id}@${KEEP.version}`],
      detail: expect.stringContaining(WRITER),
    });
    expect(keptInstead).toEqual([]);
  });

  test("outside lab and in it, every name the listing holds is callable and every name it leaves out is refused", async () => {
    await clearedToWriter();
    const answered: Record<string, boolean> = {};
    for (const lab of [false, true]) {
      await connect(PUBLIC_KEEPING, lab);
      const listed = new Set((await client.listTools()).tools.map((tool) => tool.name));
      for (const name of ["fixture_greet", "fixture_keep", "fixture_wave"]) {
        const result = (await client.callTool({ name, arguments: {} })) as CallToolResult;
        answered[`${lab ? "lab" : "public"} ${name}`] = listed.has(name) === (result.isError !== true);
      }
      if (!lab) {
        await client.close();
        await server.close();
      }
    }

    expect(Object.values(answered)).toEqual([true, true, true, true, true, true]);
  });

  test.each([
    ["input its schema refuses", { stray: true }],
    ["a head that has moved", { expectHead: "0".repeat(40) }],
    ["input its schema admits", {}],
  ])("a call with %s to an operation the clearance withholds is refused as the API refuses it", async (_, args) => {
    await clearedToWriter();
    await connect(PUBLIC_KEEPING, true);
    const { expectHead, ...input } = args as { expectHead?: string };

    const overMcp = (await client.callTool({ name: "fixture_keep", arguments: args })) as CallToolResult;
    const overApi = await runHandler(KEEP, input, { ...context, ...(expectHead === undefined ? {} : { expectHead }) })
      .then(() => undefined)
      .catch((error: OperationError) => ({ reason: error.reason, about: error.about, detail: error.detail }));

    expect(overMcp.isError).toBe(true);
    expect(overApi).toBeDefined();
    expect(JSON.parse((overMcp.content[0] as { text: string }).text)).toEqual(overApi);
    expect(keptRuns).toEqual([]);
  });

  test("a contribution that collides with a listed name is withheld, and every other tool stays listed and callable", async () => {
    const contribution = (id: string): ContributionEntry => ({ ...UNPLACED, id });
    await installModuleRecord(workspace, scope, "fixture", [contribution("fixture/greet")], now);
    await installModuleRecord(workspace, scope, "twin", [contribution("twin/a.b"), contribution("twin/a_b")], now);
    await installModuleRecord(workspace, scope, "solo", [contribution("solo/x")], now);
    await connect(FIXTURE, true);

    const { tools } = await client.listTools();
    const greeted = (await client.callTool({ name: "fixture_greet", arguments: {} })) as CallToolResult;
    const waved = (await client.callTool({ name: "fixture_wave", arguments: { at: "a sibling" } })) as CallToolResult;
    const solo = (await client.callTool({ name: "solo_x", arguments: {} })) as CallToolResult;
    const twin = (await client.callTool({ name: "twin_a_b", arguments: {} })) as CallToolResult;

    expect(tools.map((tool) => tool.name)).toEqual(["fixture_greet", "solo_x", "fixture_wave"]);
    expect(greeted.structuredContent).toEqual({ greeting: "hello", count: 2 });
    expect(waved.content).toEqual([{ type: "text", text: "waved at a sibling" }]);
    expect(JSON.parse((solo.content[0] as { text: string }).text)).toMatchObject({ about: ["solo/x", UNPLACED.kind] });
    expect(twin.isError).toBe(true);
    const refusal = JSON.parse((twin.content[0] as { text: string }).text) as { reason: string; detail: string };
    expect(refusal.reason).toBe("declaration-conflict");
    expect(refusal.detail).toContain("twin/a.b");
    expect(refusal.detail).toContain("twin/a_b");
    const collisions = (await callLogRows(workspace)).filter(
      (row) => (row["response"] as { error?: { code: string } }).error?.code === "declaration-conflict",
    );
    expect(collisions.map((row) => (row["request"] as { id: string }).id).sort()).toEqual([
      "fixture_greet",
      "twin_a_b",
      "twin_a_b",
    ]);
    expect(
      collisions.filter((row) => (row["request"] as { contribution: string }).contribution === "tool-name"),
    ).toHaveLength(2);
  });

  test("logs an extension tool's call under its own name with the arguments it was given and the answer it returned", async () => {
    await connect(NODDING);

    await client.callTool({ name: "fixture_nod", arguments: { at: "the fixture" } });

    expect(nodded).toEqual([{ at: "the fixture" }]);
    expect(await callLogRows(workspace)).toEqual([
      {
        request: { contribution: "extension", id: "fixture_nod", version: "0", input: { at: "the fixture" } },
        response: { ok: true, output: { at: "the fixture" }, diagnostics: [] },
      },
    ]);
  });

  test("refuses an extension tool's arguments that break its own input schema as invalid-input, logs the refusal and never reaches the tool", async () => {
    await connect(NODDING);

    const refused = (await client.callTool({
      name: "fixture_nod",
      arguments: { at: 4, extra: true },
    })) as CallToolResult;

    expect(refused.isError).toBe(true);
    expect(JSON.parse((refused.content[0] as { text: string }).text)).toMatchObject({
      reason: "invalid-input",
      about: ["fixture_nod"],
    });
    expect(nodded).toEqual([]);
    expect(await callLogRows(workspace)).toEqual([
      {
        request: { contribution: "extension", id: "fixture_nod", version: "0", input: { at: 4, extra: true } },
        response: {
          ok: false,
          error: { code: "invalid-input", data: { about: ["fixture_nod"] }, message: expect.any(String) },
        },
      },
    ]);
  });

  /** Declares a dialect the validator does not know, so its schema never compiles. */
  function uncompilableTool(name: string, unreached: unknown[]): McpExtensionTool {
    return {
      tool: {
        name,
        description: "Declares a schema dialect the validator does not know.",
        inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
      },
      call: async (_session, args) => {
        unreached.push(args);
        return { content: [] };
      },
    };
  }

  test("withholds an extension tool whose input schema does not compile from the listing, says why in the session's log and leaves its siblings working", async () => {
    const unreached: unknown[] = [];
    const uncompilable = uncompilableTool("fixture_uncompilable", unreached);
    await connect({ ...BARE, extensions: { mcp: { tools: [uncompilable, WAVE] } } });

    const { tools } = await client.listTools();
    await client.listTools();
    const refused = (await client.callTool({ name: "fixture_uncompilable", arguments: {} })) as CallToolResult;
    const wave = (await client.callTool({ name: "fixture_wave", arguments: { at: "a sibling" } })) as CallToolResult;

    expect(tools.map((tool) => tool.name)).toEqual(["fixture_greet", "fixture_wave"]);
    expect(refused.isError).toBe(true);
    expect(JSON.parse((refused.content[0] as { text: string }).text)).toMatchObject({
      reason: "unknown-operation",
      about: ["fixture_uncompilable"],
    });
    expect(unreached).toEqual([]);
    expect(wave.content).toEqual([{ type: "text", text: "waved at a sibling" }]);
    const rows = await callLogRows(workspace);
    expect(rows[0]).toEqual({
      request: {
        contribution: "extension",
        id: "fixture_uncompilable",
        version: "0",
        input: uncompilable.tool.inputSchema,
      },
      response: {
        ok: false,
        error: {
          code: "schema-uncompilable",
          data: null,
          message: expect.stringContaining("withheld from tools/list"),
        },
      },
    });
    expect(
      rows.filter((row) => (row["response"] as { error?: { code: string } }).error?.code === "schema-uncompilable"),
    ).toHaveLength(1);
  });

  test.each([
    ["it stands over an operation the clearance withholds", true, "keeps for its author"],
    ["outside lab, no public operation holds its name", false, "offers no operation named fixture_keep"],
  ])("an uncompilable extension left out because %s is logged with that reason", async (_, cleared, reason) => {
    if (cleared) {
      await clearedToWriter();
    }
    const unreached: unknown[] = [];
    const keepless = { ...PUBLIC_KEEPING, publicOperations: new Set([`${GREET.id}@${GREET.version}`]) };
    const distribution = cleared ? PUBLIC_KEEPING : keepless;
    await connect({ ...distribution, extensions: { mcp: { tools: [uncompilableTool("fixture_keep", unreached)] } } });

    await client.listTools();

    const [row] = (await callLogRows(workspace)).filter(
      (logged) => (logged["response"] as { error?: { code: string } }).error?.code === "schema-uncompilable",
    );
    const message = (row!["response"] as { error: { message: string } }).error.message;
    expect(message).toContain(reason);
    expect(message).not.toMatch(/^withheld from tools\/list: /);
    expect(unreached).toEqual([]);
  });

  test("withholds the name an uncompilable extension tool stands over rather than listing the projection it replaced", async () => {
    const unreached: unknown[] = [];
    await connect({ ...BARE, extensions: { mcp: { tools: [uncompilableTool("fixture_greet", unreached), WAVE] } } });

    const { tools } = await client.listTools();
    const refused = (await client.callTool({ name: "fixture_greet", arguments: { whom: "anyone" } })) as CallToolResult;

    expect(tools.map((tool) => tool.name)).toEqual(["fixture_wave"]);
    expect(refused.isError).toBe(true);
    expect(JSON.parse((refused.content[0] as { text: string }).text)).toMatchObject({
      reason: "unknown-operation",
      about: ["fixture_greet"],
    });
    expect(unreached).toEqual([]);
  });

  test("answers a refused resource read as a JSON-RPC error whose data is the refusal's reason, what it is about and its detail", async () => {
    await connect(REFUSING);

    const refused = await client.readResource({ uri: "fixture://nothing" }).catch((caught: unknown) => caught);

    expect(refused).toMatchObject({
      data: { reason: "no-such-record", about: ["fixture://nothing"], detail: "nothing is held at fixture://nothing" },
    });
  });

  test("answers a refused prompt as a JSON-RPC error whose data is the refusal's reason, what it is about and its detail", async () => {
    await connect(BARE);

    const refused = await client.getPrompt({ name: "fixture_unlisted" }).catch((caught: unknown) => caught);

    expect(refused).toMatchObject({
      data: { reason: "no-such-record", about: ["fixture_unlisted"], detail: "no prompt named fixture_unlisted" },
    });
  });

  test("logs an extension tool's error result as a failed call carrying the content it answered", async () => {
    await connect(FAILING_TOOLS);

    const answered = (await client.callTool({ name: "fixture_answers_error", arguments: {} })) as CallToolResult;

    expect(answered.isError).toBe(true);
    expect(await callLogRows(workspace)).toEqual([
      {
        request: { contribution: "extension", id: "fixture_answers_error", version: "0", input: {} },
        response: {
          ok: false,
          error: {
            code: "tool-error",
            data: [{ type: "text", text: "the fixture could not" }],
            message: expect.any(String),
          },
        },
      },
    ]);
  });

  test("logs a refusal an extension tool throws under its reason, and answers it as an error result", async () => {
    await connect(FAILING_TOOLS);

    const refused = (await client.callTool({ name: "fixture_throws_refusal", arguments: {} })) as CallToolResult;

    expect(refused.isError).toBe(true);
    expect(JSON.parse((refused.content[0] as { text: string }).text)).toMatchObject({ reason: "no-such-record" });
    expect(await callLogRows(workspace)).toEqual([
      {
        request: { contribution: "extension", id: "fixture_throws_refusal", version: "0", input: {} },
        response: {
          ok: false,
          error: { code: "no-such-record", data: { about: ["fixture"] }, message: "nothing is held" },
        },
      },
    ]);
  });

  test("a call log that fails to open is opened again for the next entry", async () => {
    const calls = join(workspace, MUSAI_DIR, LOCAL_DIR, CALL_LOG_DIR);
    await mkdir(join(workspace, MUSAI_DIR, LOCAL_DIR), { recursive: true });
    await writeFile(calls, "");
    await connect();
    await expect(client.callTool({ name: "fixture_greet", arguments: {} })).rejects.toThrow();

    await rm(calls);

    expect(((await client.callTool({ name: "fixture_greet", arguments: {} })) as CallToolResult).isError).not.toBe(
      true,
    );
    expect(await callLogRows(workspace)).toHaveLength(1);
  });

  test("passes a subscription's refused answer to the sink the caller's own context carries as well as logging it", async () => {
    const seen: string[] = [];
    context = {
      ...context,
      reportSubscription: async (trace) => {
        seen.push(trace.subscription);
      },
    };
    await connect(REPORTING);
    const event = { name: "claim.put", payload: { id: "sha256:a", about: "sha256:a", at: "abc" } };
    const error = { code: "need-refused", data: null, message: "refused" } as const;
    const trace = { subscription: "pack/on-claim", version: "1", event, error };

    await client.callTool({ name: "fixture_report", arguments: { trace } });

    expect(seen).toEqual(["pack/on-claim"]);
    expect(await subscriptionRows(workspace)).toMatchObject([{ request: { contribution: "subscription" } }]);
  });

  test("logs a subscription's refused answer a write left behind as a row naming the subscription and the event it was invoked with", async () => {
    await connect(REPORTING);
    const event = { name: "claim.put", payload: { id: "sha256:a", about: "sha256:a", at: "abc" } };
    const error = {
      code: "need-refused",
      data: { need: "run" },
      message: "the run named a binary nothing declares",
    } as const;
    const trace = { subscription: "pack/on-claim", version: "1", event, error };

    await client.callTool({ name: "fixture_report", arguments: { trace } });

    expect(await subscriptionRows(workspace)).toEqual([
      {
        request: { contribution: "subscription", id: "pack/on-claim", version: "1", input: event },
        response: { ok: false, error },
      },
    ]);
  });

  test("logs a record the fold refuses once, as a row naming the file and the commit, and passes it to the caller's own sink as well", async () => {
    const unreadable = recordId(fixtureRunRecord("never readable"));
    const path = recordPath("run", unreadable);
    const commit = await commitAroundTheStore(
      { ctx: { gitDir: join(workspace, MUSAI_DIR) }, scope, now },
      path,
      new TextEncoder().encode("not a record"),
    );
    const seen: string[] = [];
    context = {
      ...context,
      reportRefusal: (refusal) => {
        seen.push(refusal.path);
      },
    };
    await connect();

    await client.callTool({ name: "fixture_greet", arguments: {} });
    await client.callTool({ name: "fixture_greet", arguments: {} });

    expect(seen).toEqual([path, path]);
    const refused = (await callLogRows(workspace)).filter(
      (row) => (row["request"] as { contribution: string }).contribution === "fold",
    );
    expect(refused).toEqual([
      {
        request: { contribution: "fold", id: path, version: "0", input: { id: unreadable, commit } },
        response: {
          ok: false,
          error: { code: "fold-refused", data: null, message: expect.any(String) },
        },
      },
    ]);
  });

  test("a distribution with no extensions serves its projected tools alone and declares no resources capability", async () => {
    await connect(BARE);

    const { tools } = await client.listTools();
    const greeted = (await client.callTool({ name: "fixture_greet", arguments: {} })) as CallToolResult;

    expect(tools.map((tool) => tool.name)).toEqual(["fixture_greet"]);
    expect(greeted.structuredContent).toEqual({ greeting: "hello", count: 2 });
    expect(client.getServerCapabilities()).toEqual({ tools: {}, prompts: {} });
  });

  test("a distribution whose extension brings resources declares the capability, lists them as it declares them, and routes every read to its reader under the session's context", async () => {
    await connect(MOUNTING);

    const { resources } = await client.listResources();
    const { resourceTemplates } = await client.listResourceTemplates();
    const { contents } = await client.readResource({ uri: "fixture://anyone" });

    expect(client.getServerCapabilities()).toEqual({ tools: {}, resources: {}, prompts: {} });
    expect(resources).toEqual(RESOURCES.resources);
    expect(resourceTemplates).toEqual(RESOURCES.templates);
    expect(contents).toEqual([{ uri: "fixture://anyone", mimeType: "text/plain", text: "read fixture://anyone" }]);
    expect(readUris).toHaveLength(1);
    expect(readUris[0]!.session.context).toEqual(asServed(context));
  });

  test("after an install, a session over a distribution with resources sends the tools, resources and prompts list-changed notifications", async () => {
    await installEmptyModule(workspace, scope, "generic-server-fixture", now);
    await connect(MOUNTING);
    const received: string[] = [];
    client.setNotificationHandler(ToolListChangedNotificationSchema, (notification) => {
      received.push(notification.method);
    });
    client.setNotificationHandler(PromptListChangedNotificationSchema, (notification) => {
      received.push(notification.method);
    });
    client.setNotificationHandler(ResourceListChangedNotificationSchema, (notification) => {
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
});

describe("a server whose distribution projects one tool name twice", () => {
  test.each([
    ["two operations whose ids fold to one name", "fixture.a_b", "fixture_a.b", "1", "1"],
    ["two versions of one operation", "fixture.greet", "fixture.greet", "1", "2"],
  ])("%s refuse to build the server, naming both", (_, firstId, secondId, firstVersion, secondVersion) => {
    const first = { ...GREET, id: firstId, version: versionString(firstVersion) };
    const second = { ...GREET, id: secondId, version: versionString(secondVersion) };
    const colliding: McpDistribution = {
      ...BARE,
      registry: new Map([
        [`${first.id}@${first.version}`, first],
        [`${second.id}@${second.version}`, second],
      ]),
    };

    const built = () => createMcpServer(colliding, { workspace: "unopened", scope: "default", now }, { lab: true });

    expect(built).toThrow(`${first.id}@${first.version}`);
    expect(built).toThrow(`${second.id}@${second.version}`);
  });

  test("two extension tools of one name refuse to build the server", () => {
    const twice: McpDistribution = { ...BARE, extensions: { mcp: { tools: [WAVE, { ...WAVE }] } } };

    expect(() => createMcpServer(twice, { workspace: "unopened", scope: "default", now }, { lab: true })).toThrow(
      WAVE.tool.name,
    );
  });
});

describe("a call refused before its tool is resolved, driven with no transport", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-mcp-generic-server-unresolved-"));
    await initWorkspace(workspace, { now });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("a refusal raised while the workspace it would read is opened leaves a row in the call log under the name the caller sent, with the refusal's reason and what it is about", async () => {
    const scope = "not a scope";
    const log = await openCallLog(workspace);

    const refused = await callTool(
      BARE,
      { workspace, scope, now },
      "fixture_unregistered",
      { at: "nowhere" },
      async () => log,
    ).catch((caught: unknown) => caught);

    expect(refused).toMatchObject({ reason: "invalid-input", about: [scope] });
    expect(await callLogRows(workspace)).toEqual([
      {
        request: { contribution: "operation", id: "fixture_unregistered", version: "0", input: { at: "nowhere" } },
        response: {
          ok: false,
          error: { code: "invalid-input", data: { about: [scope] }, message: expect.any(String) },
        },
      },
    ]);
  });
});
