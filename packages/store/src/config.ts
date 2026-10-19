import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Clock, isPlainObject, KernelError } from "@musai/records";
import type { GitContext, TreeEntry } from "./git.js";
import {
  gitCatFile,
  gitCatFileBatch,
  gitCommitTree,
  gitHashObjectBatch,
  gitLsTree,
  gitMkTree,
  gitRevParse,
  isAbsentPathError,
} from "./git.js";
import { withCasRetry } from "./retry.js";

const TRUST_BRANCH_REF = "refs/heads/main";

const CONFIG_PATH = "config.json";

const ALLOWED_SIGNERS_PATH = "allowed-signers";

const ROLES_PATH = "roles";

const AUDIENCES_PATH = "audiences";

/** Configuration read at one commit, so every decision drawn from it sees the same read. */
export interface WorkspaceConfig {
  readonly commit: string;
  readonly values: Record<string, unknown>;
}

/** The trust branch at one commit, its signers, roles and audiences left as text for their
 * parsers. */
export interface TrustBranch {
  readonly commit: string;
  readonly config: WorkspaceConfig;
  readonly allowedSigners: string;
  readonly roles: string;
  readonly audiences: string;
}

const TRUST_PATHS = [CONFIG_PATH, ALLOWED_SIGNERS_PATH, ROLES_PATH, AUDIENCES_PATH];

/** Each trust file's text at `commit` from one subprocess, `null` where the batch found none. */
async function batchedTrustFilesAt(ctx: GitContext, commit: string): Promise<Map<string, string | null>> {
  const texts = new Map<string, string | null>();
  const specs = TRUST_PATHS.map((path) => `${commit}:${path}`);
  for await (const bytes of gitCatFileBatch(ctx, specs)) {
    texts.set(TRUST_PATHS[texts.size]!, bytes === null ? null : new TextDecoder().decode(bytes));
  }
  return texts;
}

