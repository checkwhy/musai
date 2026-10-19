import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATTESTATION_PURPOSES,
  type AttestationPurpose,
  type Audience,
  CURRENT_SCHEMA_VERSIONS,
  canonicalBytes,
  recordId,
  type SealAttestationRecord,
  timestamp,
  validateRecord,
} from "@musai/records";
import { allowedSignersLine, generateTestKey, type TestKey, writeAllowedSigners } from "@musai/test-support";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Attestation, mintAttestation } from "../src/attestation.js";
import { SIGNATURE_NAMESPACE, type SignAttestationInput, signAttestation } from "../src/sign.js";
import { type VerifyAttestationInput, verifyAttestation } from "../src/verify.js";

const ALICE = `key:SHA256:${"a".repeat(43)}`;
const BOB = `key:SHA256:${"b".repeat(43)}`;

describe("the six attestation purposes", () => {
  test("ATTESTATION_PURPOSES has exactly six members", () => {
    expect([...ATTESTATION_PURPOSES]).toEqual(["made", "asserted", "re-shared", "released", "revoked", "sealed"]);
  });

  test("a seventh purpose is refused", () => {
    expect(() =>
      mintAttestation({
        subject: recordId({ example: "content" }),
        principal: ALICE,
        principalClass: "person",
        via: "signature",
        purpose: "witnessed" as AttestationPurpose,
        at: timestamp("2026-01-01T00:00:00Z"),
      }),
    ).toThrow(/not an attestation purpose/);
  });
});

describe("minting an attestation", () => {
  test("names a principal, a time, a purpose and the record it points at, with an id from the kernel canonicalizer", () => {
    const subject = recordId({ example: "content" });
    const attestation = mintAttestation({
      subject,
      principal: ALICE,
      principalClass: "person",
      via: "signature",
      purpose: "asserted",
      at: timestamp("2026-01-01T00:00:00Z"),
    });
    expect(attestation.record.subject).toBe(subject);
    expect(attestation.record.principal).toBe(ALICE);
    expect(attestation.record.purpose).toBe("asserted");
    expect(attestation.record.at).toBe("2026-01-01T00:00:00Z");
    expect(attestation.id).toBe(recordId(attestation.record));
  });

  test("names its principal by key or pseudonym, and refuses a bare name", () => {
    const by = (principal: string) =>
      mintAttestation({
        subject: recordId({ example: "content" }),
        principal,
        principalClass: "person",
        via: "tty",
        purpose: "made",
        at: timestamp("2026-01-01T00:00:00Z"),
      });
    expect(by(ALICE).record.principal).toBe(ALICE);
    expect(by(`pseudonym:key-1:${"3f".repeat(32)}`).record.principal).toMatch(/^pseudonym:/);
    expect(() => by("alice")).toThrow(/never a bare name/);
  });

  test("two principals attesting identical content produce one record id and two attestation records", () => {
    const subject = recordId({ example: "shared content" });
    const at = timestamp("2026-01-01T00:00:00Z");
    const fromAlice = mintAttestation({
      subject,
      principal: ALICE,
      principalClass: "person",
      via: "signature",
      purpose: "asserted",
      at,
    });
    const fromBob = mintAttestation({
      subject,
      principal: BOB,
      principalClass: "person",
      via: "signature",
      purpose: "asserted",
      at,
    });
    expect(fromAlice.record.subject).toBe(subject);
    expect(fromBob.record.subject).toBe(subject);
    expect(fromAlice.id).not.toBe(fromBob.id);
  });
});

