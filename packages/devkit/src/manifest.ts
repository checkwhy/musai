import { type Context, constants, createContext, Script } from "node:vm";
import {
  DESCRIBE_OUTPUT_SCHEMA,
  decodeResponse,
  ENVELOPE_PROTOCOL,
  type EnvelopeRequest,
  encodeRequest,
} from "@musai/modules";
import type { ResourceDescriptor } from "@musai/records";
import {
  type ContributionEntry,
  canonicalBytes,
  DESCRIBE_CONTRIBUTION,
  KernelError,
  type ModuleManifest,
  type ToolchainEntry,
  versionString,
} from "@musai/records";
import { Ajv, type ValidateFunction } from "ajv";

/** The global a bundle's top level assigns its exports to, shared by the build and describe. */
export const MODULE_BUNDLE_GLOBAL = "__musaiModule";

/** Raised, before anything is minted, when a bundle's describe answer cannot become a manifest. */
export class ManifestError extends KernelError {
  constructor(message: string) {
    super({ reason: "invalid-input", detail: message });
    this.name = "ManifestError";
  }
}

const DESCRIBE_TIME_LIMIT_MS = 5000;
const CLOCK_DENIAL = "a contribution may not reach for the clock";
const RANDOMNESS_DENIAL = "a contribution may not draw randomness";

type DescribeOutcome =
  | { readonly kind: "settled"; readonly value: unknown }
  | { readonly kind: "threw"; readonly message: string }
  | { readonly kind: "unsettled" };

interface DescribeChannel {
  request: Uint8Array;
  result: DescribeOutcome | undefined;
}

/** A bundle answering describe is still a contribution, held to the in-process host's purity. */
function forbidClockAndRandomness(context: Context): void {
  const forbiddenDate = (): never => {
    throw new Error(CLOCK_DENIAL);
  };
  forbiddenDate.now = (): never => {
    throw new Error(CLOCK_DENIAL);
  };
  context["Date"] = forbiddenDate;
  (context["Math"] as { random: () => number })["random"] = (): never => {
    throw new Error(RANDOMNESS_DENIAL);
  };
}

/** Nothing a bundle could reach outside itself with. The encoders are the host's own classes, so
 * bytes built on either side of the boundary are the same kind of object. */
function buildDescribeContext(requestBytes: Uint8Array): Context {
  const context = createContext(constants.DONT_CONTEXTIFY, { microtaskMode: "afterEvaluate" });
  forbidClockAndRandomness(context);
  context["TextEncoder"] = TextEncoder;
  context["TextDecoder"] = TextDecoder;
  const channel: DescribeChannel = { request: requestBytes, result: undefined };
  context["__musaiDescribe"] = channel;
  return context;
}

/** Folds a value, a throw or a settled promise into the channel, as the in-process host does. */
function buildDescribeCallSource(globalName: string): string {
  return [
    "Promise.resolve()",
    `  .then(() => (${globalName}).invoke(globalThis.__musaiDescribe.request))`,
    '  .then((value) => { globalThis.__musaiDescribe.result = { kind: "settled", value }; })',
    '  .catch((error) => { globalThis.__musaiDescribe.result = { kind: "threw", message: error instanceof Error ? error.message : String(error) }; });',
  ].join("\n");
}

/** Runs a bundle's code once, outside the kernel's realm. A hang throws at the time limit; a call
 * that never settles leaves the channel empty. */
function runDescribe(bundleSource: string, globalName: string, requestBytes: Uint8Array): DescribeOutcome {
  const context = buildDescribeContext(requestBytes);
  const topLevel = new Script(bundleSource, { filename: "module-bundle.js" });
  topLevel.runInContext(context, { timeout: DESCRIBE_TIME_LIMIT_MS });
  // Frozen only after the top level runs: the bundle's IIFE assigns itself to a global `var`.
  Object.freeze(context);
  const callScript = new Script(buildDescribeCallSource(globalName), { filename: "module-bundle.js#describe" });
  callScript.runInContext(context, { timeout: DESCRIBE_TIME_LIMIT_MS });
  const channel = context["__musaiDescribe"] as DescribeChannel;
  return channel.result ?? { kind: "unsettled" };
}

const ajv = new Ajv({ strict: false, allErrors: true });
/** Compiled when first asked for, so loading the devkit compiles nothing. */
let describeOutput: ValidateFunction | undefined;

function describeRequest(): EnvelopeRequest {
  return {
    protocol: ENVELOPE_PROTOCOL,
    contribution: DESCRIBE_CONTRIBUTION,
    id: "describe",
    version: versionString("1"),
    input: null,
  };
}

function sortedContributions(entries: readonly ContributionEntry[]): ContributionEntry[] {
  return [...entries].sort((a, b) => {
    if (a.id !== b.id) {
      return a.id < b.id ? -1 : 1;
    }
    return a.version < b.version ? -1 : a.version > b.version ? 1 : 0;
  });
}

function sortedToolchain(entries: readonly ToolchainEntry[]): ToolchainEntry[] {
  return [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Derives a manifest by asking the bundle to describe itself, once, before anything is minted. */
export async function deriveManifest(
  moduleName: string,
  bundle: Uint8Array,
  packages: readonly string[],
  sourceTree: ResourceDescriptor,
  toolchain: readonly ToolchainEntry[],
): Promise<ModuleManifest> {
  const bundleSource = new TextDecoder().decode(bundle);
  const request = describeRequest();
  const requestBytes = encodeRequest(request);
  const outcome = runDescribe(bundleSource, MODULE_BUNDLE_GLOBAL, requestBytes);

  if (outcome.kind === "threw") {
    throw new ManifestError(
      `refusing to derive a manifest for ${moduleName}: the bundle's own code threw while answering describe: ${outcome.message}`,
    );
  }
  if (outcome.kind === "unsettled") {
    throw new ManifestError(
      `refusing to derive a manifest for ${moduleName}: the bundle's own code never answered describe within its time limit`,
    );
  }

  const response = decodeResponse(outcome.value as Uint8Array);
  if (!response.ok) {
    throw new ManifestError(
      `refusing to derive a manifest for ${moduleName}: describe answered ${response.error.code}: ${response.error.message}`,
    );
  }

  describeOutput ??= ajv.compile(DESCRIBE_OUTPUT_SCHEMA as Record<string, unknown>);
  if (!describeOutput(response.output)) {
    throw new ManifestError(
      `refusing to derive a manifest for ${moduleName}: describe's answer disagrees with the kernel's own contribution-table shape: ${ajv.errorsText(
        describeOutput.errors ?? [],
      )}`,
    );
  }

  const entries = response.output as ContributionEntry[];
  const seenIdentity = new Set<string>();
  for (const entry of entries) {
    if (!entry.id.startsWith(`${moduleName}/`)) {
      throw new ManifestError(
        `refusing to derive a manifest for ${moduleName}: contribution id ${entry.id} is not namespaced by its own module's name`,
      );
    }
    const identity = `${entry.id} ${entry.version}`;
    if (seenIdentity.has(identity)) {
      throw new ManifestError(
        `refusing to derive a manifest for ${moduleName}: two contributions share one id and version: ${entry.id}@${entry.version}`,
      );
    }
    seenIdentity.add(identity);
  }

  return {
    protocolVersion: ENVELOPE_PROTOCOL,
    contributions: sortedContributions(entries),
    sourceTree,
    toolchain: sortedToolchain(toolchain),
    packages: [...packages],
  };
}

export function manifestBytes(manifest: ModuleManifest): Uint8Array {
  return canonicalBytes(manifest);
}
