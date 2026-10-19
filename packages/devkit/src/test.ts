import { mkdtemp, readFile, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { type FetchNeedHook, type RunNeedHook, runRestartLoop } from "@musai/evaluate";
import { IndexDb } from "@musai/fold";
import type { HostInvocation, Invoker, RuleInput, RuleOutput } from "@musai/modules";
import {
  type ContributionPoint,
  ENVELOPE_PROTOCOL,
  type EnvelopeRequest,
  HOSTS,
  type HostContribution,
  invokerFromModuleHost,
  kernelPoint,
  type ModuleHost,
  recordRead,
} from "@musai/modules";
import type { ContributionEntry, FetchRecipe, RunRecord } from "@musai/records";
import {
  type Clock,
  CURRENT_SCHEMA_VERSIONS,
  canonicalBytes,
  isPlainObject,
  KernelError,
  type RecordId,
  type VersionString,
  versionString,
} from "@musai/records";
import { performFetch, performRecipe, RUNNER_PERFORMER } from "@musai/run";
import type { GitContext } from "@musai/store";
import { initWorkspace, Store } from "@musai/store";
import {
  type FixtureCase,
  type FixtureStore,
  fixtureRecordDirs,
  type Golden,
  type GoldenRound,
  readFixtureStore,
  readGolden,
  type StoredReceipt,
  writeFixtureReceipt,
  writeGolden,
} from "./fixtures.js";

const ENTRY_FILE_NAME = "module.ts";

const GATEWAY_EXPORT_NAME = "invoke";

/** Refused rather than spawned, so a suite that reaches the network or the machine never passes. */
export class UnrecordedRecipeError extends KernelError {
  readonly recipeId: RecordId;

  constructor(contribution: string, recipeId: RecordId) {
    super({
      reason: "workspace-incomplete",
      detail: `${contribution} names a recipe with no recorded receipt in this module's fixture store: ${recipeId}`,
      about: [recipeId],
    });
    this.name = "UnrecordedRecipeError";
    this.recipeId = recipeId;
  }
}

class MachineLocalInputError extends KernelError {
  constructor(message: string) {
    super({ reason: "invalid-input", detail: message });
    this.name = "MachineLocalInputError";
  }
}

const ABSOLUTE_PATH_PATTERN = /^(\/|[A-Za-z]:[\\/])/;

/** A denylist, since a rule's input has no fixed vocabulary to build a stronger check from. */
function assertNoMachineLocalField(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (ABSOLUTE_PATH_PATTERN.test(value)) {
      throw new MachineLocalInputError(
        `refusing a test input carrying an absolute path at ${path}: ${JSON.stringify(value)}`,
      );
    }
    if (value.length > 0 && value === hostname()) {
      throw new MachineLocalInputError(`refusing a test input carrying this machine's own host name at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertNoMachineLocalField(item, `${path}[${index}]`);
    });
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      assertNoMachineLocalField(item, `${path}.${key}`);
    }
  }
}

/** Which half of a fixture's golden moved: the response, by first path and byte, or the reads. */
export interface Mismatch {
  readonly module: string;
  readonly contribution: string;
  readonly fixture: string;
  readonly half: "response" | "reads";
  readonly path?: string;
  readonly byteOffset?: number;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly missing?: readonly string[];
  readonly extra?: readonly string[];
}

export interface FixtureResult {
  readonly host: string;
  readonly contribution: string;
  readonly fixture: string;
  readonly status: "pass" | "fail" | "updated" | "skipped";
  readonly mismatches: readonly Mismatch[];
  readonly message?: string;
}

export interface TestReport {
  readonly module: string;
  readonly results: readonly FixtureResult[];
  readonly ok: boolean;
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

function canonicalEqual(a: unknown, b: unknown): boolean {
  return bytesEqual(canonicalBytes(a), canonicalBytes(b));
}

function firstDifferingByteOffset(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) {
      return i;
    }
  }
  return length;
}

/** Walks sorted keys and indices so the path names the smallest region that moved. */
function firstDivergentPath(expected: unknown, actual: unknown, path: string): string {
  if (isPlainObject(expected) && isPlainObject(actual)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    for (const key of keys) {
      if (!canonicalEqual(expected[key], actual[key])) {
        return firstDivergentPath(expected[key], actual[key], `${path}.${key}`);
      }
    }
    return path;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length; index++) {
      if (!canonicalEqual(expected[index], actual[index])) {
        return firstDivergentPath(expected[index], actual[index], `${path}[${index}]`);
      }
    }
    return path;
  }
  return path;
}

function responseMismatch(
  module: string,
  contribution: string,
  fixture: string,
  expected: unknown,
  actual: unknown,
): Mismatch | undefined {
  if (canonicalEqual(expected, actual)) {
    return undefined;
  }
  const path = firstDivergentPath(expected, actual, "$");
  const byteOffset = firstDifferingByteOffset(canonicalBytes(expected), canonicalBytes(actual));
  return { module, contribution, fixture, half: "response", path, byteOffset, expected, actual };
}

function readsMismatch(
  module: string,
  contribution: string,
  fixture: string,
  expected: readonly string[],
  actual: readonly string[],
): Mismatch | undefined {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((entry) => !actualSet.has(entry));
  const extra = actual.filter((entry) => !expectedSet.has(entry));
  if (missing.length === 0 && extra.length === 0) {
    return undefined;
  }
  return { module, contribution, fixture, half: "reads", missing, extra };
}

function compareGolden(
  golden: Golden,
  actual: Golden,
  module: string,
  contribution: string,
  fixture: string,
): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const response = responseMismatch(module, contribution, fixture, golden.response, actual.response);
  if (response !== undefined) {
    mismatches.push(response);
  }
  const reads = readsMismatch(module, contribution, fixture, golden.reads, actual.reads);
  if (reads !== undefined) {
    mismatches.push(reads);
  }
  return mismatches;
}

interface ModulePackageJson {
  readonly name?: unknown;
}

async function moduleNameOf(moduleDir: string): Promise<string> {
  const text = await readFile(join(moduleDir, "package.json"), "utf8");
  const parsed = JSON.parse(text) as ModulePackageJson;
  if (typeof parsed.name !== "string" || parsed.name.length === 0) {
    throw new KernelError({
      reason: "invalid-input",
      detail: `refusing to test ${moduleDir}: its package manifest names no module name`,
      about: [moduleDir],
    });
  }
  return parsed.name;
}

interface ScratchStore {
  readonly store: Store;
  readonly index: IndexDb;
  cleanup(): Promise<void>;
}

/** The store the restart loop reads a satisfied run's receipt back through. The fixture store
 * stays plain files. */
async function makeScratchStore(now: Clock): Promise<ScratchStore> {
  const dir = await mkdtemp(join(tmpdir(), "musai-test-scratch-"));
  const { gitDir } = await initWorkspace(dir, { now });
  const ctx: GitContext = { gitDir };
  const store = new Store({ ctx, scope: "fixtures", now });
  const index = new IndexDb();
  return {
    store,
    index,
    async cleanup() {
      index.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Placed by its bytes, as a merge places a record, so a receipt keeps its stored id. */
async function placeReceipt(scratchStore: Store, receipt: StoredReceipt): Promise<RecordId> {
  const [id] = await scratchStore.placeMany([{ kind: "run", bytes: receipt.bytes }]);
  return id!;
}

/** A recorded recipe answers from the fixture store. An unrecorded one is refused, or performed
 * in the module's own working tree, less its fixture store, and recorded when recording is on. */
function buildNeedHooks(
  store: FixtureStore,
  contributionId: string,
  record: boolean,
  now: Clock,
  scratchStore: Store,
): { performRun: RunNeedHook; performFetchNeed: FetchNeedHook; refusals: UnrecordedRecipeError[] } {
  const refusals: UnrecordedRecipeError[] = [];
  const performRun: RunNeedHook = async (recipe, id) => {
    const existing = store.storedReceiptForRecipe(id);
    if (existing !== undefined) {
      return placeReceipt(scratchStore, existing);
    }
    if (record) {
      const spawnResult = await performRecipe(recipe, {
        now,
        workingRoot: store.dir,
        recordDirs: fixtureRecordDirs(store),
      });
      const receiptValue: RunRecord = {
        kind: "run",
        supersedes: [],
        schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
        runKind: "run",
        performer: RUNNER_PERFORMER,
        determinism: "nondeterministic",
        recipe: spawnResult.recipe,
        observation: spawnResult.observation,
      };
      return placeReceipt(scratchStore, await writeFixtureReceipt(store, receiptValue));
    }
    const error = new UnrecordedRecipeError(contributionId, id);
    refusals.push(error);
    throw error;
  };
  const performFetchNeed: FetchNeedHook = async (recipe: FetchRecipe, id) => {
    const existing = store.storedReceiptForRecipe(id);
    if (existing !== undefined) {
      return placeReceipt(scratchStore, existing);
    }
    if (record) {
      const { record: fetched } = await performFetch(recipe, {}, {}, { now });
      return placeReceipt(scratchStore, await writeFixtureReceipt(store, fetched));
    }
    const error = new UnrecordedRecipeError(contributionId, id);
    refusals.push(error);
    throw error;
  };
  return { performRun, performFetchNeed, refusals };
}

/** Records each round's output and read-log, the material of a fresh golden and of its replay. */
function recordingInvoker(inner: Invoker, rounds: GoldenRound[]): Invoker {
  return {
    invoke: async (input) => {
      const result = await inner.invoke(input);
      rounds.push({ output: result.output, reads: [...result.readLog.reads].sort() });
      return result;
    },
  };
}

/** Answers each round from a golden's recorded rounds, through the same restart loop as a host. */
function replayInvoker(rounds: readonly GoldenRound[]): Invoker {
  let cursor = 0;
  return {
    invoke: async (input) => {
      const round = rounds[cursor];
      if (round === undefined) {
        throw new KernelError({
          reason: "workspace-incomplete",
          detail: "the replay of this golden ran out of recorded rounds before the loop stopped asking",
        });
      }
      cursor++;
      return { output: round.output as RuleOutput, readLog: recordRead(input.claimId, round.reads) };
    },
  };
}

export interface RunModuleTestsOptions {
  /** Performs an unrecorded recipe and records its receipt, rather than refusing it. */
  readonly record?: boolean;
  /** Rewrites a golden that is missing or disagrees with what this run answered. */
  readonly update?: boolean;
  readonly now: Clock;
}

/** Declares no shapes: those are checked where a manifest is derived. A fixture pins behaviour. */
function fixtureEntry(id: string, version: VersionString, kind: string): ContributionEntry {
  return { kind, id, version, input: true, output: true, documentation: "" };
}

/** A module directory has no fold to resolve a contributed point from, so only kernel points do. */
function fixturePoint(contributionId: string, kind: string): ContributionPoint {
  const point = kernelPoint(kind);
  if (point === undefined) {
    throw new KernelError({
      reason: "invalid-input",
      detail: `refusing to test ${contributionId}: its fixture names ${kind}, which is not a point this kernel ships, and a module directory is not an installed workspace a contributed point could be resolved from`,
      about: [contributionId],
    });
  }
  return point;
}

/** Runs every fixture case under every available host and the golden's replay. A module with no
 * fixture fails rather than passing an empty suite. */
export async function runModuleTests(moduleDir: string, options: RunModuleTestsOptions): Promise<TestReport> {
  const moduleName = await moduleNameOf(moduleDir);
  const store = await readFixtureStore(moduleDir);

  if (store.cases.length === 0) {
    return {
      module: moduleName,
      results: [
        {
          host: "-",
          contribution: "-",
          fixture: "-",
          status: "fail",
          mismatches: [],
          message: `${moduleName} names no fixture at all`,
        },
      ],
      ok: false,
    };
  }

  const now = options.now;
  const entryPath = join(moduleDir, ENTRY_FILE_NAME);
  const scratch = await makeScratchStore(now);

  try {
    const results: FixtureResult[] = [];

    for (const fixtureCase of store.cases) {
      const { version, input, contribution: fixtureKind } = await store.input(fixtureCase);
      assertNoMachineLocalField(input, "$");
      const kind = fixtureKind ?? "rule";
      const contribution: HostContribution = {
        id: fixtureCase.contributionId,
        version: versionString(version),
        entry: fixtureEntry(fixtureCase.contributionId, versionString(version), kind),
        point: fixturePoint(fixtureCase.contributionId, kind),
      };
      const isSingleShot = kind !== "rule";
      let golden = await readGolden(store, fixtureCase);

      let sourceDoesNotCompile = false;
      for (const descriptor of HOSTS) {
        if (!(await descriptor.available())) {
          results.push(unavailableResult(descriptor.name, fixtureCase));
          continue;
        }
        // Another host would answer with the failure, which an update would write as the golden.
        if (sourceDoesNotCompile) {
          results.push({
            host: descriptor.name,
            contribution: fixtureCase.contributionId,
            fixture: fixtureCase.name,
            status: "skipped",
            mismatches: [],
            message: `${descriptor.name} was not run: ${moduleName}'s source does not compile`,
          });
          continue;
        }
        // A module directory has no slot registry, so each host runs under its fallback limits.
        const host = descriptor.create();
        try {
          let loaded: unknown;
          try {
            loaded = await host.load(entryPath, GATEWAY_EXPORT_NAME);
          } catch (error) {
            if (!(error instanceof SyntaxError)) {
              throw error;
            }
            sourceDoesNotCompile = true;
            results.push({
              host: descriptor.name,
              contribution: fixtureCase.contributionId,
              fixture: fixtureCase.name,
              status: "fail",
              mismatches: [],
              message: `${descriptor.name} could not compile ${moduleName}'s source: ${error.name}: ${error.message}`,
            });
            continue;
          }
          if (isSingleShot) {
            golden = await runParserCase(
              descriptor.name,
              host,
              loaded,
              input,
              contribution,
              fixtureCase,
              store,
              moduleName,
              golden,
              options,
              results,
            );
          } else {
            const invoker = invokerFromModuleHost(host, loaded, contribution);
            golden = await runOneCase(
              descriptor.name,
              invoker,
              input as RuleInput,
              contribution,
              fixtureCase,
              store,
              options,
              now,
              scratch,
              moduleName,
              golden,
              results,
            );
          }
        } finally {
          await host.close?.();
        }
      }

      if (golden !== undefined && !isSingleShot) {
        const invoker = replayInvoker(golden.rounds);
        golden = await runOneCase(
          "replay",
          invoker,
          input as RuleInput,
          contribution,
          fixtureCase,
          store,
          options,
          now,
          scratch,
          moduleName,
          golden,
          results,
        );
      } else if (golden !== undefined) {
        results.push({
          host: "replay",
          contribution: contribution.id,
          fixture: fixtureCase.name,
          status: "pass",
          mismatches: [],
        });
      }
    }

    const ok = results.every((result) => result.status !== "fail");
    return { module: moduleName, results, ok };
  } finally {
    await scratch.cleanup();
  }
}

