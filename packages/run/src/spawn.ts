import { realpath } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import type { ResourceDescriptor, SlotRegistry } from "@musai/records";
import {
  type BindingObservation,
  type Clock,
  type IsolationLevel,
  type RunObservation,
  type RunRecipe,
  resolveSlot,
  type SlotLayers,
  timestamp,
  toolingRefusal,
} from "@musai/records";
import { type WorkspaceKey, workspaceKey } from "@musai/store";
import { execa } from "execa";
import { authorisedBinary, declaredProgramsPath, type RequirementRegistry, resolveBinaries } from "./binaries.js";
import {
  type BindingsFile,
  bindDeclaredNames,
  type CheckoutBindings,
  type LayerDeclaration,
  readBindings,
} from "./bindings.js";
import {
  CONTAINER_MOUNT_ROOT,
  ContainerUnavailableError,
  containerArgv,
  containerEngineAvailable,
  DEFAULT_CONTAINER_ENGINE,
  isContainerImageSubstrate,
} from "./container.js";
import {
  hygienicEnvironment,
  RunRefusedError,
  refuseEngineClientNames,
  UndeclaredBinaryError,
  withScratch,
} from "./hygiene.js";
import { readMachineTools } from "./machine-tools.js";
import { portableValue, WORKING_ROOT_LABEL } from "./portable.js";
import { type BoundSecret, refuseSecretInArgv, scrubOutput, secretObservation, secretReadId } from "./secrets.js";
import { type Station, stationMasks, stationRecipeReady } from "./station.js";
import {
  boundDirectory,
  checkoutBindingsFor,
  insideCheckout,
  namesRoot,
  namesTree,
  resolveSubstrates,
} from "./substrate.js";

/** The core module's slot saying what the runner does when a declared level cannot be held. */
export const ISOLATION_POLICY_SLOT_ID = "musai.core/isolation-policy";

/** The cannot-hold policy the isolation-policy slot resolves to, `refuse` without a registry.
 * `ask` refuses: nothing here can ask a person, and refusing never does less than declared. */
export function containerPolicyFromSlot(
  registry: SlotRegistry | undefined,
  layers: SlotLayers | undefined,
): "refuse" | "degrade" {
  if (registry === undefined) {
    return "refuse";
  }
  const resolution = resolveSlot(ISOLATION_POLICY_SLOT_ID, registry, layers ?? {});
  return resolution.value === "degrade" ? "degrade" : "refuse";
}

export { ContainerUnavailableError } from "./container.js";

function hasDigest(descriptor: ResourceDescriptor): boolean {
  return descriptor.digest !== undefined && Object.keys(descriptor.digest).length > 0;
}

/** A digest or a `file://` locator resolves locally; a moving reference needs `resolveMoving`. */
async function resolveDeclaredSubstrates(
  substrates: readonly ResourceDescriptor[],
  resolveMoving: ((descriptor: ResourceDescriptor) => Promise<ResourceDescriptor>) | undefined,
  checkouts: CheckoutBindings,
  recordDirs: readonly string[],
): Promise<ResourceDescriptor[]> {
  const resolved: ResourceDescriptor[] = [];
  for (const descriptor of substrates) {
    if (hasDigest(descriptor) || namesTree(descriptor) || (descriptor.uri?.startsWith("file://") ?? false)) {
      const [local] = await resolveSubstrates([descriptor], checkouts, recordDirs);
      resolved.push(local!);
      continue;
    }
    if (resolveMoving === undefined) {
      throw new RunRefusedError(
        `refusing to run: substrate ${descriptor.uri ?? JSON.stringify(descriptor)} names a moving reference, and no resolver was supplied for it`,
      );
    }
    resolved.push(await resolveMoving(descriptor));
  }
  return resolved;
}

export { RunRefusedError } from "./hygiene.js";

export interface SpawnResult {
  readonly recipe: RunRecipe;
  readonly observation: RunObservation;
  /** Content ids this run read, a secret binding's among them, for dirty propagation. */
  readonly reads: ReadonlySet<string>;
  /** Whether `timeoutMs` ended the run, which the exit code alone cannot tell. */
  readonly timedOut: boolean;
}

/** A canary's measurement of hygiene nulling, typed here because `canary.ts` imports this. */
export interface HygieneProof {
  readonly channels: readonly { readonly status: "absent" | "denied" | "present" }[];
}

