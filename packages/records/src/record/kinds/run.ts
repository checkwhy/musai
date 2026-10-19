import { hexOfRecordId, type RecordId } from "../../canonical/canonicalize.js";
import {
  type ExactDecimal,
  type ExactInteger,
  isExactDecimal,
  isExactInteger,
  isTimestamp,
  isVersionString,
  type Timestamp,
  type VersionString,
} from "../../canonical/numbers.js";
import { isPlainObject } from "../../canonical/plain-object.js";
import { KernelError } from "../../reason/error.js";
import type { DraftResult, KindContract } from "../contract.js";
import {
  cloneDescriptor,
  type DigestSet,
  isDigestSet,
  isResourceDescriptor,
  type ResourceDescriptor,
} from "../descriptor.js";
import { invalid, isStringArray, isStringRecord, parseRecordIdList } from "../fields.js";
import { misusedPseudonymPrefix } from "../pseudonym.js";
import { isSealedValue, type SealableText } from "../sealed.js";

/** A receipt older than this vocabulary reads as `none`: it never claimed hygiene. */
export const ISOLATION_LEVELS = ["none", "hygiene", "container", "sandbox"] as const;

export type IsolationLevel = (typeof ISOLATION_LEVELS)[number];

export function isIsolationLevel(value: unknown): value is IsolationLevel {
  return typeof value === "string" && (ISOLATION_LEVELS as readonly string[]).includes(value);
}

/** A name bound from outside the recipe's literal environment; a secret's value never travels as
 * a literal. */
export interface DeclaredName {
  name: string;
  secret: boolean;
}

/** A binary named by digest, never by the path this machine resolved it to. */
export interface ResolvedBinaryObservation {
  name: string;
  digest: string;
}

export const BINDING_LAYERS = ["bindings", "project", "preset", "booking"] as const;

export type BindingLayer = (typeof BINDING_LAYERS)[number];

/** A plain binding carries its value; a secret one only a keyed hash and its key id. */
export interface BindingObservation {
  name: string;
  secret: boolean;
  layer: BindingLayer;
  value: string | null;
  keyedHash: string | null;
  keyId: string | null;
}

/** A name scrubbed from the captured output, and how many times. */
export interface ScrubEntry {
  name: string;
  count: number;
}

/** The portable half of a receipt: no local path; the working directory is under a substrate. */
export interface RunRecipe {
  command: string[];
  workingDirectory: string;
  environment: Record<string, string>;
  declared: DeclaredName[];
  substrates: ResourceDescriptor[];
  isolation: IsolationLevel;
  /** Binaries reached for beyond the command's own program, by bare name; absent when none, so the
   * id is unchanged. */
  tooling?: string[];
}

/** Why a tooling list is invalid, else null. An empty, repeated or implicit name would give one run
 * a second id; the reason never echoes an entry, which may be a local path. */
export function toolingRefusal(recipe: { command: readonly string[]; tooling?: unknown }): string | null {
  const { tooling } = recipe;
  if (tooling === undefined) {
    return null;
  }
  if (!Array.isArray(tooling) || tooling.length === 0) {
    return "run.recipe.tooling must be absent or a non-empty array of names";
  }
  for (const name of tooling) {
    if (typeof name !== "string" || name.length === 0 || name.includes("/") || name.includes("\\")) {
      return "run.recipe.tooling must name each tool by a non-empty bare name carrying no path separator";
    }
  }
  if (new Set(tooling).size !== tooling.length) {
    return "run.recipe.tooling must not name a tool twice";
  }
  if (tooling.includes(recipe.command[0])) {
    return "run.recipe.tooling must not name the command's own program, which is tooling implicitly";
  }
  return null;
}

/** Who performed a run; a receipt is trusted exactly as far as its performer is. */
export type RunPerformer =
  | { kind: "runner"; version: VersionString }
  | { kind: "module"; module: string; name: string; version: VersionString }
  | { kind: "foreign"; principal: string; tool: string; version: VersionString };

