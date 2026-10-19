import { describe, expect, test } from "vitest";
import { recordId } from "../src/canonical/canonicalize.js";
import { timestamp } from "../src/canonical/numbers.js";
import { isAttestingPrincipal, isKeyPrincipal, keyPrincipal } from "../src/record/principal.js";
import { isPseudonym, pseudonymFor } from "../src/record/pseudonym.js";
import { CURRENT_SCHEMA_VERSIONS, validateRecord } from "../src/record/schema.js";

const FINGERPRINT = `SHA256:${"Ab+/".repeat(10)}xyz`;
const KEY = `key:${FINGERPRINT}`;
const PSEUDONYM = `pseudonym:key-1:${"3f".repeat(32)}`;

function attestationBy(principal: string, schemaVersion: number): Record<string, unknown> {
  return {
    kind: "attestation",
    schemaVersion,
    subject: recordId({ example: "a record someone attests to" }),
    principal,
    principalClass: "person",
    via: "tty",
    purpose: "made",
    at: timestamp("2026-01-01T00:00:00.000Z"),
    supersedes: [],
  };
}

describe("an attestation's principal", () => {
  test("is a key in the audience grammar's form or a pseudonym, and nothing else", () => {
    expect(isKeyPrincipal(KEY)).toBe(true);
    expect(isKeyPrincipal(`key:SHA256:${"A".repeat(42)}`)).toBe(false);
    expect(isKeyPrincipal(`key:SHA256:${"A".repeat(43)}=`)).toBe(false);
    expect(isKeyPrincipal(`key:MD5:${"A".repeat(43)}`)).toBe(false);
    expect(isAttestingPrincipal(KEY)).toBe(true);
    expect(isAttestingPrincipal(PSEUDONYM)).toBe(true);
    expect(isAttestingPrincipal("florin")).toBe(false);
    expect(isAttestingPrincipal("public")).toBe(false);
  });

  test("names a key by the fingerprint ssh-keygen prints, and refuses anything else", () => {
    expect(keyPrincipal(FINGERPRINT)).toBe(KEY);
    expect(() => keyPrincipal("SHA256:short")).toThrow(RangeError);
  });

  test("at the current version is a key or a pseudonym, and a bare name is refused", () => {
    const version = CURRENT_SCHEMA_VERSIONS.attestation;
    expect(validateRecord(attestationBy(KEY, version))).toMatchObject({ ok: true });
    expect(validateRecord(attestationBy(PSEUDONYM, version))).toMatchObject({ ok: true });
    const named = validateRecord(attestationBy("florin", version));
    expect(named.ok).toBe(false);
    expect(!named.ok && named.error).toContain("never a bare name");
  });

  test("at an earlier version reads as minted, a bare name and all", () => {
    for (const version of [2, 3, 4, 5]) {
      const fields = attestationBy("florin", version);
      const read = validateRecord(version === 2 ? { ...fields, supersedes: undefined } : fields);
      expect(read).toMatchObject({ ok: true, record: { principal: "florin" } });
    }
  });
});

describe("a pseudonym minted for a name", () => {
  const key = { id: "8c0e2a5e-0000-4000-8000-000000000001", material: "11".repeat(32) };

  test("is the reserved form under the key's id, and the same name under the same key is one pseudonym", () => {
    const minted = pseudonymFor(key, "florin");
    expect(isPseudonym(minted)).toBe(true);
    expect(minted.startsWith(`pseudonym:${key.id}:`)).toBe(true);
    expect(pseudonymFor(key, "florin")).toBe(minted);
  });

  test("differs by name and by key, so a pseudonym tells nobody without the key who it is", () => {
    expect(pseudonymFor(key, "alice")).not.toBe(pseudonymFor(key, "florin"));
    expect(pseudonymFor({ ...key, material: "22".repeat(32) }, "florin")).not.toBe(pseudonymFor(key, "florin"));
  });
});
