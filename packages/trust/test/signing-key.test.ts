import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseAllowedSigners } from "../src/allowed-signers.js";
import { readSignerConfig, resolveSigningKey, SigningKeyError } from "../src/signing-key.js";

const KEY_TYPE = "ssh-ed25519";
const KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyMaterialForOneFixtureOnly";
const SIGNERS = parseAllowedSigners(`florin ${KEY_TYPE} ${KEY}\n`);

async function withDirs<T>(fn: (localDir: string, sshDir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "musai-signing-key-"));
  const localDir = join(root, "local");
  const sshDir = join(root, "ssh");
  await mkdir(localDir, { recursive: true });
  await mkdir(sshDir, { recursive: true });
  try {
    return await fn(localDir, sshDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeSignerConfig(localDir: string, content: unknown, mode = 0o600): Promise<void> {
  const path = join(localDir, "signer.json");
  await writeFile(path, JSON.stringify(content), { mode });
  await chmod(path, mode);
}

async function writeKeyPair(sshDir: string, name: string, keyType: string, key: string): Promise<string> {
  await writeFile(join(sshDir, `${name}.pub`), `${keyType} ${key} florin@example\n`);
  await writeFile(join(sshDir, name), "PRIVATE KEY BYTES\n", { mode: 0o600 });
  return join(sshDir, name);
}

describe("the key that signs, from the first of three places that names one", () => {
  test("a key named at the invocation outranks a configured one and a discoverable one", async () => {
    await withDirs(async (localDir, sshDir) => {
      await writeSignerConfig(localDir, { keyPath: "/configured/key" });
      await writeKeyPair(sshDir, "id_ed25519", KEY_TYPE, KEY);

      const resolved = await resolveSigningKey({
        named: "/named/key",
        localDir,
        principal: "florin",
        allowedSigners: SIGNERS,
        sshDir,
      });

      expect(resolved).toEqual({ path: "/named/key", source: "named" });
    });
  });

  test("this machine's own configuration outranks a discoverable key", async () => {
    await withDirs(async (localDir, sshDir) => {
      await writeSignerConfig(localDir, { keyPath: "/configured/key" });
      await writeKeyPair(sshDir, "id_ed25519", KEY_TYPE, KEY);

      const resolved = await resolveSigningKey({ localDir, principal: "florin", allowedSigners: SIGNERS, sshDir });

      expect(resolved).toEqual({ path: "/configured/key", source: "workspace" });
    });
  });

  test("with nothing named or configured, the key pair beside the registered public key answers", async () => {
    await withDirs(async (localDir, sshDir) => {
      await writeKeyPair(sshDir, "id_other", KEY_TYPE, "AAAAC3NzaC1lZDI1NTE5AAAAISomeOtherKeyEntirely");
      const expected = await writeKeyPair(sshDir, "id_ed25519", KEY_TYPE, KEY);

      const resolved = await resolveSigningKey({ localDir, principal: "florin", allowedSigners: SIGNERS, sshDir });

      expect(resolved).toEqual({ path: expected, source: "allowed-signers" });
    });
  });

  test("a key pair the allowed signers do not register for this principal is not discovered", async () => {
    await withDirs(async (localDir, sshDir) => {
      await writeKeyPair(sshDir, "id_ed25519", KEY_TYPE, KEY);

      const resolved = await resolveSigningKey({
        localDir,
        principal: "somebody-else",
        allowedSigners: SIGNERS,
        sshDir,
      });

      expect(resolved).toBeNull();
    });
  });

  test("a principal the allowed signers register with no key pair on this machine answers with nothing", async () => {
    await withDirs(async (localDir, sshDir) => {
      const resolved = await resolveSigningKey({ localDir, principal: "florin", allowedSigners: SIGNERS, sshDir });
      expect(resolved).toBeNull();
    });
  });

  test("an entry speaking for several principals answers for each of them by name", async () => {
    await withDirs(async (localDir, sshDir) => {
      const shared = parseAllowedSigners(`florin,alex ${KEY_TYPE} ${KEY}\n`);
      const expected = await writeKeyPair(sshDir, "id_ed25519", KEY_TYPE, KEY);

      for (const principal of ["florin", "alex"]) {
        const resolved = await resolveSigningKey({ localDir, principal, allowedSigners: shared, sshDir });
        expect(resolved).toEqual({ path: expected, source: "allowed-signers" });
      }
    });
  });

  test("a signer file readable by anyone but its owner is refused by name and mode", async () => {
    await withDirs(async (localDir) => {
      await writeSignerConfig(localDir, { keyPath: "/configured/key" }, 0o644);
      await expect(readSignerConfig(localDir)).rejects.toThrow(SigningKeyError);
      await expect(readSignerConfig(localDir)).rejects.toThrow(/644/);
    });
  });

  test("a workspace that has never named a key reads as naming none, rather than failing", async () => {
    await withDirs(async (localDir) => {
      expect(await readSignerConfig(localDir)).toEqual({});
    });
  });

  test("a signer file that is not JSON, or names no string path, is refused rather than read as empty", async () => {
    await withDirs(async (localDir) => {
      await writeFile(join(localDir, "signer.json"), "{not json", { mode: 0o600 });
      await chmod(join(localDir, "signer.json"), 0o600);
      await expect(readSignerConfig(localDir)).rejects.toThrow(/not valid JSON/);

      await writeSignerConfig(localDir, { keyPath: 42 });
      await expect(readSignerConfig(localDir)).rejects.toThrow(/non-empty string/);
    });
  });
});