/** The performer's claim about re-running; kept off the recipe so its id never depends on it. */
export const RUN_DETERMINISM = ["deterministic", "seeded", "nondeterministic"] as const;

export type RunDeterminism = (typeof RUN_DETERMINISM)[number];

/** Absent means unmeasured, never zero; amounts are exact strings RFC 8785 cannot round. */
export interface RunCost {
  cpuMs?: ExactInteger;
  tokens?: ExactInteger;
  money?: { amount: ExactDecimal; currency: string };
}

/** One read: a key a dependent looks it up by (`slot:<slot>` for a claim, else the record id) and
 * the digest of the bytes consumed, so a reader whose bytes did not move need not go stale. */
export interface ReadEntry {
  key: string;
  consumed: DigestSet;
}

const SLOT_KEY_PREFIX = "slot:";

/** The key a claim is read under: its slot, so a successor at the slot reads as what moved. */
export function slotReadKey(slot: string): string {
  return `${SLOT_KEY_PREFIX}${slot}`;
}

/** The slot a read key names, or `undefined` for a key naming a record by id. */
export function slotOfReadKey(key: string): string | undefined {
  return key.startsWith(SLOT_KEY_PREFIX) ? key.slice(SLOT_KEY_PREFIX.length) : undefined;
}

const RECIPE_KEY_PREFIX = "recipe:";

/** The key a run or fetch need is read under: its recipe, since the need asks for the latest. */
export function recipeReadKey(recipe: RecordId): string {
  return `${RECIPE_KEY_PREFIX}${recipe}`;
}

/** The recipe a read key names, or `undefined` for a key naming a slot or a record. */
export function recipeOfReadKey(key: string): RecordId | undefined {
  return key.startsWith(RECIPE_KEY_PREFIX) ? (key.slice(RECIPE_KEY_PREFIX.length) as RecordId) : undefined;
}

/** A record read whole: the digest it consumed is its id's. */
export function readEntryFor(id: RecordId, key: string = id): ReadEntry {
  return { key, consumed: { sha256: hexOfRecordId(id) } };
}

/** What this machine saw running a recipe. `reads` is what it read beyond its recipe and bindings:
 * empty for a command or a fetch, the read-set for a brief. */
export interface RunObservation {
  resolved: ResourceDescriptor[];
  isolationHeld: IsolationLevel;
  binaries: ResolvedBinaryObservation[];
  bindings: BindingObservation[];
  output: SealableText;
  outputLossy: boolean;
  exitCode: number;
  scrubbed: ScrubEntry[];
  /** Absent where the run is deterministic, so its id is its content. */
  startedAt?: Timestamp;
  finishedAt?: Timestamp;
  reads: ReadEntry[];
  cost: RunCost;
}

/** What the kernel computed: the command naming it and the substrates it took, by digest. */
export interface ComputedRecipe {
  command: string[];
  substrates: ResourceDescriptor[];
}

/** A computed run's output and what it read; no environment, so no placeholder for one. */
export interface ComputedObservation {
  output: SealableText;
  reads: ReadEntry[];
  cost: RunCost;
}

/** A command, a fetch or a testimony, performed in a declared environment, or the brief rendered
 * for a decider or a rule's evaluation, which the kernel computes. */
export const RUN_KINDS = ["run", "citation", "testimony", "brief", "evaluation"] as const;

/** The kinds the kernel computes from records alone, so a stranger re-running one gets its id. */
export const COMPUTED_RUN_KINDS = ["brief", "evaluation"] as const;

export type ComputedRunKind = (typeof COMPUTED_RUN_KINDS)[number];

export function isComputedRunKind(value: unknown): value is ComputedRunKind {
  return typeof value === "string" && (COMPUTED_RUN_KINDS as readonly string[]).includes(value);
}

interface RunFields {
  kind: "run";
  schemaVersion: number;
  performer: RunPerformer;
  /** The records this one replaces; a correction is a successor, never an edit. */
  supersedes: RecordId[];
}

/** A receipt or a citation: a recipe a stranger could re-run, an observation only this machine
 * could make, and who performed it with what they assert about re-running. */
