import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModuleRecord, PerformedRunRecord, ResourceDescriptor, ToolchainEntry } from "@musai/records";
import { canonicalBytes, hexOfRecordId, rawId, versionString } from "@musai/records";
import { Store } from "@musai/store";
import { blobStoreOf, type FixtureRepo, fixedClock, foldedIndex, makeFixtureRepo } from "@musai/test-support";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { BuildRefusedError, buildModule, buildModuleArtefacts } from "../src/build.js";
import { deriveManifest, ManifestError, MODULE_BUNDLE_GLOBAL, manifestBytes } from "../src/manifest.js";
import type { EsbuildMetafile } from "../src/metafile.js";
import { bundleOwners, bundleProvenance, outsideModuleDirectory, PurlDerivationError } from "../src/purl.js";

/** Every build here shares one instant, so one unchanged source mints one receipt. */
const FIXED_INSTANT = "2026-08-27T00:00:00.000Z";
const FIXED_NOW = fixedClock(FIXED_INSTANT);

const MINIMAL_FIXTURE_DIR = fileURLToPath(new URL("./fixtures/modules/minimal", import.meta.url));

/** The fixture lives nested in this repository, so its tree is captured against this `.git`. */
async function repoGitDir(): Promise<string> {
  const { stdout } = await execa("git", ["rev-parse", "--absolute-git-dir"], { cwd: MINIMAL_FIXTURE_DIR });
  return stdout.trim();
}

async function checkoutRoot(): Promise<string> {
  const { stdout } = await execa("git", ["rev-parse", "--show-toplevel"], { cwd: MINIMAL_FIXTURE_DIR });
  return stdout.trim();
}

interface ScratchSource {
  readonly dir: string;
  cleanup(): Promise<void>;
}

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = join(dir, relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
}

/** No commit is made: capturing a working tree needs none. */
async function writeRepositorySource(dir: string, files: Record<string, string>): Promise<void> {
  await mkdir(dir, { recursive: true });
  await execa("git", ["init", "--quiet"], { cwd: dir });
  await writeFiles(dir, files);
}

async function makeScratchSource(name: string, files: Record<string, string>): Promise<ScratchSource> {
  const dir = await mkdtemp(join(tmpdir(), `musai-module-source-${name}-`));
  await writeRepositorySource(dir, files);
  return {
    dir,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function packageJsonFor(name: string, version = "1.0.0"): string {
  return JSON.stringify({ name, version, private: true }, null, 2);
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

async function trackedRepo(): Promise<FixtureRepo> {
  const repo = await makeFixtureRepo();
  cleanups.push(repo.cleanup);
  return repo;
}

async function trackedSource(name: string, files: Record<string, string>): Promise<ScratchSource> {
  const source = await makeScratchSource(name, files);
  cleanups.push(source.cleanup);
  return source;
}

async function trackedRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `musai-module-${name}-`));
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  return root;
}

