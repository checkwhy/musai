import type { IndexDb } from "@musai/fold";
import type { DigestSet, PerformedRunRecord, ResourceDescriptor } from "@musai/records";
import {
  type Clock,
  citationRecipeFor,
  type FetchRecipe,
  instantOf,
  KernelError,
  type RecordId,
  recordId,
  type Timestamp,
} from "@musai/records";
import type { RecordWriter } from "@musai/store";
import type { LayerDeclaration } from "./bindings.js";
import { type FetchStore, performFetch } from "./fetch.js";
import { resolveSubstrates, substrateReadId } from "./substrate.js";

/** A resolution whose fetch yields no digest, refused by name rather than answered empty. */
export class ResolutionRefusedError extends KernelError {
  constructor(message: string) {
    super({ reason: "invalid-input", detail: message });
    this.name = "ResolutionRefusedError";
  }
}

/** Taken over the fetch's `citationRecipeFor` form, as `needId` does, so a resolution and a need
 * naming one fetch share a receipt. */
function resolutionRecipeId(fetch: FetchRecipe): RecordId {
  return recordId(citationRecipeFor(fetch));
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
  /** The fetch whose body's content digest resolves a reference local bytes cannot. */
  readonly fetch: FetchRecipe;
  /** How old a reused receipt may be; unbounded when unset. */
  readonly ageLimitMs?: number;
  readonly localDir?: string;
  readonly layerDeclarations?: ReadonlyMap<string, LayerDeclaration>;
  /** Where a fetched body over the blob threshold is written, and its configuration. */
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
  fetch: FetchRecipe,
  options: ResolveReferenceOptions,
  now: Clock,
): Promise<{ readonly record: PerformedRunRecord; readonly digest: DigestSet }> {
  const { record } = await performFetch(
    fetch,
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
  fetch: FetchRecipe,
  options: ResolveReferenceOptions,
): Promise<CachedResolution> {
  const now = options.now;
  const ageLimitMs = options.ageLimitMs ?? Number.POSITIVE_INFINITY;

  const existing = options.index.receiptByRecipe(recipeId);
  if (existing !== undefined && withinAge(existing.startedAt, ageLimitMs, now)) {
    // A resolution's recipe is performed, so the receipt answering it is.
    const storedDigest = digestFromFetchObservation(referenceLabel, existing.record as PerformedRunRecord);
    return {
      descriptor: {
        ...declared,
        digest: { ...storedDigest },
        annotations: { ...(declared.annotations ?? {}), resolvedBy: existing.recordId },
      },
      resolutionReceipt: existing.recordId,
    };
  }

  const { record, digest } = await performResolution(referenceLabel, fetch, options, now);
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

  const fetch = options.fetch;
  const recipeId = resolutionRecipeId(fetch);

  // Set synchronously after the lookup, so racing calls for one recipe id share this promise.
  let pending = table.get(recipeId);
  if (pending === undefined) {
    pending = resolveOnce(recipeId, declared, referenceLabel, fetch, options);
    table.set(recipeId, pending);
  }
  const cached = await pending;
  return { ...cached, reads };
}