export interface PerformedRunRecord extends RunFields {
  runKind: Exclude<(typeof RUN_KINDS)[number], ComputedRunKind>;
  determinism: RunDeterminism;
  recipe: RunRecipe;
  observation: RunObservation;
}

/** A run the kernel computed from records it names in its reads. */
export interface ComputedRunRecord extends RunFields {
  runKind: ComputedRunKind;
  determinism: "deterministic";
  recipe: ComputedRecipe;
  observation: ComputedObservation;
}

export type RunRecord = PerformedRunRecord | ComputedRunRecord;

export function isComputedRun(run: RunRecord): run is ComputedRunRecord {
  return isComputedRunKind(run.runKind);
}

/** A run read where only a performed one has an exit code and an environment to read. */
export function performedRun(id: string, run: RunRecord): PerformedRunRecord {
  if (isComputedRun(run)) {
    throw new KernelError({
      reason: "invalid-input",
      about: [id],
      detail: `run ${id} is a ${run.runKind} the kernel computed, and only a performed run is read here`,
    });
  }
  return run;
}

/** Marks the testimony substrate naming the brief it was given, by digest. */
export const BRIEF_MEDIA_TYPE = "application/vnd.musai.brief+json";

/** Marks the testimony substrate naming the crew definition that asked, by digest. */
export const CREW_MEDIA_TYPE = "application/vnd.musai.crew+json";

/** Marks the testimony substrate naming the model, a moving reference resolved at the call. */
export const MODEL_MEDIA_TYPE = "application/vnd.musai.model+json";

function isDeclaredNameArray(value: unknown): value is DeclaredName[] {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.every((entry) => {
    if (entry === null || typeof entry !== "object") {
      return false;
    }
    const candidate = entry as Record<string, unknown>;
    return typeof candidate["name"] === "string" && typeof candidate["secret"] === "boolean";
  });
}

function isResourceDescriptorArray(value: unknown): value is ResourceDescriptor[] {
  return Array.isArray(value) && value.every(isResourceDescriptor);
}

function isReadEntryArray(value: unknown): value is ReadEntry[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isPlainObject(entry) &&
        typeof entry["key"] === "string" &&
        entry["key"].length > 0 &&
        isDigestSet(entry["consumed"]) &&
        Object.keys(entry["consumed"]).length > 0,
    )
  );
}

/** Before version 3 a read was a descriptor naming a record by its digest alone, so that digest
 * is both the key and what was consumed. */
function readEntriesFromDigests(reads: unknown): unknown {
  if (!Array.isArray(reads)) {
    return reads;
  }
  return reads.map((read) => {
    const sha256 = isPlainObject(read) && isPlainObject(read["digest"]) ? read["digest"]["sha256"] : undefined;
    return typeof sha256 === "string" ? { key: `sha256:${sha256}`, consumed: { sha256 } } : read;
  });
}

function isResolvedBinaryArray(value: unknown): value is ResolvedBinaryObservation[] {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.every((entry) => {
    if (entry === null || typeof entry !== "object") {
      return false;
    }
    const keys = Object.keys(entry as object);
    if (keys.length !== 2 || !keys.includes("name") || !keys.includes("digest")) {
      return false;
    }
    const candidate = entry as Record<string, unknown>;
    return typeof candidate["name"] === "string" && typeof candidate["digest"] === "string";
  });
}

function isBindingObservationArray(value: unknown): value is BindingObservation[] {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.every((entry) => {
    if (entry === null || typeof entry !== "object") {
      return false;
    }
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate["name"] !== "string" || typeof candidate["secret"] !== "boolean") {
      return false;
    }
    if (typeof candidate["layer"] !== "string" || !(BINDING_LAYERS as readonly string[]).includes(candidate["layer"])) {
      return false;
    }
    const value_ = candidate["value"];
    const keyedHash = candidate["keyedHash"];
    const keyId = candidate["keyId"];
    const valueOk = typeof value_ === "string" || value_ === null;
    const keyedHashOk = typeof keyedHash === "string" || keyedHash === null;
    const keyIdOk = typeof keyId === "string" || keyId === null;
    if (!valueOk || !keyedHashOk || !keyIdOk) {
      return false;
    }
    if (candidate["secret"] === false) {
      return typeof value_ === "string" && keyedHash === null && keyId === null;
    }
    return value_ === null && typeof keyedHash === "string" && typeof keyId === "string";
  });
}

