import { access, copyFile, constants as fsConstants, mkdir, readFile, symlink } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { ContributionEntry, RequirementContributionInput } from "@musai/records";
import { hexOfRecordId, KernelError, rawId } from "@musai/records";
import { execa } from "execa";

/** A declared binary resolved on this process's `PATH`. The directory locates what the child's
 * `PATH` links to and never enters a record. */
export interface ResolvedBinary {
  readonly name: string;
  readonly digest: string;
  readonly directory: string;
}

export class BinaryNotFoundError extends KernelError {
  constructor(name: string) {
    super({
      reason: "tool-unavailable",
      detail: `no binary named ${name} was found on the invoking process's own PATH`,
      about: [name],
    });
    this.name = "BinaryNotFoundError";
  }
}

/** Two modules declare one binary under different predicates, so neither can authorise it. */
export class ConflictingRequirementError extends KernelError {
  constructor(binary: string, first: string, second: string) {
    super({
      reason: "declaration-conflict",
      detail: `refusing to authorise ${binary}: ${first} and ${second} declare it with different version predicates`,
      about: [binary, first, second],
    });
    this.name = "ConflictingRequirementError";
  }
}

async function firstDirectoryOnPath(name: string): Promise<string> {
  const searchPath = process.env["PATH"] ?? "";
  const directories = searchPath.split(delimiter).filter((entry) => entry.length > 0);
  for (const directory of directories) {
    try {
      await access(join(directory, name), fsConstants.X_OK);
      return directory;
    } catch {
      // No executable of this name here.
    }
  }
  throw new BinaryNotFoundError(name);
}

/** Resolves each name to its first executable on `PATH` and digests it. The directory is
 * returned for the child's `PATH` and never named in a record or a refusal. */
export async function resolveBinaries(names: readonly string[]): Promise<ResolvedBinary[]> {
  const resolved: ResolvedBinary[] = [];
  for (const name of names) {
    const directory = await firstDirectoryOnPath(name);
    let bytes: Buffer;
    try {
      bytes = await readFile(join(directory, name));
    } catch (error) {
      throw new KernelError({
        reason: "tool-unavailable",
        detail: `the binary ${name} found on the invoking process's own PATH could not be read to digest it (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`,
        about: [name],
      });
    }
    const digest = hexOfRecordId(rawId(bytes));
    resolved.push({ name, digest, directory });
  }
  return resolved;
}

/** A directory holding the resolved programs alone: their own directories would hand a run every
 * program beside them, which its receipt never names. */
export async function declaredProgramsPath(root: string, binaries: readonly ResolvedBinary[]): Promise<string> {
  const bin = join(root, "bin");
  await mkdir(bin);
  for (const binary of new Map(binaries.map((entry) => [entry.name, entry])).values()) {
    const target = join(binary.directory, binary.name);
    const link = join(bin, binary.name);
    // Windows grants a symlink only to a privileged process; a copy holds the same bytes.
    await symlink(target, link).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPERM") {
        throw error;
      }
      await copyFile(target, link);
    });
  }
  return bin;
}

/** A declared binary with the module that declared it, which refusals and `doctor` name. */
export interface RequirementEntry extends RequirementContributionInput {
  readonly declaredBy: string;
}

/** One binary under disagreeing predicates: the module folded first and the first to disagree. */
export interface RequirementConflict {
  readonly binary: string;
  readonly first: string;
  readonly second: string;
}

/** Declared tooling keyed by command-line name. A predicate disagreement is held in `conflicts`
 * and costs that binary alone. */
export interface RequirementRegistry {
  readonly byBinary: ReadonlyMap<string, RequirementEntry>;
  readonly conflicts: ReadonlyMap<string, RequirementConflict>;
  /** Programs the workspace's configuration admits for its own runs, with no version constraint. */
  readonly tools: ReadonlySet<string>;
}

export const TOOLS_CONFIG_KEY = "tools";

/** A name only, since a run finds every program on the invoking process's own `PATH`. */
export function isToolName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\\/]/.test(value);
}

