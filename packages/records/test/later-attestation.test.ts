import { describe, expect, it } from "vitest";
import { canonicalBytes, type RecordId, rawId, recordId } from "../src/canonical/canonicalize.js";
import { readLaterAttestation } from "../src/record/read.js";
import { CURRENT_SCHEMA_VERSIONS } from "../src/record/schema.js";

const SUBJECT = recordId({ marker: "subject" });
const REPLACED = recordId({ marker: "replaced" });
const LATER = CURRENT_SCHEMA_VERSIONS.attestation + 1;

/** A release as a later version might write it: every field a version fixes, and one it adds. */
function laterRelease(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "attestation",
    schemaVersion: LATER,
    subject: SUBJECT,
    principal: `key:SHA256:${"k".repeat(43)}`,
    principalClass: "person",
    via: "signature",
    purpose: "released",
    at: "2026-09-01T00:00:00.000Z",
    supersedes: [REPLACED],
    audience: "peer",
    reach: "a field no version this kernel reads defines",
    ...overrides,
  };
}

/** The value with each field set to `undefined` left out, as a writer omitting it would. */
function without(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
}

function stored(value: Record<string, unknown>): { bytes: Uint8Array; id: RecordId } {
  const bytes = canonicalBytes(value);
  return { bytes, id: rawId(bytes) };
}

describe("what the kernel reads of an attestation at a version later than it writes", () => {
  it("reads the fields every attestation version fixes and nothing a later version adds", () => {
    const { bytes, id } = stored(laterRelease());
    expect(readLaterAttestation(bytes, id)).toEqual({
      schemaVersion: LATER,
      subject: SUBJECT,
      principal: `key:SHA256:${"k".repeat(43)}`,
      via: "signature",
      purpose: "released",
      at: "2026-09-01T00:00:00.000Z",
      supersedes: [REPLACED],
    });
  });

  it("reads a purpose or a channel no version this kernel reads names, as a later version may add one", () => {
    const { bytes, id } = stored(laterRelease({ purpose: "embargoed", via: "hardware-token" }));
    expect(readLaterAttestation(bytes, id)).toMatchObject({ purpose: "embargoed", via: "hardware-token" });
  });

  it("reads an attestation at any version above the kernel's, a fractional one included, as a verifier does", () => {
    const { bytes, id } = stored(laterRelease({ schemaVersion: LATER + 0.5 }));
    expect(readLaterAttestation(bytes, id)).toMatchObject({ schemaVersion: LATER + 0.5 });
  });

  it("reads nothing of an attestation at a version this kernel reads, nor of another kind", () => {
    for (const value of [
      laterRelease({ schemaVersion: CURRENT_SCHEMA_VERSIONS.attestation }),
      laterRelease({ schemaVersion: "7" }),
      laterRelease({ kind: "claim" }),
    ]) {
      const { bytes, id } = stored(value);
      expect(readLaterAttestation(bytes, id), JSON.stringify(value)).toBeNull();
    }
  });

  it("reads nothing of bytes that do not digest to their id or are not their own canonical form", () => {
    const { bytes } = stored(laterRelease());
    expect(readLaterAttestation(bytes, REPLACED)).toBeNull();
    const spaced = new TextEncoder().encode(JSON.stringify(laterRelease(), null, 1));
    expect(readLaterAttestation(spaced, rawId(spaced))).toBeNull();
    const unbounded = new TextEncoder().encode('{"kind":"attestation","weight":1e400}');
    expect(readLaterAttestation(unbounded, rawId(unbounded))).toBeNull();
  });

  it("reads nothing without the subject and the purpose that place a withdrawal", () => {
    for (const overrides of [{ subject: "not a record id" }, { purpose: undefined }, { purpose: 7 }]) {
      const { bytes, id } = stored(without(laterRelease(overrides)));
      expect(readLaterAttestation(bytes, id), JSON.stringify(overrides)).toBeNull();
    }
  });

  it("reads a malformed fixed field as absent and keeps the rest, so a withdrawal fails closed", () => {
    const { bytes, id } = stored(
      without(laterRelease({ principal: 7, via: undefined, at: "yesterday", supersedes: ["not an id", REPLACED, 3] })),
    );
    expect(readLaterAttestation(bytes, id)).toEqual({
      schemaVersion: LATER,
      subject: SUBJECT,
      principal: null,
      via: null,
      purpose: "released",
      at: null,
      supersedes: [REPLACED],
    });
    const listless = stored(without(laterRelease({ supersedes: "not a list" })));
    expect(readLaterAttestation(listless.bytes, listless.id)).toMatchObject({ supersedes: [] });
  });
});