function isScrubEntryArray(value: unknown): value is ScrubEntry[] {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.every((entry) => {
    if (entry === null || typeof entry !== "object") {
      return false;
    }
    const candidate = entry as Record<string, unknown>;
    return typeof candidate["name"] === "string" && typeof candidate["count"] === "number";
  });
}

function parseRunPerformer(
  value: unknown,
): { readonly ok: true; readonly performer: RunPerformer } | { readonly ok: false; readonly error: string } {
  if (!isPlainObject(value)) {
    return { ok: false, error: "run.performer must name who performed the run: a runner, a module or a foreign tool" };
  }
  const kind = value["kind"];
  const version = value["version"];
  if (!isVersionString(version)) {
    return { ok: false, error: "run.performer.version must be a non-empty string with no whitespace" };
  }
  if (kind === "runner") {
    return { ok: true, performer: { kind, version } };
  }
  if (kind === "module") {
    if (typeof value["module"] !== "string" || typeof value["name"] !== "string") {
      return {
        ok: false,
        error: "a module performer must name its module and the contribution that performed the run",
      };
    }
    return { ok: true, performer: { kind, module: value["module"], name: value["name"], version } };
  }
  if (kind === "foreign") {
    if (typeof value["principal"] !== "string" || typeof value["tool"] !== "string") {
      return {
        ok: false,
        error: "a foreign performer must name the principal standing behind it and the tool they ran",
      };
    }
    const misusedPrefix = misusedPseudonymPrefix(value["principal"], "run.performer.principal");
    if (misusedPrefix !== null) {
      return { ok: false, error: misusedPrefix };
    }
    return { ok: true, performer: { kind, principal: value["principal"], tool: value["tool"], version } };
  }
  return { ok: false, error: `run.performer.kind must be one of runner, module, foreign, got ${String(kind)}` };
}

/** Unknown keys are refused, not dropped: a misspelled `tokens` would read as unmeasured. */
function parseRunCost(
  value: unknown,
): { readonly ok: true; readonly cost: RunCost } | { readonly ok: false; readonly error: string } {
  if (!isPlainObject(value)) {
    return { ok: false, error: "run.observation.cost must be an object, empty where nothing was measured" };
  }
  const known = new Set(["cpuMs", "tokens", "money"]);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      return { ok: false, error: `run.observation.cost carries a key it does not know: ${key}` };
    }
  }
  const cost: RunCost = {};
  for (const key of ["cpuMs", "tokens"] as const) {
    if (key in value) {
      if (!isExactInteger(value[key])) {
        return {
          ok: false,
          error: `run.observation.cost.${key} must be carried as digits in a string, not a bare number`,
        };
      }
      cost[key] = value[key];
    }
  }
  if ("money" in value) {
    const money = value["money"];
    if (!isPlainObject(money)) {
      return { ok: false, error: "run.observation.cost.money must name an amount and a currency" };
    }
    const amount = money["amount"];
    const currency = money["currency"];
    if (!isExactDecimal(amount)) {
      return {
        ok: false,
        error: "run.observation.cost.money.amount must be carried as digits in a string, not a bare number",
      };
    }
    if (typeof currency !== "string" || currency === "") {
      return { ok: false, error: "run.observation.cost.money.currency must be a non-empty string" };
    }
    cost.money = { amount, currency };
  }
  return { ok: true, cost };
}

export type RunDraft = Omit<PerformedRunRecord, "schemaVersion"> | Omit<ComputedRunRecord, "schemaVersion">;

const COMPUTED_RECIPE_FIELDS = ["command", "substrates"];
const COMPUTED_OBSERVATION_FIELDS = ["output", "reads", "cost"];

function strayField(value: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  return Object.keys(value).find((field) => !allowed.includes(field));
}

