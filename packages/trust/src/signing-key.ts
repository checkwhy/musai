import type { Stats } from "node:fs";
import { access, chmod, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isPlainObject, KernelError } from "@musai/records";
import { execa } from "execa";
import { type AllowedSigner, keyPrincipalOf, principalsOf } from "./allowed-signers.js";

/** Raised when a named or configured signing key is not there to sign with. */
export class SigningKeyError extends KernelError {
  constructor(message: string) {
    super({ reason: "workspace-incomplete", detail: message });
    this.name = "SigningKeyError";
  }
}

/** Where a signing key was found, so a refusal can say where it looked. */
export type SigningKeySource = "named" | "workspace" | "allowed-signers";

export interface ResolvedSigningKey {
  readonly path: string;
  readonly source: SigningKeySource;
}

/** Owner-only, like every file under `local/`. */
const SIGNER_FILE_MODE = 0o600;

const SIGNER_FILE_NAME = "signer.json";

export function signerFilePath(localDir: string): string {
  return join(localDir, SIGNER_FILE_NAME);
}

/** This machine's signer: a private key path, never key material. It lives in the uncommitted
 * `local/`, so people sharing a workspace each sign with their own key. */
export interface SignerConfig {
  readonly keyPath?: string;
}

/** Reads the local signer configuration; a workspace that never named a key reads as none. */
export async function readSignerConfig(localDir: string): Promise<SignerConfig> {
  const path = signerFilePath(localDir);
  let stats: Stats;
  try {
    stats = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
  const mode = stats.mode & 0o777;
  if (mode !== SIGNER_FILE_MODE) {
    throw new SigningKeyError(
      `refusing ${path}: its mode is ${mode.toString(8)}, expected ${SIGNER_FILE_MODE.toString(8)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new SigningKeyError(`refusing ${path}: it is not valid JSON`);
  }
  if (!isPlainObject(parsed)) {
    throw new SigningKeyError(`refusing ${path}: it must hold an object naming a key path`);
  }
  const keyPath = parsed["keyPath"];
  if (keyPath === undefined) {
    return {};
  }
  if (typeof keyPath !== "string" || keyPath.length === 0) {
    throw new SigningKeyError(`refusing ${path}: keyPath must be a non-empty string naming a private key`);
  }
  return { keyPath };
}

/** The public line `ssh-keygen` wrote beside a private key; `null` where the private half is
 * absent or the public half is no key `ssh-keygen` reads. */
export async function publicKeyBeside(keyPath: string): Promise<string | null> {
  try {
    await access(keyPath);
    await execa("ssh-keygen", ["-l", "-f", `${keyPath}.pub`]);
    return (await readFile(`${keyPath}.pub`, "utf8")).trim();
  } catch {
    return null;
  }
}

/** Names the key this machine signs with in this workspace. */
export async function writeSignerConfig(localDir: string, config: Required<SignerConfig>): Promise<void> {
  const path = signerFilePath(localDir);
  await writeFile(path, `${JSON.stringify(config)}\n`, { mode: SIGNER_FILE_MODE });
  await chmod(path, SIGNER_FILE_MODE);
}

/** The principal the public half beside a private key names it by; null where none is there. */
export async function keyPrincipalAt(keyPath: string): Promise<string | null> {
  let publicKey: string;
  try {
    publicKey = await readFile(`${keyPath}.pub`, "utf8");
  } catch {
    return null;
  }
  try {
    return keyPrincipalOf(publicKey);
  } catch {
    return null;
  }
}

/** Exact membership only: OpenSSH's wildcard and negation forms are not implemented. */
function speaksFor(signer: AllowedSigner, principal: string): boolean {
  return principalsOf(signer).includes(principal);
}

/** The private key whose `<name>.pub` holds this key type and key, as OpenSSH writes pairs. */
async function privateKeyBeside(sshDir: string, keyType: string, key: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(sshDir);
  } catch {
    return null;
  }
  for (const entry of entries.filter((name) => name.endsWith(".pub")).sort()) {
    let content: string;
    try {
      content = await readFile(join(sshDir, entry), "utf8");
    } catch {
      continue;
    }
    const [foundType, foundKey] = content.trim().split(/\s+/);
    if (foundType === keyType && foundKey === key) {
      return join(sshDir, entry.slice(0, -".pub".length));
    }
  }
  return null;
}

export interface ResolveSigningKeyInput {
  /** A key named at the invocation; it outranks every other source. */
  readonly named?: string | undefined;
  /** The workspace's local directory, holding this machine's configured key. */
  readonly localDir: string;
  /** Matched against the allowed signers' principals; absent, no key pair is discovered. */
  readonly principal: string | undefined;
  /** The allowed signers on the trust branch. */
  readonly allowedSigners: readonly AllowedSigner[];
  /** Where discovery looks for key pairs; defaults to `~/.ssh`. */
  readonly sshDir?: string | undefined;
}

/** The signing key named at the invocation, else configured on this machine, else the pair
 * matching the principal's registered key; `null` when none names one. */
export async function resolveSigningKey(input: ResolveSigningKeyInput): Promise<ResolvedSigningKey | null> {
  if (input.named !== undefined && input.named.length > 0) {
    return { path: input.named, source: "named" };
  }

  const configured = await readSignerConfig(input.localDir);
  if (configured.keyPath !== undefined) {
    return { path: configured.keyPath, source: "workspace" };
  }

  const { principal } = input;
  if (principal === undefined) {
    return null;
  }
  const sshDir = input.sshDir ?? join(homedir(), ".ssh");
  for (const signer of input.allowedSigners.filter((candidate) => speaksFor(candidate, principal))) {
    const found = await privateKeyBeside(sshDir, signer.keyType, signer.key);
    if (found !== null) {
      return { path: found, source: "allowed-signers" };
    }
  }
  return null;
}
