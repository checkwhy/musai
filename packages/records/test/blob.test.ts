import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { rawId, recordId } from "../src/canonical/canonicalize.js";
import { BLOB_THRESHOLD_CONFIG_KEY, blobThreshold, exceedsBlobThreshold } from "../src/record/blob.js";

describe("a blob's id is minted by the kernel's one hashing function, over its raw bytes", () => {
  it("matches the system digest tool over the same bytes", async () => {
    const bytes = new TextEncoder().encode("not json, just bytes");
    const id = rawId(bytes);
    const expectedDigest = createHash("sha256").update(bytes).digest("hex");
    expect(id).toBe(`sha256:${expectedDigest}`);
  });

  it("is shaped sha256:<64 lowercase hex>", () => {
    expect(rawId(new Uint8Array([1, 2, 3]))).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("differs from the canonical-JSON id of the same text hashed as a JSON string, so the two paths are not interchangeable", () => {
    const text = "not json, just bytes";
    const rawBytes = new TextEncoder().encode(text);
    expect(rawId(rawBytes)).not.toBe(recordId(text));
  });
});

describe("the blob threshold is read from configuration, never fixed in code", () => {
  it("falls back to the starting default when the key is absent", () => {
    expect(blobThreshold({})).toBeGreaterThan(0);
  });

  it("honours a workspace's configured threshold", () => {
    expect(blobThreshold({ [BLOB_THRESHOLD_CONFIG_KEY]: 10 })).toBe(10);
    expect(exceedsBlobThreshold(11, { [BLOB_THRESHOLD_CONFIG_KEY]: 10 })).toBe(true);
    expect(exceedsBlobThreshold(10, { [BLOB_THRESHOLD_CONFIG_KEY]: 10 })).toBe(false);
  });
});
