import { type RecordId, recordId } from "@musai/records";
import { describe, expect, test } from "vitest";
import { walkCitations } from "../src/citations.js";

const [a, b, c, d] = ["a", "b", "c", "d"].map((name) => recordId({ name })) as [RecordId, RecordId, RecordId, RecordId];

/** `a` cites `b` and `c`, both cite `d`. */
const CITES: ReadonlyMap<RecordId, readonly RecordId[]> = new Map([
  [a, [b, c]],
  [b, [d]],
  [c, [d]],
]);

const onward = (id: RecordId) => CITES.get(id) ?? [];

describe("a citation walk", () => {
  test("visits what a record cites breadth first, each record once", async () => {
    expect(await walkCitations([a], (id) => id, onward)).toEqual([a, b, c, d]);
  });

  test("visits nothing a walk sharing what it reached has visited", async () => {
    const reached = new Set<RecordId>();
    await walkCitations([b], (id) => id, onward, reached);

    expect(await walkCitations([a, b], (id) => id, onward, reached)).toEqual([a, c]);
  });
});