/** A bound secret shorter than this is not scrubbed, so output never becomes substitutions. */
const DEFAULT_SCRUB_MINIMUM_LENGTH = 6;

export interface PerformRecipeOptions {
  /** Where the bindings, checkout and key files live; read only by a recipe that needs one. */
  readonly localDir?: string;
  /** Used in place of the bindings file. A secret flag here can raise a name the recipe
   * declared plain, never lower one it declared secret. */
  readonly bindings?: BindingsFile;
  /** Where the recipe's tree substrate is checked out, which a relative working directory
   * resolves against when the recipe names no checkout. */
  readonly workingRoot?: string;
  /** Directories beyond the workspace's that the run's records are written into, which a working
   * tree holding them is measured without. */
  readonly recordDirs?: readonly string[];
  /** Directories a plain binding's absolute path may sit under, each recorded by its label in
   * place of the directory, so a receipt names no path of this machine. */
  readonly bindingRoots?: Readonly<Record<string, string>>;
  /** The project layer's declaration of each name. */
  readonly layerDeclarations?: ReadonlyMap<string, LayerDeclaration>;
  readonly now?: Clock;
  readonly hygieneProof?: HygieneProof;
  /** Resolves a moving reference through `resolve.ts` without this module needing the store. */
  readonly resolveMovingSubstrate?: (descriptor: ResourceDescriptor) => Promise<ResourceDescriptor>;
  /** The engine binary that runs a declared image. */
  readonly containerEngine?: string;
  /** What a declared image does when no engine can hold it: `refuse` before spawning, or
   * `degrade` to hygiene with both levels recorded. Defaults to the isolation-policy slot. */
  readonly containerPolicy?: "refuse" | "degrade";
  /** The installed modules' slot registry, which the cannot-hold policy resolves against. */
  readonly slotRegistry?: SlotRegistry;
  /** The workspace's layer assignments; empty resolves the slot to its default. */
  readonly slotLayers?: SlotLayers;
  /** Installed modules' declared tooling; a recipe naming an undeclared binary is refused. Unset
   * by the kernel's own infrastructure, which mints no receipt a claim cites. */
  readonly requirementRegistry?: RequirementRegistry;
  /** Bytes written to the child's standard input before it is closed. */
  readonly input?: Uint8Array | string;
  /** How long to wait before ending the child; `timedOut` tells that ending apart. */
  readonly timeoutMs?: number;
  /** Set under a clearance: the run goes through the container substrate or is refused. */
  readonly station?: Station;
}

function isolationHeldFrom(declared: IsolationLevel, proof: HygieneProof | undefined): IsolationLevel {
  if (declared !== "hygiene" || proof === undefined) {
    return declared;
  }
  const everyChannelNulled = proof.channels.every((entry) => entry.status !== "present");
  return everyChannelNulled ? "hygiene" : "none";
}

/** The highest exit code a completed process reports; a signal is recorded above it. */
const CLEAN_EXIT_CEILING = 255;

/** The signal an exit code records, or undefined for a code a process exited with. */
export function signalOfExitCode(exitCode: number): NodeJS.Signals | undefined {
  if (exitCode <= CLEAN_EXIT_CEILING) {
    return undefined;
  }
  const signalNumber = exitCode - CLEAN_EXIT_CEILING - 1;
  return (Object.keys(osConstants.signals) as NodeJS.Signals[]).find(
    (name) => osConstants.signals[name] === signalNumber,
  );
}

/** A child that never started is refused by its error code alone, since the error's message
 * names a host directory. */
function exitCodeFor(result: { exitCode?: number; signal?: NodeJS.Signals; code?: string }): number {
  if (result.signal !== undefined) {
    const signalNumber = osConstants.signals[result.signal];
    return CLEAN_EXIT_CEILING + 1 + signalNumber;
  }
  if (result.exitCode === undefined) {
    throw new RunRefusedError(
      `refusing to record a run that never started: spawning it failed with ${result.code ?? "no error code"}`,
    );
  }
  return result.exitCode;
}

/** A tracked symlink is measured as the target it names, so a working directory reached through
 * one could stand on an unmeasured tree. No refusal names a host path. */
