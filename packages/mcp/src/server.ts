import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  applyContributedOperation,
  assertHeadUnmovedFor,
  clearanceNamedBy,
  clockFromEnvironment,
  closingWorkspaces,
  type Distribution,
  type DraftAdmission,
  type Event,
  type EventsSinceResult,
  eventsSince,
  headCursor,
  installedManifests,
  invokeContribution,
  type JsonSchema,
  type OperationContext,
  type OperationDescriptor,
  OperationError,
  openWorkspace,
  operationsUnderClearance,
  principalNameFromEnvironment,
  runHandler,
  type SubscriptionTrace,
  validateAgainstSchema,
  type Workspace,
  type WorkspaceRefusal,
} from "@musai/api-core";
import type { EnvelopeError, OperationPlan } from "@musai/modules";
import {
  canonicalBytes,
  exitCodeForClass,
  isKernelError,
  isOperationContribution,
  type KernelError,
  type OperationContributionEntry,
  type Reason,
} from "@musai/records";
import { MUSAI_DIR, Store } from "@musai/store";
import { appendCall, type CallLog, type CallLogRequest, type CallLogResponse, openCallLog } from "./call-log.js";
import {
  type McpDistribution,
  type McpExtensionServer,
  type McpExtensionTool,
  type McpResourceSession,
  type McpToolSession,
  registerResourceHandlers,
} from "./extension.js";
import {
  manifestContributionProjections,
  type ProjectedContribution,
  toolNameFor,
  toolsFromManifests,
  toolsFromRegistry,
} from "./project.js";
import { registerPromptHandlers } from "./prompts.js";
import { refusalCrossingAsRpcError, refusalText } from "./refusal.js";

/** Stripped before validation, since no operation's input schema admits them. */
function splitEnvelopeFields(args: Record<string, unknown>): {
  readonly operationArgs: Record<string, unknown>;
  readonly plan: boolean;
  readonly expectHead: string | undefined;
} {
  const { plan, expectHead, ...operationArgs } = args;
  return {
    operationArgs,
    plan: plan === true,
    expectHead: typeof expectHead === "string" ? expectHead : undefined,
  };
}

function refusalToLogResponse(error: KernelError): CallLogResponse {
  return { ok: false, error: { code: error.reason, data: { about: error.about }, message: error.detail } };
}

/** Carries no `structuredContent`, which a client validates against the output schema even on an
 * error result. */
function refusalResult(error: KernelError): CallToolResult {
  return { isError: true, content: [{ type: "text", text: refusalText(error) }] };
}

/** No entry was found to name a kind and a version of its own. */
function unresolvedCallRequest(toolName: string, args: Record<string, unknown>): CallLogRequest {
  return { contribution: "operation", id: toolName, version: "0", input: args };
}

/** An extension tool is neither a distribution verb nor a manifest contribution, so it logs under
 * a contribution kind of its own at version `"0"`. */
function extensionCallRequest(toolName: string, args: Record<string, unknown>): CallLogRequest {
  return { contribution: "extension", id: toolName, version: "0", input: args };
}

function extensionResultToLogResponse(result: CallToolResult): CallLogResponse {
  if (result.isError === true) {
    return {
      ok: false,
      error: { code: "tool-error", data: result.content, message: "the tool answered an error result" },
    };
  }
  return { ok: true, output: result.structuredContent ?? result.content, diagnostics: [] };
}

/** Each tool whose input schema the validator cannot compile, by name, with why. */
function uncompilableToolSchemas(tools: readonly McpExtensionTool[]): ReadonlyMap<string, string> {
  const uncompilable = new Map<string, string>();
  for (const { tool } of tools) {
    try {
      validateAgainstSchema(tool.inputSchema as JsonSchema, null);
    } catch (error) {
      uncompilable.set(tool.name, error instanceof Error ? error.message : String(error));
    }
  }
  return uncompilable;
}

/** Validates against the tool's own input schema before its handler runs, and logs the call as
 * every projected tool's is. */
