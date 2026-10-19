import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeclaredName, Reason } from "@musai/records";
import { KernelError } from "@musai/records";

/** Created eagerly, so a tool spawned under the scratch never finds a dangling path. */
export const CREATED_SCRATCH_SUBDIRS = ["home", "tmp", "xdg-config", "xdg-cache", "xdg-data", "xdg-state"] as const;

/** Neutralised by assignment: pointed at the scratch, or set to turn the ambient source off. */
const ASSIGNED_CHANNELS = [
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "SSH_AUTH_SOCK",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_GLOBAL",
] as const;

/** Neutralised by absence: git reads each as set when present, the empty string included, so
 * the only neutral value is none. */
export const ABSENT_CHANNELS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CONFIG_COUNT"] as const;

/** Closed: a channel not named here is not one the runner claims to have nulled. */
export const AMBIENT_CHANNELS = [...ASSIGNED_CHANNELS, ...ABSENT_CHANNELS] as const;

export type AmbientChannel = (typeof AMBIENT_CHANNELS)[number];

/** The child's `PATH` is the kernel's own to build. */
const RESERVED_NAME = "PATH";

/** Raised before anything spawns, when a run request cannot proceed. */
export class RunRefusedError extends KernelError {
  constructor(message: string, reason: Reason = "invalid-input", about: readonly string[] = []) {
    super({ reason, detail: message, about });
    this.name = "RunRefusedError";
  }
}

/** A recipe reaches for a binary no installed module declares. A binary under test is a
 * substrate pinned by digest and never reaches this check. */
export class UndeclaredBinaryError extends RunRefusedError {
  readonly binary: string;

  constructor(binary: string) {
    super(
      `refusing to run ${binary}: no installed module declares it as a requirement, and the workspace's config.json's "tools" does not name it; add it there to admit it`,
      "undeclared-binary",
      [binary],
    );
    this.name = "UndeclaredBinaryError";
    this.binary = binary;
  }
}

/** One run's scratch root, created for that run and removed when it ends. */
export interface ScratchPaths {
  readonly root: string;
}

/** Scratch for exactly one run: nothing an earlier run left is visible, and nothing outlives it. */
export async function withScratch<T>(fn: (scratch: ScratchPaths) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "musai-run-"));
  try {
    await Promise.all(CREATED_SCRATCH_SUBDIRS.map((name) => mkdir(join(root, name), { recursive: true })));
    return await fn({ root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Per-user git configuration points at a scratch path never created, not a device name, since
 * a device present on one platform is absent on another. */
function hygieneAssignments(scratch: ScratchPaths): Record<(typeof ASSIGNED_CHANNELS)[number], string> {
  const home = join(scratch.root, "home");
  const tmp = join(scratch.root, "tmp");
  return {
    HOME: home,
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
    XDG_CONFIG_HOME: join(scratch.root, "xdg-config"),
    XDG_CACHE_HOME: join(scratch.root, "xdg-cache"),
    XDG_DATA_HOME: join(scratch.root, "xdg-data"),
    XDG_STATE_HOME: join(scratch.root, "xdg-state"),
    SSH_AUTH_SOCK: "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(scratch.root, "unwritten-global-config"),
  };
}

interface HygienicEnvironmentRecipe {
  readonly environment: Readonly<Record<string, string>>;
  readonly declared: readonly DeclaredName[];
}

/** Read by a container engine's own client, which a bound value reaches through its environment. */
const ENGINE_CLIENT_PREFIXES = ["DOCKER_", "CONTAINER_", "CONTAINERS_", "PODMAN_", "BUILDAH_", "LD_", "DYLD_"];

/** Refuses a declared name that would steer the engine running a container rather than the run. */
export function refuseEngineClientNames(declared: readonly DeclaredName[]): void {
  for (const { name } of declared) {
    if (ENGINE_CLIENT_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      throw new RunRefusedError(
        `refusing ${name}: a container run's bound values reach its engine's own client, which reads ${name}`,
      );
    }
  }
}

function assertNoCollision(name: string, hygieneKeys: ReadonlySet<string>): void {
  if (name === RESERVED_NAME) {
    throw new RunRefusedError(`refusing ${name}: the child's PATH is the kernel's own to build`);
  }
  if (hygieneKeys.has(name)) {
    throw new RunRefusedError(`refusing ${name}: it is a channel the kernel's hygiene neutralises`);
  }
}

/** Hygiene, then recipe literals, then bound names, in that fixed order. A declared name absent
 * from `bound` is left out, unlike one bound to the empty string. */
export function hygienicEnvironment(
  recipe: HygienicEnvironmentRecipe,
  scratch: ScratchPaths,
  bound: Readonly<Record<string, string>>,
): Record<string, string> {
  const assignments = hygieneAssignments(scratch);
  const hygieneKeys = new Set<string>(AMBIENT_CHANNELS);

  for (const name of Object.keys(recipe.environment)) {
    assertNoCollision(name, hygieneKeys);
  }
  for (const declared of recipe.declared) {
    assertNoCollision(declared.name, hygieneKeys);
  }

  const boundValues: Record<string, string> = {};
  for (const declared of recipe.declared) {
    if (declared.name in bound) {
      boundValues[declared.name] = bound[declared.name]!;
    }
  }

  return { ...assignments, ...recipe.environment, ...boundValues };
}