async function refuseEscapingWorkingDirectory(
  hostWorkingDirectory: string,
  checkoutDirectory: string,
  checkoutName: string,
): Promise<void> {
  let real: string;
  let realCheckout: string;
  try {
    [real, realCheckout] = await Promise.all([realpath(hostWorkingDirectory), realpath(checkoutDirectory)]);
  } catch (error) {
    throw new RunRefusedError(
      `refusing to run: the working directory in the checkout bound for substrate ${checkoutName} could not be resolved (${(error as NodeJS.ErrnoException).code ?? "no error code"})`,
    );
  }
  if (real !== realCheckout && !real.startsWith(realCheckout + sep)) {
    throw new RunRefusedError(
      `refusing to run: the working directory resolves outside the checkout bound for substrate ${checkoutName}, so the run would stand on a tree nobody measured`,
    );
  }
}

export function decodeLossy(bytes: Uint8Array): { readonly text: string; readonly lossy: boolean } {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return { text, lossy: text.includes("�") };
}

/** The workspace's current key, minting the key file when none exists yet. */
export async function currentWorkspaceKey(localDir: string | undefined, now: Clock): Promise<WorkspaceKey> {
  if (localDir === undefined) {
    throw new RunRefusedError(
      "refusing to bind a secret: no workspace local directory was supplied to mint or read its key",
    );
  }
  return workspaceKey(localDir, { now });
}

/** The recipe's program, once a module declares or the workspace admits it and every tool the
 * recipe names. A binary under test is pinned by digest or purl and is never tooling. */
export function authorisedProgram(recipe: RunRecipe, registry: RequirementRegistry | undefined): string {
  const refusedTooling = toolingRefusal(recipe);
  if (refusedTooling !== null) {
    throw new RunRefusedError(`refusing to run: ${refusedTooling}`);
  }
  const program = recipe.command[0];
  if (program === undefined) {
    throw new RunRefusedError("a recipe's run request must name a command");
  }
  if (registry !== undefined) {
    for (const name of [program, ...(recipe.tooling ?? [])]) {
      if (authorisedBinary(registry, name) === undefined && !registry.tools.has(name)) {
        throw new UndeclaredBinaryError(name);
      }
    }
  }
  return program;
}

/** Where a recipe's working directory lies on this machine, under the first checkout it names or
 * else the given root, a checkout that is not bound being absent from `checkoutDirectories`. */
function workingPlaceOf(
  recipe: RunRecipe,
  checkouts: CheckoutBindings,
  options: Pick<PerformRecipeOptions, "workingRoot">,
) {
  const checkoutDirectories = recipe.substrates
    .filter(namesRoot)
    .flatMap((descriptor) => boundDirectory(checkouts, descriptor) ?? []);
  const workingRoot = checkoutDirectories.length === 0 ? options.workingRoot : checkoutDirectories[0];
  return { checkoutDirectories, workingRoot, host: resolve(workingRoot ?? "", recipe.workingDirectory) };
}

/** The refusals a recipe earns from its own words, before anything is resolved on this machine. */
function refuseMisdeclared(recipe: RunRecipe, workingRoot: string | undefined): void {
  const rootSubstrates = recipe.substrates.filter(namesRoot);
  const rootLabels = rootSubstrates.map(
    (descriptor) => descriptor.name ?? descriptor.uri ?? `commit ${descriptor.digest!.gitCommit}`,
  );
  if (rootSubstrates.length > 0 && !insideCheckout(recipe.workingDirectory)) {
    throw new RunRefusedError(
      `refusing to run: the working directory ${recipe.workingDirectory} leaves the checkout ${rootLabels.join(", ")}, so the run would stand on a tree nobody measured`,
    );
  }
  if (!isAbsolute(recipe.workingDirectory)) {
    if (rootSubstrates.length > 1) {
      throw new RunRefusedError(
        `refusing to run: the working directory ${recipe.workingDirectory} is relative, and the recipe names the checkouts ${rootLabels.join(", ")}, so it names no single root to resolve against`,
      );
    }
    if (rootSubstrates.length === 0 && workingRoot === undefined) {
      throw new RunRefusedError(
        `refusing to run: the working directory ${recipe.workingDirectory} is relative and needs the root of the substrate it is relative to`,
      );
    }
  }
  const declaresImage = recipe.substrates.some(isContainerImageSubstrate);
  if (recipe.isolation === "container" && !declaresImage) {
    throw new RunRefusedError(
      "refusing to run: a recipe declaring container isolation must name exactly one image substrate",
    );
  }
  if (declaresImage) {
    refuseEngineClientNames(recipe.declared);
  }
}