async function callExtensionTool(
  extensionTool: McpExtensionTool,
  session: McpToolSession,
  args: Record<string, unknown>,
  log: CallLog,
  uncompilable: ReadonlyMap<string, string>,
): Promise<CallToolResult> {
  const request = extensionCallRequest(extensionTool.tool.name, args);
  try {
    const why = uncompilable.get(extensionTool.tool.name);
    if (why !== undefined) {
      throw new OperationError({
        reason: "tool-unavailable",
        about: [extensionTool.tool.name],
        detail: `its input schema does not compile: ${why}`,
      });
    }
    const validation = validateAgainstSchema(extensionTool.tool.inputSchema as JsonSchema, args);
    if (!validation.ok) {
      throw new OperationError({
        reason: "invalid-input",
        about: [extensionTool.tool.name],
        detail: validation.errors,
      });
    }
    const result = await extensionTool.call(session, args);
    await appendCall(log, session.context.workspace, request, extensionResultToLogResponse(result));
    return result;
  } catch (error) {
    if (isKernelError(error)) {
      await appendCall(log, session.context.workspace, request, refusalToLogResponse(error));
    }
    throw error;
  }
}

/** A subscription is invoked by the kernel at an event, which its row names as its input. */
function subscriptionCallRequest(trace: SubscriptionTrace): CallLogRequest {
  return { contribution: "subscription", id: trace.subscription, version: trace.version, input: trace.event };
}

/** A file the fold left out of the index is no call's own, so it logs as a contribution kind of its
 * own, named by the file's path. */
function foldRefusalRequest(refusal: WorkspaceRefusal): CallLogRequest {
  return { contribution: "fold", id: refusal.path, version: "0", input: { commit: refusal.commit, id: refusal.id } };
}

/** A refusal on the way is logged under the name as sent, since no contribution is known yet. */
async function resolveContributionTool(
  context: OperationContext,
  toolName: string,
  args: Record<string, unknown>,
  log: CallLog | undefined,
): Promise<{ readonly opened: Workspace; readonly projected: ProjectedContribution }> {
  try {
    const opened = await openWorkspace(context);
    const manifests = await installedManifests(opened);
    const projected = manifestContributionProjections(manifests).find((candidate) => candidate.tool.name === toolName);
    if (projected === undefined) {
      throw new OperationError({ reason: "unknown-operation", about: [toolName], detail: `no tool named ${toolName}` });
    }
    return { opened, projected };
  } catch (error) {
    if (log !== undefined && isKernelError(error)) {
      await appendCall(log, context.workspace, unresolvedCallRequest(toolName, args), refusalToLogResponse(error));
    }
    throw error;
  }
}

async function callContributionTool(
  context: OperationContext,
  opened: Workspace,
  projected: ProjectedContribution,
  args: Record<string, unknown>,
  log: CallLog | undefined,
  admitDrafts: DraftAdmission,
): Promise<CallToolResult> {
  const toolName = projected.tool.name;
  if (isOperationContribution(projected.entry)) {
    return callContributedOperation(context, opened, projected, projected.entry, args, log, admitDrafts);
  }
  const request = {
    contribution: projected.entry.kind,
    id: projected.entry.id,
    version: projected.entry.version,
    input: args,
  };
  let envelopeRefusal: EnvelopeError | undefined;
  try {
    const inputValidation = validateAgainstSchema(projected.entry.input as JsonSchema, args);
    if (!inputValidation.ok) {
      throw new OperationError({ reason: "invalid-input", about: [toolName], detail: inputValidation.errors });
    }
    const response = await invokeContribution(opened, projected.moduleName, projected.entry, args);
    if (!response.ok) {
      envelopeRefusal = response.error;
      throw new OperationError({
        reason: "no-such-record",
        about: [toolName],
        detail: `${toolName} refused: ${JSON.stringify(response.error)}`,
      });
    }
    const outputValidation = validateAgainstSchema(projected.entry.output as JsonSchema, response.output);
    if (!outputValidation.ok) {
      throw new OperationError({ reason: "invalid-output", about: [toolName], detail: outputValidation.errors });
    }
    if (log !== undefined) {
      await appendCall(log, context.workspace, request, {
        ok: true,
        output: response.output,
        diagnostics: response.diagnostics,
      });
    }
    return {
      content: [{ type: "text", text: new TextDecoder().decode(canonicalBytes(response.output)) }],
      structuredContent: response.output as Record<string, unknown>,
    };
  } catch (error) {
    if (log !== undefined && isKernelError(error)) {
      await appendCall(
        log,
        context.workspace,
        request,
        envelopeRefusal === undefined ? refusalToLogResponse(error) : { ok: false, error: envelopeRefusal },
      );
    }
    throw error;
  }
}

