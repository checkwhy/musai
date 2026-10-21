import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  GetPromptRequestSchema,
  type GetPromptResult,
  ListPromptsRequestSchema,
  type ListPromptsResult,
  ListPromptsResultSchema,
  ListToolsResultSchema,
  ReadResourceRequestSchema,
  type ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  installedManifests,
  isOperationError,
  type NamedManifest,
  type OperationContext,
  openWorkspace,
} from "@musai/api-core";
import { buildModule } from "@musai/devkit";
import {
  callTool,
  manifestContributionProjections,
  registerPromptHandlers,
  registerResourceHandlers,
  toolsFromManifests,
} from "@musai/mcp";
import { ENVELOPE_PROTOCOL } from "@musai/modules";
import { type ContributionEntry, type ModuleManifest, versionString } from "@musai/records";
import { initWorkspace } from "@musai/store";
import { blobStoreOf, fixedClock } from "@musai/test-support";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { REGISTRY } from "../../src/index.js";
import { MUSAI_MCP } from "../../src/mcp/extension.js";
import { MUSAI_RESOURCES } from "../../src/mcp/resources.js";
import { MUSAI } from "../../src/musai.js";
import { repoGitDir } from "../repo-git-dir.js";

const GREETER_FIXTURE_DIR = fileURLToPath(new URL("./fixtures/greeter", import.meta.url));
const now = fixedClock("2026-08-31T00:00:00.000Z");

/** A server recording its handlers and calling one back by request shape: a client's path to an
 * answer without a transport. */
function handlerRecorder(): {
  readonly server: Server;
  readonly call: <T>(schema: unknown, params: Record<string, unknown>) => Promise<T>;
} {
  const handlers = new Map<unknown, (request: never) => Promise<unknown>>();
  const server = {
    setRequestHandler(schema: unknown, handler: (request: never) => Promise<unknown>): void {
      handlers.set(schema, handler);
    },
  } as unknown as Server;
  return {
    server,
    call: async <T>(schema: unknown, params: Record<string, unknown>): Promise<T> => {
      const handler = handlers.get(schema);
      if (handler === undefined) {
        throw new Error("the session registered no handler for that request shape");
      }
      return (await handler({ params } as never)) as T;
    },
  };
}

function fixtureManifest(moduleName: string, contributions: readonly ContributionEntry[]): NamedManifest {
  const manifest: ModuleManifest = {
    protocolVersion: ENVELOPE_PROTOCOL,
    contributions: [...contributions],
    sourceTree: { digest: { gitTree: "a".repeat(40) } },
    toolchain: [],
    packages: [],
  };
  return { moduleName, manifest };
}

