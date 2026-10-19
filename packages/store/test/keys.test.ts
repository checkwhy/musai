import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixedClock } from "@musai/test-support";
import { execa } from "execa";
import { describe, expect, test } from "vitest";
import { listKeys, mintKeyFile, readKeyFile } from "../src/keys.js";

const here = dirname(fileURLToPath(import.meta.url));
const workerScript = join(here, "support", "key-file-worker.ts");
const tsLoader = fileURLToPath(import.meta.resolve("@musai/test-support/ts-esm"));

const now = fixedClock("2026-01-01T00:00:00.000Z");

async function withLocalDir<T>(fn: (localDir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "musai-key-file-"));
  const localDir = join(root, "local");
  await mkdir(localDir, { recursive: true });
  try {
    return await fn(localDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A file-size limit of zero lets the worker create a file but never write a byte into it. */
async function runWithoutWrites(verb: "mint" | "rotate", localDir: string): Promise<{ ok: boolean }> {
  const result = await execa(
    "sh",
    ["-c", 'ulimit -f 0 && exec "$@"', "sh", "node", "--import", tsLoader, workerScript, verb, localDir],
    { reject: false },
  );
  return JSON.parse(result.stdout) as { ok: boolean };
}

describe.skipIf(process.platform === "win32")("the key file is never seen before it is whole", () => {
  test("a mint whose write never lands leaves no key file behind, so the next mint succeeds", async () => {
    await withLocalDir(async (localDir) => {
      expect((await runWithoutWrites("mint", localDir)).ok).toBe(false);

      expect(await readdir(localDir)).toEqual([]);
      expect(await listKeys(localDir)).toEqual([]);
      const minted = await mintKeyFile(localDir, { now });
      expect((await readKeyFile(localDir)).keys).toEqual(minted.keys);
      expect(await readdir(localDir)).toEqual(["keys.json"]);
    });
  });

  test("a rotation whose write never lands leaves the previous key file as it was", async () => {
    await withLocalDir(async (localDir) => {
      await mintKeyFile(localDir, { now });
      const before = await readFile(join(localDir, "keys.json"), "utf8");

      expect((await runWithoutWrites("rotate", localDir)).ok).toBe(false);

      expect(await readdir(localDir)).toEqual(["keys.json"]);
      expect(await readFile(join(localDir, "keys.json"), "utf8")).toBe(before);
    });
  });
});

describe("a key the enclosing working tree would stage is never minted", () => {
  test("the refusal names every act that needs a workspace key, salting a record as well as a secret", async () => {
    const enclosing = await mkdtemp(join(tmpdir(), "musai-key-enclosing-"));
    try {
      await execa("git", ["init", "--quiet", "--initial-branch", "main", enclosing]);
      const localDir = join(enclosing, ".musai", "local");
      await mkdir(localDir, { recursive: true });
      await expect(mintKeyFile(localDir, { now })).rejects.toThrow(/binding a secret or salting a record/);
    } finally {
      await rm(enclosing, { recursive: true, force: true });
    }
  });
});
