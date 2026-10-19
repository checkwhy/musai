import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ageLimitMsFromSlot,
  dispatchEvent,
  type FloorRuling,
  floorFrom,
  type NeedOutcome,
  RESOLUTION_AGE_SLOT_ID,
} from "@musai/evaluate";
import type { Admission, FoldContributions, FoldRefusal } from "@musai/fold";
import { IndexDb, type IndexedContribution, type IndexedRefusal } from "@musai/fold";
import {
  type EventPayload,
  foldExtensionsFrom,
  HOSTS,
  needId,
  type RuleOutput,
  readClaimTypeDeclarations,
  readDimensionDeclarations,
  readFoldDeclarations,
  readQueryDeclarations,
  readRequirementDeclarations,
  readSlotDeclarations,
} from "@musai/modules";
import type { Audience, Clock, DimensionRegistry, MusaiRecord, RecordId } from "@musai/records";
import {
  type ClaimTypes,
  claimTypesFrom,
  isPlainObject,
  KernelError,
  parseAudience,
  RecordRefusedError,
  TRIPLE_DECLARATION,
} from "@musai/records";
import {
  type FetchStore,
  type LayerDeclaration,
  layerDeclarationsFromConfig,
  type RequirementRegistry,
  type Station,
  stationImageFromConfig,
  workspaceToolsFromConfig,
} from "@musai/run";
import type { CasRetryHooks, GitContext, PutItem } from "@musai/store";
import {
  adoptWorkspace,
  assertScopeFree,
  createScope,
  GitBlobStore,
  LOCAL_DIR,
  MUSAI_DIR,
  projectLayerSlots,
  RecordNotFoundError,
  readTrustBranch,
  Store,
  scopeClearedIndexPath,
  scopeIndexPath,
  scopeRefName,
  scopeVerificationCachePath,
} from "@musai/store";
import {
  type AllowedSigner,
  AttestationVerificationCache,
  type Audiences,
  parseAllowedSigners,
  parseAudiences,
  parseRoles,
  type RoleMatrix,
  roleMatrix,
  type SigningLevel,
  signingLevelOf,
} from "@musai/trust";
import type { SubscriptionTrace } from "./context.js";

/** The error answers and refused needs a dispatch of one event left, one trace each. */
function refusalTraces(
  subscribed: readonly IndexedContribution[],
  event: EventPayload,
  outputs: ReadonlyMap<string, RuleOutput>,
  outcomes: ReadonlyMap<string, NeedOutcome>,
): SubscriptionTrace[] {
  return subscribed.flatMap(({ entry }) => {
    const output = outputs.get(entry.id)!;
    const errors =
      output.kind === "error"
        ? [output.error]
        : output.kind === "request"
          ? output.needs.flatMap((need) => {
              const outcome = outcomes.get(needId(need));
              return outcome?.kind === "refused" ? [outcome.error] : [];
            })
          : [];
    return errors.map((error) => ({ subscription: entry.id, version: entry.version, event, error }));
  });
}

