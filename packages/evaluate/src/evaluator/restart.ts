import { dirname } from "node:path";
import type { IndexDb, IndexedReceipt } from "@musai/fold";
import type {
  InvocationLimits,
  Invoker,
  RuleInput,
  RuleInvocation,
  RuleOutput,
  RuleRecord,
  RuleRefusal,
} from "@musai/modules";
import {
  ENVELOPE_PROTOCOL,
  type EnvelopeError,
  type EnvelopeRequest,
  type EventPayload,
  invokeThroughHost,
  type Need,
  needId,
  pointFor,
  type ReadLog,
  recordRead,
} from "@musai/modules";
import type {
  DigestSet,
  FetchRecipe,
  ReadEntry,
  Reason,
  RecordId,
  ResourceDescriptor,
  RunRecipe,
  RunRecord,
  SlotRegistry,
} from "@musai/records";
import {
  type Clock,
  CURRENT_SCHEMA_VERSIONS,
  instantOf,
  isKernelError,
  KernelError,
  performedRun,
  RecordRefusedError,
  resolveSlot,
  type SlotLayers,
  textOf,
} from "@musai/records";
import type { FetchStore } from "@musai/run";
import {
  authorisedProgram,
  BinaryNotFoundError,
  BindingError,
  bindDeclaredNames,
  type CheckoutBindings,
  checkoutBindingsFor,
  commitTree,
  insideCheckout,
  type LayerDeclaration,
  movedSecretReads,
  namesCommit,
  namesRoot,
  performRecipe,
  type RequirementRegistry,
  type ResolutionTable,
  type ResolvedBinary,
  RUNNER_PERFORMER,
  RunRefusedError,
  readBindings,
  refuseStationRun,
  resolveBinaries,
  resolveReference,
  resolveSubstrates,
  type Station,
  StationRefusedError,
  secretReadId,
  stationRecipe,
} from "@musai/run";
import { RecordNotFoundError, type RecordWriter, readKeyFile } from "@musai/store";
import { currentRecord, handedReads } from "./read-set.js";

export const RESOLUTION_AGE_SLOT_ID = "musai.core/resolution-age";
const NEED_CONCURRENCY_SLOT_ID = "musai.core/need-concurrency";

