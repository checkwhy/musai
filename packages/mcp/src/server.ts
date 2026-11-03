import { AsyncLocalStorage } from "node:async_hooks";
import { access } from "node:fs/promises";
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
  offeredUnderClearance,
  openWorkspace,
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
import {
  appendCall,
  type CallLog,
  type CallLogRequest,
  type CallLogResponse,
  type CallLogSource,
  logCall,
  noWorkspaceAt,
  openCallLog,
} from "./call-log.js";
import {
  type McpDistribution,
  type McpExtensionServer,
  type McpExtensionTool,
  type McpResourceSession,
  type McpToolSession,
  registerResourceHandlers,
} from "./extension.js";
import {
  contributionProjections,
  DuplicateToolNameError,
  operationProjections,
  operationTool,
  type ProjectedContribution,
  type ToolNameCollision,
} from "./project.js";
import { registerPromptHandlers } from "./prompts.js";
import { noWorkspaceRefusal, type ReadGuard, refusalCrossingAsRpcError, refusalText } from "./refusal.js";

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
  log: CallLogSource,
): Promise<CallToolResult> {
  const request = extensionCallRequest(extensionTool.tool.name, args);
  try {
    const validation = validateAgainstSchema(extensionTool.tool.inputSchema as JsonSchema, args);
    if (!validation.ok) {
      throw new OperationError({
        reason: "invalid-input",
        about: [extensionTool.tool.name],
        detail: validation.errors,
      });
    }
    const result = await extensionTool.call(session, args);
    await logCall(log, session.context.workspace, request, extensionResultToLogResponse(result));
    return result;
  } catch (error) {
    if (isKernelError(error)) {
      await logCall(log, session.context.workspace, request, refusalToLogResponse(error));
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

interface OperationTarget {
  readonly kind: "operation";
  readonly tool: Tool;
  readonly descriptor: OperationDescriptor;
}

interface ContributionTarget {
  readonly kind: "contribution";
  readonly tool: Tool;
  readonly projected: ProjectedContribution;
  readonly opened: Workspace;
}

/** Carries the session it runs under, so a call by the name needs nothing but the map. */
interface ExtensionTarget {
  readonly kind: "extension";
  readonly tool: Tool;
  readonly extension: McpExtensionTool;
  readonly session: McpToolSession;
}

/** A name the session leaves out of its listing, answered with a refusal saying why. */
interface WithheldTarget {
  readonly kind: "withheld";
  readonly refusal: OperationError;
  loggedAs(args: Record<string, unknown>): CallLogRequest;
}

/** Unlisted, and dispatched through the kernel's own gate, so a call is refused in the order and
 * with the refusal the API gives it. */
interface ClearedOutTarget {
  readonly kind: "cleared-out";
  readonly descriptor: OperationDescriptor;
  readonly refusal: OperationError;
}

type DistributionTarget = OperationTarget | ClearedOutTarget | ContributionTarget | WithheldTarget;

type ToolTarget = DistributionTarget | ExtensionTarget;

/** Built once per session; the contributions an install can change mid-session join it per
 * request, after `operations` and before `joining`, the names an extension holds alone. */
interface SessionTools<T extends ToolTarget> {
  readonly operations: ReadonlyMap<string, T>;
  readonly joining: ReadonlyMap<string, T>;
  readonly projectsContributions: boolean;
  /** Why each extension the session leaves out of `operations` and `joining` is left out. */
  readonly leftOut: ReadonlyMap<string, string>;
  reportCollision(collision: ToolNameCollision, refusal: OperationError): Promise<void>;
}

function operationCallRequest(descriptor: OperationDescriptor, input: Record<string, unknown>): CallLogRequest {
  return { contribution: "operation", id: descriptor.id, version: String(descriptor.version), input };
}

function operationTarget(descriptor: OperationDescriptor, context: OperationContext): DistributionTarget {
  const offered = offeredUnderClearance(descriptor, context.clearance);
  if (offered instanceof OperationError) {
    return { kind: "cleared-out", descriptor, refusal: offered };
  }
  return { kind: "operation", tool: operationTool(offered), descriptor };
}

/** Where `offered` names the operations a session offers, no contribution projects. */
function distributionTools(
  distribution: Distribution,
  context: OperationContext,
  offered: ReadonlySet<string> | undefined,
  reportCollision: SessionTools<DistributionTarget>["reportCollision"] = async () => {},
): SessionTools<DistributionTarget> {
  const operations = new Map<string, DistributionTarget>();
  for (const [name, { key, descriptor }] of operationProjections(distribution.registry)) {
    if (offered === undefined || offered.has(key)) {
      operations.set(name, operationTarget(descriptor, context));
    }
  }
  return {
    operations,
    joining: new Map(),
    projectsContributions: offered === undefined,
    leftOut: new Map(),
    reportCollision,
  };
}

/** The extension tools a session mounts, by name, with why each whose input schema does not
 * compile is withheld. */
interface SessionExtensions {
  readonly tools: ReadonlyMap<string, McpExtensionTool>;
  readonly uncompilable: ReadonlyMap<string, string>;
}

function sessionExtensions(tools: readonly McpExtensionTool[]): SessionExtensions {
  const byName = new Map<string, McpExtensionTool>();
  for (const [index, extension] of tools.entries()) {
    const name = extension.tool.name;
    const first = tools.findIndex((other) => other.tool.name === name);
    if (first !== index) {
      throw new DuplicateToolNameError(name, `the extension tool at ${first}`, `the one at ${index}`);
    }
    byName.set(name, extension);
  }
  return { tools: byName, uncompilable: uncompilableToolSchemas(tools) };
}

function uncompilableTarget(name: string, why: string): WithheldTarget {
  return {
    kind: "withheld",
    refusal: new OperationError({
      reason: "unknown-operation",
      about: [name],
      detail: `this server offers no tool named ${name}: its input schema does not compile: ${why}`,
    }),
    loggedAs: (args) => extensionCallRequest(name, args),
  };
}

/** An extension stands in the place of a target of its name, never of one the session withholds,
 * and adds a name of its own only where contributions project. */
function sessionTools(
  distribution: McpDistribution,
  context: OperationContext,
  lab: boolean,
  extensions: SessionExtensions,
  session: McpToolSession,
  reportCollision: SessionTools<ToolTarget>["reportCollision"],
): SessionTools<ToolTarget> {
  const offered = lab ? undefined : distribution.publicOperations;
  const base = distributionTools(distribution, context, offered, reportCollision);
  const operations = new Map<string, ToolTarget>(base.operations);
  const joining = new Map<string, ToolTarget>();
  const leftOut = new Map<string, string>();
  for (const [name, extension] of extensions.tools) {
    const standsOver = operations.get(name);
    if (standsOver?.kind === "cleared-out") {
      leftOut.set(name, `it stands over ${name}, which this session withholds: ${standsOver.refusal.detail}`);
      continue;
    }
    if (standsOver === undefined && !base.projectsContributions) {
      leftOut.set(name, `this session offers no operation named ${name} for it to stand over`);
      continue;
    }
    const why = extensions.uncompilable.get(name);
    const target =
      why === undefined
        ? { kind: "extension" as const, tool: extension.tool, extension, session }
        : uncompilableTarget(name, why);
    (standsOver === undefined ? joining : operations).set(name, target);
  }
  return { ...base, operations, joining, leftOut };
}

function collisionRefusal({ name, claimants }: ToolNameCollision): OperationError {
  return new OperationError({
    reason: "declaration-conflict",
    about: [name, ...claimants],
    detail: `this server offers no contribution named ${name}: ${claimants.join(" and ")} each project to it`,
  });
}

/** Every other verb reads or writes a workspace, and would run unlogged before one stands. */
function workspaceMakers<T extends ToolTarget>(operations: ReadonlyMap<string, T>): ReadonlyMap<string, T> {
  return new Map(
    [...operations].filter(([, target]) => "descriptor" in target && target.descriptor.makesWorkspace === true),
  );
}

/** Every name the session answers, in listing order, the installed set read afresh. */
async function allTargets<T extends ToolTarget>(
  tools: SessionTools<T>,
  distribution: Distribution,
  context: OperationContext,
): Promise<ReadonlyMap<string, T | ContributionTarget | WithheldTarget>> {
  if (await noWorkspaceAt(context.workspace)) {
    return workspaceMakers(tools.operations);
  }
  const targets = new Map<string, T | ContributionTarget | WithheldTarget>(tools.operations);
  if (tools.projectsContributions) {
    const opened = await openWorkspace(context);
    const { projected, collisions } = contributionProjections(distribution.registry, await installedManifests(opened));
    for (const contribution of projected) {
      const name = contribution.tool.name;
      const target = { kind: "contribution" as const, tool: contribution.tool, projected: contribution, opened };
      targets.set(name, tools.joining.get(name) ?? target);
    }
    for (const collision of collisions) {
      const refusal = collisionRefusal(collision);
      await tools.reportCollision(collision, refusal);
      // The operation of the name keeps it; a name contributions alone claim answers the refusal.
      if (!targets.has(collision.name)) {
        const withheld: WithheldTarget = {
          kind: "withheld",
          refusal,
          loggedAs: (args) => unresolvedCallRequest(collision.name, args),
        };
        targets.set(collision.name, tools.joining.get(collision.name) ?? withheld);
      }
    }
  }
  for (const [name, target] of tools.joining) {
    targets.set(name, target);
  }
  return targets;
}

/** Reads the installed set only for a name no operation or extension holds, since a contribution
 * can claim no other. */
async function targetNamed<T extends ToolTarget>(
  tools: SessionTools<T>,
  distribution: Distribution,
  context: OperationContext,
  name: string,
): Promise<T | ContributionTarget | WithheldTarget | undefined> {
  if (await noWorkspaceAt(context.workspace)) {
    const makers = workspaceMakers(tools.operations);
    const maker = makers.get(name);
    if (maker === undefined) {
      throw noWorkspaceRefusal("unknown-operation", name, context.workspace, [...makers.keys()]);
    }
    return maker;
  }
  const held = tools.operations.get(name) ?? tools.joining.get(name);
  if (held !== undefined || !tools.projectsContributions) {
    return held;
  }
  return (await allTargets(tools, distribution, context)).get(name);
}

function listedTools(targets: ReadonlyMap<string, ToolTarget>): Tool[] {
  return [...targets.values()].flatMap((target) => ("tool" in target ? [target.tool] : []));
}

/** A refusal on the way is logged under the name as sent, since no target is known yet. */
async function resolveTarget<T>(
  found: () => Promise<T | undefined>,
  context: OperationContext,
  toolName: string,
  args: Record<string, unknown>,
  log: CallLogSource,
): Promise<T> {
  try {
    const target = await found();
    if (target === undefined) {
      throw new OperationError({ reason: "unknown-operation", about: [toolName], detail: `no tool named ${toolName}` });
    }
    return target;
  } catch (error) {
    if (isKernelError(error)) {
      await logCall(log, context.workspace, unresolvedCallRequest(toolName, args), refusalToLogResponse(error));
    }
    throw error;
  }
}

async function callTarget(
  target: ToolTarget,
  distribution: Distribution,
  context: OperationContext,
  args: Record<string, unknown>,
  log: CallLogSource,
): Promise<CallToolResult> {
  switch (target.kind) {
    case "withheld":
      await logCall(log, context.workspace, target.loggedAs(args), refusalToLogResponse(target.refusal));
      throw target.refusal;
    case "operation":
    case "cleared-out":
      return callOperation(target.descriptor, context, args, log);
    case "contribution":
      return callContributionTool(context, target.opened, target.projected, args, log, distribution.admitDrafts);
    case "extension":
      return callExtensionTool(target.extension, target.session, args, log);
  }
}

async function callContributionTool(
  context: OperationContext,
  opened: Workspace,
  projected: ProjectedContribution,
  args: Record<string, unknown>,
  log: CallLogSource,
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
    await logCall(log, context.workspace, request, {
      ok: true,
      output: response.output,
      diagnostics: response.diagnostics,
    });
    return {
      content: [{ type: "text", text: new TextDecoder().decode(canonicalBytes(response.output)) }],
      structuredContent: response.output as Record<string, unknown>,
    };
  } catch (error) {
    if (isKernelError(error)) {
      await logCall(
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
  log: CallLogSource,
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
    await logCall(log, context.workspace, request, {
      ok: true,
      output: applied,
      diagnostics: response.diagnostics,
    });
    return {
      content: [{ type: "text", text: new TextDecoder().decode(canonicalBytes(applied)) }],
      structuredContent: applied as unknown as Record<string, unknown>,
    };
  } catch (error) {
    if (isKernelError(error)) {
      await logCall(
        log,
        context.workspace,
        request,
        envelopeRefusal === undefined ? refusalToLogResponse(error) : { ok: false, error: envelopeRefusal },
      );
    }
    throw error;
  }
}

async function callOperation(
  descriptor: OperationDescriptor,
  context: OperationContext,
  args: Record<string, unknown>,
  log: CallLogSource,
): Promise<CallToolResult> {
  const { operationArgs, plan, expectHead } = splitEnvelopeFields(args);
  const request = operationCallRequest(descriptor, operationArgs);
  try {
    const output = await runHandler(descriptor, operationArgs, {
      ...context,
      mode: plan ? "plan" : context.mode,
      expectHead: expectHead ?? context.expectHead,
    });
    await logCall(log, context.workspace, request, { ok: true, output, diagnostics: [] });
    return {
      content: [{ type: "text", text: new TextDecoder().decode(canonicalBytes(output)) }],
      structuredContent: output as Record<string, unknown>,
    };
  } catch (error) {
    if (isKernelError(error)) {
      await logCall(log, context.workspace, request, refusalToLogResponse(error));
    }
    throw error;
  }
}

/** The one dispatch of `tools/call`, through the session's map, or with none through a `lab`
 * map of the distribution alone; throws a refusal, logged first. */
export function callTool(
  distribution: Distribution,
  context: OperationContext,
  toolName: string,
  args: Record<string, unknown>,
  log: CallLogSource = async () => undefined,
  tools: SessionTools<ToolTarget> = distributionTools(distribution, context, undefined),
): Promise<CallToolResult> {
  return closingWorkspaces(async () => {
    const found = () => targetNamed(tools, distribution, context, toolName);
    const target = await resolveTarget(found, context, toolName, args, log);
    return callTarget(target, distribution, context, args, log);
  });
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
): Promise<string | undefined> {
  // Left unset, the first check after `init` reads from the start and notifies what it installed.
  if (await noWorkspaceAt(context.workspace)) {
    return cursor;
  }
  using opened = await openWorkspace(context);
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

/** What a session keeps for the one log a workspace holds, each once-per-session row once per
 * log; opened when the session first sees the workspace stand, so each session has its own file. */
interface SessionLogState {
  log: Promise<CallLog> | undefined;
  readonly foldRefusals: Set<string>;
  readonly collisions: Set<string>;
  withholdingLogged: boolean;
}

function freshLogState(): SessionLogState {
  return { log: undefined, foldRefusals: new Set(), collisions: new Set(), withholdingLogged: false };
}

/** The log a state opened is its workspace's identity: its name is random, so a workspace made
 * again at the path holds none; a state that opened no log is bound to no workspace yet. */
async function holdsLogOf(state: SessionLogState): Promise<boolean> {
  const log = await state.log?.catch(() => undefined);
  return (
    log === undefined ||
    access(log.path).then(
      () => true,
      () => false,
    )
  );
}

/** Built on the SDK's low-level `Server`, not `McpServer`, so tool schemas stay the registry's JSON
 * Schema rather than a hand-kept Zod copy. */
export function createMcpServer(
  distribution: McpDistribution,
  given: OperationContext,
  options: { readonly lab: boolean },
): Server {
  let current = freshLogState();
  // What each request began under, read by every entry it writes; an entry outside one is dropped.
  const requestState = new AsyncLocalStorage<SessionLogState>();

  /** A failed open is not kept, so the next request or entry tries again. */
  function logOf(state: SessionLogState): Promise<CallLog> {
    state.log ??= openCallLog(given.workspace).catch((error: unknown) => {
      state.log = undefined;
      throw error;
    });
    return state.log;
  }

  /** Opening the log would put a directory where `init` refuses anything, so none is opened until
   * a workspace stands; an entry from a request begun under a retired log is dropped. */
  async function requestLog(): Promise<CallLog | undefined> {
    const state = requestState.getStore();
    if (state !== current || (await noWorkspaceAt(given.workspace))) {
      return undefined;
    }
    return logOf(state);
  }

  const context: OperationContext = {
    ...given,
    reportRefusal: async (refusal) => {
      await given.reportRefusal?.(refusal);
      const logged = requestState.getStore()?.foldRefusals;
      const key = `${refusal.commit}:${refusal.path}`;
      if (logged === undefined || logged.has(key)) {
        return;
      }
      logged.add(key);
      try {
        await logCall(requestLog, given.workspace, foldRefusalRequest(refusal), {
          ok: false,
          error: { code: "fold-refused", data: null, message: refusal.reason },
        });
      } catch (error) {
        // A row that was not written is tried again at the next open.
        logged.delete(key);
        throw error;
      }
    },
    reportSubscription: async (trace) => {
      await given.reportSubscription?.(trace);
      await logCall(requestLog, given.workspace, subscriptionCallRequest(trace), { ok: false, error: trace.error });
    },
  };
  const extensions = sessionExtensions(distribution.extensions?.mcp?.tools ?? []);
  const resources = distribution.extensions?.mcp?.resources;
  const server = new Server(
    { name: distribution.name, version: distribution.version },
    { capabilities: { tools: {}, ...(resources === undefined ? {} : { resources: {} }), prompts: {} } },
  );
  const resourceSession: McpResourceSession = Object.freeze({ distribution, context });
  const toolSession: McpToolSession = Object.freeze({ ...resourceSession, server: extensionServerOf(server) });
  async function logCollision(collision: ToolNameCollision, refusal: OperationError): Promise<void> {
    const logged = requestState.getStore()?.collisions;
    const key = JSON.stringify([collision.name, ...collision.claimants]);
    if (logged === undefined || logged.has(key)) {
      return;
    }
    const request = { contribution: "tool-name", id: collision.name, version: "0", input: collision.claimants };
    await logCall(requestLog, context.workspace, request, refusalToLogResponse(refusal));
    logged.add(key);
  }
  const tools = sessionTools(distribution, context, options.lab, extensions, toolSession, logCollision);

  // Unset until the first check, which reads from the start, so a fresh session notifies once.
  let cursor: string | undefined;
  // Set once any handler finds the scope's ref held; the ref's absence after it is a drop.
  let scopeSeen = false;
  // Set once a request finds the workspace standing; its absence after it is a removal.
  let workspaceSeen = false;

  /** A workspace removed, or made again at its path, since the request before is a fresh one,
   * served as at the session's start: a new log, and an init after removal reads from the start. */
  async function asRequest<T>(work: (stands: boolean) => Promise<T>): Promise<T> {
    // Read before the workspace is, so a request never adopts a state made after it began.
    let state = current;
    const stands = !(await noWorkspaceAt(context.workspace));
    const retired = stands ? !(await holdsLogOf(state)) : workspaceSeen;
    workspaceSeen = stands;
    if (retired && state === current) {
      state = freshLogState();
      current = state;
      cursor = undefined;
      scopeSeen = false;
    }
    if (stands && state === current) {
      // Opened at first sight, so a workspace made again holds no file of it; a failed open waits.
      await logOf(state).catch(() => undefined);
    }
    return requestState.run(state, () => work(stands));
  }

  /** Throws while the scope is gone, leaving the cursor where it was, so a remade scope reads on
   * from it, or as stale where its history no longer holds it. */
  async function refuseIfDropped(): Promise<void> {
    if (await scopeHoldsRef(context)) {
      scopeSeen = true;
    } else if (scopeSeen) {
      throw droppedScopeRefusal(context);
    }
  }

  const makers = [...workspaceMakers(tools.operations).keys()];
  const guardRead: ReadGuard = (read) =>
    asRequest(async (stands) => {
      if (!stands) {
        return read(makers);
      }
      await refuseIfDropped();
      return read(undefined);
    });

  async function checkListChanges(): Promise<void> {
    cursor = await checkForListChanges(server, context, cursor, resources !== undefined);
  }

  async function logWithheldTools(): Promise<void> {
    const state = requestState.getStore();
    if (state === undefined || state.withholdingLogged || extensions.uncompilable.size === 0) {
      return;
    }
    const log = await requestLog();
    if (log === undefined) {
      return;
    }
    for (const [name, { tool }] of extensions.tools) {
      const why = extensions.uncompilable.get(name);
      if (why === undefined) {
        continue;
      }
      const request = { contribution: "extension", id: name, version: "0", input: tool.inputSchema };
      const leftOut = tools.leftOut.get(name);
      const message =
        leftOut === undefined
          ? `withheld from tools/list: ${why}`
          : `left out of tools/list, since ${leftOut}; its input schema does not compile either: ${why}`;
      await appendCall(log, context.workspace, request, {
        ok: false,
        error: { code: "schema-uncompilable", data: null, message },
      });
    }
    state.withholdingLogged = true;
  }

  server.setRequestHandler(ListToolsRequestSchema, () =>
    closingWorkspaces(() =>
      refusalCrossingAsRpcError(() =>
        asRequest(async (stands) => {
          if (stands) {
            await refuseIfDropped();
          }
          await checkListChanges();
          await logWithheldTools();
          return { tools: listedTools(await allTargets(tools, distribution, context)) };
        }),
      ),
    ),
  );

  server.setRequestHandler(CallToolRequestSchema, (request) =>
    asRequest(async (stands) => {
      const args = request.params.arguments ?? {};
      try {
        if (stands) {
          await refuseIfDropped();
        }
      } catch (error) {
        if (!isKernelError(error)) {
          throw error;
        }
        await logCall(
          requestLog,
          context.workspace,
          unresolvedCallRequest(request.params.name, args),
          refusalToLogResponse(error),
        );
        return refusalResult(error);
      }
      // A refusal from the list-change check concerns the session, so it stays a JSON-RPC error.
      await checkListChanges();
      try {
        return await callTool(distribution, plainCallContext(context), request.params.name, args, requestLog, tools);
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
    registerResourceHandlers(server, resources, resourceSession, guardRead);
  }
  registerPromptHandlers(server, context, guardRead);

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