/** Any refusal but the boundary's own two names something the workspace could not answer with. */
function reasonForEnvelopeRefusal(error: EnvelopeError): Reason {
  return error.code === "invalid-input" || error.code === "invalid-output" ? error.code : "no-such-record";
}

/** Hands the plan to `applyContributedOperation` whole, so the order of the gates is the kernel's
 * and not this surface's to get right. */
async function callContributedOperation(
  context: OperationContext,
  opened: Workspace,
  projected: ProjectedContribution,
  entry: OperationContributionEntry,
  args: Record<string, unknown>,
  log: CallLog | undefined,
  admitDrafts: DraftAdmission,
): Promise<CallToolResult> {
  const { operationArgs, plan, expectHead } = splitEnvelopeFields(args);
  const request = { contribution: entry.kind, id: entry.id, version: entry.version, input: operationArgs };
  const callContext: OperationContext = {
    ...context,
    mode: plan ? "plan" : context.mode,
    expectHead: expectHead ?? context.expectHead,
  };
  let envelopeRefusal: EnvelopeError | undefined;
  try {
    await assertHeadUnmovedFor(entry.effect, callContext);
    const inputValidation = validateAgainstSchema(entry.input as JsonSchema, operationArgs);
    if (!inputValidation.ok) {
      throw new OperationError({
        reason: "invalid-input",
        about: [projected.tool.name],
        detail: inputValidation.errors,
      });
    }
    const response = await invokeContribution(opened, projected.moduleName, entry, operationArgs);
    if (!response.ok) {
      envelopeRefusal = response.error;
      throw new OperationError({
        reason: reasonForEnvelopeRefusal(response.error),
        about: [projected.tool.name],
        detail: `${projected.tool.name} refused: ${JSON.stringify(response.error)}`,
      });
    }
    const { id, version, effect, authority } = entry;
    const applied = await applyContributedOperation(
      response.output as OperationPlan,
      { id, version, effect, authority },
      opened,
      callContext,
      admitDrafts,
    );
    if (log !== undefined) {
      await appendCall(log, context.workspace, request, {
        ok: true,
        output: applied,
        diagnostics: response.diagnostics,
      });
    }
    return {
      content: [{ type: "text", text: new TextDecoder().decode(canonicalBytes(applied)) }],
      structuredContent: applied as unknown as Record<string, unknown>,
    };
  } catch (error) {
    if (log !== undefined && isKernelError(error)) {
      await appendCall(
        log,
        context.workspace,
        request,
        envelopeRefusal === undefined ? refusalToLogResponse(error) : { ok: false, error: envelopeRefusal },
      );
    }
    throw error;
  }
}

/** Throws a refusal, logged first; the `tools/call` handler answers it as an error result, so a
 * test can drive this with no transport. */
export async function callTool(
  distribution: Distribution,
  context: OperationContext,
  toolName: string,
  args: Record<string, unknown>,
  log?: CallLog,
): Promise<CallToolResult> {
  let descriptor: OperationDescriptor | undefined;
  for (const candidate of distribution.registry.values()) {
    if (toolNameFor(candidate) === toolName) {
      descriptor = candidate;
      break;
    }
  }
  if (descriptor !== undefined) {
    const { operationArgs, plan, expectHead } = splitEnvelopeFields(args);
    const request = {
      contribution: "operation",
      id: descriptor.id,
      version: String(descriptor.version),
      input: operationArgs,
    };
    try {
      const output = await runHandler(descriptor, operationArgs, {
        ...context,
        mode: plan ? "plan" : context.mode,
        expectHead: expectHead ?? context.expectHead,
      });
      if (log !== undefined) {
        await appendCall(log, context.workspace, request, { ok: true, output, diagnostics: [] });
      }
      return {
        content: [{ type: "text", text: new TextDecoder().decode(canonicalBytes(output)) }],
        structuredContent: output as Record<string, unknown>,
      };
    } catch (error) {
      if (log !== undefined && isKernelError(error)) {
        await appendCall(log, context.workspace, request, refusalToLogResponse(error));
      }
      throw error;
    }
  }

  const { opened, projected } = await resolveContributionTool(context, toolName, args, log);
  return callContributionTool(context, opened, projected, args, log, distribution.admitDrafts);
}

