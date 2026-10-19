import { isRecordId, type RecordId } from "../canonical/canonicalize.js";

/** An anchor label's width in hex: a prefix of the record id, fixed so it is never inferred. */
export const ANCHOR_LABEL_WIDTH = 12;

/** The heading an artifact's trailing receipts section starts at. */
export const RECEIPTS_HEADING = "## Receipts";

const LABEL_PATTERN = `[0-9a-f]{${ANCHOR_LABEL_WIDTH}}(?::[^\\]]+)?`;
const DEFINITION_PATTERN = new RegExp(`^\\[\\^(${LABEL_PATTERN})\\]:\\s*(\\S+)\\s*$`, "gm");
const HEADING_PATTERN = new RegExp(`^${RECEIPTS_HEADING.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");

/** Splits an artifact into its body and its trailing receipts section, empty when absent. */
export function splitReceiptsSection(text: string): { body: string; receipts: string } {
  const match = HEADING_PATTERN.exec(text);
  if (!match) {
    return { body: text, receipts: "" };
  }
  return { body: text.slice(0, match.index), receipts: text.slice(match.index + match[0].length) };
}

/** The label-to-id map of an artifact's receipts section, its one parser. A definition that is not
 * a record id is left out, since a footnote must resolve to a receipt. */
export function parseReceiptsSection(text: string): Map<string, RecordId> {
  const { receipts } = splitReceiptsSection(text);
  const resolved = new Map<string, RecordId>();
  for (const match of receipts.matchAll(DEFINITION_PATTERN)) {
    const named = match[2]!;
    if (isRecordId(named)) {
      resolved.set(match[1]!, named);
    }
  }
  return resolved;
}
