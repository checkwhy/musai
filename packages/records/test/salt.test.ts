import { describe, expect, it } from "vitest";
import {
  canonicalBytes,
  clearanceSaltKey,
  keyedHash,
  RUN_ENV_HASH_PURPOSE,
  saltFor,
} from "../src/canonical/canonicalize.js";

const KEY = new Uint8Array(32).fill(7);
const OTHER_KEY = new Uint8Array(32).fill(8);

const DRAFT = { kind: "claim", schemaVersion: 4, rendering: "the gate is shut" };

describe("a record's salt is a keyed hash over the record without it", () => {
  it("mints one salt for one record under one key, so a plan and the perform after it agree", () => {
    expect(saltFor(KEY, DRAFT)).toBe(saltFor(KEY, { ...DRAFT }));
  });

  it("mints another salt for another record under the same key", () => {
    const another = { ...DRAFT, rendering: "the gate is open" };
    expect(saltFor(KEY, another)).not.toBe(saltFor(KEY, DRAFT));
  });

  it("mints another salt under another key, so nobody without the key reproduces it", () => {
    expect(saltFor(OTHER_KEY, DRAFT)).not.toBe(saltFor(KEY, DRAFT));
  });

  it("never equals the keyed hash a receipt carries over the same parts, since its purpose is its own", () => {
    const text = new TextDecoder().decode(canonicalBytes(DRAFT));
    expect(saltFor(KEY, DRAFT)).not.toBe(keyedHash(KEY, RUN_ENV_HASH_PURPOSE, DRAFT.kind, text));
  });

  it("is 64 lowercase hex digits, the form a salted record carries", () => {
    expect(saltFor(KEY, DRAFT)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("a clearance salts under a key derived from the workspace key and the clearance", () => {
  it("gives another salt than the workspace key itself, so a station's guess never takes the author's id", () => {
    expect(saltFor(clearanceSaltKey(KEY, "writer"), DRAFT)).not.toBe(saltFor(KEY, DRAFT));
  });

  it("derives one key for one clearance under one key, so stations of a clearance agree", () => {
    expect(clearanceSaltKey(KEY, "writer")).toEqual(clearanceSaltKey(KEY, "writer"));
  });

  it("derives another key for another clearance, and another under another workspace key", () => {
    expect(clearanceSaltKey(KEY, "crew")).not.toEqual(clearanceSaltKey(KEY, "writer"));
    expect(clearanceSaltKey(OTHER_KEY, "writer")).not.toEqual(clearanceSaltKey(KEY, "writer"));
  });

  it("never equals the keyed hash a receipt carries over the clearance, since its purpose is its own", () => {
    const derived = Buffer.from(clearanceSaltKey(KEY, "writer")).toString("hex");
    expect(derived).not.toBe(keyedHash(KEY, RUN_ENV_HASH_PURPOSE, "clearance", "writer"));
  });
});
