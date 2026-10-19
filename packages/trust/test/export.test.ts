import { rm } from "node:fs/promises";
import type { Audience, PrincipalClass, ReleaseAttestationRecord } from "@musai/records";
import { CURRENT_SCHEMA_VERSIONS, canonicalBytes, recordId, timestamp, validateRecord } from "@musai/records";
import { allowedSignersLine, generateTestKey, writeAllowedSigners } from "@musai/test-support";
import { describe, expect, test } from "vitest";
import { type Attestation, mintAttestation } from "../src/attestation.js";
import { isSigningLevel, requireSignature, type SigningLevel } from "../src/level.js";
import { signAttestation } from "../src/sign.js";
import { verifyAttestation } from "../src/verify.js";

describe("the signing-level slot", () => {
  const combinations: Array<{ level: SigningLevel; principalClass: PrincipalClass; required: boolean }> = [
    { level: "off", principalClass: "person", required: false },
    { level: "off", principalClass: "agent", required: false },
    { level: "person", principalClass: "person", required: true },
    { level: "person", principalClass: "agent", required: false },
    { level: "all", principalClass: "person", required: true },
    { level: "all", principalClass: "agent", required: true },
  ];

  for (const { level, principalClass, required } of combinations) {
    test(`at ${level}, a ${principalClass} principal's attestation ${required ? "must" : "need not"} be verified`, () => {
      expect(requireSignature(level, principalClass)).toBe(required);
    });
  }

  test("with nothing configured, requireSignature behaves as at off", () => {
    expect(requireSignature(undefined, "person")).toBe(false);
    expect(requireSignature(undefined, "agent")).toBe(false);
  });

  test("an unrecognised level string throws and the message contains the offending value", () => {
    expect(() => requireSignature("occasionally", "person")).toThrow(/occasionally/);
  });

  test("isSigningLevel narrows exactly the three shipped levels", () => {
    expect(isSigningLevel("off")).toBe(true);
    expect(isSigningLevel("person")).toBe(true);
    expect(isSigningLevel("all")).toBe(true);
    expect(isSigningLevel("occasionally")).toBe(false);
  });
});

describe("verifying every person's attestation at the person level, failing fast on the first bad one", () => {
  test("three of a person's attestations are all verified, and a corrupted second one is reported by its own id", async () => {
    const key = await generateTestKey("alice@example.com");
    try {
      const allowedSignersPath = await writeAllowedSigners(key.dir, allowedSignersLine(key));
      const subject = recordId({ example: "a case's evidence" });
      const entries: Array<{ attestation: Attestation; signature: string }> = [];
      for (let index = 0; index < 3; index++) {
        const attestation = mintAttestation({
          subject,
          principal: key.principal,
          principalClass: "person",
          via: "signature",
          purpose: "asserted",
          at: timestamp(`2026-01-0${index + 1}T00:00:00Z`),
        });
        const signature = await signAttestation({ attestation, keyPath: key.keyPath });
        entries.push({ attestation, signature });
      }
      // Corrupt the second attestation's signature so its verification fails.
      entries[1] = { ...entries[1]!, signature: entries[0]!.signature };

      let failedId: string | null = null;
      let verifiedCount = 0;
      for (const entry of entries) {
        if (!requireSignature("person", "person")) {
          continue;
        }
        const result = await verifyAttestation({
          attestation: entry.attestation,
          signedBytes: canonicalBytes(entry.attestation.record),
          signature: entry.signature,
          allowedSignersPath,
        });
        if (!result.good) {
          failedId = entry.attestation.id;
          break;
        }
        verifiedCount++;
      }

      expect(failedId).toBe(entries[1]!.attestation.id);
      expect(verifiedCount).toBe(1);
    } finally {
      await rm(key.dir, { recursive: true, force: true });
    }
  });
});

describe("a release names an audience, an extent and terms", () => {
  const base = {
    subject: recordId({ example: "released" }),
    principal: `key:SHA256:${"a".repeat(43)}`,
    principalClass: "person" as const,
    via: "signature" as const,
    at: timestamp("2026-01-01T00:00:00Z"),
  };
  const terms = { form: "bytes" as const, uses: ["review", "cite"] as const, from: null, until: null, marking: null };

  test("a minted release carries its grant and validates as the store reads it", () => {
    const { record } = mintAttestation({
      ...base,
      purpose: "released",
      release: { audience: "public" as Audience, extent: "closure", terms },
    });
    expect(record).toMatchObject({ purpose: "released", audience: "public", extent: "closure", terms });
    expect(validateRecord(record).ok).toBe(true);
  });

  test("a released attestation carrying no grant is refused by the record validator", () => {
    const malformed = {
      kind: "attestation",
      schemaVersion: CURRENT_SCHEMA_VERSIONS.attestation,
      ...base,
      purpose: "released",
      supersedes: [],
    };
    expect(validateRecord(malformed).ok).toBe(false);
  });

  test("refuses to mint a release with no grant, or a revocation that withdraws nothing", () => {
    expect(() => mintAttestation({ ...base, purpose: "released" })).toThrow(RangeError);
    expect(() => mintAttestation({ ...base, purpose: "revoked" })).toThrow(RangeError);
    expect(() =>
      mintAttestation({
        ...base,
        purpose: "made",
        release: { audience: "public" as Audience, extent: "record", terms },
      }),
    ).toThrow(RangeError);
  });

  test("refuses to mint a release whose terms the record validator would refuse", () => {
    expect(() =>
      mintAttestation({
        ...base,
        purpose: "released",
        release: { audience: "public" as Audience, extent: "record", terms: { ...terms, uses: ["republish"] } },
      }),
    ).toThrow(/spdx/);
  });

  test("a released attestation with no audience fails to type-check", () => {
    // @ts-expect-error a released attestation names an audience, an extent and terms
    const bad: ReleaseAttestationRecord = {
      kind: "attestation",
      schemaVersion: CURRENT_SCHEMA_VERSIONS.attestation,
      ...base,
      purpose: "released",
      supersedes: [],
    };
    void bad;
  });
});
