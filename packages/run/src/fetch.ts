import type {
  BindingObservation,
  Clock,
  DeclaredName,
  DigestSet,
  PerformedRunRecord,
  ResourceDescriptor,
  RunObservation,
} from "@musai/records";
import {
  CURRENT_SCHEMA_VERSIONS,
  citationRecipeFor,
  exceedsBlobThreshold,
  type FetchRecipe,
  hexOfRecordId,
  KernelError,
  rawId,
} from "@musai/records";
import type { BlobStore } from "@musai/store";
import { bindDeclaredNames, type LayerDeclaration, readBindings } from "./bindings.js";
import { RunRefusedError } from "./hygiene.js";
import { RUNNER_PERFORMER } from "./performer.js";
import {
  type BoundSecret,
  refuseCredentialIn,
  refuseSecretInArgv,
  scrubOutput,
  secretObservation,
  secretReadId,
} from "./secrets.js";
import { currentWorkspaceKey, decodeLossy } from "./spawn.js";

/** A retrieval that could not cite its declared locator, refused before any network call. */
export class FetchRefusedError extends KernelError {
  constructor(message: string) {
    super({ reason: "invalid-input", detail: message });
    this.name = "FetchRefusedError";
  }
}

/** None of these is ever followed. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Outside every HTTP status, so a fetch that could not happen differs from one that disagreed. */
const TRANSPORT_FAILURE_EXIT_CODE = -1;

const DEFAULT_TIMEOUT_MS = 30_000;

const DEFAULT_RETRIES = 0;

/** The spawn path's floor: a shorter bound secret never turns a body into substitutions. */
const DEFAULT_SCRUB_MINIMUM_LENGTH = 6;

/** The binding seam `performRecipe` takes, so a fetch and a run bind a name identically. */
export interface PerformFetchBindingOptions {
  readonly localDir?: string;
  readonly layerDeclarations?: ReadonlyMap<string, LayerDeclaration>;
}

/** Where a body over the blob threshold is held, and the configuration naming the threshold. */
export interface FetchStore {
  readonly blobs?: BlobStore;
  readonly config?: Record<string, unknown>;
}

async function heldAsBlob(store: FetchStore, bytes: Uint8Array, locator: string): Promise<string> {
  if (store.blobs === undefined) {
    throw new KernelError({
      reason: "workspace-incomplete",
      detail: `refusing to hold the ${bytes.byteLength}-byte body of ${locator}: it is over the blob threshold, and this fetch was handed no blob store`,
      about: [locator],
    });
  }
  return store.blobs.put(bytes);
}

export interface PerformFetchOptions {
  readonly now: Clock;
  /** Bounds one attempt, not the whole call. */
  readonly timeoutMs?: number;
  /** Attempts beyond the first, made only after a transport failure. */
  readonly retries?: number;
}

export interface FetchResult {
  readonly record: PerformedRunRecord;
  /** Content ids this fetch read, a secret binding's among them, for dirty propagation. */
  readonly reads: ReadonlySet<string>;
}

function hexDigestOf(bytes: Uint8Array): string {
  return hexOfRecordId(rawId(bytes));
}

interface AttemptOutcome {
  readonly response?: Response;
  readonly error?: unknown;
}