async function makeDirectory(dir: string): Promise<void> {
  try {
    await mkdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
}

/** Declarations are read from the fold they extend, so each fold builds the tables it declares. */
function foldContributionsOver(index: IndexDb, blobs: GitBlobStore): FoldContributions {
  return {
    declarations: () => readFoldDeclarations(index, index.engine()).tables,
    extensions: (tables) => foldExtensionsFrom(tables, index, blobs, HOSTS),
  };
}

/** What a workspace reads from its fold as it opens: its refusals and every declaration. */
function declaredBy(index: IndexDb) {
  const declaredTypes = readClaimTypeDeclarations(index);
  const declaredDimensions = readDimensionDeclarations(index);
  // Read after the fold, which is where a row function's refusal takes a table down.
  const declaredTables = readFoldDeclarations(index, index.engine());
  return {
    refusals: index.refusals(),
    // The base type leads, so `claimTypesFrom` refuses any declaration shadowing it.
    claimTypes: claimTypesFrom([TRIPLE_DECLARATION, ...declaredTypes.declarations]),
    dimensions: declaredDimensions.dimensions,
    foldRefusals: [
      ...declaredTables.refused,
      ...index.absentFoldTables(declaredTables.tables),
      ...readQueryDeclarations(index).refused,
      ...declaredTypes.refused,
      ...declaredDimensions.refused,
    ],
  };
}

/** A clearance nothing declares would open a station no seal hides anything from. */
function refuseUndeclared(audiences: Audiences, clearance: string): void {
  let form: string;
  try {
    form = parseAudience(clearance).form;
  } catch (error) {
    throw new KernelError({ reason: "invalid-input", about: [clearance], detail: (error as Error).message });
  }
  const declared = [...audiences.names.values()];
  if (
    form === "public" ||
    audiences.names.has(clearance) ||
    declared.some((audience) => audience.members.has(clearance))
  ) {
    return;
  }
  throw new KernelError({
    reason: "invalid-input",
    about: [clearance],
    detail: `the audiences file declares no ${clearance} to clear a workspace to: declare it there, or name one it declares`,
  });
}

/** Names the `init` verb, never a binary, since every distribution's command line prints it. */
async function adoptOrRefuse(dir: string, gitDir: string): Promise<void> {
  const found = await adoptWorkspace(gitDir);
  if (found === "adopted") {
    return;
  }
  throw new KernelError({
    reason: "workspace-incomplete",
    detail:
      found === "absent"
        ? `there is no workspace at ${dir}: ${gitDir} is absent or empty, and \`init ${dir}\` makes one there`
        : `there is no workspace at ${dir}: ${gitDir} is no bare repository holding main, and nothing there was changed`,
    about: [dir],
  });
}

/** The audience a workspace reads as, and how what it admits is judged against the author's. */
export interface WorkspaceClearance {
  readonly audience: Audience;
  readonly admission: (author: Workspace) => Promise<Admission>;
}

export interface WorkspaceOptions {
  readonly dir: string;
  readonly scope: string;
  readonly onRefusal?: (refusal: IndexedRefusal) => void | Promise<void>;
  readonly now: Clock;
  readonly onSubscriptionTrace?: (trace: SubscriptionTrace) => Promise<void>;
  readonly subscriptionInvoker?: (
    workspace: Workspace,
    subscription: IndexedContribution,
    event: EventPayload,
  ) => Promise<RuleOutput>;
  /** Supplied by the opener, since judging a seal verifies its signature. */
  readonly clearance?: WorkspaceClearance;
}

/** The author's workspace a cleared one folds after a write and judges what it admits against. */
interface Author {
  readonly workspace: Workspace;
  readonly admission: WorkspaceClearance["admission"];
}

type WorkspaceFields = Pick<
  Workspace,
  | "ctx"
  | "store"
  | "blobs"
  | "fetchStore"
  | "index"
  | "matrix"
  | "audiences"
  | "floor"
  | "signingLevel"
  | "projectSlots"
  | "layerDeclarations"
  | "tools"
  | "allowedSignersPath"
  | "localDir"
  | "allowedSigners"
  | "attestationVerification"
  | "refusals"
  | "foldRefusals"
  | "claimTypes"
  | "dimensions"
  | "now"
  | "foldContributions"
  | "subscriptionInvoker"
  | "onSubscriptionTrace"
  | "clearance"
  | "station"
>;

/** An opened workspace, assembled once so no reader derives a path or reads a branch twice. */
export class Workspace {
  readonly ctx: GitContext;
  readonly store: Store;
  readonly blobs: GitBlobStore;
  /** Where a fetched body over the workspace's blob threshold is held. */
  readonly fetchStore: FetchStore;
  readonly index: IndexDb;
  readonly matrix: RoleMatrix;
  /** Read at the same pin as the matrix, so coverage and authority agree on one trust branch. */
  readonly audiences: Audiences;
  readonly floor: FloorRuling | null;
  readonly signingLevel: SigningLevel;
  readonly projectSlots: Readonly<Record<string, unknown>>;
  /** Held here so a runner raising a name's secrecy never re-reads the trust branch itself. */
  readonly layerDeclarations: ReadonlyMap<string, LayerDeclaration>;
  /** Programs the trust branch admits for runs here beside the modules' requirements. */
  readonly tools: readonly string[];
  /** The allowed-signers file materialised at the pinned commit, for `ssh-keygen` to read. */
  readonly allowedSignersPath: string;
  /** Holds what never leaves the machine: bindings and keys. */
  readonly localDir: string;
  readonly allowedSigners: readonly AllowedSigner[];
  readonly attestationVerification: AttestationVerificationCache;
  readonly refusals: readonly IndexedRefusal[];
  /** Each contributed declaration this workspace lacks and why, including a declared table simply
   * absent from the fold. It never costs the open. */
  readonly foldRefusals: readonly FoldRefusal[];
  readonly claimTypes: ClaimTypes;
  /** A name absent from it is compared under the algebra's default rather than refused. */
  readonly dimensions: DimensionRegistry;
  /** The only source of every record timestamp and commit date this workspace writes. */
  readonly now: Clock;
  readonly foldContributions: FoldContributions;
  /** Supplied by the opener, since invoking a module is I/O; without one nothing is dispatched. */
  readonly subscriptionInvoker?: (
    workspace: Workspace,
    subscription: IndexedContribution,
    event: EventPayload,
  ) => Promise<RuleOutput>;
  /** Where a subscription's error answer or refused need is left; without one it is dropped. */
  readonly onSubscriptionTrace?: (trace: SubscriptionTrace) => Promise<void>;
  /** Set where `index` is the fold this audience reads, and every read by id answers from it. */
  readonly clearance?: Audience;
  /** Set with `clearance`: what every run performed here is held to. */
  readonly station?: Station;
  readonly #author: Author | undefined;
  #closed = false;

  private constructor(fields: WorkspaceFields, author?: Author) {
    this.ctx = fields.ctx;
    this.store = fields.store;
    this.blobs = fields.blobs;
    this.fetchStore = fields.fetchStore;
    this.index = fields.index;
    this.matrix = fields.matrix;
    this.audiences = fields.audiences;
    this.floor = fields.floor;
    this.signingLevel = fields.signingLevel;
    this.projectSlots = fields.projectSlots;
    this.layerDeclarations = fields.layerDeclarations;
    this.tools = fields.tools;
    this.allowedSignersPath = fields.allowedSignersPath;
    this.localDir = fields.localDir;
    this.allowedSigners = fields.allowedSigners;
    this.attestationVerification = fields.attestationVerification;
    this.refusals = fields.refusals;
    this.foldRefusals = fields.foldRefusals;
    this.claimTypes = fields.claimTypes;
    this.dimensions = fields.dimensions;
    this.now = fields.now;
    this.foldContributions = fields.foldContributions;
    this.subscriptionInvoker = fields.subscriptionInvoker;
    this.onSubscriptionTrace = fields.onSubscriptionTrace;
    this.clearance = fields.clearance;
    this.station = fields.station;
    this.#author = author;
  }

  /** Answers from the fold as it stands, never refolding on a miss, so a read spawns no process. */
  read(id: RecordId): MusaiRecord {
    const held = this.index.recordById(id);
    if (held !== undefined) {
      return held.record;
    }
    const refusal = this.index.refusalFor(id);
    if (refusal !== undefined) {
      throw new RecordRefusedError(id, refusal.reason);
    }
    throw new RecordNotFoundError(id, this.store.scope);
  }

  /** Writes and folds a batch, then dispatches its events to subscriptions; a subscription that
   * cannot be invoked, or a trace sink that throws, refuses the call after the batch has landed. */
  async put(items: readonly PutItem[], hooks?: CasRetryHooks): Promise<RecordId[]> {
    const before = this.index.watermark();
    const ids = await this.store.putMany(items, hooks);
    await this.refold();
    await this.dispatchWritten(before, ids);
    return ids;
  }

  /** A cleared fold is judged afresh after the author's lands, since a write can carry a seal. */
  private async refold(): Promise<void> {
    const author = this.#author;
    if (author === undefined) {
      await this.index.fold(this.store, undefined, this.foldContributions);
      return;
    }
    await author.workspace.refold();
    const admission = await author.admission(author.workspace);
    await this.index.fold(author.workspace.store, undefined, this.foldContributions, admission);
  }

  /** A new scope at the commit this scope's fold holds, with a copy of that fold, so a fork costs
   * a file copy, never a cold fold; with `write` false it only answers the tip it would take. */
  async fork(scope: string, write = true): Promise<string> {
    if (this.clearance !== undefined) {
      throw new KernelError({
        reason: "invalid-input",
        about: [this.clearance],
        detail: `refusing to fork under the clearance ${this.clearance}: a fork is the author's scope, at the author's tip`,
      });
    }
    // The name becomes a path segment, so it is refused before any path is built from it.
    scopeRefName(scope);
    const at = this.index.watermark();
    if (at === null) {
      throw new KernelError({
        reason: "invalid-input",
        about: [this.store.scope],
        detail: `scope ${this.store.scope} holds no records, so there is nothing to fork`,
      });
    }
    if (!write) {
      await assertScopeFree(this.ctx, scope);
      return at;
    }
    const indexPath = scopeIndexPath(this.ctx.gitDir, scope);
    // A scope name never begins with a dot, so this file collides with no scope's directory.
    const forking = join(dirname(dirname(indexPath)), `.${scope}.forking.sqlite`);
    await rm(forking, { force: true });
    const tip = this.index.snapshotTo(forking)!;
    try {
      await createScope(this.ctx, scope, tip);
    } catch (error) {
      await rm(forking, { force: true });
      throw error;
    }
    // `open` leaves an empty fold under any name it opened, so whatever stands there goes.
    await rm(dirname(indexPath), { recursive: true, force: true });
    await mkdir(dirname(indexPath), { recursive: true });
    await rename(forking, indexPath);
    return tip;
  }

  /** The scope's fold as `audience` is cleared to read it, kept beside the scope's own: folded
   * under `admission` up to the commit it was judged at, and from nothing when its digest moves. */
  async clearedFold(audience: Audience, admission: Admission): Promise<IndexDb> {
    const path = scopeClearedIndexPath(this.ctx.gitDir, this.store.scope, audience);
    await makeDirectory(dirname(path));
    const cleared = new IndexDb(path);
    try {
      await cleared.fold(this.store, undefined, foldContributionsOver(cleared, this.blobs), admission);
    } catch (error) {
      cleared.close();
      throw error;
    }
    return cleared;
  }

  /** Closes every fold this workspace holds open, the author's too where it reads a cleared one. */
  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.index.close();
    this.#author?.workspace.close();
  }

  /** What a run here may spawn: what the installed modules declare. */
  requirements(): RequirementRegistry {
    return readRequirementDeclarations(this.index, []);
  }

  /** What a check's run may spawn: the modules' declarations and the workspace's tools. */
  checkRequirements(): RequirementRegistry {
    return readRequirementDeclarations(this.index, this.tools);
  }

  private async dispatchWritten(before: string | null, written: readonly RecordId[]): Promise<void> {
    const invoke = this.subscriptionInvoker;
    if (invoke === undefined) {
      return;
    }
    const subscriptions = this.index.contributionsOf("subscription");
    if (subscriptions.length === 0) {
      return;
    }
    const own = new Set(written);
    // A write sealing all the watermark's commit held takes that commit out of a cleared fold.
    const rows = this.index.eventsAfter(before === null ? undefined : { commit: before }) ?? this.index.eventsAfter()!;
    const dispatches = rows
      .filter((row) => own.has(row.recordId))
      .map((row) => ({
        row,
        subscribed: subscriptions.filter((subscription) => eventNamedBy(subscription.entry.input) === row.kind),
      }))
      .filter(({ subscribed }) => subscribed.length > 0);
    if (dispatches.length === 0) {
      return;
    }
    const requirementRegistry = this.requirements();
    // A subscription belongs to no case, so no preset, booking or project layer applies.
    const slotRegistry = readSlotDeclarations(this.index);
    const ageLimitMs = slotRegistry.has(RESOLUTION_AGE_SLOT_ID) ? ageLimitMsFromSlot(slotRegistry, {}) : undefined;
    const evaluationOutcomes = new Map<string, NeedOutcome>();
    const traces: SubscriptionTrace[] = [];
    for (const { row, subscribed } of dispatches) {
      const event: EventPayload = { name: row.kind, payload: { id: row.recordId, about: row.about, at: row.commit } };
      const { outputs, outcomes } = await dispatchEvent({
        event,
        subscriptions: subscribed.map((subscription) => ({
          id: subscription.entry.id,
          handler: (event: EventPayload) => invoke(this, subscription, event),
        })),
        store: this.store,
        index: this.index,
        evaluationOutcomes,
        ageLimitMs,
        localDir: this.localDir,
        layerDeclarations: this.layerDeclarations,
        requirementRegistry,
        fetchStore: this.fetchStore,
        now: this.now,
        station: this.station,
      });
      traces.push(...refusalTraces(subscribed, event, outputs, outcomes));
    }
    // Dispatch's own receipts are dispatched to nobody, or a subscription could never terminate.
    await this.refold();
    // After the fold, so a sink that throws leaves the fold holding what the dispatch minted.
    const failures: unknown[] = [];
    for (const trace of traces) {
      try {
        await this.onSubscriptionTrace?.(trace);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw failures[0];
    }
  }

  /** Claim types and dimensions are read once at open, so a process that installs a module
   * re-opens to see it. A malformed trust configuration refuses the open. */
  static async open(options: WorkspaceOptions): Promise<Workspace> {
    const gitDir = join(options.dir, MUSAI_DIR);
    const ctx: GitContext = { gitDir };
    // A scope name becomes a path segment, so it is refused before it can steer where a file lands.
    scopeRefName(options.scope);
    // The fold is where declarations are read from, so its store knows the base triple alone.
    const bootstrap = new Store({
      ctx,
      scope: options.scope,
      now: options.now,
      claimTypes: claimTypesFrom([TRIPLE_DECLARATION]),
    });
    const indexPath = scopeIndexPath(gitDir, options.scope);
    // A clone arrives without `local/`; only that miss asks the store what `.musai` is.
    const scopeDir = dirname(indexPath);
    const scopesDir = dirname(scopeDir);
    try {
      await makeDirectory(scopesDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
      await adoptOrRefuse(options.dir, gitDir);
      await makeDirectory(scopesDir);
    }
    await makeDirectory(scopeDir);
    const index = new IndexDb(indexPath);
    let author: Workspace | undefined;
    try {
      const blobs = new GitBlobStore({ ctx, now: options.now });
      const foldContributions = foldContributionsOver(index, blobs);
      await index.fold(bootstrap, undefined, foldContributions);
      const declared = declaredBy(index);
      if (options.onRefusal !== undefined && options.clearance === undefined) {
        for (const refusal of declared.refusals) {
          await options.onRefusal(refusal);
        }
      }
      const trust = await readTrustBranch(ctx);
      const store = new Store({
        ctx,
        scope: options.scope,
        now: options.now,
        claimTypes: declared.claimTypes,
        config: trust.config,
      });
      const allowedSigners = parseAllowedSigners(trust.allowedSigners);
      const matrix = roleMatrix(allowedSigners, parseRoles(trust.roles), trust.commit);
      const floor = floorFrom(trust.config);
      const signingLevel = signingLevelOf(trust.config);
      const projectSlots = projectLayerSlots(trust.config);
      const layerDeclarations = layerDeclarationsFromConfig(trust.config);
      const tools = workspaceToolsFromConfig(trust.config);
      const localDir = join(gitDir, LOCAL_DIR);
      const allowedSignersPath = join(localDir, "allowed-signers");
      const allowedSignersBytes = new TextEncoder().encode(trust.allowedSigners);
      await writeFile(allowedSignersPath, allowedSignersBytes);
      const attestationVerification = await AttestationVerificationCache.open(
        scopeVerificationCachePath(gitDir, options.scope),
        allowedSignersBytes,
      );
      author = new Workspace({
        ctx,
        store,
        blobs,
        fetchStore: { blobs, config: trust.config.values },
        index,
        matrix,
        audiences: parseAudiences(trust.audiences),
        floor,
        signingLevel,
        projectSlots,
        layerDeclarations,
        tools,
        allowedSignersPath,
        localDir,
        allowedSigners,
        attestationVerification,
        ...declared,
        now: options.now,
        foldContributions,
        subscriptionInvoker: options.subscriptionInvoker,
        onSubscriptionTrace: options.onSubscriptionTrace,
      });
      return options.clearance === undefined
        ? author
        : await author.cleared(options.clearance, options.onRefusal, stationImageFromConfig(trust.config));
    } catch (error) {
      (author ?? index).close();
      throw error;
    }
  }

  /** The same workspace read as `clearance` reads it: every field a fold answers comes from its
   * cleared fold, and the store answers a read by an id that fold does not hold as absent. */
  private async cleared(
    clearance: WorkspaceClearance,
    onRefusal: ((refusal: IndexedRefusal) => void | Promise<void>) | undefined,
    stationImage: Station["image"],
  ): Promise<Workspace> {
    refuseUndeclared(this.audiences, clearance.audience);
    const index = await this.clearedFold(clearance.audience, await clearance.admission(this));
    let declared: ReturnType<typeof declaredBy>;
    try {
      declared = declaredBy(index);
      if (onRefusal !== undefined) {
        for (const refusal of declared.refusals) {
          await onRefusal(refusal);
        }
      }
    } catch (error) {
      index.close();
      throw error;
    }
    const store = new Store({
      ctx: this.ctx,
      scope: this.store.scope,
      now: this.now,
      claimTypes: declared.claimTypes,
      holds: (id) => index.holds(id),
      clearance: clearance.audience,
    });
    return new Workspace(
      {
        ...this,
        store,
        index,
        ...declared,
        foldContributions: foldContributionsOver(index, this.blobs),
        clearance: clearance.audience,
        station: { clearance: clearance.audience, image: stationImage, musaiDir: this.ctx.gitDir },
      },
      { workspace: this, admission: clearance.admission },
    );
  }
}

function eventNamedBy(inputSchema: unknown): string | undefined {
  const properties = isPlainObject(inputSchema) ? inputSchema["properties"] : undefined;
  const name = isPlainObject(properties) ? properties["name"] : undefined;
  const named = isPlainObject(name) ? name["const"] : undefined;
  return typeof named === "string" ? named : undefined;
}
