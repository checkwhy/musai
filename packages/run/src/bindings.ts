import type { Stats } from "node:fs";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { DeclaredName } from "@musai/records";
import { isPlainObject, KernelError } from "@musai/records";
import { execa } from "execa";

const BINDINGS_FILE_MODE = 0o600;

const BINDINGS_FILE_NAME = "bindings.json";

function bindingsFilePath(localDir: string): string {
  return join(localDir, BINDINGS_FILE_NAME);
}

/** A declared name's source on this machine: a literal `value` or a credential helper `command`.
 * Its `secret` flag can raise a name the recipe declared plain, never lower it. */
export interface BindingSource {
  readonly secret: boolean;
  readonly value?: string;
  readonly command?: readonly string[];
}

export type BindingsFile = Readonly<Record<string, BindingSource>>;

/** Raised when a declared name cannot resolve. */
export class BindingError extends KernelError {
  constructor(message: string) {
    super({ reason: "workspace-incomplete", detail: message });
    this.name = "BindingError";
  }
}

function assertEntry(name: string, condition: boolean, reason: string): void {
  if (!condition) {
    throw new BindingError(`refusing binding ${name} in ${BINDINGS_FILE_NAME}: ${reason}`);
  }
}

function parseBindingsFile(parsed: unknown): BindingsFile {
  if (!isPlainObject(parsed)) {
    throw new BindingError(`refusing ${BINDINGS_FILE_NAME}: it must be an object keyed by variable name`);
  }
  const entries: Record<string, BindingSource> = {};
  for (const [name, rawEntry] of Object.entries(parsed)) {
    assertEntry(name, isPlainObject(rawEntry), "each entry must be an object");
    const candidate = rawEntry as Record<string, unknown>;
    assertEntry(name, typeof candidate["secret"] === "boolean", "its secret flag must be a boolean");
    const hasValue = typeof candidate["value"] === "string";
    const hasCommand = Array.isArray(candidate["command"]);
    assertEntry(name, hasValue !== hasCommand, "it must declare exactly one of a value or a command");
    if (hasCommand) {
      assertEntry(
        name,
        (candidate["command"] as unknown[]).every((element) => typeof element === "string"),
        "its command must be an array of strings",
      );
    }
    entries[name] = hasValue
      ? { secret: candidate["secret"] as boolean, value: candidate["value"] as string }
      : { secret: candidate["secret"] as boolean, command: [...(candidate["command"] as string[])] };
  }
  return entries;
}

/** Names the error code alone: the system's message carries the absolute path. */
function unreadableBindings(error: unknown): BindingError {
  return new BindingError(
    `refusing ${BINDINGS_FILE_NAME}: it could not be read (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`,
  );
}

/** A missing file binds nothing. Refusals name the file by basename, since they can reach a
 * verdict's reason. */
export async function readBindings(localDir: string): Promise<BindingsFile> {
  const path = bindingsFilePath(localDir);
  let stats: Stats;
  try {
    stats = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw unreadableBindings(error);
  }
  const mode = stats.mode & 0o777;
  if (mode !== BINDINGS_FILE_MODE) {
    throw new BindingError(
      `refusing ${BINDINGS_FILE_NAME}: its mode is ${mode.toString(8)}, expected ${BINDINGS_FILE_MODE.toString(8)}`,
    );
  }
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw unreadableBindings(error);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BindingError(`refusing ${BINDINGS_FILE_NAME}: it is not valid JSON`);
  }
  return parseBindingsFile(parsed);
}

const CHECKOUTS_FILE_NAME = "checkouts.json";

/** The absolute path of a checkout's top level on this machine. */
export interface CheckoutBinding {
  readonly directory: string;
}

export type CheckoutBindings = Readonly<Record<string, CheckoutBinding>>;

function assertCheckoutEntry(name: string, condition: boolean, reason: string): void {
  if (!condition) {
    throw new BindingError(`refusing checkout ${name} in ${CHECKOUTS_FILE_NAME}: ${reason}`);
  }
}

/** Where each checkout named by commit sits. The directory never enters a record, so a receipt
 * reads the same on every machine; it is no secret, so its mode is not checked. */
