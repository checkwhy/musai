import { describe, expect, test } from "vitest";
import { oldNodeRefusal } from "../src/node-version.js";

describe("the Node a stranger runs musai on", () => {
  test("refuses a Node older than 24, naming the version it found", () => {
    expect(oldNodeRefusal("20.20.2")).toBe(
      "musai needs Node 24 or later, and this is Node 20.20.2: install a newer Node and run it again",
    );
  });

  test("accepts Node 24 and every later major", () => {
    expect(oldNodeRefusal("24.0.0")).toBeNull();
    expect(oldNodeRefusal("26.1.0")).toBeNull();
  });
});
