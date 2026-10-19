import type { IndexDb } from "@musai/fold";
import type { DigestSet, PerformedRunRecord, ResourceDescriptor, RunRecipe } from "@musai/records";
import {
  type Clock,
  CURRENT_SCHEMA_VERSIONS,
  citationRecipeFor,
  type FetchRecipe,
  instantOf,
  KernelError,
  type RecordId,
  recordId,
  type Timestamp,
  textOf,
} from "@musai/records";
import type { RecordWriter } from "@musai/store";
import type { LayerDeclaration } from "./bindings.js";
import { type FetchStore, performFetch } from "./fetch.js";
import { RUNNER_PERFORMER } from "./performer.js";
import { performRecipe } from "./spawn.js";
import { resolveSubstrates, substrateReadId } from "./substrate.js";

/** A moving reference with no method to resolve it, refused by name rather than answered empty. */
export class ResolutionRefusedError extends KernelError {
  constructor(message: string) {
    super({ reason: "invalid-input", detail: message });
    this.name = "ResolutionRefusedError";
  }
}

/** A run whose trimmed output is the resolved digest's hex, or a fetch whose body's content
 * digest is the resolution. */
export type ResolutionMethod =
  | { readonly kind: "run"; readonly recipe: RunRecipe }
  | { readonly kind: "fetch"; readonly recipe: FetchRecipe };

/** A fetch method's id is taken over its `citationRecipeFor` form, as `needId` does, so a
 * resolution and a need naming one fetch share a receipt. */
function resolutionRecipeId(method: ResolutionMethod): RecordId {
  return method.kind === "run" ? recordId(method.recipe) : recordId(citationRecipeFor(method.recipe));
}

/** A reference as a recipe declared it: a locator, possibly already carrying a digest. */
export interface Reference {
  readonly declared: ResourceDescriptor;
}

/** Leaves out the read id, which every caller recomputes from its own declared reference. */
type CachedResolution = Omit<ResolveReferenceResult, "reads">;

/** Resolutions keyed by recipe id. Each promise is set before it is awaited, so concurrent
 * callers converge on one answer. */
export type ResolutionTable = Map<string, Promise<CachedResolution>>;

export interface ResolveReferenceOptions {
  readonly index: IndexDb;
  readonly store: RecordWriter;
  /** Required only when the reference is not resolvable from local bytes alone. */
  readonly method?: ResolutionMethod;
  /** How old a reused receipt may be; unbounded when unset. */
  readonly ageLimitMs?: number;
  readonly localDir?: string;
  readonly layerDeclarations?: ReadonlyMap<string, LayerDeclaration>;
  /** Where a fetch method's body over the blob threshold is written, and its configuration. */
  readonly fetchStore?: FetchStore;
  readonly now: Clock;
}

export interface ResolveReferenceResult {
  /** The declared reference with `digest` filled in; a moving one is annotated with the receipt
   * that resolved it. */
  readonly descriptor: ResourceDescriptor;
  /** The resolution's receipt, or `null` when nothing was performed. */
  readonly resolutionReceipt: RecordId | null;
  /** The declared reference's read id, contributed whichever path resolved it. */
  readonly reads: ReadonlySet<string>;
}

function hasDigest(descriptor: ResourceDescriptor): boolean {
  return descriptor.digest !== undefined && Object.keys(descriptor.digest).length > 0;
}

function locallyResolvable(descriptor: ResourceDescriptor): boolean {
  return hasDigest(descriptor) || (descriptor.uri?.startsWith("file://") ?? false);
}

const HEX_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function digestFromRunOutput(reference: string, output: string): DigestSet {
  const trimmed = output.trim();
  if (!HEX_DIGEST_PATTERN.test(trimmed)) {
    throw new ResolutionRefusedError(
      `refusing to resolve ${reference}: its run's output was not a bare sha256 hex digest`,
    );
  }
  return { sha256: trimmed };
}

function digestFromFetchObservation(reference: string, record: PerformedRunRecord): DigestSet {
  const digest = record.observation.resolved[0]?.digest;
  if (digest === undefined || Object.keys(digest).length === 0) {
    throw new ResolutionRefusedError(`refusing to resolve ${reference}: its fetch produced no content digest`);
  }
  return digest;
}

