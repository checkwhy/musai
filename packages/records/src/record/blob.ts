import type { RecordId } from "../canonical/canonicalize.js";
import { KernelError } from "../reason/error.js";

/** The configuration key for the size above which a payload is stored as a blob. */
export const BLOB_THRESHOLD_CONFIG_KEY = "blob.threshold";

const DEFAULT_BLOB_THRESHOLD_BYTES = 2 ** 20;

export function blobThreshold(config: Record<string, unknown>): number {
  const configured = config[BLOB_THRESHOLD_CONFIG_KEY];
  return typeof configured === "number" ? configured : DEFAULT_BLOB_THRESHOLD_BYTES;
}

export function exceedsBlobThreshold(byteLength: number, config: Record<string, unknown>): boolean {
  return byteLength > blobThreshold(config);
}

/** Raised when a blob's bytes no longer digest to its id, told apart from a blob never written. */
export class BlobCorruptedError extends KernelError {
  readonly expectedId: RecordId;
  readonly actualId: RecordId;
  readonly path: string;

  constructor(expectedId: RecordId, actualId: RecordId, path: string) {
    super({
      reason: "record-corrupted",
      detail: `blob at ${path} was asked for as ${expectedId}, but its bytes digest to ${actualId}`,
      about: [expectedId, actualId],
    });
    this.name = "BlobCorruptedError";
    this.expectedId = expectedId;
    this.actualId = actualId;
    this.path = path;
  }
}