/** A computed run names only what it took and what it made: an environment field would be a
 * placeholder, and an instant would give one computation two ids. */
function validateComputedRun(
  runKind: ComputedRunKind,
  determinism: string,
  performer: RunPerformer,
  supersedes: RecordId[],
  recipe: unknown,
  observation: unknown,
): DraftResult<RunDraft> {
  if (determinism !== "deterministic") {
    return invalid(`a ${runKind} run is computed by the kernel, so run.determinism must be deterministic`);
  }
  if (!isPlainObject(recipe)) {
    return invalid("run.recipe is required");
  }
  const strayRecipe = strayField(recipe, COMPUTED_RECIPE_FIELDS);
  if (strayRecipe !== undefined) {
    return invalid(`a ${runKind} run's recipe holds only command and substrates, not ${strayRecipe}`);
  }
  if (!isStringArray(recipe["command"]) || recipe["command"].length === 0) {
    return invalid("run.recipe.command must be a non-empty array of strings");
  }
  if (!isResourceDescriptorArray(recipe["substrates"])) {
    return invalid("run.recipe.substrates must be an array of resource descriptors naming a locator or a digest");
  }
  if (!isPlainObject(observation)) {
    return invalid("run.observation is required");
  }
  const strayObservation = strayField(observation, COMPUTED_OBSERVATION_FIELDS);
  if (strayObservation !== undefined) {
    return invalid(`a ${runKind} run's observation holds only output, reads and cost, not ${strayObservation}`);
  }
  if (typeof observation["output"] !== "string" && !isSealedValue(observation["output"])) {
    return invalid("run.observation.output must be a string or a sealed value");
  }
  if (!isReadEntryArray(observation["reads"])) {
    return invalid("run.observation.reads must be an array of { key, consumed }, each consumed naming a digest");
  }
  const cost = parseRunCost(observation["cost"]);
  if (!cost.ok) {
    return invalid(cost.error);
  }
  return {
    ok: true,
    record: {
      kind: "run",
      runKind,
      performer,
      determinism: "deterministic",
      supersedes,
      recipe: {
        command: [...(recipe["command"] as string[])],
        substrates: (recipe["substrates"] as ResourceDescriptor[]).map(cloneDescriptor),
      },
      observation: {
        output: observation["output"] as SealableText,
        reads: (observation["reads"] as ReadEntry[]).map((entry) => ({
          key: entry.key,
          consumed: { ...entry.consumed },
        })),
        cost: cost.cost,
      },
    },
  };
}

/** Every field is required: a missing list is refused, never defaulted, or "declares nothing" and
 * "forgot the field" would read alike. */