/** Every refusal a station gives a recipe before anything spawns: its image, its engine and its
 * mount; one the spawn's own refusal would precede is left to it. */
export async function refuseStationRun(
  asked: RunRecipe,
  options: Pick<PerformRecipeOptions, "localDir" | "workingRoot" | "containerEngine"> & { readonly station: Station },
): Promise<void> {
  const recipe = await stationRecipeReady(asked, options.station, options.containerEngine ?? DEFAULT_CONTAINER_ENGINE);
  try {
    authorisedProgram(recipe, undefined);
    refuseMisdeclared(recipe, options.workingRoot);
  } catch (error) {
    if (error instanceof RunRefusedError) {
      return;
    }
    throw error;
  }
  const checkouts = await checkoutBindingsFor(recipe.substrates, options.localDir, options.workingRoot);
  const named = recipe.substrates.filter(namesRoot).length;
  const place = workingPlaceOf(recipe, checkouts, options);
  const placed = isAbsolute(recipe.workingDirectory) || place.workingRoot !== undefined;
  if (placed && place.checkoutDirectories.length === named) {
    await stationMasks(place.host, options.station);
  }
}

/** The kernel's one spawn path. Everything refusable is refused before the child starts, and a
 * non-zero exit is data on the observation, never a thrown error. */