/** Unbounded for a caller with no slot registry to consult. */
export function ageLimitMsFromSlot(registry: SlotRegistry | undefined, layers: SlotLayers | undefined): number {
  if (registry === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  return resolveSlot(RESOLUTION_AGE_SLOT_ID, registry, layers ?? {}).value as number;
}

function concurrencyFromSlot(registry: SlotRegistry | undefined, layers: SlotLayers | undefined): number | undefined {
  if (registry === undefined) {
    return undefined;
  }
  return resolveSlot(NEED_CONCURRENCY_SLOT_ID, registry, layers ?? {}).value as number;
}

export type RuleRequest = Extract<RuleOutput, { kind: "request" }>;
export type RuleVerdict = Extract<RuleOutput, { kind: "verdict" }>;

/** One evaluation's memory of a need; an answered invoke is cached too, since a contribution is a
 * pure function of its input. */
export type NeedOutcome =
  | { readonly kind: "satisfied"; readonly recordId: RecordId }
  | { readonly kind: "answered"; readonly output: unknown; readonly moduleRecord: RecordId }
  | { readonly kind: "refused"; readonly error: EnvelopeError; readonly reason: Reason };

/** A need this kernel or evaluation cannot perform, folded forward under its own closed code. */
export class UnsupportedNeedError extends KernelError {
  constructor(message: string) {
    super({ reason: "unsupported-format", detail: message });
    this.name = "UnsupportedNeedError";
  }
}

/** An invoke the workspace cannot answer: a malformed request, not a missing kind of need. */
export class InvokeRefusedError extends KernelError {
  constructor(message: string) {
    super({ reason: "invalid-input", detail: message });
    this.name = "InvokeRefusedError";
  }
}

/** A run its caller's deadline ended, which ends the call and records no receipt of it. */
class RunTimedOutError extends KernelError {
  constructor(command: readonly string[], timeoutMs: number) {
    super({
      reason: "over-budget",
      about: [command[0]!],
      detail: `the run of ${command.join(" ")} outlived its ${timeoutMs} ms deadline and was ended, with no receipt recorded`,
    });
    this.name = "RunTimedOutError";
  }
}

function refusalFrom(need: Need, error: unknown): EnvelopeError {
  return {
    code: error instanceof UnsupportedNeedError ? "unsupported-need" : "need-refused",
    data: { need },
    message: error instanceof Error ? error.message : String(error),
  };
}

/** A non-`KernelError` is a defect, reported as `invalid-output`, the one reason of class `bug`. */
function reasonFor(error: unknown): Reason {
  return isKernelError(error) ? error.reason : "invalid-output";
}

function digestSetsEqual(a: DigestSet | undefined, b: DigestSet | undefined): boolean {
  const aEntries = Object.entries(a ?? {}).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const bEntries = Object.entries(b ?? {}).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  if (aEntries.length !== bEntries.length) {
    return false;
  }
  return aEntries.every(([key, value], index) => bEntries[index]?.[0] === key && bEntries[index]?.[1] === value);
}

/** Replaces lookup-then-spawn, so a fixture suite drives the production loop unchanged. */
export type RunNeedHook = (recipe: RunRecipe, recipeId: RecordId) => Promise<RecordId>;

/** The fetch-shaped `RunNeedHook`, so a fixture suite proves a fetch rule off the network. */
export type FetchNeedHook = (recipe: FetchRecipe, recipeId: RecordId) => Promise<RecordId>;

interface PerformNeedContext {
  readonly index: IndexDb;
  readonly store: RecordWriter;
  /** Records earlier needs in this evaluation were satisfied by, folded or not. */
  readonly evaluationRecords: ReadonlySet<RecordId>;
  readonly ageLimitMs: number;
  readonly localDir?: string;
  readonly layerDeclarations?: ReadonlyMap<string, LayerDeclaration>;
  readonly now: Clock;
  readonly performRun?: RunNeedHook;
  readonly performFetchNeed?: FetchNeedHook;
  readonly fetchStore?: FetchStore;
  readonly slotRegistry?: SlotRegistry;
  readonly requirementRegistry?: RequirementRegistry;
  readonly slotLayers?: SlotLayers;
  readonly resolutionTable?: ResolutionTable;
  readonly modulePath?: (moduleName: string) => string;
  readonly invocationLimits?: InvocationLimits;
  readonly runTimeoutMs?: number;
  readonly station?: Station;
  /** What a station's preflight decided for each run need: the receipt reused, or none. */
  readonly reuse: Map<string, RecordId | undefined>;
}

async function boundSecretsUnmoved(
  receipt: IndexedReceipt,
  recipe: RunRecipe,
  ctx: PerformNeedContext,
): Promise<boolean> {
  const bindings = performedRun(receipt.recordId, receipt.record).observation.bindings;
  const reads = new Set(
    bindings
      .filter((binding) => binding.secret && binding.keyId !== null && binding.keyedHash !== null)
      .map((binding) => secretReadId(binding.name, binding.keyId!, binding.keyedHash!)),
  );
  if (reads.size === 0 || ctx.localDir === undefined) {
    return true;
  }
  const bindingsSource = recipe.declared.length > 0 ? await readBindings(ctx.localDir) : {};
  const { resolved } = await bindDeclaredNames(recipe.declared, bindingsSource, ctx.layerDeclarations ?? new Map());
  const currentByName = new Map(resolved.map((entry) => [entry.name, entry.value]));
  const file = await readKeyFile(ctx.localDir);
  return movedSecretReads(file, reads, (name) => currentByName.get(name)).size === 0;
}

/** A working tree counts as pinned here because `receiptSatisfies` then measures it against the
 * digest the receipt recorded. */
async function receiptIsPinned(receipt: IndexedReceipt, recipe: RunRecipe, now: Measured): Promise<boolean> {
  const everySubstratePinned =
    recipe.substrates.length > 0 &&
    recipe.substrates.every((descriptor) => namesRoot(descriptor) && descriptor.name !== undefined);
  if (!everySubstratePinned || !insideCheckout(recipe.workingDirectory) || recipe.declared.length > 0) {
    return false;
  }
  const recorded = performedRun(receipt.recordId, receipt.record).observation.binaries;
  try {
    const current = await now.binaries(recorded.map((binary) => binary.name));
    return current.every((binary, index) => binary.digest === recorded[index]!.digest);
  } catch (error) {
    if (error instanceof BinaryNotFoundError) {
      return false;
    }
    throw error;
  }
}

/** A named commit answers with the tree its bound repository holds, never a disk measurement, and
 * a working tree with its measurement; `null` when one cannot be answered. */
async function reuseDigests(
  recipe: RunRecipe,
  localDir: string | undefined,
): Promise<(DigestSet | undefined)[] | null> {
  let checkouts: CheckoutBindings;
  try {
    checkouts = await checkoutBindingsFor(recipe.substrates, localDir);
  } catch (error) {
    if (error instanceof BindingError) {
      return null;
    }
    throw error;
  }
  const digests: (DigestSet | undefined)[] = [];
  for (const descriptor of recipe.substrates) {
    if (!namesCommit(descriptor)) {
      let resolved: ResourceDescriptor | undefined;
      try {
        [resolved] = await resolveSubstrates(
          [descriptor],
          checkouts,
          localDir === undefined ? [] : [dirname(localDir)],
        );
      } catch (error) {
        if (error instanceof RunRefusedError) {
          return null;
        }
        throw error;
      }
      digests.push(resolved!.digest);
      continue;
    }
    const tree = await commitTree(checkouts, descriptor);
    if (tree === null) {
      return null;
    }
    digests.push({ gitCommit: descriptor.digest!.gitCommit!, gitTree: tree });
  }
  return digests;
}

/** What a recipe's substrates and programs answer now, each measured once however many receipts
 * are weighed against it. */
interface Measured {
  readonly digests: () => Promise<(DigestSet | undefined)[] | null>;
  readonly binaries: (names: readonly string[]) => Promise<readonly ResolvedBinary[]>;
}

function measuredOnce(recipe: RunRecipe, localDir: string | undefined): Measured {
  let digests: Promise<(DigestSet | undefined)[] | null> | undefined;
  const binaries = new Map<string, Promise<readonly ResolvedBinary[]>>();
  return {
    digests: () => (digests ??= reuseDigests(recipe, localDir)),
    binaries: (names) => {
      const key = names.join("\0");
      const resolved = binaries.get(key) ?? resolveBinaries(names);
      binaries.set(key, resolved);
      return resolved;
    },
  };
}

/** A commit that cannot be answered leaves the receipt unused, never refused: the spawn decides. */
async function receiptSatisfies(
  receipt: IndexedReceipt,
  recipe: RunRecipe,
  ctx: PerformNeedContext,
  now: Measured,
): Promise<boolean> {
  const nowInstant = instantOf(ctx.now());
  const receiptInstant = instantOf(receipt.startedAt);
  if (nowInstant - receiptInstant > ctx.ageLimitMs && !(await receiptIsPinned(receipt, recipe, now))) {
    return false;
  }
  const fresh = await now.digests();
  const stored = performedRun(receipt.recordId, receipt.record).observation.resolved;
  if (fresh === null || fresh.length !== stored.length) {
    return false;
  }
  if (!fresh.every((digest, index) => digestSetsEqual(digest, stored[index]?.digest))) {
    return false;
  }
  return boundSecretsUnmoved(receipt, recipe, ctx);
}

/** The latest receipt that still answers wins, so a tree returned to an earlier state reuses it. */
async function reusableReceipt(
  asked: RunRecipe,
  askedId: RecordId,
  ctx: PerformNeedContext,
): Promise<RecordId | undefined> {
  const now = measuredOnce(asked, ctx.localDir);
  for (const receipt of ctx.index.receiptsByRecipe(askedId)) {
    if (await receiptSatisfies(receipt, asked, ctx, now)) {
      return receipt.recordId;
    }
  }
  return undefined;
}

/** Every refusal the station gives the runs among `needs`, judged before any need starts, so none
 * leaves a sibling's receipt behind; the reuse it decides is the need's, never asked again. */
async function refuseStationRuns(
  needs: readonly (readonly [string, Need])[],
  ctx: PerformNeedContext,
  station: Station,
): Promise<void> {
  for (const [id, need] of needs) {
    if (need.kind !== "run") {
      continue;
    }
    try {
      if (ctx.requirementRegistry !== undefined) {
        authorisedProgram(need.recipe, ctx.requirementRegistry);
      }
    } catch {
      continue;
    }
    const asked = stationRecipe(need.recipe, station);
    if (ctx.performRun !== undefined) {
      continue;
    }
    const reused = await reusableReceipt(asked, needId({ kind: "run", recipe: asked }), ctx);
    ctx.reuse.set(id, reused);
    if (reused === undefined) {
      try {
        await refuseStationRun(need.recipe, { station, localDir: ctx.localDir });
      } catch (error) {
        if (error instanceof StationRefusedError) {
          throw error;
        }
      }
    }
  }
}

/** Binaries are authorised before a receipt is reused, since a pinned one has no age; an invoke
 * records nothing, so mutual invokes form no chain. */
async function performNeed(
  need: Need,
  id: RecordId,
  ctx: PerformNeedContext,
): Promise<Extract<NeedOutcome, { kind: "satisfied" | "answered" }>> {
  if (need.kind === "record") {
    if (ctx.evaluationRecords.has(need.id) || ctx.index.recordById(need.id) !== undefined) {
      return { kind: "satisfied", recordId: need.id };
    }
    const refusal = ctx.index.refusalFor(need.id);
    if (refusal !== undefined) {
      throw new RecordRefusedError(need.id, refusal.reason);
    }
    throw new RecordNotFoundError(need.id, ctx.store.scope);
  }
  if (need.kind === "fetch") {
    if (ctx.performFetchNeed !== undefined) {
      return { kind: "satisfied", recordId: await ctx.performFetchNeed(need.recipe, id) };
    }
    // Resolving a fetch's locator is its retrieval, so the resolution receipt is the citation.
    const declared: ResourceDescriptor = { uri: need.recipe.locator };
    const resolved = await resolveReference({ declared }, ctx.resolutionTable ?? new Map(), {
      index: ctx.index,
      store: ctx.store,
      method: { kind: "fetch", recipe: need.recipe },
      ageLimitMs: ctx.ageLimitMs,
      localDir: ctx.localDir,
      layerDeclarations: ctx.layerDeclarations,
      fetchStore: ctx.fetchStore,
      now: ctx.now,
    });
    if (resolved.resolutionReceipt === null) {
      throw new UnsupportedNeedError(
        `refusing to satisfy a fetch need for ${need.recipe.locator}: its locator resolved with no resolution receipt to cite`,
      );
    }
    return { kind: "satisfied", recordId: resolved.resolutionReceipt };
  }
  if (need.kind === "invoke") {
    if (ctx.modulePath === undefined) {
      throw new UnsupportedNeedError(
        `refusing to invoke ${need.contribution}: this evaluation resolves no installed module to invoke a contribution through`,
      );
    }
    const contribution = ctx.index.contributionById(need.contribution);
    if (contribution === undefined) {
      throw new InvokeRefusedError(
        `refusing to invoke ${need.contribution}: the workspace holds no contribution of that id`,
      );
    }
    const point = pointFor(contribution.entry.kind, ctx.index);
    if (point === undefined) {
      throw new InvokeRefusedError(
        `refusing to invoke ${need.contribution}: the workspace holds no point named ${contribution.entry.kind}`,
      );
    }
    const request: EnvelopeRequest = {
      protocol: ENVELOPE_PROTOCOL,
      contribution: contribution.entry.kind,
      id: need.contribution,
      version: contribution.entry.version,
      input: need.input,
    };
    const response = await invokeThroughHost(
      ctx.modulePath(contribution.moduleName),
      request,
      { entry: contribution.entry, point },
      ctx.invocationLimits,
    );
    if (response === undefined) {
      throw new InvokeRefusedError(
        `refusing to invoke ${need.contribution}: this machine provides no host this kernel can invoke a contribution through`,
      );
    }
    if (!response.ok) {
      throw new InvokeRefusedError(
        `refusing to invoke ${need.contribution}: it refused with ${response.error.code}: ${response.error.message}`,
      );
    }
    return { kind: "answered", output: response.output, moduleRecord: contribution.moduleRecord };
  }
  if (need.kind !== "run") {
    throw new UnsupportedNeedError(
      `a need of kind ${JSON.stringify((need as { kind: unknown }).kind)} is outside the four this kernel supports: run, fetch, record, invoke`,
    );
  }
  if (ctx.requirementRegistry !== undefined) {
    authorisedProgram(need.recipe, ctx.requirementRegistry);
  }
  const asked = ctx.station === undefined ? need.recipe : stationRecipe(need.recipe, ctx.station);
  const askedId = ctx.station === undefined ? id : needId({ kind: "run", recipe: asked });
  if (ctx.performRun !== undefined) {
    return { kind: "satisfied", recordId: await ctx.performRun(asked, askedId) };
  }
  const reused = ctx.reuse.has(id) ? ctx.reuse.get(id) : await reusableReceipt(asked, askedId, ctx);
  if (reused !== undefined) {
    return { kind: "satisfied", recordId: reused };
  }
  const { recipe, observation, timedOut } = await performRecipe(asked, {
    now: ctx.now,
    localDir: ctx.localDir,
    layerDeclarations: ctx.layerDeclarations,
    slotRegistry: ctx.slotRegistry,
    slotLayers: ctx.slotLayers,
    requirementRegistry: ctx.requirementRegistry,
    station: ctx.station,
    timeoutMs: ctx.runTimeoutMs,
  });
  if (timedOut) {
    throw new RunTimedOutError(need.recipe.command, ctx.runTimeoutMs!);
  }
  const receiptValue: RunRecord = {
    kind: "run",
    schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
    runKind: "run",
    performer: RUNNER_PERFORMER,
    determinism: "nondeterministic",
    recipe,
    observation,
    supersedes: [],
  };
  return { kind: "satisfied", recordId: await ctx.store.put("run", receiptValue) };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number | undefined,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  if (concurrency === undefined || concurrency >= items.length) {
    return Promise.all(items.map(fn));
  }
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) {
        return;
      }
      results[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return results;
}

export interface SatisfyNeedsOptions {
  /** Duplicates by id are performed once and every requester reads the same outcome. */
  readonly needs: readonly Need[];
  readonly index: IndexDb;
  readonly store: RecordWriter;
  /** Shared and mutated across every round, rule and subscription of one evaluation. */
  readonly evaluationOutcomes: Map<string, NeedOutcome>;
  /** How old an unpinned satisfying receipt may be before it is redone. */
  readonly ageLimitMs: number;
  /** Unbounded when omitted, since needs in one round are independent. */
  readonly concurrency?: number;
  readonly localDir?: string;
  readonly layerDeclarations?: ReadonlyMap<string, LayerDeclaration>;
  readonly now: Clock;
  readonly performRun?: RunNeedHook;
  readonly performFetchNeed?: FetchNeedHook;
  /** Where a fetched body over the blob threshold is written. */
  readonly fetchStore?: FetchStore;
  /** A performed run resolves its cannot-hold policy from this registry's isolation-policy slot. */
  readonly slotRegistry?: SlotRegistry;
  /** A run naming a binary this does not cover is refused before it is spawned or reused. */
  readonly requirementRegistry?: RequirementRegistry;
  readonly slotLayers?: SlotLayers;
  /** Shared with every caller resolving a moving reference, so one locator is retrieved once. */
  readonly resolutionTable?: ResolutionTable;
  /** Unset, an invoke need is refused by name. */
  readonly modulePath?: (moduleName: string) => string;
  /** Absent, a host takes the invocation-limits slot's declared default. */
  readonly invocationLimits?: InvocationLimits;
  /** How long each run may take; one outliving it ends the call. Unset, a run is unbounded. */
  readonly runTimeoutMs?: number;
  /** Set under a clearance: every run need goes through its container, or the call is refused. */
  readonly station?: Station;
  /** Set where a station's refusal answers the need rather than ending the call. */
  readonly stationRefusalsAnswer?: boolean;
}

/** A record need reads the table as it was at the call's start, so no sibling's timing matters. */
export async function satisfyNeeds(options: SatisfyNeedsOptions): Promise<ReadonlyMap<string, NeedOutcome>> {
  const now = options.now;
  const evaluationRecords = new Set<RecordId>();
  for (const outcome of options.evaluationOutcomes.values()) {
    if (outcome.kind === "satisfied") {
      evaluationRecords.add(outcome.recordId);
    }
  }
  const ctx: PerformNeedContext = {
    index: options.index,
    store: options.store,
    evaluationRecords,
    ageLimitMs: options.ageLimitMs,
    localDir: options.localDir,
    layerDeclarations: options.layerDeclarations,
    now,
    performRun: options.performRun,
    performFetchNeed: options.performFetchNeed,
    fetchStore: options.fetchStore,
    slotRegistry: options.slotRegistry,
    requirementRegistry: options.requirementRegistry,
    slotLayers: options.slotLayers,
    resolutionTable: options.resolutionTable,
    modulePath: options.modulePath,
    invocationLimits: options.invocationLimits,
    runTimeoutMs: options.runTimeoutMs,
    station: options.station,
    reuse: new Map(),
  };

  const uniqueNeeds = new Map<string, Need>();
  for (const need of options.needs) {
    const id = needId(need);
    if (!uniqueNeeds.has(id)) {
      uniqueNeeds.set(id, need);
    }
  }

  const toPerform = [...uniqueNeeds.entries()].filter(([id]) => !options.evaluationOutcomes.has(id));

  if (options.station !== undefined && options.stationRefusalsAnswer !== true) {
    await refuseStationRuns(toPerform, ctx, options.station);
  }

  // The first need in round order that was refused is the call's refusal, whatever settled first.
  const refused: { first?: { readonly order: number; readonly error: KernelError } } = {};
  const heldRefusal = () => refused.first;
  const ordered = toPerform.map(([id, need], order) => ({ id, need, order }));
  await mapWithConcurrency(ordered, options.concurrency, async ({ id, need, order }) => {
    if (heldRefusal() !== undefined) {
      return;
    }
    try {
      options.evaluationOutcomes.set(id, await performNeed(need, id as RecordId, ctx));
    } catch (error) {
      // A run the clearance forbids or the deadline ends refuses the call, never the rule.
      if (
        (error instanceof StationRefusedError && options.stationRefusalsAnswer !== true) ||
        error instanceof RunTimedOutError
      ) {
        if (heldRefusal() === undefined || order < heldRefusal()!.order) {
          refused.first = { order, error };
        }
        return;
      }
      options.evaluationOutcomes.set(id, {
        kind: "refused",
        error: refusalFrom(need, error),
        reason: reasonFor(error),
      });
    }
  });

  if (refused.first !== undefined) {
    throw refused.first.error;
  }

  const roundOutcomes = new Map<string, NeedOutcome>();
  for (const id of uniqueNeeds.keys()) {
    roundOutcomes.set(id, options.evaluationOutcomes.get(id)!);
  }
  return roundOutcomes;
}

/** An invoke's id appears in `needs`, never in `satisfied`: an invoke mints no record. */
export interface RestartRound {
  readonly needs: readonly RecordId[];
  readonly satisfied: readonly RecordId[];
}

export interface RestartLoopOptions {
  readonly invoker: Invoker;
  /** The first invocation's input, ordinarily carrying no evidence yet. */
  readonly input: RuleInput;
  readonly store: RecordWriter;
  readonly index: IndexDb;
  /** Unnamed, it comes from the resolution-age slot, or is unbounded with no `slotRegistry`. */
  readonly ageLimitMs?: number;
  /** Unnamed, it comes from the need-concurrency slot, or is unbounded with no `slotRegistry`. */
  readonly concurrency?: number;
  /** Shared across one evaluation's rules and subscriptions, so a shared need performs once. */
  readonly evaluationOutcomes?: Map<string, NeedOutcome>;
  readonly localDir?: string;
  readonly layerDeclarations?: ReadonlyMap<string, LayerDeclaration>;
  readonly now: Clock;
  readonly performRun?: RunNeedHook;
  readonly performFetchNeed?: FetchNeedHook;
  /** Where a fetched body over the blob threshold is written. */
  readonly fetchStore?: FetchStore;
  /** Absent, every seam resolved from a slot takes that slot's declared default. */
  readonly slotRegistry?: SlotRegistry;
  /** A run naming a binary this does not cover is refused before it is spawned or reused. */
  readonly requirementRegistry?: RequirementRegistry;
  readonly slotLayers?: SlotLayers;
  readonly resolutionTable?: ResolutionTable;
  /** Unset, an invoke need is refused by name. */
  readonly modulePath?: (moduleName: string) => string;
  /** Bounds invoked contributions only; the driven rule is bounded by its own invoker. */
  readonly invocationLimits?: InvocationLimits;
  readonly runTimeoutMs?: number;
  /** The record at the slot the input names, so the read-set reads the claim itself. */
  readonly claim?: RecordId;
  readonly station?: Station;
  readonly stationRefusalsAnswer?: boolean;
}

export interface RestartLoopResult {
  readonly verdict: RuleVerdict;
  readonly invocations: number;
  /** Each id once, under the first run or fetch need that answered it, else under `record`. */
  readonly receipts: readonly { readonly id: RecordId; readonly need: Need["kind"] }[];
  readonly readLog: ReadLog;
  /** What the kernel handed the rule, keyed as a read-set is. */
  readonly readSet: readonly ReadEntry[];
  readonly rounds: readonly RestartRound[];
}

const STALLED_REASON = "the rule requested only needs it had already been given, so the loop stopped rather than spin";

/** Restarts the rule until a verdict or a stall: a round asking only what this rule itself was
 * already given, whatever the shared table knew. */
export async function runRestartLoop(options: RestartLoopOptions): Promise<RestartLoopResult> {
  const now = options.now;
  const ageLimitMs = options.ageLimitMs ?? ageLimitMsFromSlot(options.slotRegistry, options.slotLayers);
  const concurrency = options.concurrency ?? concurrencyFromSlot(options.slotRegistry, options.slotLayers);
  const evaluationOutcomes = options.evaluationOutcomes ?? new Map<string, NeedOutcome>();
  const resolutionTable = options.resolutionTable ?? new Map();
  const givenToThisRule = new Set<string>();
  let input = options.input;
  let invocations = 0;
  const receipts: { readonly id: RecordId; readonly need: Need["kind"] }[] = [];
  const reads = new Set<string>();
  const rounds: RestartRound[] = [];
  const recipes = new Map<RecordId, RecordId>();
  const concluded = (verdict: RuleVerdict): RestartLoopResult => ({
    verdict,
    invocations,
    receipts,
    readLog: recordRead(input.claimId, reads),
    readSet: handedReads(
      input,
      receipts.filter((entry) => entry.need === "record").map((entry) => entry.id),
      recipes,
      options.index,
      options.claim,
    ),
    rounds,
  });

  for (;;) {
    invocations++;
    const { output, readLog } = await options.invoker.invoke(input);
    for (const read of readLog.reads) {
      reads.add(read);
    }

    if (output.kind === "verdict") {
      return concluded(output);
    }
    if (output.kind === "error") {
      const verdict: RuleVerdict = {
        kind: "verdict",
        label: "open",
        reason: `${output.error.code}: ${output.error.message}`,
      };
      return concluded(verdict);
    }

    const needs = output.needs;
    const alreadyGiven = needs.length > 0 && needs.every((need) => givenToThisRule.has(needId(need)));
    if (needs.length === 0 || alreadyGiven) {
      const stalled: RuleVerdict = { kind: "verdict", label: "open", reason: STALLED_REASON };
      return concluded(stalled);
    }

    const roundOutcomes = await satisfyNeeds({
      needs,
      index: options.index,
      store: options.store,
      evaluationOutcomes,
      ageLimitMs,
      concurrency,
      localDir: options.localDir,
      layerDeclarations: options.layerDeclarations,
      slotRegistry: options.slotRegistry,
      requirementRegistry: options.requirementRegistry,
      slotLayers: options.slotLayers,
      now,
      performRun: options.performRun,
      performFetchNeed: options.performFetchNeed,
      fetchStore: options.fetchStore,
      resolutionTable,
      modulePath: options.modulePath,
      invocationLimits: options.invocationLimits,
      runTimeoutMs: options.runTimeoutMs,
      station: options.station,
      stationRefusalsAnswer: options.stationRefusalsAnswer,
    });

    const roundSatisfied: RecordId[] = [];
    const evidence = [...input.evidence];
    const refusals: RuleRefusal[] = [];
    const answers: RuleInvocation[] = [...(input.invocations ?? [])];
    const records: RuleRecord[] = [...(input.records ?? [])];
    for (const need of needs) {
      const id = needId(need);
      givenToThisRule.add(id);
      const outcome = roundOutcomes.get(id)!;
      if (outcome.kind === "refused") {
        refusals.push({ need, error: outcome.error });
        continue;
      }
      if (outcome.kind === "answered") {
        // Listed once: a later round reads an invoke's answer back rather than calling again.
        if (!answers.some((answer) => needId(answer.need) === id)) {
          answers.push({ need, moduleRecord: outcome.moduleRecord, output: outcome.output });
        }
        continue;
      }
      roundSatisfied.push(outcome.recordId);
      if (need.kind === "record" && !records.some((entry) => entry.id === outcome.recordId)) {
        // The store, not the fold, for a receipt this evaluation minted and has not yet folded.
        const held = currentRecord(options.index, outcome.recordId);
        records.push({ id: outcome.recordId, record: held ?? (await options.store.read(outcome.recordId, "run")) });
      }
      const listed = receipts.findIndex((entry) => entry.id === outcome.recordId);
      if (listed === -1) {
        receipts.push({ id: outcome.recordId, need: need.kind });
      } else if (need.kind !== "record" && receipts[listed]!.need === "record") {
        // A run or fetch need's answer is always a run; a record need's is whatever it names.
        receipts[listed] = { id: outcome.recordId, need: need.kind };
      }
      if (need.kind === "run" || need.kind === "fetch") {
        recipes.set(outcome.recordId, id);
      }
      if (
        (need.kind === "run" || need.kind === "fetch") &&
        !evidence.some((entry) => entry.runId === outcome.recordId)
      ) {
        // The store, not the fold: the receipt may be minted this round and not yet folded.
        const receiptValue = performedRun(
          outcome.recordId,
          (await options.store.read(outcome.recordId, "run")) as RunRecord,
        );
        evidence.push({
          runId: outcome.recordId,
          exitCode: receiptValue.observation.exitCode,
          output: textOf(receiptValue.observation.output, `the output of run ${outcome.recordId}`),
        });
      }
    }

    rounds.push({ needs: needs.map((need) => needId(need)), satisfied: roundSatisfied });
    input = { ...input, evidence, refusals, invocations: answers, ...(records.length === 0 ? {} : { records }) };
  }
}

export interface SubscriptionEntry {
  readonly id: string;
  readonly handler: (event: EventPayload) => RuleOutput | Promise<RuleOutput>;
}

export interface DispatchEventOptions {
  readonly event: EventPayload;
  readonly subscriptions: readonly SubscriptionEntry[];
  readonly store: RecordWriter;
  readonly index: IndexDb;
  /** Shared across one evaluation's events and rules, so a need any of them names performs once. */
  readonly evaluationOutcomes?: Map<string, NeedOutcome>;
  readonly ageLimitMs?: number;
  readonly concurrency?: number;
  readonly localDir?: string;
  readonly layerDeclarations?: ReadonlyMap<string, LayerDeclaration>;
  /** A run naming a binary this does not cover is refused before it is spawned or reused. */
  readonly requirementRegistry?: RequirementRegistry;
  readonly fetchStore?: FetchStore;
  readonly now: Clock;
  readonly station?: Station;
}

export interface DispatchEventResult {
  /** Each subscription's first-round output, by contribution id. */
  readonly outputs: ReadonlyMap<string, RuleOutput>;
  readonly outcomes: ReadonlyMap<string, NeedOutcome>;
}

/** Satisfies every subscription's needs in one pass through the shared table, so one recipe runs
 * once however many subscriptions name it. */
export async function dispatchEvent(options: DispatchEventOptions): Promise<DispatchEventResult> {
  const outputs = new Map<string, RuleOutput>();
  const allNeeds: Need[] = [];
  for (const subscription of options.subscriptions) {
    const output = await subscription.handler(options.event);
    outputs.set(subscription.id, output);
    if (output.kind === "request") {
      allNeeds.push(...output.needs);
    }
  }
  if (allNeeds.length === 0) {
    return { outputs, outcomes: new Map() };
  }
  const outcomes = await satisfyNeeds({
    needs: allNeeds,
    index: options.index,
    store: options.store,
    evaluationOutcomes: options.evaluationOutcomes ?? new Map<string, NeedOutcome>(),
    ageLimitMs: options.ageLimitMs ?? Number.POSITIVE_INFINITY,
    concurrency: options.concurrency,
    localDir: options.localDir,
    layerDeclarations: options.layerDeclarations,
    requirementRegistry: options.requirementRegistry,
    fetchStore: options.fetchStore,
    now: options.now,
    station: options.station,
    // A dispatched run is not the writer's operation, so its refusal is the subscription's.
    stationRefusalsAnswer: true,
  });
  return { outputs, outcomes };
}
