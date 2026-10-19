import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateTestKey } from "@musai/test-support";
import { execa } from "execa";
import { describe, expect, test } from "vitest";
import {
  aliasOf,
  keyPrincipalOf,
  lineLackingKeyForm,
  parseAllowedSigners,
  shownPrincipal,
} from "../src/allowed-signers.js";
import { keyPrincipalAt } from "../src/signing-key.js";

const OTHER_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK2BQWDJDXC+Z7BUUruH+wCErasTO3aYNeoSUkCdWdb5";

describe("a key named as a principal", () => {
  test("is the fingerprint ssh-keygen -l prints for its public half", async () => {
    for (const type of ["ed25519", "rsa", "ecdsa"]) {
      const dir = await mkdtemp(join(tmpdir(), "musai-key-principal-"));
      const path = join(dir, "key");
      await execa("ssh-keygen", ["-q", "-t", type, "-N", "", "-C", "florin", "-f", path]);
      const printed = await execa("ssh-keygen", ["-l", "-E", "sha256", "-f", `${path}.pub`]);
      const fingerprint = printed.stdout.split(" ")[1]!;
      expect(fingerprint).toMatch(/^SHA256:/);
      expect(keyPrincipalOf(await readFile(`${path}.pub`, "utf8"))).toBe(`key:${fingerprint}`);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("is listed beside a name on its own allowed-signers line, and the name reads back as its alias", async () => {
    const key = await generateTestKey("florin");
    const principal = keyPrincipalOf(key.pubKeyLine);
    const signers = parseAllowedSigners(`florin,${principal} namespaces="musai" ${key.pubKeyLine}\n`);
    expect(signers).toHaveLength(1);
    expect(aliasOf(signers, principal)).toBe("florin");
    expect(aliasOf(signers, keyPrincipalOf(OTHER_KEY))).toBeUndefined();
    expect(shownPrincipal(signers, principal)).toBe(`florin (${principal})`);
    expect(shownPrincipal(signers, "pseudonym:k:00")).toBe("pseudonym:k:00");
  });

  test("a line binding the key under a name alone reads back with the key's form added, and nothing else changed", async () => {
    const key = await generateTestKey("florin");
    const signers = parseAllowedSigners(
      `mallory ${OTHER_KEY}\nflorin namespaces="musai",valid-after="20260101Z" ${key.pubKeyLine}\n`,
    );
    expect(lineLackingKeyForm(signers, key.principal)).toBe(
      `florin,${key.principal} namespaces="musai",valid-after="20260101Z" ${key.pubKeyLine}`,
    );
    const listed = parseAllowedSigners(`florin,${key.principal} ${key.pubKeyLine}\n`);
    expect(lineLackingKeyForm(listed, key.principal)).toBeNull();
    expect(lineLackingKeyForm(parseAllowedSigners(`mallory ${OTHER_KEY}\n`), key.principal)).toBeNull();
  });

  test("is read from the public half beside a private key, and is absent where no public half is", async () => {
    const key = await generateTestKey("florin");
    expect(await keyPrincipalAt(key.keyPath)).toBe(key.principal);
    expect(await keyPrincipalAt(join(key.dir, "absent"))).toBeNull();
  });

  test("never names another key: a line whose key form is not its own key's is refused", async () => {
    const key = await generateTestKey("mallory");
    const impersonated = keyPrincipalOf(OTHER_KEY);
    expect(() => parseAllowedSigners(`mallory,${impersonated} ${key.pubKeyLine}\n`)).toThrow(
      /one key never speaks as another/,
    );
    expect(() => parseAllowedSigners(`mallory,key:not-a-fingerprint ${key.pubKeyLine}\n`)).toThrow(
      /one key never speaks as another/,
    );
  });
});
