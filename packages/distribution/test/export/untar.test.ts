import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, test } from "vitest";
import { readBundle } from "../../src/bundle/source.js";
import { tarGz } from "../../src/export/tar.js";
import { untarGz } from "../../src/export/untar.js";

const encoder = new TextEncoder();

const BUNDLE = new Map<string, Uint8Array>([
  ["roles", encoder.encode("owner@example.test owner any\n")],
  [`records/claim/ab/cd/${"abcd".repeat(16)}.json`, encoder.encode('{"kind":"claim"}')],
  [`blobs/cd/${"cd".repeat(32)}`, new Uint8Array(1300).fill(7)],
]);

/** The archive with one header field rewritten and its checksum made good, as a hand would. */
function tampered(archive: Uint8Array, member: number, offset: number, value: string): Uint8Array {
  const tar = Buffer.from(gunzipSync(archive));
  let at = 0;
  for (let index = 0; index < member; index++) {
    const size = Number.parseInt(tar.toString("latin1", at + 124, at + 135), 8);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  const header = tar.subarray(at, at + 512);
  header.fill(0, offset, offset + (offset === 0 ? 100 : value.length));
  header.write(value, offset, "latin1");
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return new Uint8Array(gzipSync(tar));
}

function refusalOf(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    return error as Error;
  }
  return expect.unreachable("the archive was read");
}

describe("reading a bundle's tar.gz", () => {
  test("reads back every file export wrote, byte for byte", () => {
    const read = untarGz(tarGz(BUNDLE));

    expect([...read.keys()].sort()).toEqual([...BUNDLE.keys()].sort());
    for (const [path, bytes] of BUNDLE) {
      expect(Buffer.from(read.get(path)!).equals(Buffer.from(bytes))).toBe(true);
    }
  });

  test("refuses a member whose path climbs out of the bundle", () => {
    const archive = tampered(tarGz(BUNDLE), 0, 0, "../outside");

    expect(refusalOf(() => untarGz(archive)).message).toMatch(/\.\.\/outside/);
  });

  test("refuses a member that is a link rather than a file", () => {
    const archive = tampered(tarGz(BUNDLE), 1, 156, "2");

    expect(refusalOf(() => untarGz(archive)).message).toMatch(/is not a regular file/);
  });

  test("refuses two members at one path", () => {
    const archive = tampered(tarGz(BUNDLE), 1, 0, `blobs/cd/${"cd".repeat(32)}`);

    expect(refusalOf(() => untarGz(archive)).message).toMatch(/twice/);
  });

  test("refuses a header whose checksum does not hold", () => {
    const tar = Buffer.from(gunzipSync(tarGz(BUNDLE)));
    tar[0] = tar[0]! ^ 1;

    expect(refusalOf(() => untarGz(new Uint8Array(gzipSync(tar)))).message).toMatch(/checksum/);
  });

  test("refuses an archive that unpacks past its limit", () => {
    expect(refusalOf(() => untarGz(tarGz(BUNDLE), 1024)).message).toMatch(/1024 bytes/);
  });
});

describe("a bundle named by a path or a URL", () => {
  let scratch: string | undefined;

  afterEach(async () => {
    if (scratch !== undefined) {
      await rm(scratch, { recursive: true, force: true });
      scratch = undefined;
    }
  });

  test("reads a bundle from a file", async () => {
    scratch = await mkdtemp(join(tmpdir(), "musai-bundle-source-"));
    const path = join(scratch, "bundle.tar.gz");
    await writeFile(path, tarGz(BUNDLE));

    expect([...(await readBundle(path)).keys()].sort()).toEqual([...BUNDLE.keys()].sort());
  });

  test("reads a bundle fetched over https", async () => {
    const fetched: string[] = [];
    const fetcher = async (url: string) => {
      fetched.push(url);
      return new Response(Buffer.from(tarGz(BUNDLE)));
    };

    const read = await readBundle("https://example.test/bundle.tar.gz", fetcher);

    expect(fetched).toEqual(["https://example.test/bundle.tar.gz"]);
    expect([...read.keys()].sort()).toEqual([...BUNDLE.keys()].sort());
  });

  test("refuses a URL that is not https, fetching nothing", async () => {
    const fetcher = async () => expect.unreachable("an http URL was fetched");

    await expect(readBundle("http://example.test/bundle.tar.gz", fetcher)).rejects.toThrow(/https/);
  });

  test("refuses a response that is not a success", async () => {
    const fetcher = async () => new Response("gone", { status: 404 });

    await expect(readBundle("https://example.test/missing.tar.gz", fetcher)).rejects.toThrow(/404/);
  });
});
