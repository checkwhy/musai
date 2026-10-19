import { gzipSync } from "node:zlib";

const BLOCK = 512;

/** The gzip header's OS byte for "unknown", so the archive names no host it was written on. */
const GZIP_OS_UNKNOWN = 255;

const encoder = new TextEncoder();

function writeField(header: Uint8Array, offset: number, length: number, text: string): void {
  const bytes = encoder.encode(text);
  if (bytes.length > length) {
    throw new RangeError(`${text} does not fit a ${length}-byte ustar field`);
  }
  header.set(bytes, offset);
}

/** A zero-padded octal number filling a field but for its trailing NUL. */
function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0");
}

/** Owner, group and mtime are zeroed, so a header says nothing of who wrote the archive, where or
 * when. */
function header(name: string, size: number): Uint8Array {
  const block = new Uint8Array(BLOCK);
  if (encoder.encode(name).length > 100) {
    throw new RangeError(`${name}: a ustar name holds at most 100 bytes`);
  }
  writeField(block, 0, 100, name);
  writeField(block, 100, 8, octal(0o644, 8));
  writeField(block, 108, 8, octal(0, 8));
  writeField(block, 116, 8, octal(0, 8));
  writeField(block, 124, 12, octal(size, 12));
  writeField(block, 136, 12, octal(0, 12));
  writeField(block, 148, 8, " ".repeat(8));
  writeField(block, 156, 1, "0");
  writeField(block, 257, 6, "ustar\0");
  writeField(block, 263, 2, "00");
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  writeField(block, 148, 8, `${octal(checksum, 7)}\0 `);
  return block;
}

/** Its bytes depend on the files alone, so two machines with the same zlib write the same archive.
 * */
export function tarGz(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const paths = [...files.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const blocks: Uint8Array[] = [];
  for (const path of paths) {
    const bytes = files.get(path)!;
    blocks.push(header(path, bytes.length), bytes, new Uint8Array((BLOCK - (bytes.length % BLOCK)) % BLOCK));
  }
  blocks.push(new Uint8Array(BLOCK * 2));
  const archive = gzipSync(Buffer.concat(blocks), { level: 9 });
  archive[9] = GZIP_OS_UNKNOWN;
  return new Uint8Array(archive);
}
