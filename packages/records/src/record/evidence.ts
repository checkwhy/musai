import { isRecordId, type RecordId } from "../canonical/canonicalize.js";
import { isVersionString, type VersionString } from "../canonical/numbers.js";
import { isPlainObject } from "../canonical/plain-object.js";
import { invalid } from "./fields.js";

/** Four parts rather than one joined string, so a key holding a slash or colon round-trips. */
export interface Selector {
  module: string;
  parser: string;
  version: VersionString;
  key: string;
}

/** For a person and an index column; nothing parses it back. */
export function renderSelector(selector: Selector): string {
  return `${selector.module}/${selector.parser}@${selector.version}:${selector.key}`;
}

/** A claim's edge to the run backing it. `item` is the id of what the selector picked, so two
 * observations agree when their items are equal. */
export interface EvidenceEdge {
  run: RecordId;
  selector: Selector;
  item: RecordId;
}

type EvidenceEdgesResult =
  | { readonly ok: true; readonly edges: EvidenceEdge[] }
  | { readonly ok: false; readonly error: string };

function parseSelectorField(
  value: unknown,
  context: string,
): { readonly ok: true; readonly selector: Selector } | { readonly ok: false; readonly error: string } {
  if (!isPlainObject(value)) {
    return invalid(`${context} selector must be an object naming module, parser, version and key`);
  }
  if (typeof value["module"] !== "string") {
    return invalid(`${context} selector must carry module as a string`);
  }
  if (typeof value["parser"] !== "string") {
    return invalid(`${context} selector must carry parser as a string`);
  }
  if (!isVersionString(value["version"])) {
    return invalid(`${context} selector must carry version as a non-empty string with no whitespace`);
  }
  if (typeof value["key"] !== "string") {
    return invalid(`${context} selector must carry key as a string`);
  }
  return {
    ok: true,
    selector: {
      module: value["module"],
      parser: value["parser"],
      version: value["version"],
      key: value["key"],
    },
  };
}

/** Rebuilds evidence edges from their known parts, sorted by run then selector so two folds agree,
 * with identical edges collapsed. */
export function parseEvidenceEdges(value: unknown, context: string): EvidenceEdgesResult {
  if (!Array.isArray(value)) {
    return invalid(`${context}.evidence must be an array of evidence edges`);
  }
  const edges: EvidenceEdge[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) {
      return invalid(`${context}.evidence entries must be objects`);
    }
    if (!isRecordId(entry["run"])) {
      return invalid(`${context}.evidence entry must carry run as a record id`);
    }
    const selectorResult = parseSelectorField(entry["selector"], `${context}.evidence entry's`);
    if (!selectorResult.ok) {
      return selectorResult;
    }
    if (!isRecordId(entry["item"])) {
      return invalid(`${context}.evidence entry must carry item as a record id`);
    }
    edges.push({ run: entry["run"], selector: selectorResult.selector, item: entry["item"] });
  }
  const sorted = [...edges].sort((a, b) => {
    if (a.run !== b.run) {
      return a.run < b.run ? -1 : 1;
    }
    const renderedA = renderSelector(a.selector);
    const renderedB = renderSelector(b.selector);
    return renderedA < renderedB ? -1 : renderedA > renderedB ? 1 : 0;
  });
  const seen = new Set<string>();
  const deduped: EvidenceEdge[] = [];
  for (const edge of sorted) {
    const identity = `${edge.run}\u0000${renderSelector(edge.selector)}\u0000${edge.item}`;
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    deduped.push(edge);
  }
  return { ok: true, edges: deduped };
}
