import { posix } from "node:path";
import type { PerformedRunRecord, ResourceDescriptor, RunRecipe } from "@musai/records";
import { KernelError } from "@musai/records";
import { execa, execaSync } from "execa";
import { onExit } from "signal-exit";
import { CREATED_SCRATCH_SUBDIRS, hygienicEnvironment } from "./hygiene.js";
import { shellWord } from "./shell.js";

/** Marks the substrate that is the declared image; its tag resolves like any moving reference. */
export const CONTAINER_IMAGE_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";

export function isContainerImageSubstrate(descriptor: ResourceDescriptor): boolean {
  return descriptor.mediaType === CONTAINER_IMAGE_MEDIA_TYPE;
}

/** The tree's read-only mount, fixed so a working directory stays relative and portable. */
export const CONTAINER_MOUNT_ROOT = "/musai/tree";

const CONTAINER_SCRATCH_ROOT = "/musai/scratch";

/** A tmpfs per scratch directory, as an image's root leaves what it writes there unremovable by the
 * author in a bind-mounted scratch; executable, as a build runs what it writes to its temp. */
const CONTAINER_PRIVATE_ROOT = "/musai/private";

/** An engine slower than this to answer reads as unavailable rather than hanging the run. */
const ENGINE_PROBE_TIMEOUT_MS = 5000;

export const DEFAULT_CONTAINER_ENGINE = "docker";

/** No engine can hold a declared image and the policy refuses, which is the default. */
export class ContainerUnavailableError extends KernelError {
  constructor(message: string) {
    super({ reason: "tool-unavailable", detail: message });
    this.name = "ContainerUnavailableError";
  }
}

/** Asks the engine's own `info` rather than probing a socket, whose location differs by
 * platform and installation. */
