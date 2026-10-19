import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IndexDb } from "@musai/fold";
import { installModule } from "@musai/modules";
import type { ModuleManifest, RunObservation, RunRecipe, RunRecord, ToolchainEntry } from "@musai/records";
import {
  type Clock,
  CURRENT_SCHEMA_VERSIONS,
  hexOfRecordId,
  KernelError,
  type RecordId,
  rawId,
  textOf,
  type VersionString,
  versionString,
} from "@musai/records";
import { performRecipe, RUNNER_PERFORMER, treeSubstrate } from "@musai/run";
import type { BlobStore, Store } from "@musai/store";
import { type GitContext, resolveGitDir } from "@musai/store";
import { deriveManifest, MODULE_BUNDLE_GLOBAL } from "./manifest.js";
import type { EsbuildMetafile } from "./metafile.js";
import { bundleProvenance } from "./purl.js";

/** Raised before anything is minted, when the source or its bundle cannot be built. */
export class BuildRefusedError extends KernelError {
  constructor(message: string) {
    super({ reason: "invalid-input", detail: message });
    this.name = "BuildRefusedError";
  }
}

/** `sourceGitDir` defaults to the repository holding the source directory, nested or its own. */
export interface BuildArtefactsOptions {
  readonly sourceGitDir?: string;
  readonly now: Clock;
}

/** Adds the workspace a build is stored in and the fold install resolves contributions against. */
export interface BuildModuleOptions extends BuildArtefactsOptions {
  readonly blobs: BlobStore;
  readonly index: IndexDb;
}

/** What a build produces before anything is stored. */
export interface ModuleArtefacts {
  readonly name: string;
  readonly version: VersionString;
  readonly bundleBytes: Uint8Array;
  readonly manifest: ModuleManifest;
  readonly buildReceipt: RunRecord;
}

export interface BuildResult {
  readonly moduleRecordId: RecordId;
  readonly bundleId: RecordId;
  readonly buildReceiptId: RecordId;
}

const ENTRY_FILE_NAME = "module.ts";

/** A label esbuild's metafile keys against, never a path written: the bundle returns on stdout. */
const OUTPUT_LABEL = "bundle.js";

/** Where the bundler sits is this machine's fact: the machine binds it and the recipe names it. */
const BUNDLER_MAIN_NAME = "MUSAI_BUNDLER_MAIN";

interface ModulePackageJson {
  readonly name?: unknown;
  readonly version?: unknown;
}

async function readModulePackageJson(sourceDir: string): Promise<ModulePackageJson> {
  let text: string;
  try {
    text = await readFile(join(sourceDir, "package.json"), "utf8");
  } catch {
    throw new BuildRefusedError(`refusing to build ${sourceDir}: it names no package.json`);
  }
  return JSON.parse(text) as ModulePackageJson;
}

function moduleNameFrom(sourceDir: string, packageJson: ModulePackageJson): string {
  if (typeof packageJson.name !== "string" || packageJson.name.length === 0) {
    throw new BuildRefusedError(`refusing to build ${sourceDir}: its package manifest names no module name`);
  }
  return packageJson.name;
}

function moduleVersionFrom(sourceDir: string, packageJson: ModulePackageJson): VersionString {
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new BuildRefusedError(`refusing to build ${sourceDir}: its package manifest names no version`);
  }
  return versionString(packageJson.version);
}

interface EsbuildPackageJson {
  readonly version: string;
  readonly bin: { readonly esbuild: string };
}

/** Never a `PATH` lookup: a package manager's shim answers for the checkout it was generated in. */
async function installedEsbuild(): Promise<{
  readonly version: VersionString;
  readonly binaryPath: string;
  readonly packageDir: string;
}> {
  const packageJsonPath = fileURLToPath(import.meta.resolve("esbuild/package.json"));
  const text = await readFile(packageJsonPath, "utf8");
  const parsed = JSON.parse(text) as EsbuildPackageJson;
  return {
    version: versionString(parsed.version),
    binaryPath: join(dirname(packageJsonPath), parsed.bin.esbuild),
    packageDir: dirname(packageJsonPath),
  };
}

/** No path this machine resolved enters the script and the bundler reads no tsconfig, so two builds
 * of one unchanged source mint one recipe. */
function buildScriptSource(entryPath: string, globalName: string): string {
  return [
    `const esbuild = require(process.env[${JSON.stringify(BUNDLER_MAIN_NAME)}]);`,
    "const result = esbuild.buildSync({",
    `  entryPoints: [${JSON.stringify(entryPath)}],`,
    "  bundle: true,",
    '  platform: "neutral",',
    '  target: "es2020",',
    "  tsconfigRaw: { compilerOptions: { alwaysStrict: true } },",
    '  format: "iife",',
    `  globalName: ${JSON.stringify(globalName)},`,
    `  outfile: ${JSON.stringify(OUTPUT_LABEL)},`,
    "  metafile: true,",
    "  write: false,",
    '  logLevel: "silent",',
    "});",
    `const bundleFile = result.outputFiles.find((file) => file.path.endsWith(${JSON.stringify(OUTPUT_LABEL)}));`,
    "process.stdout.write(JSON.stringify({ bundle: bundleFile.text, metafile: result.metafile }));",
  ].join("\n");
}