/** Re-reads the installed set on every call, so a module installed mid-session lists at once. A
 * session outside `lab` lists the distribution's public operations alone. */
async function exposedTools(
  distribution: McpDistribution,
  lab: boolean,
  extensionTools: readonly McpExtensionTool[],
  context: OperationContext,
): Promise<Tool[]> {
  const offered = distribution.publicOperations;
  const registry = operationsUnderClearance(distribution.registry, context.clearance);
  if (!lab && offered !== undefined) {
    return toolsFromRegistry(new Map([...registry].filter(([key]) => offered.has(key))));
  }
  const opened = await openWorkspace(context);
  const manifests = await installedManifests(opened);
  const merged = [...toolsFromRegistry(registry), ...toolsFromManifests(distribution.registry, manifests)];
  const laidOver = merged.map(
    (tool) => extensionTools.find((extension) => extension.tool.name === tool.name)?.tool ?? tool,
  );
  // An extension standing in for an operation the clearance withholds is withheld with it.
  const withheld = [...distribution.registry]
    .filter(([key]) => !registry.has(key))
    .map(([, descriptor]) => toolNameFor(descriptor));
  const joining = extensionTools
    .filter((extension) => !merged.some((tool) => tool.name === extension.tool.name))
    .filter((extension) => !withheld.includes(extension.tool.name))
    .map((extension) => extension.tool);
  return [...laidOver, ...joining];
}

/** Only the two module kinds add or replace a manifest to project from. */
function changesWhatAManifestProjects(events: readonly Event[]): boolean {
  return events.some((event) => event.kind === "module.installed" || event.kind === "pin.changed");
}

/** The scope's ref is read before any fold is opened, since opening would make an empty fold of a
 * dropped name. */
async function scopeHoldsRef(context: OperationContext): Promise<boolean> {
  const store = new Store({
    ctx: { gitDir: join(context.workspace, MUSAI_DIR) },
    scope: context.scope,
    now: context.now,
  });
  return (await store.tip()) !== null;
}

function droppedScopeRefusal(context: OperationContext): OperationError {
  return new OperationError({
    reason: "workspace-incomplete",
    about: [context.scope],
    detail: `scope ${context.scope} was dropped after this session read it: fork it again to carry on here, or restart the server on another scope`,
  });
}

/** Notifies every list the server has a capability for, since a manifest can add to any of them;
 * the SDK refuses a notification for an undeclared capability. */
export async function checkForListChanges(
  server: Server,
  context: OperationContext,
  cursor: string | undefined,
  mountsResources: boolean,
): Promise<string> {
  const opened = await openWorkspace(context);
  let read: EventsSinceResult;
  let withdrawn = false;
  try {
    read = await eventsSince(opened, cursor);
  } catch (error) {
    // A seal can take the cursor's commit out of a cleared fold, and what it lists with it.
    if (!isKernelError(error) || error.reason !== "stale") {
      throw error;
    }
    read = { events: [], cursor: headCursor(opened) };
    withdrawn = true;
  }
  if (withdrawn || changesWhatAManifestProjects(read.events)) {
    await server.sendToolListChanged();
    if (mountsResources) {
      await server.sendResourceListChanged();
    }
    await server.sendPromptListChanged();
  }
  return read.cursor;
}

/** Channel `model`, since a relayed answer is the delegate's. A client names itself, so its
 * handshake name never stands for a principal. */
function plainCallContext(context: OperationContext): OperationContext {
  return { ...context, via: "model", ...principalNameFromEnvironment() };
}

