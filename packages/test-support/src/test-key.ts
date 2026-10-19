import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";

export interface TestKey {
  readonly dir: string;
  readonly keyPath: string;
  readonly pubKeyLine: string;
  /** The alias allowed-signers lists beside the key. */
  readonly name: string;
  /** The key as a record names it, from the fingerprint `ssh-keygen -l` prints. */
  readonly principal: string;
}

export async function generateTestKey(name: string): Promise<TestKey> {
  const dir = await mkdtemp(join(tmpdir(), "musai-test-key-"));
  const keyPath = join(dir, "id_ed25519");
  await execa("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", name, "-f", keyPath, "-q"]);
  const pubKeyLine = (await readFile(`${keyPath}.pub`, "utf8")).trim();
  const printed = await execa("ssh-keygen", ["-l", "-E", "sha256", "-f", `${keyPath}.pub`]);
  const fingerprint = printed.stdout.split(" ")[1]!;
  return { dir, keyPath, pubKeyLine, name, principal: `key:${fingerprint}` };
}

/** The line `init --key` writes: the alias, then the key's own form, so either verifies. */
export function allowedSignersLine(key: TestKey, options?: string): string {
  const optionsPart = options ? `${options} ` : "";
  return `${key.name},${key.principal} ${optionsPart}${key.pubKeyLine}\n`;
}

export async function writeAllowedSigners(dir: string, content: string): Promise<string> {
  const path = join(dir, "allowed_signers");
  await writeFile(path, content);
  return path;
}