interface BuildScriptOutput {
  readonly bundle: string;
  readonly metafile: EsbuildMetafile;
}

/** Builds a module's bundle, its build run and its derived manifest, storing nothing. A bundle that
 * draws a file of the module's own from outside its directory refuses the build. */
export async function buildModuleArtefacts(
  sourceDir: string,
  options: BuildArtefactsOptions,
): Promise<ModuleArtefacts> {
  const packageJson = await readModulePackageJson(sourceDir);
  const moduleName = moduleNameFrom(sourceDir, packageJson);
  const moduleVersion = moduleVersionFrom(sourceDir, packageJson);

  const sourceGitDir = await resolveGitDir(sourceDir, options.sourceGitDir);
  if (sourceGitDir === null) {
    throw new BuildRefusedError(
      options.sourceGitDir === undefined
        ? `refusing to build ${moduleName}: ${sourceDir} belongs to no git repository, so there is no tree to capture as the build's substrate`
        : `refusing to build ${moduleName}: ${options.sourceGitDir} is not a git directory, so there is no tree to capture as the build's substrate`,
    );
  }
  const ctx: GitContext = { gitDir: sourceGitDir };
  const sourceTree = await treeSubstrate(ctx, sourceDir);

  const recipe: RunRecipe = {
    command: ["node", "-e", buildScriptSource(ENTRY_FILE_NAME, MODULE_BUNDLE_GLOBAL)],
    workingDirectory: ".",
    environment: {},
    declared: [{ name: BUNDLER_MAIN_NAME, secret: false }],
    substrates: [sourceTree],
    isolation: "hygiene",
  };

  const esbuild = await installedEsbuild();
  const spawnResult = await performRecipe(recipe, {
    now: options.now,
    workingRoot: sourceDir,
    bindingRoots: { [`esbuild@${esbuild.version}`]: esbuild.packageDir },
    bindings: { [BUNDLER_MAIN_NAME]: { secret: false, value: fileURLToPath(import.meta.resolve("esbuild")) } },
  });
  if (spawnResult.observation.exitCode !== 0) {
    throw new BuildRefusedError(
      `refusing to build ${moduleName}: the bundler exited ${spawnResult.observation.exitCode}: ${textOf(spawnResult.observation.output, "the bundler's output")}`,
    );
  }

  const { bundle, metafile } = JSON.parse(
    textOf(spawnResult.observation.output, "the bundler's output"),
  ) as BuildScriptOutput;
  // The metafile's keys are relative to the bundler's working directory, `sourceDir` by real path.
  const { outsideDirectory, packages } = await bundleProvenance(
    metafile,
    metafile.outputs[OUTPUT_LABEL]!.entryPoint!,
    await realpath(sourceDir),
  );
  if (outsideDirectory.length > 0) {
    throw new BuildRefusedError(
      `refusing to build ${moduleName}: its bundle draws ${outsideDirectory.join(", ")} from outside its directory ${sourceDir} as the module's own source; a file is the module's own when the module reaches it by path, when a pattern import matches it, or when the nearest package.json above it that names a package holds the module`,
    );
  }
  const bundleBytes = new TextEncoder().encode(bundle);

  const esbuildDigest = hexOfRecordId(rawId(await readFile(esbuild.binaryPath)));
  const toolchain: ToolchainEntry[] = [
    { name: "node", version: versionString(process.versions.node) },
    { name: "esbuild", version: esbuild.version },
  ];

  const observation: RunObservation = {
    ...spawnResult.observation,
    output: rawId(bundleBytes),
    binaries: [...spawnResult.observation.binaries, { name: "esbuild", digest: esbuildDigest }],
  };
  const buildReceipt: RunRecord = {
    kind: "run",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
    runKind: "run",
    performer: RUNNER_PERFORMER,
    determinism: "nondeterministic",
    recipe: spawnResult.recipe,
    observation,
  };

  const manifest = await deriveManifest(moduleName, bundleBytes, packages, sourceTree, toolchain);

  return { name: moduleName, version: moduleVersion, bundleBytes, manifest, buildReceipt };
}

/** Builds a module, stores its build run as a receipt, and installs the module citing it. */
export async function buildModule(sourceDir: string, store: Store, options: BuildModuleOptions): Promise<BuildResult> {
  const { name, version, bundleBytes, manifest, buildReceipt } = await buildModuleArtefacts(sourceDir, options);

  const buildReceiptId = await store.put("run", buildReceipt);
  const { moduleRecordId, bundleId } = await installModule(
    name,
    version,
    manifest,
    bundleBytes,
    buildReceiptId,
    store,
    options.blobs,
    options.index,
  );

  return { moduleRecordId, bundleId, buildReceiptId };
}
