import { hexOfRecordId, rawId } from "../canonical/canonicalize.js";

const encoder = new TextEncoder();

/** The SHA-256 of `sha256sum`'s listing of the tree sorted bytewise, so coreutils reproduces it
 * over any unpacked copy. */
export function bundleDigest(files: ReadonlyMap<string, Uint8Array>): string {
  const paths = [...files.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const listing = paths.map((path) => `${hexOfRecordId(rawId(files.get(path)!))}  ${path}\n`).join("");
  return hexOfRecordId(rawId(encoder.encode(listing)));
}