export async function containerEngineAvailable(engine: string): Promise<boolean> {
  try {
    const result = await execa(engine, ["info"], { reject: false, timeout: ENGINE_PROBE_TIMEOUT_MS });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/** A name no concurrent run's container holds; it reaches no receipt, so nothing digests it. */
export function containerName(): string {
  return `musai-run-${globalThis.crypto.randomUUID()}`;
}

/** Ends a container its run outlived, whose PID 1 ignores SIGTERM, through its run's engine
 * environment; `kill` goes first, as podman's `rm -f` stops gently before it kills. */
export async function endContainer(
  engine: string,
  name: string,
  environment: Readonly<Record<string, string>>,
): Promise<void> {
  const options = { reject: false, timeout: ENGINE_PROBE_TIMEOUT_MS, env: environment } as const;
  await execa(engine, ["kill", name], options);
  await execa(engine, ["rm", "-f", name], options);
}

/** How long an exiting process waits on each live run's `kill`: a supervisor's stop allows seconds
 * for every run at once, and `--rm` removes the container once it is dead. */
const EXIT_KILL_TIMEOUT_MS = 2000;

/** Kills the container should this process exit first, as the run's own exit handler ends its
 * tree; an exiting process runs nothing asynchronous, so the engine is called synchronously. */
export function endContainerOnExit(
  engine: string,
  name: string,
  environment: Readonly<Record<string, string>>,
): () => void {
  return onExit(() => {
    execaSync(engine, ["kill", name], { reject: false, timeout: EXIT_KILL_TIMEOUT_MS, env: environment });
  });
}

/** Strips a `:tag` so the digest replaces it. A colon before the last `/` is a registry port. */
function imageRepository(uri: string): string {
  const lastSlash = uri.lastIndexOf("/");
  const searchFrom = lastSlash === -1 ? 0 : lastSlash + 1;
  const colon = uri.indexOf(":", searchFrom);
  return colon === -1 ? uri : uri.slice(0, colon);
}

/** A scratch entry where the container finds it: its own directories on a tmpfs, the rest in the
 * mounted scratch. */
function insideContainer(entry: string): string {
  const own = (CREATED_SCRATCH_SUBDIRS as readonly string[]).includes(entry);
  return `${own ? CONTAINER_PRIVATE_ROOT : CONTAINER_SCRATCH_ROOT}/${entry}`;
}

/** Hygiene, then the recipe's literals in RFC 8785 key order, then each declared name once, which
 * the engine reads from its own environment: an argv is any local user's. */
function environmentArgs(recipe: RunRecipe): string[] {
  const literals = Object.entries(recipe.environment).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const declared = new Set(recipe.declared.map(({ name }) => name));
  const hygiene = Object.entries(hygienicEnvironment(recipe, insideContainer, {})).filter(
    ([name]) => !Object.hasOwn(recipe.environment, name),
  );
  const entries = [
    ...[...hygiene, ...literals].map(([name, value]) => (declared.has(name) ? name : `${name}=${value}`)),
    ...[...declared].filter((name) => !Object.hasOwn(recipe.environment, name)),
  ];
  return entries.flatMap((entry) => ["-e", entry]);
}

/** Where a container run's argv names this machine: the directory it mounts as the tree, its
 * scratch, and the container's name. */
export interface ContainerHost {
  readonly tree: string;
  readonly scratch: string;
  readonly name?: string;
}

/** The engine's arguments for a declared-image run, naming the image by digest. Networking is
 * off: a network a recipe cannot declare is a channel the receipt cannot describe. */
export function containerArgv(
  recipe: RunRecipe,
  resolvedImageDigest: string,
  host: ContainerHost,
  masked: readonly string[] = [],
): string[] {
  const imageDescriptor = recipe.substrates.find(isContainerImageSubstrate);
  if (imageDescriptor === undefined || imageDescriptor.uri === undefined) {
    throw new ContainerUnavailableError(
      "refusing to build a container argument array: the recipe names no image substrate with a locator",
    );
  }
  const imageRef = `${imageRepository(imageDescriptor.uri)}@sha256:${resolvedImageDigest}`;
  // An engine's own tmpfs defaults to noexec, and the long `--mount` form names no exec.
  const privateArgs = CREATED_SCRATCH_SUBDIRS.flatMap((directory) => [
    "--tmpfs",
    `${CONTAINER_PRIVATE_ROOT}/${directory}:exec,mode=1777`,
  ]);
  // An empty read-only mount hides a directory of the tree; Docker and Podman both read this form.
  const maskArgs = masked.flatMap((path) => [
    "--mount",
    `type=tmpfs,destination=${CONTAINER_MOUNT_ROOT}/${path},readonly`,
  ]);
  // An image's own entrypoint would take the command as its arguments: the receipt names what runs.
  const [program, ...programArguments] = recipe.command;

  return [
    "run",
    "--rm",
    ...(host.name === undefined ? [] : ["--name", host.name]),
    "--network",
    "none",
    "-v",
    `${host.tree}:${CONTAINER_MOUNT_ROOT}:ro`,
    ...maskArgs,
    "-v",
    `${host.scratch}:${CONTAINER_SCRATCH_ROOT}:rw`,
    ...privateArgs,
    "-w",
    CONTAINER_MOUNT_ROOT,
    ...environmentArgs(recipe),
    "--entrypoint",
    program,
    imageRef,
    ...programArguments,
  ];
}

/** The checkout an engine line mounts, a variable the shell refuses to expand while it is unset. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell parameter expansion, not a template
export const RECIPE_CHECKOUT_PLACEHOLDER = "${MUSAI_CHECKOUT:?set it to your checkout}";

const FRESH_SCRATCH = "$(mktemp -d)";

/** What a stranger types to perform a container recipe by hand: the line its run took, the
 * checkout named by a variable they set, a fresh scratch and no container name. */
export function engineLineOf(recipe: RunRecipe, resolvedImageDigest: string): string[] {
  const { workingDirectory } = recipe;
  // Uncleaned, as cleaning against a placeholder drops a leading `..` with the checkout before it.
  const tree = posix.isAbsolute(workingDirectory)
    ? workingDirectory
    : workingDirectory === "."
      ? RECIPE_CHECKOUT_PLACEHOLDER
      : `${RECIPE_CHECKOUT_PLACEHOLDER}/${workingDirectory}`;
  return [DEFAULT_CONTAINER_ENGINE, ...containerArgv(recipe, resolvedImageDigest, { tree, scratch: FRESH_SCRATCH })];
}

/** An engine line as its arguments and as one POSIX shell line. */
export interface EngineLine {
  readonly argv: readonly string[];
  readonly shell: string;
}

/** The engine line a receipt's run took, or `null` where it was held outside a container or
 * resolved its image to no digest. */
export function engineLineOfRun(run: PerformedRunRecord): EngineLine | null {
  const index = run.recipe.substrates.findIndex(isContainerImageSubstrate);
  const digest = run.observation.resolved[index]?.digest?.sha256;
  if (run.observation.isolationHeld !== "container" || !run.recipe.substrates[index]?.uri || !digest) {
    return null;
  }
  const argv = engineLineOf(run.recipe, digest);
  // The first two `-v` are the mounts, ahead of anything the recipe names.
  const tree = argv.indexOf("-v") + 1;
  const mounts = [tree, argv.indexOf("-v", tree) + 1];
  const words = argv.map((arg, at) => {
    const placeholder = [RECIPE_CHECKOUT_PLACEHOLDER, FRESH_SCRATCH].find((opening) => arg.startsWith(opening));
    return mounts.includes(at) && placeholder !== undefined
      ? `"${placeholder}"${shellWord(arg.slice(placeholder.length))}`
      : shellWord(arg);
  });
  return { argv, shell: words.join(" ") };
}