function validateRun(fields: Record<string, unknown>): DraftResult<RunDraft> {
  const { runKind, recipe, observation } = fields;
  const supersedes = parseRecordIdList(fields["supersedes"], "run", "supersedes", "empty when nothing is replaced");
  if (!supersedes.ok) {
    return invalid(supersedes.error);
  }
  if (typeof runKind !== "string" || !(RUN_KINDS as readonly string[]).includes(runKind)) {
    return invalid(`run.runKind must be one of ${RUN_KINDS.join(", ")}`);
  }
  const performer = parseRunPerformer(fields["performer"]);
  if (!performer.ok) {
    return invalid(performer.error);
  }
  const determinism = fields["determinism"];
  if (typeof determinism !== "string" || !(RUN_DETERMINISM as readonly string[]).includes(determinism)) {
    return invalid(`run.determinism must be one of ${RUN_DETERMINISM.join(", ")}`);
  }
  if (isComputedRunKind(runKind)) {
    return validateComputedRun(runKind, determinism, performer.performer, supersedes.ids, recipe, observation);
  }
  if (!isPlainObject(recipe)) {
    return invalid("run.recipe is required");
  }
  if (!isStringArray(recipe["command"])) {
    return invalid("run.recipe.command must be an array of strings");
  }
  if (typeof recipe["workingDirectory"] !== "string") {
    return invalid("run.recipe.workingDirectory must be a string");
  }
  if (!isStringRecord(recipe["environment"])) {
    return invalid("run.recipe.environment must be an object whose values are strings");
  }
  if (!isDeclaredNameArray(recipe["declared"])) {
    return invalid("run.recipe.declared must be an array of { name, secret }");
  }
  if (!isResourceDescriptorArray(recipe["substrates"])) {
    return invalid("run.recipe.substrates must be an array of resource descriptors naming a locator or a digest");
  }
  if (!isIsolationLevel(recipe["isolation"])) {
    return invalid(`run.recipe.isolation must be one of ${ISOLATION_LEVELS.join(", ")}`);
  }
  const refusedTooling = toolingRefusal({ command: recipe["command"] as string[], tooling: recipe["tooling"] });
  if (refusedTooling !== null) {
    return invalid(refusedTooling);
  }

  // A testimony binds its brief, crew and model as substrates; the transcript is its output.
  if (runKind === "testimony") {
    const command = recipe["command"] as string[];
    if (command.length !== 2 || command[0] !== "ask" || (command[1]?.length ?? 0) === 0) {
      return invalid('a testimony run\'s recipe.command must be exactly ["ask", <contribution id>]');
    }
    const substrates = recipe["substrates"] as ResourceDescriptor[];
    const brief = substrates.find((substrate) => substrate.mediaType === BRIEF_MEDIA_TYPE);
    if (brief?.digest?.sha256 === undefined) {
      return invalid(
        "a testimony run's recipe must name the brief it was given as a substrate carrying a sha256 digest",
      );
    }
    const crew = substrates.find((substrate) => substrate.mediaType === CREW_MEDIA_TYPE);
    if (crew?.digest?.sha256 === undefined) {
      return invalid(
        "a testimony run's recipe must name the crew definition that asked as a substrate carrying a sha256 digest",
      );
    }
    const model = substrates.find((substrate) => substrate.mediaType === MODEL_MEDIA_TYPE);
    if (model?.uri === undefined) {
      return invalid("a testimony run's recipe must name the model as a substrate carrying a locator");
    }
  }

  if (!isPlainObject(observation)) {
    return invalid("run.observation is required");
  }
  const cost = parseRunCost(observation["cost"]);
  if (!cost.ok) {
    return invalid(cost.error);
  }
  if (!isResourceDescriptorArray(observation["resolved"])) {
    return invalid("run.observation.resolved must be an array of resource descriptors naming a locator or a digest");
  }
  if (!isIsolationLevel(observation["isolationHeld"])) {
    return invalid(`run.observation.isolationHeld must be one of ${ISOLATION_LEVELS.join(", ")}`);
  }
  if (!isResolvedBinaryArray(observation["binaries"])) {
    return invalid("run.observation.binaries must be an array of { name, digest }");
  }
  if (!isBindingObservationArray(observation["bindings"])) {
    return invalid(
      "run.observation.bindings must be an array of binding observations, each carrying either its value alone or a keyed hash and a key id alone",
    );
  }
  if (typeof observation["output"] !== "string" && !isSealedValue(observation["output"])) {
    return invalid("run.observation.output must be a string or a sealed value");
  }
  if (typeof observation["outputLossy"] !== "boolean") {
    return invalid("run.observation.outputLossy must be a boolean");
  }
  if (!("exitCode" in observation)) {
    return invalid("run.observation.exitCode is required");
  }
  if (!isScrubEntryArray(observation["scrubbed"])) {
    return invalid("run.observation.scrubbed must be an array of { name, count }");
  }
  const timed = determinism !== "deterministic";
  for (const instant of ["startedAt", "finishedAt"] as const) {
    if (!timed && instant in observation) {
      return invalid(`run.observation.${instant} must be absent from a deterministic run, so its id is its content`);
    }
    if (timed && !isTimestamp(observation[instant])) {
      return invalid(`run.observation.${instant} must be an RFC 3339 timestamp`);
    }
  }
  if (!isReadEntryArray(observation["reads"])) {
    return invalid("run.observation.reads must be an array of { key, consumed }, each consumed naming a digest");
  }

  const record: RunDraft = {
    kind: "run",
    runKind: runKind as PerformedRunRecord["runKind"],
    performer: performer.performer,
    determinism: determinism as RunDeterminism,
    supersedes: supersedes.ids,
    recipe: {
      command: [...(recipe["command"] as string[])],
      workingDirectory: recipe["workingDirectory"] as string,
      environment: { ...(recipe["environment"] as Record<string, string>) },
      declared: (recipe["declared"] as DeclaredName[]).map((declared) => ({
        name: declared.name,
        secret: declared.secret,
      })),
      substrates: (recipe["substrates"] as ResourceDescriptor[]).map(cloneDescriptor),
      isolation: recipe["isolation"] as IsolationLevel,
      ...(recipe["tooling"] === undefined ? {} : { tooling: [...(recipe["tooling"] as string[])] }),
    },
    observation: {
      resolved: (observation["resolved"] as ResourceDescriptor[]).map(cloneDescriptor),
      isolationHeld: observation["isolationHeld"] as IsolationLevel,
      binaries: (observation["binaries"] as ResolvedBinaryObservation[]).map((binary) => ({
        name: binary.name,
        digest: binary.digest,
      })),
      bindings: (observation["bindings"] as BindingObservation[]).map((binding) => ({ ...binding })),
      output: observation["output"] as SealableText,
      outputLossy: observation["outputLossy"] as boolean,
      exitCode: observation["exitCode"] as number,
      scrubbed: (observation["scrubbed"] as ScrubEntry[]).map((entry) => ({ name: entry.name, count: entry.count })),
      ...(timed
        ? { startedAt: observation["startedAt"] as Timestamp, finishedAt: observation["finishedAt"] as Timestamp }
        : {}),
      reads: (observation["reads"] as ReadEntry[]).map((entry) => ({
        key: entry.key,
        consumed: { ...entry.consumed },
      })),
      cost: cost.cost,
    },
  };
  return { ok: true, record };
}

