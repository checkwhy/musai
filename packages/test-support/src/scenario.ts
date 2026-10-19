import { createHash } from "node:crypto";
import { appendFile, chmod, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exitCodeForClass } from "@musai/records";
import { LOCAL_DIR, MUSAI_DIR, Store } from "@musai/store";
import { execa } from "execa";
import { fixedClock, SCENARIO_INSTANT } from "./clock.js";
import { fixWorkspaceKey } from "./pseudonyms.js";
import { receiptIds } from "./receipts.js";

/** A name no terminal answers to, so two runs mint the same attestation whoever runs them. */
export const SCENARIO_PRINCIPAL = "scenario-suite";

/** Exactly one of `append` and `json`; `json` is written whole, so a path in it stays valid. */
export interface Edit {
  readonly path: string;
  readonly append?: string;
  readonly json?: unknown;
}

/** Replaces all of `repo` but `.git` with `from`, committed under a pinned identity and date. */
export interface Commit {
  readonly repo: string;
  readonly from: string;
  readonly message: string;
}

/** One invocation of the binary, one edit to a file, or one commit to a repository it owns. */
export interface Step {
  readonly id: string;
  readonly args?: readonly string[];
  readonly exit?: number;
  readonly edit?: Edit;
  readonly commit?: Commit;
  /** A CLI step's own instant, so a scenario can write an older record and a newer one; it must not
   * run earlier than a step before it, since receipt reuse compares ages. */
  readonly now?: string;
  /** A CLI step's clearance, so a scenario can run one workspace as its author and as a station. */
  readonly clearance?: string;
}

export function stepInstant(step: Step): string {
  return step.now ?? SCENARIO_INSTANT;
}

export interface Scenario {
  readonly steps: readonly Step[];
  /** Step ids replayed after the fold is deleted; each must answer as it did the first time. */
  readonly replay: readonly string[];
  /** Ids of `why` steps whose derivation must reach an evidence hop. */
  readonly holds: readonly string[];
  /** Steps whose bytes move with every commit to this repository: run and compared across runs,
   * never recorded; the measurement rule in `packages/scenarios/README.md` finds them. */
  readonly unrecorded?: readonly string[];
}

export interface ScenarioRun {
  readonly outputs: ReadonlyMap<string, string>;
  /** The first run's outputs before normalisation, for an assertion about what it would hide. */
  readonly raw: ReadonlyMap<string, string>;
  /** Both streams each CLI step of the first run printed, unnormalised; one alone is recorded. */
  readonly printed: ReadonlyMap<string, Printed>;
  /** The workspace path the first run used, as the runner spelled it. */
  readonly workspace: string;
  /** The receipts the first run left, so an event about a run reads as a receipt or not. */
  readonly receipts: ReadonlySet<string>;
}

export interface Printed {
  readonly stdout: string;
  readonly stderr: string;
}

interface StepsRun {
  readonly outputs: Map<string, string>;
  readonly raw: Map<string, string>;
  readonly printed: Map<string, Printed>;
}

interface RunContext {
  readonly repo: string;
  readonly scenarioDir: string;
  readonly workspace: string;
  readonly cli: string;
  readonly parsed: Map<string, unknown>;
}

const COMMIT_SHA = /\b[0-9a-f]{40}\b/g;
const INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;

