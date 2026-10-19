import { relative, sep } from "node:path";
import type { ResourceDescriptor, RunRecipe } from "@musai/records";
import { KernelError } from "@musai/records";
import { execa } from "execa";
import { CREATED_SCRATCH_SUBDIRS, type ScratchPaths } from "./hygiene.js";

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

/** Strips a `:tag` so the digest replaces it. A colon before the last `/` is a registry port. */
function imageRepository(uri: string): string {
  const lastSlash = uri.lastIndexOf("/");
  const searchFrom = lastSlash === -1 ? 0 : lastSlash + 1;
  const colon = uri.indexOf(":", searchFrom);
  return colon === -1 ? uri : uri.slice(0, colon);
}

/** A host path under the scratch, named where it lives inside the container. */
function insideScratch(value: string, scratch: ScratchPaths): string {
  if (value !== scratch.root && !value.startsWith(scratch.root + sep)) {
    return value;
  }
  const parts = relative(scratch.root, value)
    .split(sep)
    .filter((part) => part.length > 0);
  const own = (CREATED_SCRATCH_SUBDIRS as readonly string[]).includes(parts[0] ?? "");
  return [own ? CONTAINER_PRIVATE_ROOT : CONTAINER_SCRATCH_ROOT, ...parts].join("/");
}

/** The engine's arguments for a declared-image run, naming the image by digest. Networking is
 * off: a network a recipe cannot declare is a channel the receipt cannot describe. */
export function containerArgv(
  recipe: RunRecipe,
  resolvedImageDigest: string,
  scratch: ScratchPaths,
  hostWorkingDirectory: string,
  mountRoot: string,
  environment: Readonly<Record<string, string>> = {},
  masked: readonly string[] = [],
  byName: readonly string[] = [],
): string[] {
  const imageDescriptor = recipe.substrates.find(isContainerImageSubstrate);
  if (imageDescriptor === undefined || imageDescriptor.uri === undefined) {
    throw new ContainerUnavailableError(
      "refusing to build a container argument array: the recipe names no image substrate with a locator",
    );
  }
  const imageRef = `${imageRepository(imageDescriptor.uri)}@sha256:${resolvedImageDigest}`;
  // A value named alone is read from the engine's own environment: an argv is any local user's.
  const environmentArgs = Object.entries(environment).flatMap(([name, value]) => [
    "-e",
    byName.includes(name) ? name : `${name}=${insideScratch(value, scratch)}`,
  ]);
  // An engine's own tmpfs defaults to noexec, and the long `--mount` form names no exec.
  const privateArgs = CREATED_SCRATCH_SUBDIRS.flatMap((directory) => [
    "--tmpfs",
    `${CONTAINER_PRIVATE_ROOT}/${directory}:exec,mode=1777`,
  ]);
  // An empty read-only mount hides a directory of the tree; Docker and Podman both read this form.
  const maskArgs = masked.flatMap((path) => ["--mount", `type=tmpfs,destination=${mountRoot}/${path},readonly`]);
  // An image's own entrypoint would take the command as its arguments: the receipt names what runs.
  const [program, ...programArguments] = recipe.command;

  return [
    "run",
    "--rm",
    "--network",
    "none",
    "-v",
    `${hostWorkingDirectory}:${mountRoot}:ro`,
    ...maskArgs,
    "-v",
    `${scratch.root}:${CONTAINER_SCRATCH_ROOT}:rw`,
    ...privateArgs,
    "-w",
    mountRoot,
    ...environmentArgs,
    "--entrypoint",
    program,
    imageRef,
    ...programArguments,
  ];
}