function withinAge(startedAt: Timestamp, ageLimitMs: number, now: Clock): boolean {
  return instantOf(now()) - instantOf(startedAt) <= ageLimitMs;
}

async function performResolution(
  reference: string,
  method: ResolutionMethod,
  options: ResolveReferenceOptions,
  now: Clock,
): Promise<{ readonly record: PerformedRunRecord; readonly digest: DigestSet }> {
  if (method.kind === "run") {
    const { recipe, observation } = await performRecipe(method.recipe, {
      now,
      localDir: options.localDir,
      layerDeclarations: options.layerDeclarations,
    });
    const record: PerformedRunRecord = {
      kind: "run",
      schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
      runKind: "run",
      performer: RUNNER_PERFORMER,
      determinism: "nondeterministic",
      recipe,
      observation,
      supersedes: [],
    };
    return {
      record,
      digest: digestFromRunOutput(reference, textOf(observation.output, `the output resolving ${reference}`)),
    };
  }
  const { record } = await performFetch(
    method.recipe,
    { localDir: options.localDir, layerDeclarations: options.layerDeclarations },
    options.fetchStore ?? {},
    { now },
  );
  return { record, digest: digestFromFetchObservation(reference, record) };
}

/** The one place a resolution receipt is minted or reused; it runs once per table entry. */
async function resolveOnce(
  recipeId: RecordId,
  declared: ResourceDescriptor,
  referenceLabel: string,
  method: ResolutionMethod,
  options: ResolveReferenceOptions,
): Promise<CachedResolution> {
  const now = options.now;
  const ageLimitMs = options.ageLimitMs ?? Number.POSITIVE_INFINITY;

  const existing = options.index.receiptByRecipe(recipeId);
  if (existing !== undefined && withinAge(existing.startedAt, ageLimitMs, now)) {
    const storedDigest =
      method.kind === "run"
        ? digestFromRunOutput(
            referenceLabel,
            textOf(existing.record.observation.output, `the output resolving ${referenceLabel}`),
          )
        : // A resolution's recipe is performed, so the receipt answering it is.
          digestFromFetchObservation(referenceLabel, existing.record as PerformedRunRecord);
    return {
      descriptor: {
        ...declared,
        digest: { ...storedDigest },
        annotations: { ...(declared.annotations ?? {}), resolvedBy: existing.recordId },
      },
      resolutionReceipt: existing.recordId,
    };
  }

  const { record, digest } = await performResolution(referenceLabel, method, options, now);
  const resolutionReceipt = await options.store.put("run", record);
  return {
    descriptor: {
      ...declared,
      digest: { ...digest },
      annotations: { ...(declared.annotations ?? {}), resolvedBy: resolutionReceipt },
    },
    resolutionReceipt,
  };
}

/** A digest computable from local bytes is never a resolution run. A moving reference resolves
 * once per evaluation into an ordinary receipt that never overwrites an earlier one. */
export async function resolveReference(
  reference: Reference,
  table: ResolutionTable,
  options: ResolveReferenceOptions,
): Promise<ResolveReferenceResult> {
  const declared = reference.declared;
  const readId = substrateReadId(declared);
  const reads = new Set([readId]);
  const referenceLabel = declared.uri ?? JSON.stringify(declared.digest ?? {});

  if (hasDigest(declared)) {
    return { descriptor: { ...declared, digest: { ...declared.digest } }, resolutionReceipt: null, reads };
  }

  if (locallyResolvable(declared)) {
    // Only a descriptor with no digest reaches here, so never a named commit: no checkouts needed.
    const [resolved] = await resolveSubstrates([declared], {});
    return { descriptor: resolved!, resolutionReceipt: null, reads };
  }

  if (options.method === undefined) {
    throw new ResolutionRefusedError(
      `refusing to resolve ${referenceLabel}: it names a moving reference, and no resolver was supplied for it`,
    );
  }
  const method = options.method;
  const recipeId = resolutionRecipeId(method);

  // Set synchronously after the lookup, so racing calls for one recipe id share this promise.
  let pending = table.get(recipeId);
  if (pending === undefined) {
    pending = resolveOnce(recipeId, declared, referenceLabel, method, options);
    table.set(recipeId, pending);
  }
  const cached = await pending;
  return { ...cached, reads };
}
