import { describe, expect, test } from "vitest";
import { bundleExport } from "../../src/ops/export.js";

describe("an export's text", () => {
  test("names the archive and the bundle's digest, and counts what it holds in agreeing number", () => {
    const text = (records: number, signatures: number, blobs: number) =>
      bundleExport.renderText({
        path: "/out/b.tar.gz",
        digest: "ab".repeat(32),
        records,
        signatures,
        blobs,
        released: null,
      });
    expect(text(14, 8, 1)).toBe(`/out/b.tar.gz\nbundle ${"ab".repeat(32)}\n14 records, 8 signatures, 1 blob`);
    expect(text(1, 1, 0)).toBe(`/out/b.tar.gz\nbundle ${"ab".repeat(32)}\n1 record, 1 signature, 0 blobs`);
  });

  test("names the release an export minted before the archive", () => {
    const text = bundleExport.renderText({
      path: "/out/b.tar.gz",
      digest: "ab".repeat(32),
      records: 1,
      signatures: 1,
      blobs: 0,
      released: `sha256:${"cd".repeat(32)}`,
    });
    expect(text.split("\n")[0]).toBe(`released ${"cd".repeat(6)} for review, cite`);
  });
});
