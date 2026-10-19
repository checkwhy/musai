import {
  parseReceiptsSection as kernelParseReceiptsSection,
  RECEIPTS_HEADING,
  type RecordId,
  splitReceiptsSection,
} from "@musai/records";
import { ANCHOR_LABEL_WIDTH, type AnchorGrammar, type AnchorParseResult, type AnchorResolution } from "./grammar.js";

export { RECEIPTS_HEADING };

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const LABEL_PATTERN = `[0-9a-f]{${ANCHOR_LABEL_WIDTH}}(?::[^\\]]+)?`;
const REFERENCE_PATTERN = new RegExp(`\\[\\^(${LABEL_PATTERN})\\](?!:)`, "g");
const LABEL_PARTS_PATTERN = new RegExp(`^([0-9a-f]{${ANCHOR_LABEL_WIDTH}})(?::(.+))?$`);

/** A markdown artifact's footnote labels in first-appearance order, resolved through its own
 * receipts section; an unlisted label resolves to `fullId: null`. */
export function parseAnchors(bytes: Uint8Array): AnchorParseResult {
  const text = decoder.decode(bytes);
  const { body } = splitReceiptsSection(text);
  const resolved = kernelParseReceiptsSection(text);

  const seen = new Map<string, AnchorResolution>();
  for (const match of body.matchAll(REFERENCE_PATTERN)) {
    const label = match[1]!;
    if (seen.has(label)) {
      continue;
    }
    const parts = LABEL_PARTS_PATTERN.exec(label);
    const selector = parts?.[2] ?? null;
    seen.set(label, { label, selector, fullId: resolved.get(label) ?? null });
  }

  return { anchors: [...seen.values()] };
}

/** Replaces the receipts section with one sorted by label, so writing it twice is idempotent. */
export function writeReceiptsSection(bytes: Uint8Array, resolutions: ReadonlyMap<string, RecordId>): Uint8Array {
  const text = decoder.decode(bytes);
  const { body } = splitReceiptsSection(text);
  const trimmedBody = body.replace(/\s+$/, "");

  const lines = [...resolutions.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([label, id]) => `[^${label}]: ${id}`);

  const sectionParts = [RECEIPTS_HEADING, "", ...lines];
  const section = sectionParts.join("\n");

  const rendered = trimmedBody.length > 0 ? `${trimmedBody}\n\n${section}\n` : `${section}\n`;
  return encoder.encode(rendered);
}

export const markdownGrammar: AnchorGrammar = {
  format: "markdown",
  parseAnchors,
  writeReceiptsSection,
};