/** Holds no reference a cast could reach the server or its handshake through. */
function extensionServerOf(server: Server): McpExtensionServer {
  const surface: McpExtensionServer = {
    elicitInput: (params, options) => server.elicitInput(params, options),
    getClientCapabilities: () => structuredClone(server.getClientCapabilities()),
    getClientVersion: () => structuredClone(server.getClientVersion()),
  };
  return Object.freeze(surface);
}

/** Built on the SDK's low-level `Server`, not `McpServer`, so tool schemas stay the registry's JSON
 * Schema rather than a hand-kept Zod copy. */
export function createMcpServer(
  distribution: McpDistribution,
  given: OperationContext,
  options: { readonly lab: boolean },
): Server {
  // Opened on the first call; a second session opens a second file.
  let logPromise: Promise<CallLog> | undefined;
  function sessionLog(): Promise<CallLog> {
    logPromise ??= openCallLog(given.workspace);
    return logPromise;
  }

  // Every open of the workspace reports its refusals again, so each is logged once per session.
  const loggedFoldRefusals = new Set<string>();
  const context: OperationContext = {
    ...given,
    reportRefusal: async (refusal) => {
      await given.reportRefusal?.(refusal);
      const key = `${refusal.commit}:${refusal.path}`;
      if (loggedFoldRefusals.has(key)) {
        return;
      }
      loggedFoldRefusals.add(key);
      try {
        await appendCall(await sessionLog(), given.workspace, foldRefusalRequest(refusal), {
          ok: false,
          error: { code: "fold-refused", data: null, message: refusal.reason },
        });
      } catch (error) {
        // A row that was not written is tried again at the next open.
        loggedFoldRefusals.delete(key);
        throw error;
      }
    },
    reportSubscription: async (trace) => {
      await given.reportSubscription?.(trace);
      const request = subscriptionCallRequest(trace);
      await appendCall(await sessionLog(), given.workspace, request, { ok: false, error: trace.error });
    },
  };
  const extensionTools = distribution.extensions?.mcp?.tools ?? [];
  const uncompilable = uncompilableToolSchemas(extensionTools);
  const resources = distribution.extensions?.mcp?.resources;
  const server = new Server(
    { name: distribution.name, version: distribution.version },
    { capabilities: { tools: {}, ...(resources === undefined ? {} : { resources: {} }), prompts: {} } },
  );
  const resourceSession: McpResourceSession = Object.freeze({ distribution, context });
  const toolSession: McpToolSession = Object.freeze({ ...resourceSession, server: extensionServerOf(server) });

  // Unset until the first check, which reads from the start, so a fresh session notifies once.
  let cursor: string | undefined;
  // Set once any handler finds the scope's ref held; the ref's absence after it is a drop.
  let scopeSeen = false;

  /** Throws while the scope is gone, leaving the cursor where it was, so a remade scope reads on
   * from it, or as stale where its history no longer holds it. */
  async function refuseIfDropped(): Promise<void> {
    if (await scopeHoldsRef(context)) {
      scopeSeen = true;
    } else if (scopeSeen) {
      throw droppedScopeRefusal(context);
    }
  }

  async function checkListChanges(): Promise<void> {
    cursor = await checkForListChanges(server, context, cursor, resources !== undefined);
  }

  server.setRequestHandler(ListToolsRequestSchema, () =>
    closingWorkspaces(() =>
      refusalCrossingAsRpcError(async () => {
        await refuseIfDropped();
        await checkListChanges();
        return { tools: await exposedTools(distribution, options.lab, extensionTools, context) };
      }),
    ),
  );

  server.setRequestHandler(CallToolRequestSchema, (request) =>
    closingWorkspaces(async () => {
      const args = request.params.arguments ?? {};
      try {
        await refuseIfDropped();
      } catch (error) {
        if (!isKernelError(error)) {
          throw error;
        }
        await appendCall(
          await sessionLog(),
          context.workspace,
          unresolvedCallRequest(request.params.name, args),
          refusalToLogResponse(error),
        );
        return refusalResult(error);
      }
      // A refusal from the list-change check concerns the session, so it stays a JSON-RPC error.
      await checkListChanges();
      try {
        const extensionTool = extensionTools.find((extension) => extension.tool.name === request.params.name);
        const log = await sessionLog();
        if (extensionTool !== undefined) {
          return await callExtensionTool(extensionTool, toolSession, args, log, uncompilable);
        }
        return await callTool(distribution, plainCallContext(context), request.params.name, args, log);
      } catch (error) {
        // MCP gives a failed call a result of its own; a throw that is no refusal is a defect.
        if (isKernelError(error)) {
          return refusalResult(error);
        }
        throw error;
      }
    }),
  );

  if (resources !== undefined) {
    registerResourceHandlers(server, resources, resourceSession, refuseIfDropped);
  }
  registerPromptHandlers(server, context, refuseIfDropped);

  return server;
}

