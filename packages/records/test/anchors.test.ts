import { describe, expect, test } from "vitest";
import { recordId } from "../src/canonical/canonicalize.js";
import { ANCHOR_LABEL_WIDTH, parseReceiptsSection, splitReceiptsSection } from "../src/record/anchors.js";

const REAL = recordId({ example: "a receipt an artifact anchors to" });
const LABEL = REAL.slice("sha256:".length, "sha256:".length + ANCHOR_LABEL_WIDTH);

describe("an artifact's own receipts section", () => {
  test("resolves a label to the record id its definition names", () => {
    const resolved = parseReceiptsSection(`body\n\n## Receipts\n\n[^${LABEL}]: ${REAL}\n`);
    expect(resolved.get(LABEL)).toBe(REAL);
  });

  test("leaves out a definition naming something that is not a record id, rather than carrying it into the fold", () => {
    for (const named of [
      "not-a-real-sha256-id",
      "sha256:short",
      `sha256:${"g".repeat(64)}`,
      `SHA256:${"a".repeat(64)}`,
      REAL.toUpperCase(),
    ]) {
      const resolved = parseReceiptsSection(`## Receipts\n\n[^${LABEL}]: ${named}\n`);
      expect({ named, resolved: [...resolved] }).toEqual({ named, resolved: [] });
    }
  });

  test("reads only the section after the heading, so a footnote in the body anchors nothing", () => {
    const inBody = parseReceiptsSection(`[^${LABEL}]: ${REAL}\n\nbody with no heading\n`);
    expect([...inBody]).toEqual([]);
    expect(splitReceiptsSection("no heading here").receipts).toBe("");
  });
});
