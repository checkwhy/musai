import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobCorruptedError, hexOfRecordId, KernelError, rawId } from "@musai/records";
import { fixedClock } from "@musai/test-support";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitBlobStore } from "../src/blob-store.js";
import {
  type GitContext,
  gitCommitTree,
  gitHashObjectBatch,
  gitRevParse,
  gitSpliceTree,
  gitUpdateRefCas,
} from "../src/git.js";
import { initWorkspace, MUSAI_DIR } from "../src/init.js";

const NOW = fixedClock("2026-10-02T00:00:00.000Z");
const BLOBS_REF = "refs/heads/blobs";

async function systemSha256(filePath: string): Promise<string> {
  try {
    return (await execa("sha256sum", [filePath])).stdout.split(/\s+/)[0]!;
  } catch {
    return (await execa("shasum", ["-a", "256", filePath])).stdout.split(/\s+/)[0]!;
  }
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("a workspace's blob store", () => {
  let project: string;
  let ctx: GitContext;
  let blobs: GitBlobStore;

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), "musai-blob-store-"));
    await execa("git", ["init", "--quiet", project]);
    await initWorkspace(project, { now: NOW });
    ctx = { gitDir: join(project, MUSAI_DIR) };
    blobs = new GitBlobStore({ ctx, now: NOW });
  });

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  it("answers a read with exactly the bytes that were put under that id", async () => {
    const bytes = new Uint8Array([0, 0xff, 0x80, 10, 13, 0xc3, 0x28]);
    const id = await blobs.put(bytes);

    expect(id).toBe(rawId(bytes));
    expect(Buffer.from(await blobs.read(id))).toEqual(Buffer.from(bytes));
  });

  it("reads a put blob back from a clone of the store", async () => {
    const bytes = bytesOf("a bundle a clone must load");
    const id = await blobs.put(bytes);
    const clone = await mkdtemp(join(tmpdir(), "musai-blob-clone-"));
    try {
      await execa("git", ["clone", "--quiet", "--bare", ctx.gitDir, join(clone, MUSAI_DIR)]);

      const cloned = new GitBlobStore({ ctx: { gitDir: join(clone, MUSAI_DIR) }, now: NOW });
      expect(Buffer.from(await cloned.read(id))).toEqual(Buffer.from(bytes));
    } finally {
      await rm(clone, { recursive: true, force: true });
    }
  });

  it("writes no commit for a blob the branch already holds", async () => {
    const bytes = bytesOf("a bundle installed twice");
    await blobs.put(bytes);
    const tip = await gitRevParse(ctx, BLOBS_REF);

    await blobs.put(bytes);

    expect(await gitRevParse(ctx, BLOBS_REF)).toBe(tip);
  });

  it("lands both of two writers putting different blobs at once", async () => {
    const first = bytesOf("the first writer's blob");
    const second = bytesOf("the second writer's blob");
    const rival = new GitBlobStore({ ctx, now: NOW });

    const id = await blobs.put(first, {
      beforeSwap: async (_tip, attempt) => {
        if (attempt === 1) {
          await rival.put(second);
        }
      },
    });

    expect(Buffer.from(await blobs.read(id))).toEqual(Buffer.from(first));
    expect(Buffer.from(await blobs.read(rawId(second)))).toEqual(Buffer.from(second));
  });

  it("refuses bytes on the branch that do not digest to the id they are held under", async () => {
    const bytes = bytesOf("a bundle later swapped on the branch");
    const id = await blobs.put(bytes);
    const scratch = await mkdtemp(join(tmpdir(), "musai-blob-swap-"));
    const altered = bytesOf("other bytes under the same name");
    try {
      await writeFile(join(scratch, "altered"), altered);
      const [sha] = await gitHashObjectBatch(ctx, [join(scratch, "altered")]);
      const tip = await gitRevParse(ctx, BLOBS_REF);
      const hex = hexOfRecordId(id);
      const tree = await gitSpliceTree(ctx, tip, [{ path: `${hex.slice(0, 2)}/${hex}`, sha: sha! }]);
      await gitUpdateRefCas(ctx, BLOBS_REF, await gitCommitTree(ctx, tree, [tip!], "swap\n", NOW), tip);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }

    const refusal = await blobs.read(id).then(
      () => expect.unreachable("a read of swapped bytes answered them"),
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(BlobCorruptedError);
    expect(refusal).toMatchObject({ expectedId: id, actualId: rawId(altered) });
  });

  it("refuses a blob the branch never held as no such record", async () => {
    const refusal = await blobs.read(rawId(bytesOf("never put"))).then(
      () => expect.unreachable("a read of an absent blob answered"),
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(KernelError);
    expect((refusal as KernelError).reason).toBe("no-such-record");
  });

  it("materialises a blob once, and rewrites a cached file that no longer digests to its id", async () => {
    const bytes = bytesOf("a bundle a host loads by path");
    const id = await blobs.put(bytes);

    const path = await blobs.materialise(id);
    const written = await stat(path);
    expect(Buffer.from(await readFile(path))).toEqual(Buffer.from(bytes));
    expect(await blobs.materialise(id)).toBe(path);
    expect((await stat(path)).ino).toBe(written.ino);

    await writeFile(path, "tampered");
    expect(await blobs.materialise(id)).toBe(path);
    expect(Buffer.from(await readFile(path))).toEqual(Buffer.from(bytes));
  });

  it("materialises a file whose digest under the system's own tool is the blob's id", async () => {
    const id = await blobs.put(bytesOf("a payload too large for a record"));

    expect(await systemSha256(await blobs.materialise(id))).toBe(hexOfRecordId(id));
  });

  it("leaves nothing an add-everything in the enclosing repository stages", async () => {
    const id = await blobs.put(bytesOf("a bundle"));
    await blobs.materialise(id);

    await execa("git", ["-C", project, "add", "-A"]);

    const staged = (await execa("git", ["-C", project, "ls-files"])).stdout.split("\n");
    expect(staged.filter((path) => path.endsWith(hexOfRecordId(id)))).toEqual([]);
  });
});
