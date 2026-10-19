import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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
import { type OperationContext, type OperationDescriptor, OperationError } from "@musai/api-core";
import { type ContributionEntry, recordId, recordPath, versionString } from "@musai/records";
import { initWorkspace, LOCAL_DIR, MUSAI_DIR } from "@musai/store";
import {
  commitAroundTheStore,
  fixedClock,
  fixtureRunRecord,
  installEmptyModule,
  installModuleRecord,
} from "@musai/test-support";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CALL_LOG_DIR, openCallLog } from "../src/call-log.js";
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

const MOUNTING: McpDistribution = { ...BARE, extensions: { mcp: { tools: [WAVE], resources: RESOURCES } } };

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

  async function connect(distribution: McpDistribution = FIXTURE): Promise<void> {
    server = createMcpServer(distribution, context, { lab: false });
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

  test("refuses an extension tool whose input schema does not compile as unavailable by its name and leaves its siblings working", async () => {
    const unreached: unknown[] = [];
    const UNCOMPILABLE: McpExtensionTool = {
      tool: {
        name: "fixture_uncompilable",
        description: "Declares a schema dialect the validator does not know.",
        inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
      },
      call: async (_session, args) => {
        unreached.push(args);
        return { content: [] };
      },
    };
    await connect({ ...BARE, extensions: { mcp: { tools: [UNCOMPILABLE, WAVE] } } });

    const refused = (await client.callTool({ name: "fixture_uncompilable", arguments: {} })) as CallToolResult;
    const wave = (await client.callTool({ name: "fixture_wave", arguments: { at: "a sibling" } })) as CallToolResult;

    expect(refused.isError).toBe(true);
    expect(JSON.parse((refused.content[0] as { text: string }).text)).toMatchObject({
      reason: "tool-unavailable",
      about: ["fixture_uncompilable"],
    });
    expect(unreached).toEqual([]);
    expect(wave.content).toEqual([{ type: "text", text: "waved at a sibling" }]);
    expect((await callLogRows(workspace))[0]).toMatchObject({
      request: { contribution: "extension", id: "fixture_uncompilable" },
      response: { ok: false, error: { code: "tool-unavailable" } },
    });
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

  test("passes a subscription's refused answer to the sink the caller's own context carries as well as logging it", async () => {
    const seen: string[] = [];
    context = {
      ...context,
      reportSubscription: async (trace) => {
        seen.push(trace.subscription);
      },
    };
    await connect(SPREAD);
    await client.callTool({ name: "fixture_distribution", arguments: {} });
    const event = { name: "claim.put", payload: { id: "sha256:a", about: "sha256:a", at: "abc" } };
    const error = { code: "need-refused", data: null, message: "refused" } as const;

    await namingToolSessions[0]!.context.reportSubscription!({
      subscription: "pack/on-claim",
      version: "1",
      event,
      error,
    });

    expect(seen).toEqual(["pack/on-claim"]);
    expect((await callLogRows(workspace)).slice(-1)[0]).toMatchObject({ request: { contribution: "subscription" } });
  });

  test("logs a subscription's refused answer a write left behind as a row naming the subscription and the event it was invoked with", async () => {
    await connect(SPREAD);
    await client.callTool({ name: "fixture_distribution", arguments: {} });
    const event = { name: "claim.put", payload: { id: "sha256:a", about: "sha256:a", at: "abc" } };
    const error = {
      code: "need-refused",
      data: { need: "run" },
      message: "the run named a binary nothing declares",
    } as const;

    await namingToolSessions[0]!.context.reportSubscription!({
      subscription: "pack/on-claim",
      version: "1",
      event,
      error,
    });

    expect((await callLogRows(workspace)).slice(-1)).toEqual([
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
      log,
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
