import { describe, expect, test } from "vitest";
import { moduleNew, moduleTest } from "../src/ops/module.js";

const failing = { module: "example", results: [], ok: false };

describe("a module's own failing test", () => {
  test("exits as a claim that does not hold, not as a kernel bug", () => {
    expect(moduleTest.exitCode(failing)).toBe(7);
    expect(moduleNew.exitCode({ targetDir: "example", created: true, testReport: failing })).toBe(7);
  });

  test("a passing one exits 0", () => {
    expect(moduleTest.exitCode({ ...failing, ok: true })).toBe(0);
  });
});