export async function serveStdio(server: Server): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/** Every flag this server reads, and whether it takes a value. */
const SERVER_FLAGS: ReadonlyMap<string, boolean> = new Map([
  ["--workspace", true],
  ["--scope", true],
  ["--clearance", true],
  ["--lab", false],
]);

/** A flag deciding what a station sees must never fail open on its spelling, so an argument this
 * server does not read stops the launch. */
function refuseUnreadArguments(args: readonly string[]): void {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const takesValue = SERVER_FLAGS.get(arg);
    if (takesValue === true) {
      index += 1;
    } else if (takesValue === undefined && !arg.startsWith("--clearance=")) {
      throw new OperationError({
        reason: "invalid-input",
        about: [arg],
        detail: `${arg} is no argument this server reads: it reads ${[...SERVER_FLAGS.keys()].join(", ")}`,
      });
    }
  }
}

/** The CLI reads its clearance from `MUSAI_CLEARANCE`; a launcher setting it for this server
 * would otherwise serve every record. */
function refuseClearanceFromEnvironment(clearance: string | undefined): void {
  if (clearance === undefined && process.env["MUSAI_CLEARANCE"] !== undefined) {
    throw new OperationError({
      reason: "invalid-input",
      about: ["MUSAI_CLEARANCE"],
      detail:
        "MUSAI_CLEARANCE is set, and this server reads its clearance from --clearance alone: pass --clearance <audience>, or unset it to serve every record",
    });
  }
}

function flagValue(args: readonly string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index === -1 || index === args.length - 1 ? fallback : args[index + 1]!;
}

/** Every spelling of `--clearance`, its value or `""` where it has none, so a clearance spelled any
 * way is read and none is dropped. */
function clearanceFlag(args: readonly string[]): string | undefined {
  const given = args.flatMap((arg, index) => {
    if (arg === "--clearance") {
      return [args[index + 1] ?? ""];
    }
    return arg.startsWith("--clearance=") ? [arg.slice("--clearance=".length)] : [];
  });
  if (given.length > 1) {
    throw new OperationError({
      reason: "invalid-input",
      about: ["--clearance"],
      detail: `--clearance is given ${given.length} times: name the one audience this server is cleared to`,
    });
  }
  return given[0];
}

/** `args` are the arguments after the script's own path. */
export async function runMcpServer(distribution: McpDistribution, args: readonly string[]): Promise<void> {
  const workspace = flagValue(args, "--workspace", process.cwd());
  const scope = flagValue(args, "--scope", "default");

  // A refused argument, MUSAI_NOW or clearance exits before serving; exitCode lets stderr drain.
  let context: OperationContext | undefined;
  try {
    refuseUnreadArguments(args);
    const named = clearanceFlag(args);
    refuseClearanceFromEnvironment(named);
    const clearance = clearanceNamedBy("--clearance", named);
    context = { workspace, scope, now: clockFromEnvironment(), clearance };
    if (context.clearance !== undefined) {
      (await openWorkspace(context)).close();
    }
  } catch (error) {
    if (!isKernelError(error)) {
      throw error;
    }
    process.stderr.write(`${error.message}\n`);
    process.exitCode = exitCodeForClass(error.code);
    return;
  }

  const server = createMcpServer(distribution, context, { lab: args.includes("--lab") });
  await serveStdio(server);
}
