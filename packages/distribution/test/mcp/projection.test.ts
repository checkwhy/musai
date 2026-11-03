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
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  installedManifests,
  isOperationError,
  type NamedManifest,
  type OperationContext,
  openWorkspace,
  Workspace,
} from "@musai/api-core";
import { buildModule } from "@musai/devkit";
import {
  callTool,
  contributionProjections,
  manifestContributionProjections,
  type ReadGuard,
  registerPromptHandlers,
  registerResourceHandlers,
} from "@musai/mcp";
import { ENVELOPE_PROTOCOL } from "@musai/modules";
import { type ContributionEntry, type ModuleManifest, versionString } from "@musai/records";
import { initWorkspace } from "@musai/store";
import { blobStoreOf, fixedClock } from "@musai/test-support";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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

/** Each suite registers its handlers over a workspace it made. */
const standing: ReadGuard = (read) => read(undefined);

/** Every workspace opened while `run` runs, and every one closed by then. */
async function workspacesOpenedBy(
  run: () => Promise<unknown>,
): Promise<{ readonly opened: readonly Workspace[]; readonly closed: readonly Workspace[] }> {
  const open = vi.spyOn(Workspace, "open");
  const close = vi.spyOn(Workspace.prototype, "close");
  try {
    await run().catch(() => undefined);
    const opened = await Promise.all(open.mock.results.map((result) => result.value as Promise<Workspace>));
    return { opened, closed: [...close.mock.contexts] as Workspace[] };
  } finally {
    open.mockRestore();
    close.mockRestore();
  }
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

    const tools = projectedTools(manifests);
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
    const [projected] = manifestContributionProjections(manifests).projected;
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

    const tools = projectedTools(manifests);
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

    expect(projectedTools(manifests)).toEqual([
      {
        name: "pack_an-operation",
        description: "an operation contribution, whose plan the kernel checks and applies",
        inputSchema: { type: "object", properties: { subject: { type: "string" } } },
      },
    ]);
    expect(manifestContributionProjections(manifests).projected.map((projected) => projected.entry.id)).toEqual([
      "pack/an-operation",
    ]);
  });

  test("two modules whose contributions project to one tool name project neither, and the collision names both", () => {
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

    const { projected, collisions } = contributionProjections(REGISTRY, manifests);

    expect(projected).toEqual([]);
    expect(collisions).toEqual([{ name: "pack_x_y", claimants: ["pack.x's pack.x/y", "pack's pack/x.y"] }]);
  });

  test("a contribution whose own name would shadow one of the distribution's own operations is not projected, and the collision names both", () => {
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
    expect(contributionProjections(REGISTRY, manifests)).toEqual({
      projected: [],
      collisions: [
        {
          name: shadowedName,
          claimants: [`the distribution's own operation ${shadowedKey}`, `${moduleName}'s ${moduleName}/${localId}`],
        },
      ],
    });

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
    expect(contributionProjections(REGISTRY, operationManifests).projected).toEqual([]);
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

    const first = projectedTools(manifests);
    const second = projectedTools(manifests);
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
    const [projected] = manifestContributionProjections(manifests).projected;
    expect(projected!.tool.inputSchema).toBe(projected!.entry.input);
  });
});

function projectedTools(manifests: readonly NamedManifest[]): Tool[] {
  return contributionProjections(REGISTRY, manifests).projected.map((projection) => projection.tool);
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
    using opened = await openWorkspace({ workspace, scope, now });
    const manifests = await installedManifests(opened);
    expect(manifests).toEqual([]);

    const tools = projectedTools(manifests);
    expect(tools).toEqual([]);

    const { server, call } = handlerRecorder();
    registerPromptHandlers(server, { workspace, scope, now }, standing);
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
    using opened = await openWorkspace({ workspace, scope, now });
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
    using opened = await openWorkspace({ workspace, scope, now });
    const manifests = await installedManifests(opened);

    const tools = projectedTools(manifests);
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
    registerPromptHandlers(server, context, standing);

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

  test("a prompt read opens its workspace once and closes it", async () => {
    const { server, call } = handlerRecorder();
    registerPromptHandlers(server, context, standing);

    const reads = [
      () => call(ListPromptsRequestSchema, {}),
      () => call(GetPromptRequestSchema, { name: "greeter_note", arguments: { who: "Ada" } }),
      () => call(GetPromptRequestSchema, { name: "no_such_prompt", arguments: {} }),
    ];
    for (const read of reads) {
      const { opened, closed } = await workspacesOpenedBy(read);
      expect(opened).toHaveLength(1);
      expect(closed).toContain(opened[0]);
    }
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
    registerResourceHandlers(
      server,
      MUSAI_RESOURCES,
      { distribution: MUSAI_MCP, context: { workspace, scope, now } },
      standing,
    );
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

  test("a resource read closes every workspace it opens, answered or refused", async () => {
    const session = { distribution: MUSAI_MCP, context: { workspace, scope, now } };
    for (const uri of ["gates://pending", "case://no-such-case", "claim://no-such-slot"]) {
      const { opened, closed } = await workspacesOpenedBy(() => MUSAI_RESOURCES.read(session, uri));
      expect([uri, opened.length > 0]).toEqual([uri, true]);
      for (const held of opened) {
        expect(closed).toContain(held);
      }
    }
  });

  test("a URI naming no known shape refuses with a closed reason", async () => {
    const error = await read("mystery://nothing").catch((caught: unknown) => caught);
    expect((error as { data: { reason: string } }).data.reason).toBe("no-such-record");
  });
});