describe("minting a seal", () => {
  const sealing = {
    subject: recordId({ example: "sealed content" }),
    principal: ALICE,
    principalClass: "person",
    via: "tty",
    at: timestamp("2026-01-01T00:00:00Z"),
  } as const;

  test("names the audience the record is sealed from, at the current schema version", () => {
    const sealed = mintAttestation({ ...sealing, purpose: "sealed", seal: { audience: "cast" as Audience } });
    expect(sealed.record).toMatchObject({
      purpose: "sealed",
      seal: { audience: "cast" },
      schemaVersion: CURRENT_SCHEMA_VERSIONS.attestation,
    });
    expect(validateRecord(sealed.record)).toEqual({ ok: true, record: sealed.record });
  });

  test("carries the extent a seal names, and names none where none is asked", () => {
    const closure = mintAttestation({
      ...sealing,
      purpose: "sealed",
      seal: { audience: "cast" as Audience, extent: "closure" },
    });
    const bare = mintAttestation({ ...sealing, purpose: "sealed", seal: { audience: "cast" as Audience } });
    expect([closure.record, bare.record]).toMatchObject([
      { seal: { audience: "cast", extent: "closure" } },
      { seal: { audience: "cast" } },
    ]);
    expect(Object.keys((bare.record as SealAttestationRecord).seal)).toEqual(["audience"]);
    expect(validateRecord(closure.record)).toEqual({ ok: true, record: closure.record });
  });

  test("a seal, and only a seal, names an audience it is sealed from", () => {
    expect(() => mintAttestation({ ...sealing, purpose: "sealed" })).toThrow(/only a seal/);
    expect(() => mintAttestation({ ...sealing, purpose: "asserted", seal: { audience: "cast" as Audience } })).toThrow(
      /only a seal/,
    );
  });
});

describe("the namespace is the kernel's own, never a call site's", () => {
  const attestation = mintAttestation({
    subject: recordId({ example: "content" }),
    principal: ALICE,
    principalClass: "person",
    via: "signature",
    purpose: "asserted",
    at: timestamp("2026-01-01T00:00:00Z"),
  });

  test("a signing invocation admits no namespace field", () => {
    const input: SignAttestationInput = {
      attestation,
      keyPath: "/tmp/key",
      // @ts-expect-error a namespace field here would mean the choice came back to the call site
      namespace: SIGNATURE_NAMESPACE,
    };
    expect(input.keyPath).toBe("/tmp/key");
  });

  test("a verification invocation admits no namespace field", () => {
    const input: VerifyAttestationInput = {
      attestation,
      signedBytes: canonicalBytes(attestation.record),
      signature: "",
      allowedSignersPath: "/tmp/allowed_signers",
      // @ts-expect-error a namespace field here would mean the choice came back to the call site
      namespace: SIGNATURE_NAMESPACE,
    };
    expect(input.allowedSignersPath).toBe("/tmp/allowed_signers");
  });
});

describe("no key material reaches a result or a message", () => {
  test("signing and verifying name no private key material, so a refusal can be pasted anywhere", async () => {
    const signSource = await readFile(new URL("../src/sign.ts", import.meta.url), "utf8");
    const verifySource = await readFile(new URL("../src/verify.ts", import.meta.url), "utf8");
    const forbidden = /PRIVATE KEY|passphrase|privateKeyPath/;
    for (const line of `${signSource}\n${verifySource}`.split("\n")) {
      const stripped = line.trim();
      if (stripped.startsWith("//") || stripped.startsWith("*") || stripped.startsWith("/*")) {
        continue;
      }
      expect(line).not.toMatch(forbidden);
    }
  });
});