/** A run read from before version 4, in the shape version 4 gives it: a brief computed, and a
 * deterministic run untimed. */
function inVersionFourShape(fields: Record<string, unknown>): Record<string, unknown> {
  const recipe = fields["recipe"] as Record<string, unknown>;
  const observation = fields["observation"] as Record<string, unknown>;
  if (isComputedRunKind(fields["runKind"])) {
    return {
      ...fields,
      determinism: "deterministic",
      recipe: { command: recipe["command"], substrates: recipe["substrates"] },
      observation: { output: observation["output"], reads: observation["reads"], cost: observation["cost"] },
    };
  }
  if (fields["determinism"] !== "deterministic") {
    return fields;
  }
  const { startedAt: _started, finishedAt: _finished, ...untimed } = observation;
  return { ...fields, observation: untimed };
}

export const runContract: KindContract<"run", RunDraft> = {
  kind: "run",
  version: 4,
  normalizers: {
    // Before performers were recorded only musai's runner made receipts, its version unwritten.
    1: (fields) => {
      const observation = fields["observation"] as Record<string, unknown>;
      return inVersionFourShape({
        ...fields,
        supersedes: [],
        performer: { kind: "runner", version: "unrecorded" },
        determinism: "nondeterministic",
        observation: { ...observation, cost: {}, reads: readEntriesFromDigests(observation["reads"]) },
      });
    },
    2: (fields) => {
      const observation = fields["observation"] as Record<string, unknown>;
      return inVersionFourShape({
        ...fields,
        observation: { ...observation, reads: readEntriesFromDigests(observation["reads"]) },
      });
    },
    3: inVersionFourShape,
  },
  numberPolicy: {
    schemaVersion: "measured",
    observation: {
      exitCode: "measured",
      startedAt: "exact",
      finishedAt: "exact",
      cost: { cpuMs: "exact", tokens: "exact", money: { amount: "exact" } },
    },
  },
  sealedPaths: new Set(["$.observation.output"]),
  packMayDraft: false,
  saltable: false,
  validate: validateRun,
};