function unavailableResult(host: string, fixtureCase: FixtureCase): FixtureResult {
  return {
    host,
    contribution: fixtureCase.contributionId,
    fixture: fixtureCase.name,
    status: "skipped",
    mismatches: [],
    message: `${host} is not available on this machine`,
  };
}

async function runOneCase(
  hostName: string,
  invoker: Invoker,
  input: RuleInput,
  contribution: HostContribution,
  fixtureCase: FixtureCase,
  store: FixtureStore,
  options: RunModuleTestsOptions,
  now: Clock,
  scratch: ScratchStore,
  moduleName: string,
  golden: Golden | undefined,
  results: FixtureResult[],
): Promise<Golden | undefined> {
  const rounds: GoldenRound[] = [];
  const { performRun, performFetchNeed, refusals } = buildNeedHooks(
    store,
    contribution.id,
    options.record === true,
    now,
    scratch.store,
  );
  const recorded = recordingInvoker(invoker, rounds);

  const restartResult = await runRestartLoop({
    invoker: recorded,
    input,
    store: scratch.store,
    index: scratch.index,
    performRun,
    performFetchNeed,
    now,
  });

  if (refusals.length > 0) {
    results.push({
      host: hostName,
      contribution: contribution.id,
      fixture: fixtureCase.name,
      status: "fail",
      mismatches: [],
      message: refusals[0]!.message,
    });
    return golden;
  }

  const actual: Golden = { response: restartResult.verdict, reads: [...restartResult.readLog.reads].sort(), rounds };
  return reconcileGolden(hostName, contribution, fixtureCase, store, options, moduleName, golden, actual, results);
}

