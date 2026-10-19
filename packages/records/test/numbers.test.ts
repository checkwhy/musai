import { describe, expect, it } from "vitest";
import { canonicalBytes } from "../src/canonical/canonicalize.js";
import {
  assertNumberPolicy,
  type ExactDecimal,
  exactDecimal,
  instantOf,
  isExactDecimal,
  isExactInteger,
  isTimestamp,
  isVersionString,
  timestamp,
  versionString,
} from "../src/canonical/numbers.js";

function decodeCanonicalBytes(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes));
}

describe("exact narrowing constructors", () => {
  it("accepts a value with no exponent and no trailing garbage", () => {
    expect(exactDecimal("-123.456000000001")).toBe("-123.456000000001");
    expect(isExactInteger("9007199254740993")).toBe(true);
  });

  it("rejects a lexical form the exact type does not recognise", () => {
    expect(() => exactDecimal("1e10")).toThrow(RangeError);
    expect(isExactInteger("12.5")).toBe(false);
  });

  it("accepts a well-formed RFC 3339 timestamp and rejects a bare date", () => {
    expect(isTimestamp("2026-08-27T19:28:13.038Z")).toBe(true);
    expect(isTimestamp("2026-08-27")).toBe(false);
    expect(timestamp("2026-08-27T19:28:13+02:00")).toBe("2026-08-27T19:28:13+02:00");
  });

  it("accepts a non-empty, whitespace-free version string", () => {
    expect(isVersionString("pkg:npm/canonicalize@4.0.0")).toBe(true);
    expect(isVersionString("has space")).toBe(false);
    expect(versionString("v1.2.3")).toBe("v1.2.3");
  });
});

describe("instantOf", () => {
  it("agrees on the instant named by a Z spelling and an equivalent offset spelling", () => {
    const zSpelling = timestamp("2026-01-01T00:00:00.000Z");
    const offsetSpelling = timestamp("2026-01-01T01:00:00.000+01:00");
    expect(instantOf(zSpelling)).toBe(instantOf(offsetSpelling));
  });

  it("orders an offset spelling and a Z spelling by the instant each names, even where their characters sort the other way", () => {
    const earlier = timestamp("2026-01-01T23:00:00.000+10:00");
    const later = timestamp("2026-01-01T14:00:00.000Z");
    expect(earlier > later).toBe(true);
    expect(instantOf(later)).toBeGreaterThan(instantOf(earlier));
  });
});

describe("compile-time exactness", () => {
  it("rejects a bare number assigned to an exact-typed field", () => {
    // @ts-expect-error an exact-typed field accepts a string, not a bare number
    const bad: ExactDecimal = 42;
    void bad;
  });

  it("accepts a branded string assigned to an exact-typed field", () => {
    const good: ExactDecimal = exactDecimal("42");
    expect(isExactDecimal(good)).toBe(true);
  });
});

describe("assertNumberPolicy", () => {
  it("returns an empty report for a record that honours its declared exactness", () => {
    const record = { version: "1.2.3", count: 4 };
    const violations = assertNumberPolicy(record, { version: "exact", count: "measured" });
    expect(violations).toEqual([]);
  });

  it("names the field path of a violating record", () => {
    const record = { version: 1, count: "4" };
    const violations = assertNumberPolicy(record, { version: "exact", count: "measured" });
    expect(violations).toEqual([
      { path: "$.version", expected: "exact", actualType: "number" },
      { path: "$.count", expected: "measured", actualType: "string" },
    ]);
  });

  it("walks nested objects and arrays, naming a violation inside either", () => {
    const record = {
      timestamps: [{ startedAt: 12345 }],
      weight: { measured: "not-a-number" },
    };
    const violations = assertNumberPolicy(record, {
      timestamps: [{ startedAt: "exact" }],
      weight: { measured: "measured" },
    });
    expect(violations).toEqual([
      { path: "$.timestamps[0].startedAt", expected: "exact", actualType: "number" },
      { path: "$.weight.measured", expected: "measured", actualType: "string" },
    ]);
  });

  it("does not walk a path absent from the shape", () => {
    const record = { known: "1.0.0" };
    const violations = assertNumberPolicy(record, { known: "exact", unknown: "measured" });
    expect(violations).toEqual([]);
  });
});

describe("round-trip fidelity", () => {
  it("preserves every digit of an integer beyond the safe range through canonical bytes", () => {
    const beyondSafeRange = "90071992547409929007199254740992";
    const decoded = decodeCanonicalBytes(canonicalBytes({ id: beyondSafeRange })) as { id: string };
    expect(decoded.id).toBe("90071992547409929007199254740992");
  });

  it("preserves an exact decimal's digits with no rounding through canonical bytes", () => {
    const precise = exactDecimal("0.100000000000000000000001");
    const decoded = decodeCanonicalBytes(canonicalBytes({ price: precise })) as { price: string };
    expect(decoded.price).toBe("0.100000000000000000000001");
  });

  it("keeps a measured negative zero and a denormal typed as numbers, not strings", () => {
    const record = { negZero: -0, denormal: 5e-324 };
    const violations = assertNumberPolicy(record, { negZero: "measured", denormal: "measured" });
    expect(violations).toEqual([]);
    expect(Object.is(record.negZero, -0)).toBe(true);
    expect(record.denormal).toBe(5e-324);
  });
});
