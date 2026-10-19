import { gunzipSync } from "node:zlib";
import { OperationError } from "@musai/api-core";

const BLOCK = 512;

/** What a received bundle may unpack to, so a small archive cannot fill the disk. */
export const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;

/** A ustar regular file is `0`; old archivers write NUL. */
const REGULAR_FILE_FLAGS = new Set(["0", "\0"]);

function refused(detail: string, about: string): OperationError {
  return new OperationError({ reason: "invalid-input", about: [about], detail: `refusing the bundle: ${detail}` });
}

function field(header: Buffer, offset: number, length: number): string {
  const text = header.toString("utf8", offset, offset + length);
  const nul = text.indexOf("\0");
  return nul === -1 ? text : text.slice(0, nul);
}

function checksumHolds(header: Buffer): boolean {
  const recorded = Number.parseInt(field(header, 148, 8).trim(), 8);
  let sum = 0;
  for (let index = 0; index < BLOCK; index++) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index]!;
  }
  return sum === recorded;
}

/** A path is the bundle's own only when no segment climbs, none is empty and it starts nowhere. */
function bundlePath(name: string): boolean {
  return (
    !name.startsWith("/") && !name.includes("\\") && name.split("/").every((part) => ![".", "..", ""].includes(part))
  );
}

/** The files of a bundle `tarGz` wrote, refusing any member a hand could have made unsafe. */
export function untarGz(archive: Uint8Array, maxBytes = MAX_BUNDLE_BYTES): Map<string, Uint8Array> {
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, { maxOutputLength: maxBytes });
  } catch (error) {
    throw (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE"
      ? refused(`it unpacks to more than ${maxBytes} bytes`, "archive")
      : refused(`it is not gzip: ${(error as Error).message}`, "archive");
  }
  const files = new Map<string, Uint8Array>();
  let at = 0;
  while (at + BLOCK <= tar.length) {
    const header = tar.subarray(at, at + BLOCK);
    if (header.every((byte) => byte === 0)) {
      return files;
    }
    if (!checksumHolds(header)) {
      throw refused(`the header at byte ${at} fails its checksum`, String(at));
    }
    const prefix = field(header, 345, 155);
    const name = prefix.length > 0 ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100);
    const size = Number.parseInt(field(header, 124, 12).trim(), 8);
    if (!bundlePath(name)) {
      throw refused(`${name} is not a path inside the bundle`, name);
    }
    if (!REGULAR_FILE_FLAGS.has(String.fromCharCode(header[156]!))) {
      throw refused(`${name} is not a regular file`, name);
    }
    if (files.has(name)) {
      throw refused(`${name} appears twice`, name);
    }
    const start = at + BLOCK;
    if (!Number.isSafeInteger(size) || start + size > tar.length) {
      throw refused(`${name} claims ${size} bytes the archive does not hold`, name);
    }
    files.set(name, new Uint8Array(tar.subarray(start, start + size)));
    at = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  throw refused("it ends before its closing blocks", "archive");
}
