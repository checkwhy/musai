import { readdir, readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("a record carries no visibility field", () => {
  test("no kind under the record layer names a visibility of its own, since a release is an attestation rather than a marking on the record", async () => {
    const recordDirectory = new URL("../src/record/", import.meta.url);
    const sources = (await readdir(recordDirectory, { recursive: true }))
      .filter((entry) => entry.endsWith(".ts"))
      .map((entry) => new URL(entry, recordDirectory));
    for (const source of sources) {
      const codeOnly = (await readFile(source, "utf8"))
        .split("\n")
        .filter((line) => {
          const trimmed = line.trim();
          return !(trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*"));
        })
        .join("\n");
      const matches = codeOnly.match(/\b(visibility|isPublic|exported|isPrivate)\b/g) ?? [];
      expect(matches).toHaveLength(0);
    }
  });
});
