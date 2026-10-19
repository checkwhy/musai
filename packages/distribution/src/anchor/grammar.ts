import { ANCHOR_LABEL_WIDTH, type RecordId } from "@musai/records";

/** Re-exported so the fold and a surface's grammar never disagree on a label's width. */
export { ANCHOR_LABEL_WIDTH };

/** One footnote label, resolved through the artifact's own receipts section, never the store. */
export interface AnchorResolution {
  readonly label: string;
  readonly selector: string | null;
  readonly fullId: RecordId | null;
}

export interface AnchorParseResult {
  readonly anchors: readonly AnchorResolution[];
}

/** Parses an artifact's anchors and writes its receipts section back, idempotently. Bytes in,
 * values or bytes out: a grammar never touches a store, an index or a filesystem. */
export interface AnchorGrammar {
  readonly format: string;
  parseAnchors(bytes: Uint8Array): AnchorParseResult;
  writeReceiptsSection(bytes: Uint8Array, resolutions: ReadonlyMap<string, RecordId>): Uint8Array;
}

/** The exact inverse of `renderSelector`, or `null` for text lacking any of its four parts. */
export function parseSelectorText(
  text: string,
): { module: string; parser: string; version: string; key: string } | null {
  const match = /^([^/]+)\/([^@]+)@([^:]+):(.+)$/.exec(text);
  if (!match) {
    return null;
  }
  const [, moduleName, parser, version, key] = match;
  return { module: moduleName!, parser: parser!, version: version!, key: key! };
}