async function reconcileGolden(
  hostName: string,
  contribution: HostContribution,
  fixtureCase: FixtureCase,
  store: FixtureStore,
  options: RunModuleTestsOptions,
  moduleName: string,
  golden: Golden | undefined,
  actual: Golden,
  results: FixtureResult[],
): Promise<Golden | undefined> {
  if (golden === undefined) {
    if (!options.update) {
      results.push({
        host: hostName,
        contribution: contribution.id,
        fixture: fixtureCase.name,
        status: "fail",
        mismatches: [],
        message: `no golden recorded yet for ${fixtureCase.contributionId}/${fixtureCase.name}; run with the update flag to record one`,
      });
      return golden;
    }
    await writeGolden(store, fixtureCase, actual);
    results.push({
      host: hostName,
      contribution: contribution.id,
      fixture: fixtureCase.name,
      status: "updated",
      mismatches: [],
    });
    return actual;
  }

  const mismatches = compareGolden(golden, actual, moduleName, contribution.id, fixtureCase.name);
  if (mismatches.length === 0) {
    results.push({
      host: hostName,
      contribution: contribution.id,
      fixture: fixtureCase.name,
      status: "pass",
      mismatches: [],
    });
    return golden;
  }
  if (options.update) {
    await writeGolden(store, fixtureCase, actual);
    results.push({
      host: hostName,
      contribution: contribution.id,
      fixture: fixtureCase.name,
      status: "updated",
      mismatches: [],
    });
    return actual;
  }
  results.push({
    host: hostName,
    contribution: contribution.id,
    fixture: fixtureCase.name,
    status: "fail",
    mismatches,
  });
  return golden;
}

/** A single-shot kind, such as a parser, is invoked once and never restarted. */
async function runParserCase(
  hostName: string,
  host: ModuleHost,
  loaded: unknown,
  input: unknown,
  contribution: HostContribution,
  fixtureCase: FixtureCase,
  store: FixtureStore,
  moduleName: string,
  golden: Golden | undefined,
  options: RunModuleTestsOptions,
  results: FixtureResult[],
): Promise<Golden | undefined> {
  const request: EnvelopeRequest = {
    protocol: ENVELOPE_PROTOCOL,
    contribution: contribution.entry.kind,
    id: contribution.id,
    version: contribution.version,
    input,
  };
  const { response, readLog }: HostInvocation = await host.invoke(loaded, request, contribution);
  if (!response.ok) {
    results.push({
      host: hostName,
      contribution: contribution.id,
      fixture: fixtureCase.name,
      status: "fail",
      mismatches: [],
      message: `${response.error.code}: ${response.error.message}`,
    });
    return golden;
  }
  const reads = [...readLog.reads].sort();
  const actual: Golden = { response: response.output, reads, rounds: [{ output: response.output, reads }] };
  return reconcileGolden(hostName, contribution, fixtureCase, store, options, moduleName, golden, actual, results);
}