export async function readCheckoutBindings(localDir: string): Promise<CheckoutBindings> {
  let raw: string;
  try {
    raw = await readFile(join(localDir, CHECKOUTS_FILE_NAME), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {};
    }
    throw new BindingError(`refusing ${CHECKOUTS_FILE_NAME}: it could not be read (${code ?? "unknown error"})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BindingError(`refusing ${CHECKOUTS_FILE_NAME}: it is not valid JSON`);
  }
  if (!isPlainObject(parsed)) {
    throw new BindingError(`refusing ${CHECKOUTS_FILE_NAME}: it must be an object keyed by substrate name`);
  }
  const checkouts: Record<string, CheckoutBinding> = {};
  for (const [name, entry] of Object.entries(parsed)) {
    assertCheckoutEntry(name, isPlainObject(entry), "each entry must be an object");
    const candidate = entry as Record<string, unknown>;
    assertCheckoutEntry(
      name,
      Object.keys(candidate).length === 1 && typeof candidate["directory"] === "string",
      "each entry must hold exactly a directory",
    );
    const directory = candidate["directory"] as string;
    assertCheckoutEntry(name, isAbsolute(directory), "its directory must be an absolute path");
    checkouts[name] = { directory };
  }
  return checkouts;
}

/** Binds `name` to `directory`, refusing a name another directory holds, as a pack checkout may. */
export async function bindCheckout(localDir: string, name: string, directory: string): Promise<void> {
  const bound = await readCheckoutBindings(localDir);
  const held = bound[name]?.directory;
  if (held !== undefined) {
    const real = (path: string) => realpath(path).catch(() => resolve(path));
    if ((await real(held)) === (await real(directory))) {
      return;
    }
    throw new KernelError({
      reason: "declaration-conflict",
      about: [name],
      detail: `refusing to bind ${name} to ${directory}: ${CHECKOUTS_FILE_NAME} binds it to ${held}; remove that binding, or bind the other checkout under another name`,
    });
  }
  const checkouts = { ...bound, [name]: { directory } };
  await writeFile(join(localDir, CHECKOUTS_FILE_NAME), `${JSON.stringify(checkouts, null, 2)}\n`);
}

/** Runs in the operator's inherited environment, the one deliberate exception to hygiene; the
 * receipt carries the command, never its output. */
async function runCredentialHelper(name: string, command: readonly string[]): Promise<string> {
  const [program, ...args] = command;
  if (program === undefined) {
    throw new BindingError(`refusing binding ${name}: its command is empty`);
  }
  const result = await execa(program, args, { reject: false });
  if (result.exitCode !== 0) {
    throw new BindingError(`refusing binding ${name}: its command exited ${result.exitCode ?? "with a signal"}`);
  }
  return (result.stdout ?? "").toString().trim();
}

/** A declared name's value, secret if any source raised it. */
export interface ResolvedBinding {
  readonly name: string;
  readonly secret: boolean;
  readonly value: string;
  /** Present when a command produced the value; the receipt records the command in its place. */
  readonly command?: readonly string[];
}

/** The project layer's declaration of a name: a secret flag it can raise, never lower. */
export interface LayerDeclaration {
  readonly secret: boolean;
}

export const DECLARED_NAMES_CONFIG_KEY = "declaredNames";

/** The project layer's secret flag for each name, from the workspace's configuration. The value
 * comes only from the local bindings file. */
export function layerDeclarationsFromConfig(config: {
  readonly values: Readonly<Record<string, unknown>>;
}): ReadonlyMap<string, LayerDeclaration> {
  const declared = config.values[DECLARED_NAMES_CONFIG_KEY];
  if (declared === undefined) {
    return new Map();
  }
  if (!isPlainObject(declared)) {
    throw new BindingError(
      `refusing to read ${DECLARED_NAMES_CONFIG_KEY} from the workspace's configuration: it must be an object keyed by variable name`,
    );
  }
  const layerDeclarations = new Map<string, LayerDeclaration>();
  for (const [name, entry] of Object.entries(declared)) {
    if (!isPlainObject(entry) || typeof entry["secret"] !== "boolean") {
      throw new BindingError(
        `refusing declaration ${name} in ${DECLARED_NAMES_CONFIG_KEY}: its secret flag must be a boolean`,
      );
    }
    layerDeclarations.set(name, { secret: entry["secret"] });
  }
  return layerDeclarations;
}

export interface BindDeclaredNamesResult {
  /** The table `hygienicEnvironment` receives. */
  readonly bound: Readonly<Record<string, string>>;
  /** One entry per declared name, in declared order, for the receipt's binding observations. */
  readonly resolved: readonly ResolvedBinding[];
}

/** Secrecy is the union of the recipe's, the bindings file's and the project layer's flags,
 * and none lowers another. */
export async function bindDeclaredNames(
  declared: readonly DeclaredName[],
  bindings: BindingsFile,
  layerDeclarations: ReadonlyMap<string, LayerDeclaration>,
): Promise<BindDeclaredNamesResult> {
  const bound: Record<string, string> = {};
  const resolved: ResolvedBinding[] = [];

  for (const declaration of declared) {
    const source = bindings[declaration.name];
    if (source === undefined) {
      throw new BindingError(
        `refusing to run: ${declaration.name} is declared but not bound; add it to ${BINDINGS_FILE_NAME} in the workspace's local directory`,
      );
    }
    const value =
      source.value !== undefined ? source.value : await runCredentialHelper(declaration.name, source.command!);
    const secret = declaration.secret || source.secret || (layerDeclarations.get(declaration.name)?.secret ?? false);
    bound[declaration.name] = value;
    resolved.push(
      source.command !== undefined
        ? { name: declaration.name, secret, value, command: source.command }
        : { name: declaration.name, secret, value },
    );
  }

  return { bound, resolved };
}
