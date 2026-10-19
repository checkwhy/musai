import { describe, expect, test } from "vitest";
import type { RecordId } from "../src/canonical/canonicalize.js";
import { idFromPath, kindFromPath, recordPath } from "../src/record/path.js";

const HEX = `ab12${"c".repeat(60)}`;
const ID = `sha256:${HEX}` as RecordId;

describe("a record's path in a scope's tree", () => {
  test("shards on the digest's first two pairs of hex characters, and reads back to the id and the kind", () => {
    const path = recordPath("claim", ID);

    expect(path).toBe(`records/claim/ab/12/${HEX}.json`);
    expect(idFromPath(path)).toBe(ID);
    expect(kindFromPath(path)).toBe("claim");
  });

  test("a path sharded on one level is not a record path", () => {
    expect(() => idFromPath(`records/claim/ab/${HEX}.json`)).toThrow("not a record path");
  });

  test("a path whose shard levels are not its digest's own prefix is refused", () => {
    expect(() => idFromPath(`records/claim/ab/13/${HEX}.json`)).toThrow("path prefix does not match its hash");
    expect(() => idFromPath(`records/claim/ac/12/${HEX}.json`)).toThrow("path prefix does not match its hash");
  });
});
