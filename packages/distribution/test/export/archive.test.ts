import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { bundleDigest } from "@musai/records";
import { afterEach, describe, expect, test } from "vitest";
import { tarGz } from "../../src/export/tar.js";

const encoder = new TextEncoder();

const BUNDLE = new Map<string, Uint8Array>([
  ["roles", encoder.encode("owner@example.test owner any\n")],
  [`records/claim/ab/${"ab".repeat(32)}.json`, encoder.encode('{"kind":"claim"}')],
  ["allowed-signers", encoder.encode("owner@example.test ssh-ed25519 AAAA\n")],
  [`blobs/cd/${"cd".repeat(32)}`, new Uint8Array(1300).fill(7)],
]);

const hasTar = spawnSync("tar", ["--version"]).status === 0;
const hasSha256sum = spawnSync("sha256sum", ["--version"]).status === 0;

let scratch: string | undefined;

afterEach(async () => {
  if (scratch !== undefined) {
    await rm(scratch, { recursive: true, force: true });
    scratch = undefined;
  }
});

describe("a bundle written as a tar.gz", () => {
  test("is the same bytes every time it is written, whatever order the files were gathered in", () => {
    const reversed = new Map([...BUNDLE].reverse());
    expect(Buffer.from(tarGz(reversed)).equals(Buffer.from(tarGz(BUNDLE)))).toBe(true);
  });

  test("carries no instant, owner or host in its headers", () => {
    const archive = tarGz(BUNDLE);
    expect([...archive.slice(4, 8)]).toEqual([0, 0, 0, 0]);
    expect(archive[9]).toBe(255);
    const tar = gunzipSync(archive);
    const header = tar.subarray(0, 512);
    const field = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString("latin1")
        .replace(/\0+$/, "");
    expect(field(0, 100)).toBe("allowed-signers");
    expect(field(100, 8)).toBe("0000644");
    expect(field(108, 8)).toBe("0000000");
    expect(field(136, 12)).toBe("00000000000");
    expect(field(257, 6)).toBe("ustar");
    expect(field(265, 32)).toBe("");
    expect(tar.length % 512).toBe(0);
    expect([...tar.subarray(tar.length - 1024)].every((byte) => byte === 0)).toBe(true);
  });

  test.skipIf(!hasTar)("reads back to the same files under the system tar", async () => {
    scratch = await mkdtemp(join(tmpdir(), "musai-tar-"));
    const archive = join(scratch, "bundle.tar.gz");
    await writeFile(archive, tarGz(BUNDLE));
    const listed = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
    expect(listed).toEqual([...BUNDLE.keys()].sort());
    execFileSync("tar", ["-xzf", archive, "-C", scratch]);
    for (const [path, bytes] of BUNDLE) {
      expect(Buffer.from(await readFile(join(scratch, path))).equals(Buffer.from(bytes))).toBe(true);
    }
  });

  test("refuses a path a ustar header cannot hold rather than truncating it", () => {
    expect(() => tarGz(new Map([["x".repeat(101), new Uint8Array()]]))).toThrow(/a ustar name holds at most 100 bytes/);
  });
});

describe("a bundle's digest", () => {
  test.skipIf(!hasSha256sum || !hasTar)("is what sha256sum prints over every file sorted by path", async () => {
    scratch = await mkdtemp(join(tmpdir(), "musai-digest-"));
    const archive = join(scratch, "bundle.tar.gz");
    await writeFile(archive, tarGz(BUNDLE));
    execFileSync("tar", ["-xzf", archive, "-C", scratch]);
    const listing = execFileSync("sha256sum", [...BUNDLE.keys()].sort(), { cwd: scratch });
    const expected = execFileSync("sha256sum", { input: listing, encoding: "utf8" }).split(" ")[0];
    expect(bundleDigest(BUNDLE)).toBe(expected);
  });
});