/** A workspace key's id is minted at random; the hash after it is an id's width, and placeheld. */
const PSEUDONYM_KEY_ID = /pseudonym:[^:\s"]+:/g;

/** The user's name is left alone: every step pins its principal, and replacing it would rewrite
 * any word it spells. */
export function normalise(text: string, context: Pick<RunContext, "repo" | "scenarioDir" | "workspace">): string {
  return text
    .replaceAll(context.workspace, "<workspace>")
    .replaceAll(context.scenarioDir, "<scenario>")
    .replaceAll(context.repo, "<repo>")
    .replace(COMMIT_SHA, "<commit>")
    .replace(INSTANT, "<time>")
    .replace(PSEUDONYM_KEY_ID, "pseudonym:<key>:");
}

function lookup(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (current === null || typeof current !== "object") {
      throw new Error(`cannot read ${segment} of a ${typeof current}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Beside the workspace, so a key never enters the tree a check measures. */
function keysDir(context: Pick<RunContext, "workspace">): string {
  return `${context.workspace}-keys`;
}

/** Git keeps no file mode but the executable bit, and `ssh-keygen` refuses a key others may read,
 * so a scenario's committed keys are copied out owner-only. */
async function prepareKeys(context: RunContext): Promise<void> {
  const committed = join(context.scenarioDir, "keys");
  const names = await readdir(committed).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  await rm(keysDir(context), { recursive: true, force: true });
  for (const name of names) {
    await mkdir(keysDir(context), { recursive: true });
    await cp(join(committed, name), join(keysDir(context), name));
    await chmod(join(keysDir(context), name), 0o600);
  }
}

/** `$WORKSPACE`, `$REPO`, `$SCENARIO` and `$KEYS` name the directories; `${step.a.b.0}` reads a
 * field of an earlier step's parsed JSON output. */
export function resolvePlaceholders(args: readonly string[], context: RunContext): string[] {
  return args.map((arg) =>
    arg
      .replaceAll("$KEYS", keysDir(context))
      .replaceAll("$WORKSPACE", context.workspace)
      .replaceAll("$REPO", context.repo)
      .replaceAll("$SCENARIO", context.scenarioDir)
      .replace(/\$\{([^}]+)\}/g, (_match, reference: string) => {
        const [stepId, ...path] = reference.split(".");
        const parsed = context.parsed.get(stepId ?? "");
        if (parsed === undefined) {
          throw new Error(`step ${stepId} has no parsed output to read ${reference} from`);
        }
        return String(lookup(parsed, path));
      }),
  );
}

function resolveJson(value: unknown, context: RunContext): unknown {
  if (typeof value === "string") {
    return resolvePlaceholders([value], context)[0];
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveJson(item, context));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveJson(item, context)]));
  }
  return value;
}

export async function applyEdit(edit: Edit, context: RunContext): Promise<void> {
  if ((edit.append === undefined) === (edit.json === undefined)) {
    throw new Error(`the edit of ${edit.path} must give exactly one of append and json`);
  }
  const [path] = resolvePlaceholders([edit.path], context);
  if (edit.append !== undefined) {
    await appendFile(path!, edit.append);
  } else {
    await writeFile(path!, JSON.stringify(resolveJson(edit.json, context)));
  }
}

/** Pinned identity, dates and configuration give the same shas on every run on one machine; a
 * filesystem with no executable bit commits a different tree. */
export async function commitStep(commit: Commit, context: RunContext): Promise<{ commit: string; tree: string }> {
  const [repo, from] = resolvePlaceholders([commit.repo, commit.from], context);
  const git = async (args: readonly string[]): Promise<string> =>
    (
      await execa("git", args, {
        cwd: repo!,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: SCENARIO_PRINCIPAL,
          GIT_AUTHOR_EMAIL: "scenario-suite@musai.invalid",
          GIT_AUTHOR_DATE: SCENARIO_INSTANT,
          GIT_COMMITTER_NAME: SCENARIO_PRINCIPAL,
          GIT_COMMITTER_EMAIL: "scenario-suite@musai.invalid",
          GIT_COMMITTER_DATE: SCENARIO_INSTANT,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: join(context.workspace, "no-global-gitconfig"),
        },
      })
    ).stdout.trim();
  await mkdir(repo!, { recursive: true });
  const entries = await readdir(repo!);
  if (!entries.includes(".git")) {
    await git(["init", "--quiet", "--initial-branch", "main"]);
  }
  for (const entry of entries.filter((name) => name !== ".git")) {
    await rm(join(repo!, entry), { recursive: true, force: true });
  }
  await cp(from!, repo!, { recursive: true });
  await git(["add", "-A"]);
  await git(["commit", "--quiet", "-m", commit.message]);
  return { commit: await git(["rev-parse", "HEAD"]), tree: await git(["rev-parse", "HEAD^{tree}"]) };
}

/** Fixed whatever the shell had, since a build records the digest of the `node` a `PATH` lookup
 * resolves; Windows keeps no fixed tool directory, so the shell's entries follow there. */
export function scenarioPath(repo: string): string {
  const system = process.platform === "win32" ? (process.env["PATH"] ?? "").split(delimiter) : ["/usr/bin", "/bin"];
  return [dirname(process.execPath), join(repo, "node_modules", ".bin"), ...system].join(delimiter);
}

/** The shell's clearance is dropped, so a step that names none runs as the workspace's author. */
export function stepEnvironment(step: Step, repo: string): Record<string, string | undefined> {
  const { MUSAI_CLEARANCE: _shells, ...inherited } = process.env;
  return {
    ...inherited,
    PATH: scenarioPath(repo),
    MUSAI_NOW: stepInstant(step),
    MUSAI_PRINCIPAL: SCENARIO_PRINCIPAL,
    ...(step.clearance === undefined ? {} : { MUSAI_CLEARANCE: step.clearance }),
  };
}

/** A maximal run of lowercase hex digits: never a piece of a longer run. */
const HEX_RUN = /(?<![0-9a-f])[0-9a-f]+(?![0-9a-f])/g;

const ID_WIDTH = 64;

/** A shorter hex run is more often a word or a number than a label shortening an id. */
const LABEL_FLOOR = 8;

/** Numbers each record id, and each label shortening one, by first appearance across all outputs,
 * so a recording holds no id a machine derived and one id is one placeholder in every step. */
export function placeholderIds(outputs: readonly string[]): string[] {
  const ids = new Set(
    outputs.flatMap((text) => [...text.matchAll(HEX_RUN)].map(([run]) => run).filter((run) => run.length === ID_WIDTH)),
  );
  const numbers = new Map<string, number>();
  return outputs.map((text) =>
    text.replace(HEX_RUN, (run) => {
      const id = run.length === ID_WIDTH ? run : run.length >= LABEL_FLOOR ? onlyIdShortenedTo(run, ids) : undefined;
      if (id === undefined) {
        return run;
      }
      let number = numbers.get(id);
      if (number === undefined) {
        number = numbers.size + 1;
        numbers.set(id, number);
      }
      return run.length === ID_WIDTH ? `<id-${number}>` : `<id-${number}:${run.length}>`;
    }),
  );
}

function onlyIdShortenedTo(label: string, ids: ReadonlySet<string>): string | undefined {
  const shortened = [...ids].filter((id) => id.startsWith(label));
  return shortened.length === 1 ? shortened[0] : undefined;
}

/** The outputs with ids as placeholders, in the form a recording holds them. */
export function withPlaceholderIds(outputs: ReadonlyMap<string, string>): Map<string, string> {
  const ids = [...outputs.keys()];
  const placeheld = placeholderIds(ids.map((id) => outputs.get(id)!));
  return new Map(ids.map((id, at) => [id, placeheld[at]!]));
}

export function firstDifference(
  actual: ReadonlyMap<string, string>,
  recorded: ReadonlyMap<string, string>,
): { readonly id: string; readonly recorded: string; readonly actual: string } | undefined {
  const placeheld = withPlaceholderIds(actual);
  for (const [id, text] of placeheld) {
    if (text !== recorded.get(id)) {
      return { id, recorded: recorded.get(id)!, actual: text };
    }
  }
  return undefined;
}

async function runSteps(scenario: Scenario, context: RunContext): Promise<StepsRun> {
  await prepareKeys(context);
  const outputs = new Map<string, string>();
  const raw = new Map<string, string>();
  const printed = new Map<string, Printed>();
  for (const step of scenario.steps) {
    if (step.edit !== undefined) {
      await applyEdit(step.edit, context);
      continue;
    }
    if (step.commit !== undefined) {
      const answer = await commitStep(step.commit, context);
      raw.set(step.id, JSON.stringify(answer));
      outputs.set(step.id, normalise(JSON.stringify(answer), context));
      context.parsed.set(step.id, answer);
      continue;
    }
    const args = resolvePlaceholders(step.args ?? [], context);
    const result = await execa("node", [context.cli, ...args, "--workspace", context.workspace, "--json"], {
      cwd: context.workspace,
      env: stepEnvironment(step, context.repo),
      extendEnv: false,
      reject: false,
    });
    const expectedExit = step.exit ?? 0;
    if (result.exitCode !== expectedExit) {
      throw new Error(`step ${step.id} exited ${result.exitCode}, expected ${expectedExit}\n${result.stderr}`);
    }
    // A claim that does not hold is an answer on stdout, where a refusal is on stderr.
    const text = expectedExit === 0 || expectedExit === exitCodeForClass("unheld") ? result.stdout : result.stderr;
    raw.set(step.id, text);
    outputs.set(step.id, normalise(text, context));
    printed.set(step.id, { stdout: result.stdout, stderr: result.stderr });
    if (text.length > 0) {
      context.parsed.set(step.id, JSON.parse(text));
    }
    // A workspace key minted per run would give each run its own pseudonyms and salts.
    if (args[0] === "init" && expectedExit === 0) {
      await fixWorkspaceKey(context.workspace);
    }
  }
  return { outputs, raw, printed };
}

export function derivationNodes(node: {
  readonly label: string;
  readonly children: readonly unknown[];
}): { readonly label: string }[] {
  const children = node.children as { readonly label: string; readonly children: readonly unknown[] }[];
  return [node, ...children.flatMap(derivationNodes)];
}

function contextFieldsFor(scenarioDir: string): Pick<RunContext, "repo" | "scenarioDir" | "cli" | "parsed"> {
  const repo = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  return {
    repo,
    scenarioDir,
    cli: join(repo, "packages", "distribution", "dist", "bin", "cli.js"),
    parsed: new Map(),
  };
}

/** Fixed per clone and scenario, so two clones running the suite at once share no directory. */
export function scenarioWorkspace(repo: string, scenarioDir: string): string {
  const clone = createHash("sha256").update(repo).digest("hex").slice(0, 12);
  return join(tmpdir(), `musai-scenario-${clone}-${basename(scenarioDir)}`);
}

async function contextFor(scenarioDir: string): Promise<RunContext> {
  const fields = contextFieldsFor(scenarioDir);
  const workspace = scenarioWorkspace(fields.repo, scenarioDir);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  return { ...fields, workspace };
}

/** The steps alone, into a directory the caller owns; an id minted here may differ from `expected/`
 * wherever the workspace path reaches it, so a test compares live answers only. */
export async function runScenarioInto(scenarioDir: string, workspace: string): Promise<ReadonlyMap<string, unknown>> {
  const scenario = JSON.parse(await readFile(join(scenarioDir, "scenario.json"), "utf8")) as Scenario;
  const context: RunContext = { ...contextFieldsFor(scenarioDir), workspace };
  await runSteps(scenario, context);
  return context.parsed;
}

/** A station's cleared folds go too, so a replay under a clearance refolds from nothing; removing
 * no `index.sqlite` means the fold has moved, and the replay check would pass without a rebuild. */
export async function deleteFolds(localDir: string): Promise<void> {
  let removed = 0;
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.name === "index.sqlite") {
        await rm(path, { force: true });
        removed += 1;
      } else if (basename(dir) === "cleared" && entry.name.endsWith(".sqlite")) {
        await rm(path, { force: true });
      }
    }
  }
  await walk(localDir);
  if (removed === 0) {
    throw new Error(
      `deleted no index.sqlite under ${localDir}: the replay check depends on the fold actually being ` +
        "deleted, so a moved fold path needs this walk updated rather than left to pass vacuously",
    );
  }
}

/** Runs twice with a replay and a `holds` walk, then holds the outputs, ids as placeholders,
 * against `expected/`, or records them under `MUSAI_SCENARIO_RECORD=1`. */
export async function runScenario(scenarioDir: string): Promise<ScenarioRun> {
  const scenario = JSON.parse(await readFile(join(scenarioDir, "scenario.json"), "utf8")) as Scenario;
  const first = await contextFor(scenarioDir);
  try {
    const { outputs, raw, printed } = await runSteps(scenario, first);
    await deleteFolds(join(first.workspace, MUSAI_DIR, LOCAL_DIR));
    const { outputs: replayed } = await runSteps(
      { ...scenario, steps: scenario.steps.filter((step) => scenario.replay.includes(step.id)) },
      first,
    );
    for (const [id, text] of replayed) {
      if (outputs.get(id) !== text) {
        throw new Error(`step ${id} answered differently after the fold was rebuilt`);
      }
    }
    for (const id of scenario.holds) {
      const derivation = (
        first.parsed.get(id) as
          | { readonly derivation?: { readonly label: string; readonly children: readonly unknown[] } }
          | undefined
      )?.derivation;
      if (derivation === undefined || !derivationNodes(derivation).some((hop) => hop.label === "evidence")) {
        throw new Error(`step ${id} does not reach an evidence hop`);
      }
    }
    const second = await contextFor(scenarioDir);
    const { outputs: again } = await runSteps(scenario, second);
    for (const [id, text] of outputs) {
      if (again.get(id) !== text) {
        throw new Error(`step ${id} answered differently on the second run:\n${text}\n---\n${again.get(id)}`);
      }
    }
    const unrecorded = new Set(scenario.unrecorded ?? []);
    const expectedDir = join(scenarioDir, "expected");
    const compared = new Map([...outputs].filter(([id]) => !unrecorded.has(id)));
    if (process.env["MUSAI_SCENARIO_RECORD"] === "1") {
      await rm(expectedDir, { recursive: true, force: true });
      await mkdir(expectedDir, { recursive: true });
      for (const [id, text] of withPlaceholderIds(compared)) {
        await writeFile(join(expectedDir, `${id}.stdout`), text);
      }
    } else {
      const files = new Set(await readdir(expectedDir));
      const recorded = new Map<string, string>();
      for (const id of compared.keys()) {
        const file = `${id}.stdout`;
        if (!files.has(file)) {
          throw new Error(`no recorded output for step ${id}; run with MUSAI_SCENARIO_RECORD=1 and read the diff`);
        }
        recorded.set(id, await readFile(join(expectedDir, file), "utf8"));
        files.delete(file);
      }
      if (files.size > 0) {
        throw new Error(`recorded outputs with no step: ${[...files].join(", ")}`);
      }
      const difference = firstDifference(compared, recorded);
      if (difference !== undefined) {
        throw new Error(
          `step ${difference.id} differs from its recorded output:\n--- recorded\n${difference.recorded}\n--- actual\n${difference.actual}`,
        );
      }
    }
    const store = new Store({
      ctx: { gitDir: join(first.workspace, MUSAI_DIR) },
      scope: "default",
      now: fixedClock(SCENARIO_INSTANT),
    });
    return { outputs, raw, printed, workspace: first.workspace, receipts: new Set(await receiptIds(store)) };
  } finally {
    await rm(first.workspace, { recursive: true, force: true });
    await rm(keysDir(first), { recursive: true, force: true });
  }
}
