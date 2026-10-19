import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { IndexDb } from "@musai/fold";
import type { RunRecipe } from "@musai/records";
import { rawId, recordId } from "@musai/records";
import { fixedClock, ownGit } from "@musai/test-support";
import { execa } from "execa";
import { afterEach, describe, expect, test, vi } from "vitest";
import { readFixtureStore, readGolden } from "../src/fixtures.js";
import { ScaffoldRefusedError, scaffoldModule } from "../src/scaffold.js";
import { runModuleTests } from "../src/test.js";

const FIXED_INSTANT = "2026-08-30T00:00:00.000Z";
const FIXED_NOW = fixedClock(FIXED_INSTANT);

const THE_RECIPE: RunRecipe = {
  command: ["node", "-e", "process.stdout.write('ok')"],
  workingDirectory: ".",
  environment: {},
  declared: [],
  substrates: [{ name: "tree", uri: "musai:tree" }],
  isolation: "hygiene",
};
const THE_RECIPE_ID = recordId(THE_RECIPE);

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

async function scratchDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `musai-scaffold-${name}-`));
  cleanups.push(async () => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function walkAllFiles(dir: string, root: string = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git") {
      continue;
    }
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkAllFiles(entryPath, root)));
    } else {
      files.push(entryPath);
    }
  }
  return files;
}

/** Every file a scaffold wrote, by relative path and content digest, leaving out its `.git`. */
async function digestTree(dir: string): Promise<Record<string, string>> {
  const files = (await walkAllFiles(dir)).sort();
  const digests: Record<string, string> = {};
  for (const filePath of files) {
    const bytes = await readFile(filePath);
    digests[relative(dir, filePath)] = rawId(new Uint8Array(bytes));
  }
  return digests;
}

// Each case builds and runs a module under every host: about 15s loaded, so 3x that is the budget.
describe("a new module that is already green, and a template that cannot rot", { timeout: 45_000 }, () => {
  test("scaffolding an empty directory yields a module that builds and passes with no further action", async () => {
    const dir = await scratchDir("empty-directory");

    const result = await scaffoldModule(dir, { now: FIXED_NOW });

    expect(result.created).toBe(true);
    expect(result.testReport?.ok).toBe(true);
  });

  test("scaffolding closes every index it folds", async () => {
    const dir = await scratchDir("closes-indexes");
    const folded = vi.spyOn(IndexDb.prototype, "fold");
    const closed = vi.spyOn(IndexDb.prototype, "close");

    await scaffoldModule(dir, { now: FIXED_NOW });

    const released = new Set<unknown>(closed.mock.contexts);
    expect(folded.mock.contexts.length).toBeGreaterThan(0);
    expect(folded.mock.contexts.filter((index) => !released.has(index))).toEqual([]);
  });

  test("a scaffolded rule holds over a run standing in the module's own working tree, never the filesystem root", async () => {
    const dir = await scratchDir("own-tree");

    await scaffoldModule(dir, { now: FIXED_NOW });

    const store = await readFixtureStore(dir);
    const receipt = store.storedReceiptForRecipe(THE_RECIPE_ID)?.record;
    expect(receipt?.recipe.workingDirectory).toBe(".");
    expect(receipt?.observation.resolved).toEqual([
      { name: "tree", digest: { gitTree: expect.stringMatching(/^[0-9a-f]{40}$/) } },
    ]);
    const [fixtureCase] = store.cases;
    expect((await readGolden(store, fixtureCase!))?.response).toMatchObject({ kind: "verdict", label: "holds" });
  });

  test("a scaffold's receipt recorded again once deleted is the one its golden cites", async () => {
    const dir = await scratchDir("recorded-again");
    await scaffoldModule(dir, { now: FIXED_NOW });
    await rm(join(dir, "records"), { recursive: true, force: true });

    const report = await runModuleTests(dir, { record: true, now: FIXED_NOW });

    expect(report.results.filter((result) => result.status === "fail")).toEqual([]);
  });

  test("the recorded fixture receipts validate through the ordinary record validator and were minted by the runner, declaring exactly one binary, the runtime", async () => {
    const dir = await scratchDir("minted-receipt");

    await scaffoldModule(dir, { now: FIXED_NOW });

    const store = await readFixtureStore(dir);
    const receipt = store.storedReceiptForRecipe(THE_RECIPE_ID)?.record;
    expect(receipt).toBeDefined();
    expect(receipt?.observation.exitCode).toBe(0);
    expect(receipt?.observation.binaries).toHaveLength(1);
    expect(receipt?.observation.binaries[0]?.name).toBe("node");
  });

  test("a module scaffolded while the shell names another repository in GIT_DIR is its own sha1 repository, and that one is untouched", async () => {
    const other = join(await scratchDir("other-checkout"), "checkout");
    await execa("git", ["init", "--quiet", other]);
    const otherGitDir = join(other, ".git");
    const otherBefore = await digestTree(otherGitDir);
    const dir = await scratchDir("shell-git-dir");
    vi.stubEnv("GIT_DIR", otherGitDir);

    const result = await scaffoldModule(dir, { now: FIXED_NOW });
    vi.unstubAllEnvs();

    expect(result.testReport?.ok).toBe(true);
    expect(await ownGit(join(dir, ".git"), ["rev-parse", "--show-object-format"])).toBe("sha1");
    expect(await digestTree(otherGitDir)).toEqual(otherBefore);
  });

  test("scaffolding into a directory holding content it did not create is refused with the directory named", async () => {
    const dir = await scratchDir("occupied");
    await writeFile(join(dir, "unrelated.txt"), "already here\n");

    await expect(scaffoldModule(dir, { now: FIXED_NOW })).rejects.toThrow(ScaffoldRefusedError);
    await expect(scaffoldModule(dir, { now: FIXED_NOW })).rejects.toThrow(dir);
  });

  test("a second scaffold into a directory it did create says so and writes nothing new", async () => {
    const dir = await scratchDir("second-scaffold");

    const first = await scaffoldModule(dir, { now: FIXED_NOW });
    const digestsAfterFirst = await digestTree(dir);
    const second = await scaffoldModule(dir, { now: FIXED_NOW });
    const digestsAfterSecond = await digestTree(dir);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.testReport).toBeNull();
    expect(digestsAfterSecond).toEqual(digestsAfterFirst);
  });

  test("two scaffolds into two empty directories produce identical file sets, compared by content digest", async () => {
    const dirA = await scratchDir("identical-a");
    const dirB = await scratchDir("identical-b");

    await scaffoldModule(dirA, { now: FIXED_NOW });
    await scaffoldModule(dirB, { now: FIXED_NOW });

    const digestsA = await digestTree(dirA);
    const digestsB = await digestTree(dirB);
    expect(digestsB).toEqual(digestsA);
  });

  test("a built install's default template holds exactly its source's files, byte for byte", async () => {
    const built = await digestTree(fileURLToPath(new URL("../dist/templates/default", import.meta.url)));
    const source = await digestTree(fileURLToPath(new URL("../src/templates/default", import.meta.url)));

    expect(built).toEqual(source);
  });
});