describe("signing and verifying with the system OpenSSH binary", () => {
  let key: TestKey;
  let attestation: Attestation;
  let signature: string;

  beforeAll(async () => {
    key = await generateTestKey("alice@example.com");
    attestation = mintAttestation({
      subject: recordId({ example: "a case's evidence" }),
      principal: key.principal,
      principalClass: "person",
      via: "signature",
      purpose: "asserted",
      at: timestamp("2026-01-01T00:00:00Z"),
    });
    signature = await signAttestation({ attestation, keyPath: key.keyPath });
  });

  afterAll(async () => {
    await rm(key.dir, { recursive: true, force: true });
  });

  test("a bare ssh-keygen -Y verify shell invocation with no git configuration reports a good signature", async () => {
    const allowedSignersPath = await writeAllowedSigners(key.dir, allowedSignersLine(key));
    const sigPath = join(key.dir, "raw-check.sig");
    await writeFile(sigPath, signature);

    const result = await execa(
      "ssh-keygen",
      ["-Y", "verify", "-f", allowedSignersPath, "-I", key.principal, "-n", SIGNATURE_NAMESPACE, "-s", sigPath],
      {
        env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" },
        extendEnv: false,
        input: canonicalBytes(attestation.record),
        reject: false,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Good");
  });

  test("a signature made under the pinned namespace over the same bytes verifies", async () => {
    const allowedSignersPath = await writeAllowedSigners(key.dir, allowedSignersLine(key));
    const result = await verifyAttestation({
      attestation,
      signedBytes: canonicalBytes(attestation.record),
      signature,
      allowedSignersPath,
    });
    expect(result.good).toBe(true);
    expect(result.principal).toBe(key.principal);
  });

  test("a signature made under a different namespace over the same bytes does not verify", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "musai-namespace-test-"));
    try {
      const messagePath = join(tmpDir, "attestation.json");
      await writeFile(messagePath, canonicalBytes(attestation.record));
      await execa("ssh-keygen", ["-Y", "sign", "-f", key.keyPath, "-n", "other-namespace", messagePath], {
        env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" },
        extendEnv: false,
      });
      const wrongNamespaceSignature = await readFile(`${messagePath}.sig`, "utf8");
      const allowedSignersPath = await writeAllowedSigners(tmpDir, allowedSignersLine(key));

      const result = await verifyAttestation({
        attestation,
        signedBytes: canonicalBytes(attestation.record),
        signature: wrongNamespaceSignature,
        allowedSignersPath,
      });
      expect(result.good).toBe(false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("an attestation made while a key's window was open still verifies after the window has closed", async () => {
    // The window covers the claimed time (2026-01-01) and closes before now: a key rotated out.
    const allowedSignersPath = await writeAllowedSigners(
      key.dir,
      allowedSignersLine(key, 'valid-after="20250101000000",valid-before="20260201000000"'),
    );
    const result = await verifyAttestation({
      attestation,
      signedBytes: canonicalBytes(attestation.record),
      signature,
      allowedSignersPath,
    });
    expect(result.good).toBe(true);
  });

  test("an attestation claiming a time before the key's window opened fails verification naming the window check", async () => {
    const allowedSignersPath = await writeAllowedSigners(
      key.dir,
      allowedSignersLine(key, 'valid-after="20990101000000"'),
    );
    const result = await verifyAttestation({
      attestation,
      signedBytes: canonicalBytes(attestation.record),
      signature,
      allowedSignersPath,
    });
    expect(result.good).toBe(false);
    expect(result.failureReason).toBe("not-yet-valid");
  });

  test("an attestation claiming a time after the key's window closed fails verification naming the window check", async () => {
    const allowedSignersPath = await writeAllowedSigners(
      key.dir,
      allowedSignersLine(key, 'valid-before="20200101000000"'),
    );
    const result = await verifyAttestation({
      attestation,
      signedBytes: canonicalBytes(attestation.record),
      signature,
      allowedSignersPath,
    });
    expect(result.good).toBe(false);
    expect(result.failureReason).toBe("no-longer-valid");
  });

  test("tampered bytes fail verification as a signature-invalid result", async () => {
    const allowedSignersPath = await writeAllowedSigners(key.dir, allowedSignersLine(key));
    const tamperedAttestation: Attestation = {
      ...attestation,
      record: { ...attestation.record, principal: key.principal, subject: recordId({ different: "content" }) },
    };
    const result = await verifyAttestation({
      attestation: tamperedAttestation,
      signedBytes: canonicalBytes(tamperedAttestation.record),
      signature,
      allowedSignersPath,
    });
    expect(result.good).toBe(false);
    expect(result.failureReason).toBe("signature-invalid");
  });
});
