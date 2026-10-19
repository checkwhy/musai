import { describe, expect, test } from "vitest";
import { recordId } from "../src/canonical/canonicalize.js";
import { timestamp, versionString } from "../src/canonical/numbers.js";
import { isPseudonym } from "../src/record/pseudonym.js";
import { CURRENT_SCHEMA_VERSIONS, validateRecord } from "../src/record/schema.js";

/** The one spelling the reserved prefix admits: a key id, then sixty-four lowercase hex. */
const PSEUDONYM = `pseudonym:key-1:${"3f".repeat(32)}`;

const SUBJECT = recordId({ example: "a record a pseudonym attests to" });

function attestationBy(principal: string): Record<string, unknown> {
  return {
    kind: "attestation",
    schemaVersion: CURRENT_SCHEMA_VERSIONS.attestation,
    subject: SUBJECT,
    principal,
    principalClass: "person",
    via: "signature",
    purpose: "made",
    at: timestamp("2026-01-01T00:00:00.000Z"),
    supersedes: [],
  };
}

function foreignRunBy(principal: string): Record<string, unknown> {
  const at = timestamp("2026-01-01T00:00:00.000Z");
  return {
    kind: "run",
    schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
    runKind: "run",
    performer: { kind: "foreign", principal, tool: "timbre", version: versionString("2") },
    determinism: "nondeterministic",
    supersedes: [],
    recipe: {
      command: ["true"],
      workingDirectory: "/",
      environment: {},
      declared: [],
      substrates: [],
      isolation: "hygiene",
    },
    observation: {
      resolved: [],
      isolationHeld: "hygiene",
      binaries: [],
      bindings: [],
      output: "",
      outputLossy: false,
      exitCode: 0,
      scrubbed: [],
      startedAt: at,
      finishedAt: at,
      reads: [],
      cost: {},
    },
  };
}

describe("a pseudonymous principal", () => {
  test("matches the reserved grammar, and a string that does not is not one", () => {
    expect(isPseudonym(PSEUDONYM)).toBe(true);
    expect(isPseudonym("alice@example.com")).toBe(false);
    expect(isPseudonym("pseudonym:key-1:not-hex")).toBe(false);
  });

  test("an attestation minted when a name could stand carrying the reserved prefix must match the grammar", () => {
    const minted = (principal: string) => ({ ...attestationBy(principal), schemaVersion: 5 });
    expect(validateRecord(minted(PSEUDONYM))).toMatchObject({ ok: true });
    expect(validateRecord(minted("alice@example.com"))).toMatchObject({ ok: true });

    const malformed = validateRecord(minted("pseudonym:key-1:short"));
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.error).toContain("reserves the pseudonym: prefix");
    }
  });

  test("an attestation at the current version names a well-formed pseudonym, never a malformed one", () => {
    expect(validateRecord(attestationBy(PSEUDONYM))).toMatchObject({ ok: true });
    expect(validateRecord(attestationBy("pseudonym:key-1:short")).ok).toBe(false);
  });

  test("a foreign performer's principal is held to the same grammar, so the prefix is reserved on every record that carries one", () => {
    expect(validateRecord(foreignRunBy(PSEUDONYM))).toMatchObject({ ok: true });
    expect(validateRecord(foreignRunBy("alice@example.com"))).toMatchObject({ ok: true });

    const malformed = validateRecord(foreignRunBy("pseudonym:key-1:short"));
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.error).toContain("run.performer.principal reserves the pseudonym: prefix");
    }
  });
});
