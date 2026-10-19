import type { RecordId } from "../canonical/canonicalize.js";
import { isRecordKind, type RecordKind } from "./kinds.js";

/** Hex characters per directory level, as in git's loose objects. */
export const ID_PREFIX_WIDTH = 2;

const HEX_ID_PATTERN = /^sha256:([0-9a-f]{64})$/;

function hexOf(id: RecordId): string {
  const match = HEX_ID_PATTERN.exec(id);
  if (!match) {
    throw new RangeError(`not a sha256 record id: ${id}`);
  }
  return match[1]!;
}

/** `records/<kind>/<xx>/<yy>/<hex>.json`, sharded on the digest's first two hex pairs. */
export function recordPath(kind: RecordKind, id: RecordId): string {
  if (!isRecordKind(kind)) {
    throw new RangeError(`not a record kind: ${kind}`);
  }
  const hex = hexOf(id);
  const first = hex.slice(0, ID_PREFIX_WIDTH);
  const second = hex.slice(ID_PREFIX_WIDTH, 2 * ID_PREFIX_WIDTH);
  return `records/${kind}/${first}/${second}/${hex}.json`;
}

/** Inside a workspace's `.musai/`, and at a bundle's root. */
export const BLOBS_DIR = "blobs";

/** `blobs/<xx>/<hex>`: no kind and no extension, since the bytes are the payload itself. */
export function blobPath(id: RecordId): string {
  const hex = hexOf(id);
  const prefix = hex.slice(0, ID_PREFIX_WIDTH);
  return `${BLOBS_DIR}/${prefix}/${hex}`;
}

const RECORD_PATH_PATTERN = /^records\/[^/]+\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{64})\.json$/;

const RECORD_KIND_DIRECTORY_PATTERN = /^records\/([^/]+)\//;

export function kindFromPath(path: string): RecordKind {
  const match = RECORD_KIND_DIRECTORY_PATTERN.exec(path);
  const kind = match?.[1];
  if (!isRecordKind(kind)) {
    throw new RangeError(`not a record path: ${path}`);
  }
  return kind;
}

/** Inverts `recordPath`, refusing a path whose directories are not its digest's prefix. */
export function idFromPath(path: string): RecordId {
  const match = RECORD_PATH_PATTERN.exec(path);
  if (!match) {
    throw new RangeError(`not a record path: ${path}`);
  }
  const [, first, second, hex] = match;
  if (!hex!.startsWith(`${first}${second}`)) {
    throw new RangeError(`path prefix does not match its hash: ${path}`);
  }
  return `sha256:${hex}`;
}

export function sidecarPath(id: RecordId): string {
  return `${recordPath("attestation", id)}.sig`;
}

/** A signature is the one non-record file under `records/`. */
export function isSidecarPath(path: string): boolean {
  return path.endsWith(".sig");
}
