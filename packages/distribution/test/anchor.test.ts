import type { RecordId } from "@musai/records";
import { describe, expect, test } from "vitest";
import { anchorGrammarFor, UngrammaredFormatError } from "../src/anchor/formats.js";
import { ANCHOR_LABEL_WIDTH } from "../src/anchor/grammar.js";
import { parseAnchors, RECEIPTS_HEADING, writeReceiptsSection } from "../src/anchor/markdown.js";

const encoder = new TextEncoder();

function bytesOf(text: string): Uint8Array {
  return encoder.encode(text);
}

const ID_A: RecordId = `sha256:${"a".repeat(64)}` as RecordId;
const ID_B: RecordId = `sha256:${"b".repeat(64)}` as RecordId;

describe("ANCHOR_LABEL_WIDTH", () => {
  test("is a fixed twelve-hex-character prefix", () => {
    expect(ANCHOR_LABEL_WIDTH).toBe(12);
  });
});

describe("parseAnchors", () => {
  test("returns one entry per footnote label found, mapped through the receipts section", () => {
    const text = [
      "The fault reproduces on 6.4.1.[^aaaaaaaaaaaa]",
      "",
      RECEIPTS_HEADING,
      "",
      `[^aaaaaaaaaaaa]: ${ID_A}`,
      "",
    ].join("\n");

    const result = parseAnchors(bytesOf(text));

    expect(result.anchors).toEqual([{ label: "aaaaaaaaaaaa", selector: null, fullId: ID_A }]);
  });

  test("a label absent from the receipts section is reported unresolved by name rather than guessed", () => {
    const text = ["A sentence[^bbbbbbbbbbbb] with no receipt.", "", RECEIPTS_HEADING, ""].join("\n");

    const result = parseAnchors(bytesOf(text));

    expect(result.anchors).toEqual([{ label: "bbbbbbbbbbbb", selector: null, fullId: null }]);
  });

  test("two records sharing a twelve-hex prefix both resolve correctly when the receipts section lists both", () => {
    const sharedPrefix = "cccccccccccc";
    const idOne: RecordId = `sha256:${"c".repeat(52)}${"1".repeat(12)}` as RecordId;
    const idTwo: RecordId = `sha256:${"c".repeat(52)}${"2".repeat(12)}` as RecordId;
    const text = [
      `First run.[^${sharedPrefix}:module/parser@1:key-one]`,
      `Second run.[^${sharedPrefix}:module/parser@1:key-two]`,
      "",
      RECEIPTS_HEADING,
      "",
      `[^${sharedPrefix}:module/parser@1:key-one]: ${idOne}`,
      `[^${sharedPrefix}:module/parser@1:key-two]: ${idTwo}`,
      "",
    ].join("\n");

    const result = parseAnchors(bytesOf(text));

    expect(result.anchors).toEqual([
      { label: `${sharedPrefix}:module/parser@1:key-one`, selector: "module/parser@1:key-one", fullId: idOne },
      { label: `${sharedPrefix}:module/parser@1:key-two`, selector: "module/parser@1:key-two", fullId: idTwo },
    ]);
  });

  test("a number's anchor carries the selector after the label, parseable with the evidence edge's own vocabulary", () => {
    const label = "dddddddddddd:musai.core/numbers@1:exitCode";
    const text = [`It exits clean.[^${label}]`, "", RECEIPTS_HEADING, "", `[^${label}]: ${ID_A}`, ""].join("\n");

    const result = parseAnchors(bytesOf(text));

    expect(result.anchors).toEqual([{ label, selector: "musai.core/numbers@1:exitCode", fullId: ID_A }]);
  });

  test("anchors are returned in the order they appear in the text, and duplicate uses of one label collapse to one resolution", () => {
    const text = [
      "First.[^111111111111]",
      "Second.[^222222222222]",
      "First again.[^111111111111]",
      "",
      RECEIPTS_HEADING,
      "",
      `[^111111111111]: ${ID_A}`,
      `[^222222222222]: ${ID_B}`,
      "",
    ].join("\n");

    const result = parseAnchors(bytesOf(text));

    expect(result.anchors.map((anchor) => anchor.label)).toEqual(["111111111111", "222222222222"]);
  });

  test("an empty artifact produces a defined, empty result", () => {
    expect(parseAnchors(bytesOf(""))).toEqual({ anchors: [] });
  });

  test("a receipts section with no anchors in the running text produces a defined, empty result", () => {
    const text = [
      "Plain prose with no footnote at all.",
      "",
      RECEIPTS_HEADING,
      "",
      `[^333333333333]: ${ID_A}`,
      "",
    ].join("\n");
    expect(parseAnchors(bytesOf(text))).toEqual({ anchors: [] });
  });

  test("anchors with no receipts section at all still produce a defined result, every anchor unresolved", () => {
    const text = "A claim with a footnote[^444444444444] and nothing trailing it.\n";
    expect(parseAnchors(bytesOf(text))).toEqual({
      anchors: [{ label: "444444444444", selector: null, fullId: null }],
    });
  });
});

describe("writeReceiptsSection", () => {
  test("appends a section mapping every label used to its full id", () => {
    const original = bytesOf("A claim[^555555555555] rests on a run.\n");
    const resolutions = new Map<string, RecordId>([["555555555555", ID_A]]);

    const written = writeReceiptsSection(original, resolutions);
    const result = parseAnchors(written);

    expect(result.anchors).toEqual([{ label: "555555555555", selector: null, fullId: ID_A }]);
  });

  test("is idempotent: writing it twice produces the same bytes", () => {
    const original = bytesOf("A claim[^666666666666] rests on a run.\n");
    const resolutions = new Map<string, RecordId>([["666666666666", ID_A]]);

    const once = writeReceiptsSection(original, resolutions);
    const twice = writeReceiptsSection(once, resolutions);

    expect(Buffer.from(twice).equals(Buffer.from(once))).toBe(true);
  });

  test("replaces an existing receipts section rather than appending a second one", () => {
    const original = bytesOf(
      ["A claim[^777777777777] rests on a run.", "", RECEIPTS_HEADING, "", `[^777777777777]: ${ID_A}`, ""].join("\n"),
    );
    const resolutions = new Map<string, RecordId>([["777777777777", ID_B]]);

    const rewritten = writeReceiptsSection(original, resolutions);
    const text = new TextDecoder().decode(rewritten);

    expect(text.split(RECEIPTS_HEADING).length - 1).toBe(1);
    expect(parseAnchors(rewritten).anchors).toEqual([{ label: "777777777777", selector: null, fullId: ID_B }]);
  });
});

describe("anchorGrammarFor", () => {
  test('resolves the markdown grammar for format "markdown"', () => {
    const grammar = anchorGrammarFor("markdown");
    expect(grammar.format).toBe("markdown");
  });

  test("refuses a format with no installed grammar, naming it, rather than an empty anchor list", () => {
    expect(() => anchorGrammarFor("application/pdf")).toThrow(UngrammaredFormatError);
  });
});

describe("packages/distribution/src/anchor/markdown.ts touches no store, index or filesystem", () => {
  test("its own source names no such call", async () => {
    const { readFile } = await import("node:fs/promises");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(join(here, "..", "src", "anchor", "markdown.ts"), "utf8");
    expect(source).not.toMatch(/\bStore\b|\bIndexDb\b|node:fs/);
  });
});
