import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { IndexDb } from "@musai/fold";
import type { Clock } from "@musai/records";
import { KernelError } from "@musai/records";
import type { GitContext } from "@musai/store";
import { GitBlobStore, gitInitWorkTree, initWorkspace, packageRootFrom, Store } from "@musai/store";
import { buildModule } from "./build.js";
import { runModuleTests, type TestReport } from "./test.js";

export interface TemplateReference {
  readonly module: string;
  readonly contribution: string;
}

/** Resolves without any installed module to read a contribution from. */
export const DEFAULT_TEMPLATE: TemplateReference = { module: "musai", contribution: "musai/default" };

/** Raised when the target holds content this call did not create, or a template cannot resolve. */
export class ScaffoldRefusedError extends KernelError {
  constructor(message: string) {
    super({ reason: "invalid-input", detail: message });
    this.name = "ScaffoldRefusedError";
  }
}

/** Copied into `dist/templates/` for a built install, read from `src/` in a source checkout. */
async function defaultTemplateDir(): Promise<string> {
  const root = packageRootFrom(import.meta.url);
  const builtCandidate = join(root, "dist", "templates", "default");
  try {
    await access(builtCandidate);
    return builtCandidate;
  } catch {
    return join(root, "src", "templates", "default");
  }
}

interface TemplateFile {
  readonly relativePath: string;
  readonly content: Uint8Array;
}

async function walkTemplateFiles(root: string, dir: string = root): Promise<TemplateFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: TemplateFile[] = [];
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkTemplateFiles(root, entryPath)));
    } else {
      const content = await readFile(entryPath);
      files.push({ relativePath: relative(root, entryPath), content: new Uint8Array(content) });
    }
  }
  return files;
}

/** Only the default resolves, and any other reference is refused rather than answered with it. */
async function resolveTemplateFiles(template: TemplateReference | undefined): Promise<readonly TemplateFile[]> {
  const reference = template ?? DEFAULT_TEMPLATE;
  if (reference.module !== DEFAULT_TEMPLATE.module || reference.contribution !== DEFAULT_TEMPLATE.contribution) {
    throw new ScaffoldRefusedError(
      `refusing to scaffold from ${reference.module}/${reference.contribution}: only the kernel's own default template resolves without an installed module to read a template contribution from`,
    );
  }
  return walkTemplateFiles(await defaultTemplateDir());
}

async function listIfPresent(dir: string): Promise<string[] | null> {
  try {
    return await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/** Whether a directory holds exactly the template's files, as a prior run of this scaffold left. */
async function alreadyScaffolded(targetDir: string, files: readonly TemplateFile[]): Promise<boolean> {
  for (const file of files) {
    let existing: Buffer;
    try {
      existing = await readFile(join(targetDir, file.relativePath));
    } catch {
      return false;
    }
    if (!bytesEqual(new Uint8Array(existing), file.content)) {
      return false;
    }
  }
  return true;
}

interface ScratchWorkspace {
  readonly store: Store;
  readonly index: IndexDb;
  readonly blobs: GitBlobStore;
  cleanup(): Promise<void>;
}

/** Discarded once the scaffold is proven green. */
async function makeScratchWorkspace(now: Clock): Promise<ScratchWorkspace> {
  const dir = await mkdtemp(join(tmpdir(), "musai-scaffold-scratch-"));
  const { gitDir } = await initWorkspace(dir, { now });
  const ctx: GitContext = { gitDir };
  const store = new Store({ ctx, scope: "scaffold", now });
  const index = new IndexDb(":memory:");
  await index.fold(store);
  return {
    store,
    index,
    blobs: new GitBlobStore({ ctx, now }),
    async cleanup() {
      index.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export interface ScaffoldModuleOptions {
  /** The kernel's default when omitted. */
  readonly template?: TemplateReference;
  readonly now: Clock;
}

export interface ScaffoldModuleResult {
  readonly targetDir: string;
  /** False when the directory already held this scaffold, which is a no-op. */
  readonly created: boolean;
  /** `null` when nothing ran, as when the scaffold was already there. */
  readonly testReport: TestReport | null;
}

/** Writes a template into an empty or absent directory as its own repository, then builds and
 * tests it, recording receipts and goldens, so the module handed back was proven green here. */
export async function scaffoldModule(targetDir: string, options: ScaffoldModuleOptions): Promise<ScaffoldModuleResult> {
  const resolved = resolve(targetDir);
  const files = await resolveTemplateFiles(options.template);

  const existingEntries = await listIfPresent(resolved);
  if (existingEntries !== null && existingEntries.length > 0) {
    if (await alreadyScaffolded(resolved, files)) {
      return { targetDir: resolved, created: false, testReport: null };
    }
    throw new ScaffoldRefusedError(
      `refusing to scaffold ${resolved}: it already holds content this call did not create`,
    );
  }

  await mkdir(resolved, { recursive: true });
  for (const file of files) {
    const filePath = join(resolved, file.relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, file.content);
  }
  await gitInitWorkTree(resolved);

  const scratch = await makeScratchWorkspace(options.now);
  try {
    await buildModule(resolved, scratch.store, {
      blobs: scratch.blobs,
      index: scratch.index,
      now: options.now,
    });
    const testReport = await runModuleTests(resolved, { record: true, update: true, now: options.now });
    return { targetDir: resolved, created: true, testReport };
  } finally {
    await scratch.cleanup();
  }
}