describe("the mechanical projection, over hand-built fixture manifests", () => {
  test("a contribution whose own input is an object schema projects to a tool carrying that exact schema, unmodified", () => {
    const manifests = [
      fixtureManifest("pack", [
        {
          kind: "rule",
          id: "pack/decides",
          version: versionString("1"),
          input: {
            type: "object",
            additionalProperties: false,
            required: ["x"],
            properties: { x: { type: "string" } },
          },
          output: {
            type: "object",
            additionalProperties: false,
            required: ["y"],
            properties: { y: { type: "string" } },
          },
          documentation: "a fixture rule",
        },
        {
          kind: "parser",
          id: "pack/selects",
          version: versionString("1"),
          input: {
            type: "object",
            additionalProperties: false,
            required: ["output"],
            properties: { output: { type: "string" } },
          },
          output: true,
          documentation: "a fixture parser",
        },
      ]),
    ];

    const tools = toolsFromManifests(REGISTRY, manifests);
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("pack_decides");
    expect(names).toContain("pack_selects");

    const decides = tools.find((tool) => tool.name === "pack_decides")!;
    expect(decides.inputSchema).toEqual(manifests[0]!.manifest.contributions[0]!.input);
  });

  test("a query projects to a tool carrying its declared parameters as the input schema and its rows as the output schema", () => {
    const manifests = [
      fixtureManifest("pack", [
        {
          kind: "query",
          id: "pack/cases",
          version: versionString("1"),
          input: {
            type: "object",
            additionalProperties: false,
            required: [],
            properties: { kind: { type: ["string", "null"] } },
            statement: "SELECT id FROM cases WHERE :kind IS NULL OR kind = :kind ORDER BY id ASC",
            tables: ["cases"],
          },
          output: {
            type: "object",
            additionalProperties: false,
            required: ["rows"],
            properties: {
              rows: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["id"],
                  properties: { id: { type: "string" } },
                },
              },
            },
          },
          documentation: "a fixture query",
        },
      ]),
    ];

    // A query's input schema carries two words Ajv ignores, so it projects as the object it is.
    const [projected] = manifestContributionProjections(manifests);
    expect(projected?.tool.name).toBe("pack_cases");
    expect(projected?.tool.inputSchema).toEqual(manifests[0]!.manifest.contributions[0]!.input);
    expect(projected?.tool.outputSchema).toEqual(manifests[0]!.manifest.contributions[0]!.output);
  });

  test("a contribution whose own input is not an object schema — the boolean shorthand, or a kind's own repurposed data — does not project, whatever its kind", () => {
    const manifests = [
      fixtureManifest("pack", [
        {
          kind: "rule",
          id: "pack/unconstrained",
          version: versionString("1"),
          input: true,
          output: true,
          documentation: "an unconstrained rule, never invoked directly",
        },
        {
          kind: "slot",
          id: "pack/some-slot",
          version: versionString("1"),
          input: { layers: ["project"], hasDefault: true, default: null },
          output: { type: "string" },
          documentation: "a slot declaration, not an invocable contribution",
        },
      ]),
    ];

    const tools = toolsFromManifests(REGISTRY, manifests);
    expect(tools.map((tool) => tool.name)).toEqual([]);
  });

  test("an operation contribution projects as a tool from its own input schema, advertising no output schema since it answers with the applied plan", () => {
    const manifests = [
      fixtureManifest("pack", [
        {
          kind: "operation",
          id: "pack/an-operation",
          version: versionString("1"),
          input: { type: "object", properties: { subject: { type: "string" } } },
          output: { type: "object" },
          documentation: "an operation contribution, whose plan the kernel checks and applies",
          effect: "write",
          authority: null,
        },
      ]),
    ];

    expect(toolsFromManifests(REGISTRY, manifests)).toEqual([
      {
        name: "pack_an-operation",
        description: "an operation contribution, whose plan the kernel checks and applies",
        inputSchema: { type: "object", properties: { subject: { type: "string" } } },
      },
    ]);
    expect(manifestContributionProjections(manifests).map((projected) => projected.entry.id)).toEqual([
      "pack/an-operation",
    ]);
  });

  test("two modules whose contributions project to one tool name are refused, naming both modules", () => {
    const manifests = [
      fixtureManifest("pack", [
        {
          kind: "rule",
          id: "pack/x.y",
          version: versionString("1"),
          input: { type: "object" },
          output: true,
          documentation: "first claimant",
        },
      ]),
      fixtureManifest("pack.x", [
        {
          kind: "rule",
          id: "pack.x/y",
          version: versionString("1"),
          input: { type: "object" },
          output: true,
          documentation: "second claimant, colliding once separators fold",
        },
      ]),
    ];

    expect(() => toolsFromManifests(REGISTRY, manifests)).toThrow(/pack/);
    expect(() => toolsFromManifests(REGISTRY, manifests)).toThrow(/pack\.x/);
  });

  test("a contribution whose own name would shadow one of the distribution's own operations is refused the same way", () => {
    // A contribution `claim/status` folds through the same transform to `claim_status`.
    const shadowedKey = "claim.status@3";
    const [moduleName, localId] = shadowedKey.replace(/@\d+$/, "").split(".") as [string, string];
    const shadowedName = `${moduleName}_${localId}`;
    expect([...REGISTRY.keys()]).toContain(shadowedKey);

    const manifests = [
      fixtureManifest(moduleName, [
        {
          kind: "rule",
          id: `${moduleName}/${localId}`,
          version: versionString("1"),
          input: { type: "object" },
          output: true,
          documentation: "shadows a built-in operation's own tool name",
        },
      ]),
    ];
    expect(() => toolsFromManifests(REGISTRY, manifests)).toThrow(DuplicateToolNameErrorPattern(shadowedName));

    const operationManifests = [
      fixtureManifest(moduleName, [
        {
          kind: "operation",
          id: `${moduleName}/${localId}`,
          version: versionString("1"),
          input: { type: "object" },
          output: true,
          documentation: "an operation contribution shadowing a built-in operation's own tool name",
          effect: "read",
          authority: null,
        },
      ]),
    ];
    expect(() => toolsFromManifests(REGISTRY, operationManifests)).toThrow(DuplicateToolNameErrorPattern(shadowedName));
  });

  test("the projected list is ordered by contribution id ascending, byte-equal across two reads at one head", () => {
    const manifests = [
      fixtureManifest("pack", [
        {
          kind: "rule",
          id: "pack/zzz",
          version: versionString("1"),
          input: { type: "object" },
          output: true,
          documentation: "z",
        },
        {
          kind: "rule",
          id: "pack/aaa",
          version: versionString("1"),
          input: { type: "object" },
          output: true,
          documentation: "a",
        },
        {
          kind: "rule",
          id: "pack/mmm",
          version: versionString("1"),
          input: { type: "object" },
          output: true,
          documentation: "m",
        },
      ]),
    ];

    const first = toolsFromManifests(REGISTRY, manifests);
    const second = toolsFromManifests(REGISTRY, manifests);
    expect(first.map((tool) => tool.name)).toEqual(["pack_aaa", "pack_mmm", "pack_zzz"]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test("a tool's advertised inputSchema and the schema a call is validated against are the same object", () => {
    const manifests = [
      fixtureManifest("pack", [
        {
          kind: "rule",
          id: "pack/decides",
          version: versionString("1"),
          input: { type: "object" },
          output: true,
          documentation: "d",
        },
      ]),
    ];
    const [projected] = manifestContributionProjections(manifests);
    expect(projected!.tool.inputSchema).toBe(projected!.entry.input);
  });
});

function DuplicateToolNameErrorPattern(name: string): RegExp {
  return new RegExp(name.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

describe("with no modules installed", () => {
  let workspace: string;
  const scope = "default";

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-mcp-projection-"));
    await initWorkspace(workspace, { now });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("the tool list is exactly the distribution's own operations and nothing else, and no prompt or manifest tool appears", async () => {
    const opened = await openWorkspace({ workspace, scope, now });
    const manifests = await installedManifests(opened);
    expect(manifests).toEqual([]);

    const tools = toolsFromManifests(REGISTRY, manifests);
    expect(tools).toEqual([]);

    const { server, call } = handlerRecorder();
    registerPromptHandlers(server, { workspace, scope, now });
    expect(await call<ListPromptsResult>(ListPromptsRequestSchema, {})).toEqual({ prompts: [] });
  });
});

describe("a module installed mid-session, genuinely esbuild-bundled through a real host", () => {
  let workspace: string;
  const scope = "default";
  let context: OperationContext;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-mcp-projection-real-"));
    await initWorkspace(workspace, { now });
    context = { workspace, scope, now };
    const sourceGitDir = await repoGitDir();
    const opened = await openWorkspace({ workspace, scope, now });
    await buildModule(GREETER_FIXTURE_DIR, opened.store, {
      blobs: blobStoreOf(workspace),
      index: opened.index,
      sourceGitDir,
      now,
    });
  }, 30_000);

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("its parser contribution appears as a tool a client accepts, and calling it with valid arguments really invokes the bundle", async () => {
    const opened = await openWorkspace({ workspace, scope, now });
    const manifests = await installedManifests(opened);

    const tools = toolsFromManifests(REGISTRY, manifests);
    const parsed = ListToolsResultSchema.safeParse({ tools });
    expect(parsed.success ? null : parsed.error.issues).toBe(null);
    expect(tools.some((tool) => tool.name === "greeter_greets")).toBe(true);

    const result = await callTool(MUSAI, context, "greeter_greets", { name: "world" });
    expect(result.structuredContent).toEqual({ greeting: "hello, world" });
  }, 15_000);

  test("a call whose arguments fail the contribution's own schema is refused before the bundle is ever invoked", async () => {
    const error = await callTool(MUSAI, context, "greeter_greets", {}).catch((caught: unknown) => caught);
    expect(isOperationError(error)).toBe(true);
    expect((error as { reason: string }).reason).toBe("invalid-input");
  }, 15_000);

  test("a tool name naming neither an operation nor an installed contribution refuses as unknown-operation", async () => {
    const error = await callTool(MUSAI, context, "no_such_tool", {}).catch((caught: unknown) => caught);
    expect(isOperationError(error)).toBe(true);
    expect((error as { reason: string }).reason).toBe("unknown-operation");
  }, 15_000);

  test("its template contribution appears as a prompt, and getting it with real arguments really invokes the bundle", async () => {
    const { server, call } = handlerRecorder();
    registerPromptHandlers(server, context);

    const listed = await call<ListPromptsResult>(ListPromptsRequestSchema, {});
    const parsed = ListPromptsResultSchema.safeParse(listed);
    expect(parsed.success ? null : parsed.error.issues).toBe(null);

    const note = listed.prompts.find((prompt) => prompt.name === "greeter_note");
    expect(note).toBeDefined();
    expect(note!.arguments).toEqual([{ name: "who", required: true }]);

    const result = await call<GetPromptResult>(GetPromptRequestSchema, {
      name: "greeter_note",
      arguments: { who: "Ada" },
    });
    expect(result.messages).toEqual([{ role: "user", content: { type: "text", text: "a note for Ada" } }]);
  }, 15_000);
}, 30_000);

describe("resources, addressed by URI", () => {
  let workspace: string;
  const scope = "default";
  let read: <T>(uri: string) => Promise<T>;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-mcp-resources-"));
    await initWorkspace(workspace, { now });
    const { server, call } = handlerRecorder();
    registerResourceHandlers(server, MUSAI_RESOURCES, {
      distribution: MUSAI_MCP,
      context: { workspace, scope, now },
    });
    read = <T>(uri: string) => call<T>(ReadResourceRequestSchema, { uri });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("a case URI naming nothing real refuses with a closed reason rather than an empty document", async () => {
    const error = await read("case://no-such-case").catch((caught: unknown) => caught);
    expect((error as { data: { reason: string } }).data.reason).toBe("no-such-record");
  });

  test("a claim URI naming nothing real refuses with a closed reason", async () => {
    const error = await read("claim://no-such-slot").catch((caught: unknown) => caught);
    expect((error as { data: { reason: string } }).data.reason).toBe("no-such-record");
  });

  test("the pending-gates URI resolves to an empty gate list in a workspace with no case at all", async () => {
    const result = await read<ReadResourceResult>("gates://pending");
    const content = result.contents[0]!;
    const text = "text" in content ? content.text : "";
    expect(JSON.parse(text)).toEqual({ gates: [] });
  });

  test("a URI naming no known shape refuses with a closed reason", async () => {
    const error = await read("mystery://nothing").catch((caught: unknown) => caught);
    expect((error as { data: { reason: string } }).data.reason).toBe("no-such-record");
  });
});
