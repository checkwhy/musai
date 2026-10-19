import { chmod, link, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Clock, isPlainObject, KernelError, type Timestamp, timestamp } from "@musai/records";
import { gitCheckIgnored } from "./git.js";

const KEY_FILE_MODE = 0o600;

const KEY_FILE_NAME = "keys.json";

function keyFilePath(localDir: string): string {
  return join(localDir, KEY_FILE_NAME);
}

/** A retired key is never deleted, so a receipt minted under it stays checkable here. */
export interface WorkspaceKey {
  readonly id: string;
  readonly status: "current" | "retired";
  readonly createdAt: Timestamp;
  /** Lowercase hex, never written anywhere but the key file. */
  readonly material: string;
}

export interface KeyFile {
  readonly keys: readonly WorkspaceKey[];
}

export class KeyFileError extends KernelError {
  constructor(message: string) {
    super({ reason: "workspace-incomplete", detail: message });
    this.name = "KeyFileError";
  }
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("hex");
}

function newKey(at: Timestamp): WorkspaceKey {
  return {
    id: globalThis.crypto.randomUUID(),
    status: "current",
    createdAt: at,
    material: randomHex(32),
  };
}

/** Only access beyond the owner is refused; a mode narrower than 0600 grants nobody anything. */
function assertMode(mode: number): void {
  const found = mode & 0o777;
  if ((found & 0o077) !== 0) {
    throw new KeyFileError(
      `refusing ${KEY_FILE_NAME}: its mode is ${found.toString(8)}, which grants access beyond its owner; ${KEY_FILE_MODE.toString(8)} or narrower is expected`,
    );
  }
}

function assertField(index: number, condition: boolean, field: string, expected: string): void {
  if (!condition) {
    throw new KeyFileError(`refusing ${KEY_FILE_NAME}: entry ${index}'s ${field} must be ${expected}`);
  }
}

function parseKeyFile(parsed: unknown): KeyFile {
  if (!isPlainObject(parsed)) {
    throw new KeyFileError(`refusing ${KEY_FILE_NAME}: it must be an object holding a "keys" array`);
  }
  const rawKeys = parsed["keys"];
  if (!Array.isArray(rawKeys)) {
    throw new KeyFileError(`refusing ${KEY_FILE_NAME}: "keys" must be an array`);
  }
  const keys: WorkspaceKey[] = rawKeys.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new KeyFileError(`refusing ${KEY_FILE_NAME}: entry ${index} must be an object`);
    }
    assertField(index, typeof entry["id"] === "string", "id", "a string");
    assertField(
      index,
      entry["status"] === "current" || entry["status"] === "retired",
      "status",
      '"current" or "retired"',
    );
    assertField(index, typeof entry["createdAt"] === "string", "createdAt", "a string");
    assertField(index, typeof entry["material"] === "string", "material", "a string");
    return {
      id: entry["id"] as string,
      status: entry["status"] as "current" | "retired",
      createdAt: timestamp(entry["createdAt"] as string),
      material: entry["material"] as string,
    };
  });
  return { keys };
}

/** Only the error code, since the system's message holds an absolute path a verdict may carry. */
function unusable(error: unknown, doing: string): KeyFileError {
  return new KeyFileError(
    `refusing ${KEY_FILE_NAME}: it could not be ${doing} (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`,
  );
}

/** An absent file passes through as the system's ENOENT, for the callers that mint on it. */
export async function readKeyFile(localDir: string): Promise<KeyFile> {
  const path = keyFilePath(localDir);
  let raw: string;
  try {
    const stats = await stat(path);
    assertMode(stats.mode);
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof KeyFileError || (error as NodeJS.ErrnoException).code === "ENOENT") {
      throw error;
    }
    throw unusable(error, "read");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new KeyFileError(`refusing ${KEY_FILE_NAME}: it is not valid JSON`);
  }
  return parseKeyFile(parsed);
}

/** Written whole under a name of its own first, so no reader sees the key file part-written. */
async function placeWhole(
  path: string,
  file: KeyFile,
  place: (from: string, to: string) => Promise<void>,
): Promise<void> {
  const aside = `${path}.${globalThis.crypto.randomUUID()}`;
  try {
    await writeFile(aside, JSON.stringify(file), { flag: "wx", mode: KEY_FILE_MODE });
    await chmod(aside, KEY_FILE_MODE);
    await place(aside, path);
  } finally {
    await rm(aside, { force: true });
  }
}

/** Creates the key file exclusively, so a racing call reads the winner's. It is refused inside an
 * enclosing working tree that does not ignore the local directory, which would stage the key. */
export async function mintKeyFile(localDir: string, options: { now: Clock }): Promise<KeyFile> {
  const musaiDir = dirname(localDir);
  const ignoreStatus = await gitCheckIgnored(localDir, dirname(musaiDir));
  if (ignoreStatus === "not-ignored") {
    throw new KeyFileError(
      `refusing to mint ${KEY_FILE_NAME}: the workspace's local directory sits in an enclosing git working tree that does not ignore it; add it to that tree's own ignore file before binding a secret or salting a record here, either of which mints the workspace key`,
    );
  }

  const path = keyFilePath(localDir);
  const file: KeyFile = { keys: [newKey(options.now())] };
  try {
    // A hard link refuses a name already taken, where a rename would replace the first key landed.
    await placeWhole(path, file, link);
    return file;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return readKeyFile(localDir);
    }
    throw unusable(error, "written");
  }
}

/** Every key the workspace has minted, oldest first; empty rather than ENOENT before the first. */
export async function listKeys(localDir: string): Promise<readonly WorkspaceKey[]> {
  try {
    return (await readKeyFile(localDir)).keys;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/** The workspace's current key, minting the key file when none exists yet. */
export async function workspaceKey(localDir: string, options: { now: Clock }): Promise<WorkspaceKey> {
  let file: KeyFile;
  try {
    file = await readKeyFile(localDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    file = await mintKeyFile(localDir, options);
  }
  return currentKey(file);
}

export function currentKey(file: KeyFile): WorkspaceKey {
  const current = file.keys.filter((key) => key.status === "current");
  if (current.length !== 1) {
    throw new KeyFileError(`the workspace key file must hold exactly one current key; found ${current.length}`);
  }
  return current[0]!;
}

export function keyMaterial(key: WorkspaceKey): Buffer {
  return Buffer.from(key.material, "hex");
}

/** `undefined` for a key this workspace never held, such as a peer's. */
export function keyById(file: KeyFile, id: string): WorkspaceKey | undefined {
  return file.keys.find((key) => key.id === id);
}

/** Retires the current key and adds a new one; a workspace with no key file mints its first. */
export async function rotateKey(localDir: string, options: { now: Clock }): Promise<KeyFile> {
  let existing: KeyFile;
  try {
    existing = await readKeyFile(localDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return mintKeyFile(localDir, { now: options.now });
    }
    throw error;
  }
  const retired = existing.keys.map((key) => (key.status === "current" ? { ...key, status: "retired" as const } : key));
  const file: KeyFile = {
    keys: [...retired, newKey(options.now())],
  };
  const path = keyFilePath(localDir);
  await placeWhole(path, file, rename);
  return file;
}