async function attemptRetrieval(
  locator: string,
  headers: Readonly<Record<string, string>>,
  timeoutMs: number,
): Promise<AttemptOutcome> {
  try {
    const response = await fetch(locator, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { response };
  } catch (error) {
    return { error };
  }
}

/** Built over `citationRecipeFor`, as `needId` is, so a minted receipt and a reused one answer
 * for the same recipe id. */
function citationRecord(recipe: FetchRecipe, observation: RunObservation): PerformedRunRecord {
  return {
    kind: "run",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
    runKind: "citation",
    performer: RUNNER_PERFORMER,
    determinism: "nondeterministic",
    recipe: citationRecipeFor(recipe),
    observation,
  };
}

/** Retrieves a locator into a citation receipt through the platform's client, since a retrieval
 * has nothing for hygiene to build. A redirect is refused; a transport failure is a receipt. */
export async function performFetch(
  recipe: FetchRecipe,
  bound: PerformFetchBindingOptions = {},
  store: FetchStore,
  options: PerformFetchOptions,
): Promise<FetchResult> {
  const now = options.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const layerDeclarations = bound.layerDeclarations ?? new Map<string, LayerDeclaration>();

  const declared: DeclaredName[] = [...recipe.headers, ...recipe.names];
  const bindingsSource = declared.length > 0 && bound.localDir !== undefined ? await readBindings(bound.localDir) : {};
  const { bound: boundValues, resolved: resolvedBindings } = await bindDeclaredNames(
    declared,
    bindingsSource,
    layerDeclarations,
  );

  const boundSecrets: BoundSecret[] = resolvedBindings
    .filter((entry) => entry.secret)
    .map((entry) => ({ name: entry.name, value: entry.value }));
  const key = boundSecrets.length > 0 ? await currentWorkspaceKey(bound.localDir, now) : undefined;

  const reads = new Set<string>();
  const bindingObservations: BindingObservation[] = resolvedBindings.map((entry) => {
    if (entry.secret) {
      const observation = secretObservation(key!, entry.name, entry.value);
      reads.add(secretReadId(observation.name, observation.keyId!, observation.keyedHash!));
      return observation;
    }
    return {
      name: entry.name,
      secret: false,
      layer: "bindings",
      value: entry.command !== undefined ? JSON.stringify(entry.command) : entry.value,
      keyedHash: null,
      keyId: null,
    };
  });

  const headers: Record<string, string> = {};
  for (const header of recipe.headers) {
    headers[header.name] = boundValues[header.name]!;
  }
  refuseSecretInArgv([recipe.locator], boundSecrets);

  const startedAt = now();
  let outcome: AttemptOutcome = { error: new RunRefusedError(`${recipe.locator} named no attempt`) };
  for (let attempt = 0; attempt <= retries; attempt++) {
    outcome = await attemptRetrieval(recipe.locator, headers, timeoutMs);
    if (outcome.response !== undefined) {
      break;
    }
  }
  const finishedAt = now();

  if (outcome.response === undefined) {
    const failureMessage = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    const observation: RunObservation = {
      resolved: [],
      isolationHeld: "none",
      binaries: [],
      bindings: bindingObservations,
      output: failureMessage,
      outputLossy: false,
      exitCode: TRANSPORT_FAILURE_EXIT_CODE,
      scrubbed: [],
      startedAt,
      finishedAt,
      reads: [],
      cost: {},
    };
    return { record: citationRecord(recipe, observation), reads };
  }

  const response = outcome.response;
  if (REDIRECT_STATUSES.has(response.status)) {
    const location = response.headers.get("location") ?? "<no location header>";
    throw new FetchRefusedError(
      `refusing to follow a redirect: ${recipe.locator} responded ${response.status} asking to move to ${location}, and a citation's subject is the address the recipe declared`,
    );
  }

  const rawBytes = new Uint8Array(await response.arrayBuffer());
  const digestHex = hexDigestOf(rawBytes);
  const { text: rawText, lossy } = decodeLossy(rawBytes);
  const { text: scrubbedText, report } = scrubOutput(rawText, boundSecrets, DEFAULT_SCRUB_MINIMUM_LENGTH);
  refuseCredentialIn(recipe.locator, scrubbedText);
  const scrubbedBytes = new TextEncoder().encode(scrubbedText);

  const config = store.config ?? {};
  const storesAsBlob = exceedsBlobThreshold(scrubbedBytes.byteLength, config);
  const output = storesAsBlob ? await heldAsBlob(store, scrubbedBytes, recipe.locator) : scrubbedText;

  const digest: DigestSet = { sha256: digestHex };
  const resolvedDescriptor: ResourceDescriptor = {
    uri: recipe.locator,
    digest,
    annotations: { storage: storesAsBlob ? "blob" : "inline" },
  };

  const observation: RunObservation = {
    resolved: [resolvedDescriptor],
    isolationHeld: "none",
    binaries: [],
    bindings: bindingObservations,
    output,
    outputLossy: lossy,
    exitCode: response.status,
    scrubbed: [...report],
    startedAt,
    finishedAt,
    reads: [],
    cost: {},
  };

  return { record: citationRecord(recipe, observation), reads };
}