export async function performRecipe(asked: RunRecipe, options: PerformRecipeOptions = {}): Promise<SpawnResult> {
  const engine = options.containerEngine ?? DEFAULT_CONTAINER_ENGINE;
  const recipe = options.station === undefined ? asked : await stationRecipeReady(asked, options.station, engine);
  // Only a caller that never turns the observation into a record omits the clock.
  const now = options.now ?? (() => timestamp(new Date().toISOString()));
  const layerDeclarations = options.layerDeclarations ?? new Map<string, LayerDeclaration>();

  const program = authorisedProgram(recipe, options.requirementRegistry);
  const args = recipe.command.slice(1);
  const rootSubstrates = recipe.substrates.filter(namesRoot);
  refuseMisdeclared(recipe, options.workingRoot);
  const imageSubstrateIndex = recipe.substrates.findIndex(isContainerImageSubstrate);
  const declaresImage = imageSubstrateIndex !== -1;
  // A station's engine answered as its recipe was readied.
  const containerHeld = declaresImage && (options.station !== undefined || (await containerEngineAvailable(engine)));
  if (declaresImage && !containerHeld) {
    const policy = options.containerPolicy ?? containerPolicyFromSlot(options.slotRegistry, options.slotLayers);
    if (policy === "refuse") {
      const image = recipe.substrates[imageSubstrateIndex]!;
      throw new ContainerUnavailableError(
        `refusing to run: the recipe declares the image ${image.uri ?? image.digest?.sha256}, but ${engine} is not available on this machine`,
      );
    }
    // A permitting policy spawns the plain command under hygiene, recorded as not held.
  }

  // An image's digest fixes every program in it, so a container run names no host binary.
  const machineTools = containerHeld || options.localDir === undefined ? [] : await readMachineTools(options.localDir);
  // A missing binary is refused before the checkout is measured, since measuring runs git.
  const resolvedBinaries = containerHeld
    ? []
    : await resolveBinaries([...new Set([program, ...(recipe.tooling ?? []), ...machineTools])]);
  const checkouts = await checkoutBindingsFor(recipe.substrates, options.localDir, options.workingRoot);
  const resolvedSubstrates = await resolveDeclaredSubstrates(
    recipe.substrates,
    options.resolveMovingSubstrate,
    checkouts,
    [...(options.localDir === undefined ? [] : [dirname(options.localDir)]), ...(options.recordDirs ?? [])],
  );
  // Every named checkout is bound by now: resolution refuses one that is not.
  const { checkoutDirectories, workingRoot, host: hostWorkingDirectory } = workingPlaceOf(recipe, checkouts, options);
  if (checkoutDirectories.length > 0) {
    await refuseEscapingWorkingDirectory(hostWorkingDirectory, checkoutDirectories[0]!, rootSubstrates[0]!.name!);
  }

  const masked = options.station === undefined ? [] : await stationMasks(hostWorkingDirectory, options.station);

  const imageDigestHex = declaresImage ? resolvedSubstrates[imageSubstrateIndex]?.digest?.sha256 : undefined;
  if (declaresImage && imageDigestHex === undefined) {
    throw new RunRefusedError("refusing to run: the declared image substrate resolved to no digest");
  }

  const bindingsSource =
    options.bindings ??
    (recipe.declared.length > 0 && options.localDir !== undefined ? await readBindings(options.localDir) : {});
  const { bound, resolved } = await bindDeclaredNames(recipe.declared, bindingsSource, layerDeclarations);

  const boundSecrets: BoundSecret[] = resolved
    .filter((entry) => entry.secret)
    .map((entry) => ({ name: entry.name, value: entry.value }));
  refuseSecretInArgv(recipe.command, boundSecrets);

  const key = boundSecrets.length > 0 ? await currentWorkspaceKey(options.localDir, now) : undefined;

  const roots = new Map([
    ...(workingRoot === undefined ? [] : [[WORKING_ROOT_LABEL, workingRoot] as const]),
    ...Object.entries(options.bindingRoots ?? {}),
  ]);
  const recordedValue = (name: string, value: string): string => {
    const portable = portableValue(value, roots);
    if (portable === null) {
      throw new RunRefusedError(
        `refusing to run: the binding ${name} names ${value}, a path under neither the run's working root nor a root it declares, and its receipt would carry this machine's layout`,
      );
    }
    return portable;
  };
  // A helper is found on this machine's PATH or by its path; the receipt names it by program.
  const recordedCommand = (name: string, [helper, ...args]: readonly string[]): string[] => [
    basename(helper!),
    ...args.map((arg) => recordedValue(name, arg)),
  ];
  const reads = new Set<string>();
  const bindingObservations: BindingObservation[] = resolved.map((entry) => {
    if (entry.secret) {
      const observation = secretObservation(key!, entry.name, entry.value);
      reads.add(secretReadId(observation.name, observation.keyId!, observation.keyedHash!));
      return observation;
    }
    return {
      name: entry.name,
      secret: false,
      layer: "bindings",
      value:
        entry.command !== undefined
          ? JSON.stringify(recordedCommand(entry.name, entry.command))
          : recordedValue(entry.name, entry.value),
      keyedHash: null,
      keyId: null,
    };
  });

  return withScratch(async (scratch) => {
    const environment = hygienicEnvironment(recipe, scratch, bound);
    // A container keeps the image's own PATH: the host's directories name nothing inside it.
    const childEnvironment = containerHeld
      ? environment
      : { ...environment, PATH: await declaredProgramsPath(scratch.root, resolvedBinaries) };

    const startedAt = now();
    const result = containerHeld
      ? await execa(
          engine,
          containerArgv(
            recipe,
            imageDigestHex!,
            scratch,
            hostWorkingDirectory,
            CONTAINER_MOUNT_ROOT,
            childEnvironment,
            masked,
            Object.keys(bound),
          ),
          {
            env: bound,
            reject: false,
            encoding: "buffer",
            input: options.input,
            timeout: options.timeoutMs,
          },
        )
      : await execa(program, args, {
          cwd: hostWorkingDirectory,
          env: childEnvironment,
          extendEnv: false,
          reject: false,
          encoding: "buffer",
          input: options.input,
          timeout: options.timeoutMs,
        });
    const finishedAt = now();

    const captured = Buffer.concat([result.stdout ?? new Uint8Array(), result.stderr ?? new Uint8Array()]);
    const { text, lossy } = decodeLossy(captured);
    const { text: scrubbedText, report } = scrubOutput(text, boundSecrets, DEFAULT_SCRUB_MINIMUM_LENGTH);

    const isolationHeld = declaresImage
      ? containerHeld
        ? "container"
        : "hygiene"
      : isolationHeldFrom(recipe.isolation, options.hygieneProof);

    const observation: RunObservation = {
      resolved: resolvedSubstrates,
      isolationHeld,
      binaries: resolvedBinaries.map((binary) => ({ name: binary.name, digest: binary.digest })),
      bindings: bindingObservations,
      output: scrubbedText,
      outputLossy: lossy,
      exitCode: exitCodeFor(result),
      scrubbed: [...report],
      startedAt,
      finishedAt,
      reads: [],
      cost: {},
    };
    return { recipe, observation, reads, timedOut: result.timedOut ?? false };
  });
}