/** Init seeds this file, so its absence is a broken workspace rather than a default. */
async function readConfigAt(ctx: GitContext, commit: string, batched: string | null): Promise<WorkspaceConfig> {
  let text: string;
  try {
    text = batched ?? (await gitCatFile(ctx, `${commit}:${CONFIG_PATH}`)).toString("utf8");
  } catch (error) {
    throw new KernelError({
      reason: "workspace-incomplete",
      detail: `refusing to read workspace configuration: ${CONFIG_PATH} is absent at ${commit}`,
      about: [CONFIG_PATH],
      cause: error,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new KernelError({
      reason: "workspace-incomplete",
      detail: `refusing to read workspace configuration: ${CONFIG_PATH} at ${commit} does not parse as JSON`,
      about: [CONFIG_PATH],
      cause: error,
    });
  }

  if (!isPlainObject(parsed)) {
    throw new KernelError({
      reason: "workspace-incomplete",
      detail: `refusing to read workspace configuration: ${CONFIG_PATH} at ${commit} is not a JSON object`,
      about: [CONFIG_PATH],
    });
  }

  return { commit, values: parsed };
}

/** An absent file reads as empty. Any other failure is refused, since empty files grant every
 * action to every principal; a file the batch found none at is read alone to tell the two apart. */
async function readOptionalTrustFileAt(
  ctx: GitContext,
  commit: string,
  path: string,
  batched: string | null,
): Promise<string> {
  if (batched !== null) {
    return batched;
  }
  try {
    return (await gitCatFile(ctx, `${commit}:${path}`)).toString("utf8");
  } catch (error) {
    if (isAbsentPathError(error)) {
      return "";
    }
    throw new KernelError({
      reason: "workspace-incomplete",
      detail: `refusing to read workspace configuration: ${path} at ${commit} could not be read and was not reported absent`,
      about: [path],
      cause: error,
    });
  }
}

/** Reads every trust-branch file at one commit, so a concurrent write cannot land between them. */
export async function readTrustBranch(ctx: GitContext): Promise<TrustBranch> {
  const commit = await gitRevParse(ctx, TRUST_BRANCH_REF);
  if (commit === null) {
    throw new KernelError({
      reason: "workspace-incomplete",
      detail: `refusing to read workspace configuration: ${TRUST_BRANCH_REF} does not exist`,
      about: [TRUST_BRANCH_REF],
    });
  }
  const batched = await batchedTrustFilesAt(ctx, commit);
  const config = await readConfigAt(ctx, commit, batched.get(CONFIG_PATH)!);
  const allowedSigners = await readOptionalTrustFileAt(
    ctx,
    commit,
    ALLOWED_SIGNERS_PATH,
    batched.get(ALLOWED_SIGNERS_PATH)!,
  );
  const roles = await readOptionalTrustFileAt(ctx, commit, ROLES_PATH, batched.get(ROLES_PATH)!);
  const audiences = await readOptionalTrustFileAt(ctx, commit, AUDIENCES_PATH, batched.get(AUDIENCES_PATH)!);
  return { commit, config, allowedSigners, roles, audiences };
}

/** A trust file's new text, `null` to remove it, or a function of its text at the tip. */
export type MainFileContent = string | null | ((current: string | null) => string);

async function mainFileAt(ctx: GitContext, tip: string | null, name: string): Promise<string | null> {
  if (tip === null) {
    return null;
  }
  try {
    return new TextDecoder().decode(await gitCatFile(ctx, `${tip}:${name}`));
  } catch (error) {
    if (isAbsentPathError(error)) {
      return null;
    }
    throw error;
  }
}

/** Replaces each named file at the trust branch's root, removing one named `null`, and keeps the
 * rest, rebuilt against whichever tip the swap finds. */
export async function writeMainFiles(
  ctx: GitContext,
  files: Readonly<Record<string, MainFileContent>>,
  now: Clock,
): Promise<string> {
  const names = Object.keys(files).sort();
  const scratch = await mkdtemp(join(tmpdir(), "musai-trust-write-"));
  try {
    return await withCasRetry({ ctx, ref: TRUST_BRANCH_REF }, async (tip) => {
      const contents = await Promise.all(
        names.map(async (name) => {
          const content = files[name]!;
          return typeof content === "function" ? content(await mainFileAt(ctx, tip, name)) : content;
        }),
      );
      const written = names.flatMap((name, index) => {
        const content = contents[index]!;
        return content === null ? [] : [{ name, content }];
      });
      const paths = await Promise.all(
        written.map(async ({ content }, index) => {
          const path = join(scratch, String(index));
          await writeFile(path, content);
          return path;
        }),
      );
      const blobs = await gitHashObjectBatch(ctx, paths);
      const replaced: TreeEntry[] = written.map(({ name }, index) => ({
        mode: "100644",
        type: "blob",
        sha: blobs[index]!,
        path: name,
      }));
      const kept = (tip === null ? [] : await gitLsTree(ctx, tip))
        .filter((entry) => !names.includes(entry.path))
        .map((entry) => ({ ...entry }) as TreeEntry);
      const tree = await gitMkTree(ctx, [...kept, ...replaced]);
      const commitSha = await gitCommitTree(ctx, tree, tip === null ? [] : [tip], `write ${names.join(", ")}\n`, now);
      return { commitSha, value: commitSha };
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** `config.json`'s new text as a function of the tip's, so a write keeps another writer's keys. */
export function editedConfig(
  edit: (values: Record<string, unknown>) => Record<string, unknown>,
): (current: string | null) => string {
  return (current) => {
    const values = current === null ? {} : (JSON.parse(current) as Record<string, unknown>);
    return `${JSON.stringify(edit(values), null, 2)}\n`;
  };
}

export async function readWorkspaceConfig(ctx: GitContext): Promise<WorkspaceConfig> {
  return (await readTrustBranch(ctx)).config;
}

export const SLOTS_CONFIG_KEY = "slots";

/** The project layer's slot assignments; a configuration with no `slots` key assigns none. */
export function projectLayerSlots(config: WorkspaceConfig): Readonly<Record<string, unknown>> {
  const slots = config.values[SLOTS_CONFIG_KEY];
  if (slots === undefined) {
    return {};
  }
  if (!isPlainObject(slots)) {
    throw new KernelError({
      reason: "workspace-incomplete",
      detail: `refusing to read the project layer's slot assignments from configuration at ${config.commit}: ${SLOTS_CONFIG_KEY} must be an object keyed by slot id`,
      about: [SLOTS_CONFIG_KEY],
    });
  }
  return slots;
}