/** The programs a workspace's `config.json` names under `tools`; absent, it names none. */
export function workspaceToolsFromConfig(config: {
  readonly values: Readonly<Record<string, unknown>>;
}): readonly string[] {
  const tools = config.values[TOOLS_CONFIG_KEY];
  if (tools === undefined) {
    return [];
  }
  if (!Array.isArray(tools) || !tools.every(isToolName)) {
    throw new KernelError({
      reason: "workspace-incomplete",
      detail: `refusing to read ${TOOLS_CONFIG_KEY} from the workspace's configuration: it must be a list of program names, each without a path separator`,
      about: [TOOLS_CONFIG_KEY],
    });
  }
  return tools;
}

/** Folds `requirement` rows in order. It never throws: a disagreement is refused where that
 * binary is authorised, never where the set is read. */
export function requirementsFromModules(
  rows: readonly { readonly moduleName: string; readonly entry: ContributionEntry }[],
  tools: readonly string[] = [],
): RequirementRegistry {
  const byBinary = new Map<string, RequirementEntry>();
  const conflicts = new Map<string, RequirementConflict>();
  for (const { moduleName, entry } of rows) {
    const input = entry.input as RequirementContributionInput;
    const existing = byBinary.get(input.binary);
    if (existing === undefined) {
      byBinary.set(input.binary, { ...input, declaredBy: moduleName });
      continue;
    }
    if (existing.versionPredicate !== input.versionPredicate && !conflicts.has(input.binary)) {
      conflicts.set(input.binary, { binary: input.binary, first: existing.declaredBy, second: moduleName });
    }
  }
  return { byBinary, conflicts, tools: new Set(tools) };
}

export function authorisedBinary(registry: RequirementRegistry, name: string): RequirementEntry | undefined {
  const conflict = registry.conflicts.get(name);
  if (conflict !== undefined) {
    throw new ConflictingRequirementError(conflict.binary, conflict.first, conflict.second);
  }
  return registry.byBinary.get(name);
}

/** A probe running longer reports no version rather than hanging its caller. */
const VERSION_PROBE_TIMEOUT_MS = 3000;

const VERSION_PATTERN = /\d+\.\d+(?:\.\d+)?/;

/** Longest first, so `>=` is read before `>`. */
const PREDICATE_OPERATORS = [">=", "<=", "==", ">", "<", "="] as const;

/** A missing segment reads as zero, so `24` and `24.0.0` are one version. */
function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10));
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    const a = leftParts[index] ?? 0;
    const b = rightParts[index] ?? 0;
    if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return 0;
}

/** `null` for a predicate form this kernel does not implement, which must read as unchecked,
 * never as satisfied. */
export function versionSatisfies(observed: string, predicate: string): boolean | null {
  const trimmed = predicate.trim();
  const operator = PREDICATE_OPERATORS.find((candidate) => trimmed.startsWith(candidate));
  if (operator === undefined) {
    return null;
  }
  const wanted = trimmed.slice(operator.length).trim();
  if (!/^\d+(?:\.\d+)*$/.test(wanted) || !/^\d+(?:\.\d+)*$/.test(observed)) {
    return null;
  }
  const ordering = compareVersions(observed, wanted);
  switch (operator) {
    case ">=":
      return ordering >= 0;
    case "<=":
      return ordering <= 0;
    case ">":
      return ordering > 0;
    case "<":
      return ordering < 0;
    default:
      return ordering === 0;
  }
}

/** The first version token `--version` prints, or `null`: an unreadable version is data,
 * never a refusal. */
export async function probeBinaryVersion(directory: string, binary: string): Promise<string | null> {
  const result = await execa(join(directory, binary), ["--version"], {
    reject: false,
    timeout: VERSION_PROBE_TIMEOUT_MS,
  }).catch(() => null);
  if (result === null) {
    return null;
  }
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return VERSION_PATTERN.exec(combined)?.[0] ?? null;
}