describe("building the fixture module produces a manifest nobody wrote and a receipt saying what the build stood on", () => {
  it("mints one module record id and byte-identical manifest bytes across two builds of one unchanged source", async () => {
    const repo = await trackedRepo();
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const index = await foldedIndex(store);
    const sourceGitDir = await repoGitDir();
    const options = { blobs: blobStoreOf(repo.workspace), index, sourceGitDir, now: FIXED_NOW };

    const first = await buildModule(MINIMAL_FIXTURE_DIR, store, options);
    const second = await buildModule(MINIMAL_FIXTURE_DIR, store, options);

    expect(second.moduleRecordId).toBe(first.moduleRecordId);
    expect(second.bundleId).toBe(first.bundleId);
    expect(second.buildReceiptId).toBe(first.buildReceiptId);

    const firstRecord = (await store.read(first.moduleRecordId, "module")) as ModuleRecord;
    const secondRecord = (await store.read(second.moduleRecordId, "module")) as ModuleRecord;
    expect(manifestBytes(secondRecord.manifest)).toEqual(manifestBytes(firstRecord.manifest));
  });

  it("names the source tree and both toolchain binaries by digest on the build's own receipt", async () => {
    const repo = await trackedRepo();
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const index = await foldedIndex(store);
    const sourceGitDir = await repoGitDir();
    const result = await buildModule(MINIMAL_FIXTURE_DIR, store, {
      blobs: blobStoreOf(repo.workspace),
      index,
      sourceGitDir,
      now: FIXED_NOW,
    });

    const receipt = (await store.read(result.buildReceiptId, "run")) as PerformedRunRecord;
    expect(receipt.recipe.substrates[0]!.digest?.gitTree).toBeTypeOf("string");
    expect(receipt.recipe.workingDirectory).toBe(".");
    expect(receipt.observation.binaries).toHaveLength(2);
    expect(receipt.observation.binaries.map((binary) => binary.name).sort()).toEqual(["esbuild", "node"]);
    for (const binary of receipt.observation.binaries) {
      expect(binary.digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("names the stored bundle blob's own digest as the receipt's output", async () => {
    const repo = await trackedRepo();
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const index = await foldedIndex(store);
    const sourceGitDir = await repoGitDir();
    const result = await buildModule(MINIMAL_FIXTURE_DIR, store, {
      blobs: blobStoreOf(repo.workspace),
      index,
      sourceGitDir,
      now: FIXED_NOW,
    });

    const receipt = (await store.read(result.buildReceiptId, "run")) as PerformedRunRecord;
    expect(receipt.observation.output).toBe(result.bundleId);
    const bundleBytes = await blobStoreOf(repo.workspace).read(result.bundleId);
    expect(bundleBytes.byteLength).toBeGreaterThan(0);
  });
});

describe("producing a build's artefacts needs no workspace, and storing them moves no byte", () => {
  it("answers the receipt, manifest and bundle a stored build of the same source holds, with no store to write to", async () => {
    const sourceGitDir = await repoGitDir();
    const artefacts = await buildModuleArtefacts(MINIMAL_FIXTURE_DIR, { sourceGitDir, now: FIXED_NOW });

    const repo = await trackedRepo();
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const index = await foldedIndex(store);
    const result = await buildModule(MINIMAL_FIXTURE_DIR, store, {
      blobs: blobStoreOf(repo.workspace),
      index,
      sourceGitDir,
      now: FIXED_NOW,
    });

    const receipt = (await store.read(result.buildReceiptId, "run")) as PerformedRunRecord;
    expect(canonicalBytes(artefacts.buildReceipt)).toEqual(canonicalBytes(receipt));

    const record = (await store.read(result.moduleRecordId, "module")) as ModuleRecord;
    expect(manifestBytes(artefacts.manifest)).toEqual(manifestBytes(record.manifest));
    expect(artefacts.name).toBe(record.name);
    expect(artefacts.version).toBe(record.version);

    expect(rawId(artefacts.bundleBytes)).toBe(result.bundleId);
    expect(await blobStoreOf(repo.workspace).read(result.bundleId)).toEqual(artefacts.bundleBytes);
  });
});

describe("a build's recipe names nothing about where this checkout sits on disk", () => {
  it("carries no path under the checkout root in its command, and names the bundler by its package, never its path", async () => {
    const repo = await trackedRepo();
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const index = await foldedIndex(store);
    const root = await checkoutRoot();
    const result = await buildModule(MINIMAL_FIXTURE_DIR, store, {
      blobs: blobStoreOf(repo.workspace),
      index,
      sourceGitDir: await repoGitDir(),
      now: FIXED_NOW,
    });

    const receipt = (await store.read(result.buildReceiptId, "run")) as PerformedRunRecord;
    expect(JSON.stringify(receipt.recipe.command)).not.toContain(root);
    expect(receipt.recipe.declared).toEqual([{ name: "MUSAI_BUNDLER_MAIN", secret: false }]);
    expect(receipt.observation.bindings).toHaveLength(1);
    expect(receipt.observation.bindings[0]).toMatchObject({
      name: "MUSAI_BUNDLER_MAIN",
      secret: false,
      layer: "bindings",
      keyedHash: null,
      keyId: null,
    });
    expect(receipt.observation.bindings[0]!.value).toMatch(/^esbuild@\d+\.\d+\.\d+:lib\/main\.js$/);
  });

  it("yields one module record from one source built at two paths: the same recipe bytes, the same manifest bytes, the same record id", async () => {
    const repo = await trackedRepo();
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const index = await foldedIndex(store);
    const files = {
      "package.json": await readFile(join(MINIMAL_FIXTURE_DIR, "package.json"), "utf8"),
      "module.ts": await readFile(join(MINIMAL_FIXTURE_DIR, "module.ts"), "utf8"),
    };
    const here = await trackedSource("here", files);
    const there = await trackedSource("there", files);

    const builtHere = await buildModule(here.dir, store, { blobs: blobStoreOf(repo.workspace), index, now: FIXED_NOW });
    const builtThere = await buildModule(there.dir, store, {
      blobs: blobStoreOf(repo.workspace),
      index,
      now: FIXED_NOW,
    });

    // Decoded only so a difference prints as JSON; the bytes compared are the kernel's.
    const decoded = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
    const receiptHere = (await store.read(builtHere.buildReceiptId, "run")) as PerformedRunRecord;
    const receiptThere = (await store.read(builtThere.buildReceiptId, "run")) as PerformedRunRecord;
    expect(decoded(canonicalBytes(receiptThere.recipe)), "the build recipe's canonical bytes").toBe(
      decoded(canonicalBytes(receiptHere.recipe)),
    );

    const recordHere = (await store.read(builtHere.moduleRecordId, "module")) as ModuleRecord;
    const recordThere = (await store.read(builtThere.moduleRecordId, "module")) as ModuleRecord;
    expect(decoded(manifestBytes(recordThere.manifest)), "the derived manifest's canonical bytes").toBe(
      decoded(manifestBytes(recordHere.manifest)),
    );

    expect(builtThere.moduleRecordId, "the module record id").toBe(builtHere.moduleRecordId);
  });
});

describe("a declared binary is named by the digest of the tool itself, not of a package manager's shim", () => {
  it("names the esbuild entry by the digest of the executable its own package manifest declares", async () => {
    const repo = await trackedRepo();
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const index = await foldedIndex(store);
    const result = await buildModule(MINIMAL_FIXTURE_DIR, store, {
      blobs: blobStoreOf(repo.workspace),
      index,
      sourceGitDir: await repoGitDir(),
      now: FIXED_NOW,
    });

    const receipt = (await store.read(result.buildReceiptId, "run")) as PerformedRunRecord;
    const esbuildEntry = receipt.observation.binaries.find((binary) => binary.name === "esbuild");
    expect(esbuildEntry).toBeDefined();

    const packageJsonPath = fileURLToPath(import.meta.resolve("esbuild/package.json"));
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { bin: { esbuild: string } };
    const executablePath = join(dirname(packageJsonPath), packageJson.bin.esbuild);
    const executableBytes = await readFile(executablePath);
    const expectedDigest = hexOfRecordId(rawId(executableBytes));

    expect(esbuildEntry!.digest).toBe(expectedDigest);

    const root = await checkoutRoot();
    const shimBytes = await readFile(join(root, "node_modules", ".bin", "esbuild"));
    const shimDigest = hexOfRecordId(rawId(shimBytes));
    expect(esbuildEntry!.digest).not.toBe(shimDigest);
  });
});

describe("the package that resolves esbuild for its build declares it as a dependency of its own", () => {
  it("names esbuild in its own package.json at the version the build's resolve finds", async () => {
    const ownPackageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const ownPackageJson = JSON.parse(await readFile(ownPackageJsonPath, "utf8")) as {
      dependencies: Record<string, string>;
    };

    const resolvedPackageJsonPath = fileURLToPath(import.meta.resolve("esbuild/package.json"));
    const resolvedPackageJson = JSON.parse(await readFile(resolvedPackageJsonPath, "utf8")) as { version: string };

    expect(ownPackageJson.dependencies.esbuild).toBe(resolvedPackageJson.version);
  });
});

describe("which repository a source tree is captured against is resolved from the source directory", () => {
  it("captures a module nested inside a larger checkout against that checkout, with no git directory named", async () => {
    const repo = await trackedRepo();
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const index = await foldedIndex(store);
    const blobs = blobStoreOf(repo.workspace);

    const named = await buildModule(MINIMAL_FIXTURE_DIR, store, {
      blobs,
      index,
      sourceGitDir: await repoGitDir(),
      now: FIXED_NOW,
    });
    const resolved = await buildModule(MINIMAL_FIXTURE_DIR, store, { blobs, index, now: FIXED_NOW });

    expect(resolved.buildReceiptId).toBe(named.buildReceiptId);
    expect(resolved.moduleRecordId).toBe(named.moduleRecordId);
  });

  it("captures a module checked out in a linked worktree, whose .git is a pointer file, against that worktree", async () => {
    const repo = await trackedRepo();
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const index = await foldedIndex(store);
    const source = await trackedSource("worktree", {
      "package.json": await readFile(join(MINIMAL_FIXTURE_DIR, "package.json"), "utf8"),
      "module.ts": await readFile(join(MINIMAL_FIXTURE_DIR, "module.ts"), "utf8"),
    });
    const git = (...args: string[]) =>
      execa("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], {
        cwd: source.dir,
      });
    await git("add", "--all");
    await git("commit", "--quiet", "-m", "seed");
    const linked = `${source.dir}-linked`;
    await git("worktree", "add", "--quiet", linked, "-b", "linked");
    cleanups.push(async () => {
      await rm(linked, { recursive: true, force: true });
    });
    const blobs = blobStoreOf(repo.workspace);

    const named = await buildModule(linked, store, {
      blobs,
      index,
      sourceGitDir: join(linked, ".git"),
      now: FIXED_NOW,
    });
    const resolved = await buildModule(linked, store, { blobs, index, now: FIXED_NOW });

    expect(resolved.buildReceiptId).toBe(named.buildReceiptId);
    expect(resolved.moduleRecordId).toBe(named.moduleRecordId);
  });

  it("refuses a source directory belonging to no repository, by name", async () => {
    const repo = await trackedRepo();
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const index = await foldedIndex(store);
    const dir = await mkdtemp(join(tmpdir(), "musai-module-source-unversioned-"));
    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    await writeFile(join(dir, "package.json"), packageJsonFor("unversioned"));
    await writeFile(join(dir, "module.ts"), "export const contributions = [];\n");

    await expect(
      buildModule(dir, store, { blobs: blobStoreOf(repo.workspace), index, now: FIXED_NOW }),
    ).rejects.toThrow(BuildRefusedError);
  });
});

describe("a manifest's contribution table does not depend on the order its typed export declared it in", () => {
  it("produces the same manifest bytes whichever order two contributions were declared in", async () => {
    const bundleFor = (contributionsLiteral: string): Uint8Array => {
      const source = [
        `var ${MODULE_BUNDLE_GLOBAL} = (function () {`,
        "  function respond(output) { return new TextEncoder().encode(JSON.stringify({ ok: true, output, diagnostics: [] })); }",
        "  function invoke(requestBytes) {",
        "    var request = JSON.parse(new TextDecoder().decode(requestBytes));",
        `    var contributions = ${contributionsLiteral};`,
        '    if (request.contribution === "describe") { return respond(contributions); }',
        '    return respond({ kind: "verdict", label: "open", reason: "not evaluated" });',
        "  }",
        "  return { invoke: invoke };",
        "})();",
      ].join("\n");
      return new TextEncoder().encode(source);
    };

    const parserEntry =
      '{"kind":"parser","id":"shuffled-module/exit-code","version":"1","input":true,"output":true,"documentation":"d"}';
    const ruleEntry =
      '{"kind":"rule","id":"shuffled-module/clean-exit","version":"1","input":true,"output":true,"documentation":"d"}';

    const sourceTree: ResourceDescriptor = { digest: { gitTree: "0".repeat(40) } };
    const toolchain: ToolchainEntry[] = [
      { name: "node", version: versionString("24.0.0") },
      { name: "esbuild", version: versionString("0.28.2") },
    ];

    const manifestA = await deriveManifest(
      "shuffled-module",
      bundleFor(`[${parserEntry}, ${ruleEntry}]`),
      [],
      sourceTree,
      toolchain,
    );
    const manifestB = await deriveManifest(
      "shuffled-module",
      bundleFor(`[${ruleEntry}, ${parserEntry}]`),
      [],
      sourceTree,
      toolchain,
    );

    expect(manifestB.contributions.map((entry) => entry.id)).toEqual(manifestA.contributions.map((entry) => entry.id));
    expect(manifestBytes(manifestB)).toEqual(manifestBytes(manifestA));
  });
});

describe("a module contributing nothing is not a special case", () => {
  it("builds and produces an empty contribution array", async () => {
    const repo = await trackedRepo();
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const index = await foldedIndex(store);
    const source = await trackedSource("empty", {
      "package.json": packageJsonFor("empty-module"),
      "module.ts": [
        "function respond(output) { return new TextEncoder().encode(JSON.stringify({ ok: true, output, diagnostics: [] })); }",
        "export function invoke(requestBytes) {",
        "  const request = JSON.parse(new TextDecoder().decode(requestBytes));",
        '  if (request.contribution === "describe") { return respond([]); }',
        '  return respond({ kind: "verdict", label: "open", reason: "not evaluated" });',
        "}",
      ].join("\n"),
    });

    const result = await buildModule(source.dir, store, { blobs: blobStoreOf(repo.workspace), index, now: FIXED_NOW });
    const record = (await store.read(result.moduleRecordId, "module")) as ModuleRecord;
    expect(record.manifest.contributions).toEqual([]);
  });
});

describe("the bundler takes its compiler options from the build's recipe", () => {
  /** How the bundler lowers a class field depends on `useDefineForClassFields`, so a stray
   * compiler option shows in the bundle's bytes. */
  const CLASS_FIELD_MODULE = {
    "package.json": packageJsonFor("class-field-module"),
    "module.ts": [
      'class Verdict { kind = "verdict"; label = "open"; reason = "not evaluated"; }',
      "function respond(output) { return new TextEncoder().encode(JSON.stringify({ ok: true, output, diagnostics: [] })); }",
      "export function invoke(requestBytes) {",
      "  const request = JSON.parse(new TextDecoder().decode(requestBytes));",
      '  if (request.contribution === "describe") { return respond([]); }',
      "  return respond(new Verdict());",
      "}",
    ].join("\n"),
  };

  /** The module's bundle with nothing above it, and beside a stray `configName` above it. */
  async function bundlesBesideStrayOptions(
    parent: string,
    configName: string,
  ): Promise<{ readonly bare: string; readonly besideStrayOptions: string }> {
    const root = await trackedRoot("compiler-options");
    for (const dir of ["bare", parent]) {
      await writeRepositorySource(join(root, dir, "module"), CLASS_FIELD_MODULE);
    }
    await writeFile(
      join(root, parent, configName),
      JSON.stringify({ compilerOptions: { useDefineForClassFields: false } }),
    );
    const [bare, besideStrayOptions] = await Promise.all(
      ["bare", parent].map(async (dir) => {
        const { bundleBytes } = await buildModuleArtefacts(join(root, dir, "module"), { now: FIXED_NOW });
        return new TextDecoder().decode(bundleBytes);
      }),
    );
    return { bare: bare!, besideStrayOptions: besideStrayOptions! };
  }

  it("gives the same bundle bytes whether or not a tsconfig.json sits in a directory above the module", async () => {
    const { bare, besideStrayOptions } = await bundlesBesideStrayOptions("ts", "tsconfig.json");

    expect(besideStrayOptions, "the bundle of the module under ts/, beside ts/tsconfig.json").toBe(bare);
  });

  it("gives the same bundle bytes whether or not a jsconfig.json sits in a directory above the module", async () => {
    const { bare, besideStrayOptions } = await bundlesBesideStrayOptions("js", "jsconfig.json");

    expect(besideStrayOptions, "the bundle of the module under js/, beside js/jsconfig.json").toBe(bare);
  });

  it("starts every bundle with the strict prologue, with no tsconfig.json anywhere above the module", async () => {
    const source = await trackedSource("strict", CLASS_FIELD_MODULE);

    const { bundleBytes } = await buildModuleArtefacts(source.dir, { now: FIXED_NOW });

    expect(new TextDecoder().decode(bundleBytes).slice(0, '"use strict";\n'.length)).toBe('"use strict";\n');
  });
});

describe("a build draws from outside its module's directory only the packages the module imports by name", () => {
  /** A module whose verdict's reason is what its one import brings in. */
  const moduleImporting = (specifier: string): string =>
    [
      `import { reason } from ${JSON.stringify(specifier)};`,
      "function respond(output) { return new TextEncoder().encode(JSON.stringify({ ok: true, output, diagnostics: [] })); }",
      "export function invoke(requestBytes) {",
      "  const request = JSON.parse(new TextDecoder().decode(requestBytes));",
      '  if (request.contribution === "describe") { return respond([]); }',
      '  return respond({ kind: "verdict", label: "open", reason });',
      "}",
    ].join("\n");

  const REASON_SOURCE = 'export const reason = "not evaluated";\n';

  /** Declares its entry by `exports` alone: the recipe's `platform: "neutral"` reads no `main`. */
  const TINY_DEP = {
    "node_modules/tiny-dep/package.json": JSON.stringify({ name: "tiny-dep", version: "1.2.3", exports: "./index.js" }),
    "node_modules/tiny-dep/index.js": REASON_SOURCE,
  };

  /** A workspace sibling whose entry draws a second file of its own by a relative import. */
  const siblingPackage = (manifest: Record<string, unknown>): Record<string, string> => ({
    "packages/sibling-util/package.json": JSON.stringify({ exports: "./index.js", ...manifest }),
    "packages/sibling-util/index.js": 'export { reason } from "./inner.js";\n',
    "packages/sibling-util/inner.js": REASON_SOURCE,
  });

  /** A junction, which Windows makes without privilege and other platforms make as a symlink. */
  async function linkDirectory(target: string, path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await symlink(target, path, "junction");
  }

  async function writeImportingModule(
    moduleDir: string,
    specifier: string,
    manifest: Record<string, unknown> = { name: "reaching-module", version: "1.0.0" },
  ): Promise<void> {
    await writeRepositorySource(moduleDir, {
      "package.json": JSON.stringify(manifest),
      "module.ts": moduleImporting(specifier),
    });
  }

  async function moduleBeside(root: string, specifier: string, around: Record<string, string>): Promise<string> {
    await writeFiles(root, around);
    const moduleDir = join(root, "module");
    await writeImportingModule(moduleDir, specifier);
    return moduleDir;
  }

  /** A pnpm workspace whose `packages/pack/m` module imports `specifier`, with
   * `node_modules/@acme` linking `pack` and its sibling `other`. */
  async function moduleInWorkspace(root: string, specifier: string): Promise<string> {
    await writeFiles(root, {
      "packages/other/package.json": JSON.stringify({ name: "@acme/other", version: "3.1.4", exports: "./x.js" }),
      "packages/other/x.js": REASON_SOURCE,
      "packages/pack/package.json": JSON.stringify({ name: "@acme/pack", version: "0.1.0" }),
    });
    const moduleDir = join(root, "packages", "pack", "m");
    await writeImportingModule(moduleDir, specifier);
    await linkDirectory(join(root, "packages", "pack"), join(root, "node_modules", "@acme", "pack"));
    await linkDirectory(join(root, "packages", "other"), join(root, "node_modules", "@acme", "other"));
    return moduleDir;
  }

  const outsideRefusal = (moduleDir: string, inputs: string): string =>
    `refusing to build reaching-module: its bundle draws ${inputs} from outside its directory ${moduleDir} as the module's own source; a file is the module's own when the module reaches it by path, when a pattern import matches it, or when the nearest package.json above it that names a package holds the module`;

  it("refuses a module whose source imports a file from outside its directory, naming the input, before anything is stored", async () => {
    const repo = await trackedRepo();
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const index = await foldedIndex(store);
    const moduleDir = await moduleBeside(await trackedRoot("outside"), "../shared/value.js", {
      "shared/value.ts": 'export const reason: string = "not evaluated";\n',
    });
    const tipBefore = await store.tip();

    const refusal = await buildModule(moduleDir, store, {
      blobs: blobStoreOf(repo.workspace),
      index,
      now: FIXED_NOW,
    }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(BuildRefusedError);
    expect((refusal as BuildRefusedError).message).toBe(outsideRefusal(moduleDir, "../shared/value.ts"));
    expect(await store.tip(), "the scope's tip after the refusal").toBe(tipBefore);
    expect(await store.list("run"), "the run records the store holds").toEqual([]);
  });

  it("refuses an outside input whose import suffix climbs back into the module, naming the input as the bundler printed it", async () => {
    const moduleDir = await moduleBeside(await trackedRoot("suffix"), "../shared/value.js?/../../module/absent", {
      "shared/value.ts": 'export const reason: string = "not evaluated";\n',
    });

    await expect(buildModuleArtefacts(moduleDir, { now: FIXED_NOW })).rejects.toThrow(
      new BuildRefusedError(outsideRefusal(moduleDir, "../shared/value.ts?/../../module/absent")),
    );
  });

  it("refuses a module that reaches a file in a node_modules outside it by a relative import, naming the file", async () => {
    const moduleDir = await moduleBeside(await trackedRoot("relative-package"), "../node_modules/pkg/index.js", {
      "node_modules/pkg/package.json": JSON.stringify({ name: "pkg", version: "2.0.0" }),
      "node_modules/pkg/index.js": REASON_SOURCE,
    });

    await expect(buildModuleArtefacts(moduleDir, { now: FIXED_NOW })).rejects.toThrow(
      new BuildRefusedError(outsideRefusal(moduleDir, "../node_modules/pkg/index.js")),
    );
  });

  it("refuses a module that reaches outside its directory through a link inside it, naming the file the link leads to", async () => {
    const root = await trackedRoot("link-out");
    const moduleDir = await moduleBeside(root, "./lib/value.js", { "shared/value.ts": REASON_SOURCE });
    await linkDirectory(join(root, "shared"), join(moduleDir, "lib"));

    await expect(buildModuleArtefacts(moduleDir, { now: FIXED_NOW })).rejects.toThrow(
      new BuildRefusedError(outsideRefusal(moduleDir, "../shared/value.ts")),
    );
  });

  it("refuses a file outside its directory that a pattern import matches, naming the file", async () => {
    const root = await trackedRoot("pattern");
    await writeFiles(root, { "shared/value.ts": REASON_SOURCE });
    const moduleDir = join(root, "module");
    await writeRepositorySource(moduleDir, {
      "package.json": JSON.stringify({ name: "reaching-module", version: "1.0.0" }),
      "module.ts": `${moduleImporting("./reason.js")}\nexport const load = (name) => import(\`../shared/\${name}.ts\`);\n`,
      "reason.ts": REASON_SOURCE,
    });

    await expect(buildModuleArtefacts(moduleDir, { now: FIXED_NOW })).rejects.toThrow(
      new BuildRefusedError(outsideRefusal(moduleDir, "../shared/value.ts")),
    );
  });

  it("builds a module whose bare import resolves through a node_modules above it, and names the dependency by package url", async () => {
    const moduleDir = await moduleBeside(await trackedRoot("dependency"), "tiny-dep", TINY_DEP);

    const { manifest } = await buildModuleArtefacts(moduleDir, { now: FIXED_NOW });

    expect(manifest.packages).toEqual(["pkg:npm/tiny-dep@1.2.3"]);
  });

  it("names a dependency by package url whatever suffix its import carries", async () => {
    const moduleDir = await moduleBeside(
      await trackedRoot("dependency-suffix"),
      "tiny-dep?/../../../module/absent",
      TINY_DEP,
    );

    const { manifest } = await buildModuleArtefacts(moduleDir, { now: FIXED_NOW });

    expect(manifest.packages).toEqual(["pkg:npm/tiny-dep@1.2.3"]);
  });

  it("records a workspace sibling imported by name through a linked node_modules entry by its package.json alone, whichever node_modules holds the link", async () => {
    for (const linkParent of ["module/node_modules", "node_modules"]) {
      const root = await trackedRoot("sibling");
      const moduleDir = await moduleBeside(
        root,
        "sibling-util",
        siblingPackage({ name: "sibling-util", version: "1.0.0" }),
      );
      await linkDirectory(join(root, "packages", "sibling-util"), join(root, linkParent, "sibling-util"));

      const { manifest } = await buildModuleArtefacts(moduleDir, { now: FIXED_NOW });

      expect(manifest.packages, `the packages, the link in ${linkParent}/`).toEqual(["pkg:npm/sibling-util@1.0.0"]);
    }
  });

  it("records a package by the version its package.json holds, 0.0.0 as it stands", async () => {
    const root = await trackedRoot("zero-version");
    const moduleDir = await moduleBeside(
      root,
      "sibling-util",
      siblingPackage({ name: "sibling-util", version: "0.0.0" }),
    );
    await linkDirectory(join(root, "packages", "sibling-util"), join(root, "node_modules", "sibling-util"));

    const { manifest } = await buildModuleArtefacts(moduleDir, { now: FIXED_NOW });

    expect(manifest.packages).toEqual(["pkg:npm/sibling-util@0.0.0"]);
  });

  it("refuses a package whose package.json names no version, naming the file drawn from it", async () => {
    const root = await trackedRoot("no-version");
    const moduleDir = await moduleBeside(root, "sibling-util", siblingPackage({ name: "sibling-util" }));
    await linkDirectory(join(root, "packages", "sibling-util"), join(root, "node_modules", "sibling-util"));

    await expect(buildModuleArtefacts(moduleDir, { now: FIXED_NOW })).rejects.toThrow(
      new PurlDerivationError(
        "refusing to derive a package url for ../packages/sibling-util/index.js: its package.json, ../packages/sibling-util/package.json, names sibling-util and no version",
      ),
    );
  });

  it("names a package by the nearest package.json above the file that names one, past one that names none", async () => {
    const root = await trackedRoot("nested-manifest");
    const moduleDir = await moduleBeside(root, "sibling-util", {
      "packages/sibling-util/package.json": JSON.stringify({
        name: "sibling-util",
        version: "1.0.0",
        exports: "./esm/index.js",
      }),
      "packages/sibling-util/esm/package.json": JSON.stringify({ type: "module" }),
      "packages/sibling-util/esm/index.js": REASON_SOURCE,
    });
    await linkDirectory(join(root, "packages", "sibling-util"), join(root, "node_modules", "sibling-util"));

    const { manifest } = await buildModuleArtefacts(moduleDir, { now: FIXED_NOW });

    expect(manifest.packages).toEqual(["pkg:npm/sibling-util@1.0.0"]);
  });

  it("refuses a file drawn by name from a directory no package.json naming a package sits above, naming the file", async () => {
    const root = await trackedRoot("nameless");
    const moduleDir = await moduleBeside(root, "sibling-util", siblingPackage({ version: "1.0.0" }));
    await linkDirectory(join(root, "packages", "sibling-util"), join(root, "node_modules", "sibling-util"));

    await expect(buildModuleArtefacts(moduleDir, { now: FIXED_NOW })).rejects.toThrow(
      new PurlDerivationError(
        "refusing to derive a package url for ../packages/sibling-util/index.js: no package.json above it names a package",
      ),
    );
  });

  it("refuses a relative import from outside the module's directory alike by its real path and through a linked path", async () => {
    const root = await trackedRoot("linked-refusal");
    const moduleDirs = [
      await moduleInWorkspace(root, "../../other/x.js"),
      join(root, "node_modules", "@acme", "pack", "m"),
    ];

    const outcomes = await Promise.all(
      moduleDirs.map((moduleDir) =>
        buildModuleArtefacts(moduleDir, { now: FIXED_NOW }).then(
          () => "built",
          (error: unknown) => (error instanceof BuildRefusedError ? error.message : error),
        ),
      ),
    );

    expect(outcomes).toEqual(moduleDirs.map((moduleDir) => outsideRefusal(moduleDir, "../../other/x.js")));
  });

  it("derives one manifest for a module built by its real path and through a linked path, naming no package that holds the module", async () => {
    const root = await trackedRoot("linked-manifest");
    const realDir = await moduleInWorkspace(root, "@acme/other");

    const byRealPath = await buildModuleArtefacts(realDir, { now: FIXED_NOW });
    const byLinkedPath = await buildModuleArtefacts(join(root, "node_modules", "@acme", "pack", "m"), {
      now: FIXED_NOW,
    });

    expect(byRealPath.manifest.packages).toEqual(["pkg:npm/%40acme/other@3.1.4"]);
    const decoded = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
    expect(decoded(manifestBytes(byLinkedPath.manifest)), "the manifest built through the linked path").toBe(
      decoded(manifestBytes(byRealPath.manifest)),
    );
  });

  it("names a dependency alike when the module is built through a link to its directory from a different depth", async () => {
    const root = await trackedRoot("linked-depth");
    await writeFiles(join(root, "real"), TINY_DEP);
    const realDir = join(root, "real", "deep", "module");
    await writeImportingModule(realDir, "tiny-dep");
    await linkDirectory(realDir, join(root, "module-link"));

    const { manifest } = await buildModuleArtefacts(join(root, "module-link"), { now: FIXED_NOW });

    expect(manifest.packages).toEqual(["pkg:npm/tiny-dep@1.2.3"]);
  });

  it("reads a data URL a package imports as no file, whatever directory its text climbs to", async () => {
    const root = await trackedRoot("package-data-url");
    const moduleDir = await moduleBeside(root, "tiny-dep", {
      ...TINY_DEP,
      "node_modules/tiny-dep/index.js":
        "export { reason } from 'data:text/javascript,export let reason//../../../o';\n",
    });

    const { manifest } = await buildModuleArtefacts(moduleDir, { now: FIXED_NOW });

    expect(manifest.packages).toEqual(["pkg:npm/tiny-dep@1.2.3"]);
  });

  it("builds a module that imports its own files by its own package name, recording no package", async () => {
    const root = await trackedRoot("self-reference");
    const moduleDir = join(root, "module");
    await writeImportingModule(moduleDir, "reaching-module/lib", {
      name: "reaching-module",
      version: "1.0.0",
      exports: { "./lib": "./lib/value.js" },
    });
    await writeFiles(moduleDir, { "lib/value.js": REASON_SOURCE });

    const { manifest } = await buildModuleArtefacts(moduleDir, { now: FIXED_NOW });

    expect(manifest.packages).toEqual([]);
  });

  it("refuses a module that imports by name the package holding it, naming the file drawn from outside its directory", async () => {
    const root = await trackedRoot("enclosing");
    await writeFiles(root, {
      "pack/package.json": JSON.stringify({ name: "pack", version: "1.0.0", exports: "./index.js" }),
      "pack/index.js": REASON_SOURCE,
    });
    const moduleDir = join(root, "pack", "m");
    await writeImportingModule(moduleDir, "pack");
    await linkDirectory(join(root, "pack"), join(root, "node_modules", "pack"));

    await expect(buildModuleArtefacts(moduleDir, { now: FIXED_NOW })).rejects.toThrow(
      new BuildRefusedError(outsideRefusal(moduleDir, "../index.js")),
    );
  });
});

/** One import a hand-written metafile records: its resolved key and what the bundler printed. */
interface RecordedImport {
  readonly path: string;
  readonly original?: string;
  readonly kind?: string;
  readonly external?: boolean;
}

/** Keyed as the bundler keys inputs, relative to the directory it ran in. */
const metafileOf = (imports: Record<string, readonly RecordedImport[]>): EsbuildMetafile => ({
  inputs: Object.fromEntries(
    Object.entries(imports).map(([key, list]) => [
      key,
      { bytes: 0, imports: list.map((recorded) => ({ kind: "import-statement", ...recorded })) },
    ]),
  ),
  outputs: {},
});

describe("whose each file of a bundle is, read from the specifiers its importers wrote", () => {
  it("makes a file the module reaches by path its own, and one reached by a package's name that package's, with what that file draws by path", () => {
    const metafile = metafileOf({
      "module.ts": [
        { path: "lib/a.ts", original: "./lib/a.js" },
        { path: "../node_modules/dep/index.js", original: "dep" },
      ],
      "lib/a.ts": [],
      "../node_modules/dep/index.js": [{ path: "../node_modules/dep/inner.js", original: "./inner.js" }],
      "../node_modules/dep/inner.js": [],
    });

    expect(bundleOwners(metafile, "module.ts")).toEqual({
      own: ["lib/a.ts", "module.ts"],
      packaged: ["../node_modules/dep/index.js", "../node_modules/dep/inner.js"],
    });
  });

  it("makes a file reached both by path from the module and by a package's name the module's own and the package's too", () => {
    const metafile = metafileOf({
      "module.ts": [
        { path: "../node_modules/dep/index.js", original: "dep" },
        { path: "../node_modules/dep/index.js", original: "../node_modules/dep/index.js" },
      ],
      "../node_modules/dep/index.js": [],
    });

    expect(bundleOwners(metafile, "module.ts")).toEqual({
      own: ["../node_modules/dep/index.js", "module.ts"],
      packaged: ["../node_modules/dep/index.js"],
    });
  });

  it("keeps a file a package draws from outside its own directory, by path or by name, that package's", () => {
    const metafile = metafileOf({
      "module.ts": [{ path: "../node_modules/dep/index.js", original: "dep" }],
      "../node_modules/dep/index.js": [
        { path: "../shared/x.js", original: "../../shared/x.js" },
        { path: "../node_modules/other/index.js", original: "other" },
      ],
      "../shared/x.js": [],
      "../node_modules/other/index.js": [],
    });

    expect(bundleOwners(metafile, "module.ts")).toEqual({
      own: ["module.ts"],
      packaged: ["../node_modules/dep/index.js", "../node_modules/other/index.js", "../shared/x.js"],
    });
  });

  it("skips an import whose path names no input, and keeps an import carrying no specifier its importer's", () => {
    const metafile = metafileOf({
      "module.ts": [
        { path: "<runtime>", external: true },
        { path: "./lib/unused.js?raw", external: true },
        { path: "../shared/x.ts" },
        { path: "../node_modules/dep/index.js", original: "dep" },
      ],
      "../shared/x.ts": [],
      "../node_modules/dep/index.js": [{ path: "../node_modules/dep/y.js" }],
      "../node_modules/dep/y.js": [],
    });

    expect(bundleOwners(metafile, "module.ts")).toEqual({
      own: ["../shared/x.ts", "module.ts"],
      packaged: ["../node_modules/dep/index.js", "../node_modules/dep/y.js"],
    });
  });

  it("reads every kind of import alike: a subpath import, a data URL and an absolute path keep their importer's owner, and a package's name hands the file to its package", () => {
    const dataUrl = "data:text/javascript,export const v = 1";
    const metafile = metafileOf({
      "module.ts": [
        { path: "lib/sub.ts", kind: "require-call", original: "#sub" },
        { path: `<${dataUrl}>`, kind: "dynamic-import", original: dataUrl },
        { path: "../abs/x.ts", kind: "import-statement", original: "/r/abs/x.ts" },
        { path: "../node_modules/@scope/dep/index.js", kind: "dynamic-import", original: "@scope/dep" },
        { path: "../node_modules/plain/index.js", kind: "require-call", original: "plain" },
      ],
      "lib/sub.ts": [],
      [`<${dataUrl}>`]: [],
      "../abs/x.ts": [],
      "../node_modules/@scope/dep/index.js": [],
      "../node_modules/plain/index.js": [],
    });

    expect(bundleOwners(metafile, "module.ts")).toEqual({
      own: ["../abs/x.ts", `<${dataUrl}>`, "lib/sub.ts", "module.ts"],
      packaged: ["../node_modules/@scope/dep/index.js", "../node_modules/plain/index.js"],
    });
  });

  it("makes an input no import reaches, as a pattern import's match, the module's own, and the entry its own however a package reaches it", () => {
    const metafile = metafileOf({
      "module.ts": [
        { path: "./lib/**/*.ts", external: true },
        { path: "../node_modules/dep/index.js", original: "dep" },
      ],
      "lib/a.ts": [],
      "../shared/b.ts": [],
      "../node_modules/dep/index.js": [{ path: "module.ts", original: "reaching-module" }],
    });

    expect(bundleOwners(metafile, "module.ts")).toEqual({
      own: ["../shared/b.ts", "lib/a.ts", "module.ts"],
      packaged: ["../node_modules/dep/index.js", "module.ts"],
    });
  });
});

describe("which of the module's own files lie outside its directory", () => {
  it("reads a key by its segments: a sibling directory named with the module's name as its prefix lies outside, a file whose name begins with two dots inside", () => {
    expect(outsideModuleDirectory(["module.ts", "lib/value.ts", "..value.ts", "../m-extra/value.ts"])).toEqual([
      "../m-extra/value.ts",
    ]);
  });

  it("reads each key by the file it names rather than its import's suffix, and names each outside file as keyed, sorted", () => {
    expect(
      outsideModuleDirectory([
        "module.ts",
        "lib/a?b.ts",
        "lib/value.ts?/../../../x",
        "<data:text/javascript,export const reason = 1>",
        "<data:text/javascript,//../../../../x>",
        "../shared/value.ts?/../../m/absent",
        "../shared/value.ts#/node_modules/x/y.js",
      ]),
    ).toEqual(["../shared/value.ts#/node_modules/x/y.js", "../shared/value.ts?/../../m/absent"]);
  });
});

describe("which package.json names a file a package's name drew", () => {
  it("reads a path that runs through a file, as a key into an archive under Yarn PnP does, as holding no package.json, and walks on above it", async () => {
    const root = await trackedRoot("archive");
    await writeFiles(root, {
      "project/package.json": JSON.stringify({ name: "project", version: "1.0.0" }),
      "project/.yarn/cache/dep.zip": "an archive, not a directory",
    });
    const moduleDir = join(root, "project", "module");
    await mkdir(moduleDir, { recursive: true });
    const archived = "../.yarn/cache/dep.zip/node_modules/dep/index.js";
    const metafile = metafileOf({ "module.ts": [{ path: archived, original: "dep" }], [archived]: [] });

    await expect(bundleProvenance(metafile, "module.ts", moduleDir)).resolves.toEqual({
      outsideDirectory: [archived],
      packages: [],
    });
  });
});

describe("a bundle that reaches for a runtime built-in fails the build rather than the invocation", () => {
  it("names the specifier in the build's own refusal", async () => {
    const repo = await trackedRepo();
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const index = await foldedIndex(store);
    const source = await trackedSource("builtin", {
      "package.json": packageJsonFor("builtin-module"),
      "module.ts": [
        "import { readFileSync } from 'node:fs';",
        "export function invoke(requestBytes) { return requestBytes; }",
        "void readFileSync;",
      ].join("\n"),
    });

    await expect(
      buildModule(source.dir, store, { blobs: blobStoreOf(repo.workspace), index, now: FIXED_NOW }),
    ).rejects.toThrow(BuildRefusedError);
    await expect(
      buildModule(source.dir, store, { blobs: blobStoreOf(repo.workspace), index, now: FIXED_NOW }),
    ).rejects.toThrow(/node:fs/);
  });
});

describe("the one possible refusals a describe answer can still earn before any record is minted", () => {
  it("refuses two contributions sharing one id and version, by name", async () => {
    const repo = await trackedRepo();
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const index = await foldedIndex(store);
    const source = await trackedSource("dup-id", {
      "package.json": packageJsonFor("dup-module"),
      "module.ts": [
        'const ENTRY = { kind: "rule", id: "dup-module/only", version: "1", input: true, output: true, documentation: "d" };',
        "const CONTRIBUTIONS = [ENTRY, ENTRY];",
        "function respond(output) { return new TextEncoder().encode(JSON.stringify({ ok: true, output, diagnostics: [] })); }",
        "export function invoke(requestBytes) {",
        "  const request = JSON.parse(new TextDecoder().decode(requestBytes));",
        '  if (request.contribution === "describe") { return respond(CONTRIBUTIONS); }',
        '  return respond({ kind: "verdict", label: "open", reason: "not evaluated" });',
        "}",
      ].join("\n"),
    });

    await expect(
      buildModule(source.dir, store, { blobs: blobStoreOf(repo.workspace), index, now: FIXED_NOW }),
    ).rejects.toThrow(ManifestError);
    await expect(
      buildModule(source.dir, store, { blobs: blobStoreOf(repo.workspace), index, now: FIXED_NOW }),
    ).rejects.toThrow(/dup-module\/only/);
  });

  it("refuses a contribution id not namespaced by its own module's name, by name", async () => {
    const repo = await trackedRepo();
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const index = await foldedIndex(store);
    const source = await trackedSource("bad-namespace", {
      "package.json": packageJsonFor("owner-module"),
      "module.ts": [
        'const ENTRY = { kind: "rule", id: "someone-else/only", version: "1", input: true, output: true, documentation: "d" };',
        "const CONTRIBUTIONS = [ENTRY];",
        "function respond(output) { return new TextEncoder().encode(JSON.stringify({ ok: true, output, diagnostics: [] })); }",
        "export function invoke(requestBytes) {",
        "  const request = JSON.parse(new TextDecoder().decode(requestBytes));",
        '  if (request.contribution === "describe") { return respond(CONTRIBUTIONS); }',
        '  return respond({ kind: "verdict", label: "open", reason: "not evaluated" });',
        "}",
      ].join("\n"),
    });

    await expect(
      buildModule(source.dir, store, { blobs: blobStoreOf(repo.workspace), index, now: FIXED_NOW }),
    ).rejects.toThrow(ManifestError);
    await expect(
      buildModule(source.dir, store, { blobs: blobStoreOf(repo.workspace), index, now: FIXED_NOW }),
    ).rejects.toThrow(/someone-else\/only/);
  });
});

describe("the global a bundle assigns its exports onto", () => {
  // Each host's call script cannot import this package, so it carries the name by value.
  const carriedByValue = ["../../modules/src/module/host-child.ts", "../../modules/src/rule/sandbox-worker.ts"];

  it.each(carriedByValue)("is spelled the same in %s as the bundler writes it", async (relativePath) => {
    const source = await readFile(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
    expect(source).toContain(`"${MODULE_BUNDLE_GLOBAL}"`);
  });
});
