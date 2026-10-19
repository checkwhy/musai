import { describe, expect, test } from "vitest";
import { versionSatisfies } from "../src/binaries.js";

describe("whether a version found satisfies the constraint a requirement declared", () => {
  test("a version at or above the floor satisfies a >= constraint, and one below does not", () => {
    expect(versionSatisfies("2.52.0", ">=2.40")).toBe(true);
    expect(versionSatisfies("2.40", ">=2.40")).toBe(true);
    expect(versionSatisfies("2.39.5", ">=2.40")).toBe(false);
  });

  test("segments compare as numbers, never as text, so 2.9 is below 2.40 and 10 is above 9", () => {
    expect(versionSatisfies("2.9.0", ">=2.40")).toBe(false);
    expect(versionSatisfies("10.0.0", ">=9")).toBe(true);
  });

  test("a segment absent from one side reads as zero, so 24 and 24.0.0 are one version", () => {
    expect(versionSatisfies("24", ">=24.0.0")).toBe(true);
    expect(versionSatisfies("24.0.0", ">=24")).toBe(true);
    expect(versionSatisfies("24.0.1", ">=24")).toBe(true);
  });

  test("the other comparisons answer the way they read", () => {
    expect(versionSatisfies("1.0", "<=2.0")).toBe(true);
    expect(versionSatisfies("3.0", "<=2.0")).toBe(false);
    expect(versionSatisfies("3.0", ">2.0")).toBe(true);
    expect(versionSatisfies("2.0", ">2.0")).toBe(false);
    expect(versionSatisfies("1.0", "<2.0")).toBe(true);
    expect(versionSatisfies("2.0", "=2.0")).toBe(true);
    expect(versionSatisfies("2.0", "==2.0")).toBe(true);
  });

  test("a constraint this kernel cannot evaluate answers with nothing, never with a pass", () => {
    expect(versionSatisfies("2.52.0", "^2.40")).toBeNull();
    expect(versionSatisfies("2.52.0", "~2.40")).toBeNull();
    expect(versionSatisfies("2.52.0", ">=2.40 <3")).toBeNull();
    expect(versionSatisfies("2.52.0", ">=v2.40")).toBeNull();
    expect(versionSatisfies("2.52.0", "")).toBeNull();
  });

  test("a version that is not dotted numbers answers with nothing rather than being guessed at", () => {
    expect(versionSatisfies("2.52.0-rc1", ">=2.40")).toBeNull();
    expect(versionSatisfies("unknown", ">=2.40")).toBeNull();
  });
});
