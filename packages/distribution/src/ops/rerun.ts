import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkRecipesOf,
  contributionKeysOf,
  coveringRelease,
  DECLARATIVE_RULE,
  type DeclarativeParameters,
  declarativeParametersOf,
  expectedExitCodeOf,
  isOperationError,
  type OperationDescriptor,
  OperationError,
  openWorkspace,
  releaseStanding,
  runHandler,
  signatureCheck,
  type Workspace,
} from "@musai/api-core";
import {
  type AttestationRecord,
  BLOBS_DIR,
  blobPath,
  type ClaimRecord,
  type Conditions,
  CURRENT_SCHEMA_VERSIONS,
  exitCodeForClass,
  idFromPath,
  isComputedRun,
  isKernelError,
  isSidecarPath,
  kindFromPath,
  type PerformedRunRecord,
  performedRun,
  type RecordId,
  type RunObservation,
  type RunRecipe,
  type RunRecord,
  rawId,
  recordId,
  renderedTextOf,
  sidecarPath,
  type Timestamp,
  timestamp,
  versionString,
} from "@musai/records";
import {
  bindCheckout,
  checkoutBindingsFor,
  isContainerImageSubstrate,
  namesTree,
  performRecipe,
  RUNNER_PERFORMER,
  resolveSubstrates,
} from "@musai/run";
import { MUSAI_DIR, type PlacedItem, resolveWorkTree, writeMainFiles } from "@musai/store";
import { aliasOf } from "@musai/trust";
import { readBundle } from "../bundle/source.js";
import { recordedRuleVerdict } from "../claim.js";
import { shortIdOf } from "../claim-ref.js";
import { buildCarried, judgingModuleName, judgingModulesOf } from "../export/closure.js";
import { commandText, markOf } from "../text.js";
import { repositoryOf } from "./check.js";
import { workspaceInit } from "./workspace.js";

export interface RerunInput {
  /** A bundle's `.tar.gz`, by path or https URL. */
  readonly bundle: string;
  /** Performs each recipe; without it, rerun only shows what it would run. */
  readonly yes?: boolean;
}

/** What a run ended with, as two runs compare: its exit code and its output's digest. */
export interface RunEnd {
  readonly exitCode: number;
  readonly output: string | null;
}

/** A receipt shown with the recipe it ran, and with what that recipe ended with here. */
export interface RerunRun {
  readonly receipt: string;
  readonly command: readonly string[];
  readonly tools: readonly string[];
  readonly tree: { readonly name: string; readonly recorded: string | null; readonly here: string | null } | null;
  readonly recorded: RunEnd;
  readonly rerun: RunEnd | null;
  /** `null` where nothing ran or the output is sealed; a timing or a path moves it harmlessly. */
  readonly outputMatches: boolean | null;
}

export interface RerunClaim extends RerunRun {
  readonly statement: string;
  readonly short: string;
  /** By the exit code, the check's finer verdict. */
  readonly verdict: "matches" | "differs" | "not-run";
  /** Whether each run met the exit code the check expects, which two failing codes share. */
  readonly verdicts: {
    readonly recorded: "holds" | "fails";
    readonly rerun: "holds" | "fails" | null;
    readonly matches: boolean | null;
  };
}

/** A claim a module's rule judges, or the interpreter by anything but one recipe's exit code,
 * compared by its rule's verdict over the bundle's receipts and over the same recipes run here. */
export interface RerunRule {
  readonly statement: string;
  readonly short: string;
  readonly rule: string;
  readonly runs: readonly RerunRun[];
  readonly recorded: "holds" | "fails" | null;
  readonly rerun: "holds" | "fails" | "open" | null;
  readonly verdict: "matches" | "differs" | "not-run" | "not-re-derivable";
  /** Why the rule's verdict cannot be re-derived here, where it cannot. */
  readonly why: string | null;
}

export interface RerunOutput {
  /** `null` where the bundle carries no manifest naming an audience to check. */
  readonly release: {
    readonly audience: string;
    readonly covered: true;
    /** The key that signed the covering release, and the name the bundle's signers give it. */
    readonly signer: { readonly principal: string; readonly name: string | null };
  } | null;
  readonly performed: boolean;
  readonly claims: readonly RerunClaim[];
  /** The claims whose verdict is re-derived, where the bundle holds any. */
  readonly rules?: readonly RerunRule[];
}

const TRUST_FILES = ["allowed-signers", "roles", "audiences"] as const;

const MANIFEST = "bundle.json";

function corrupted(path: string, detail: string): OperationError {
  return new OperationError({ reason: "record-corrupted", about: [path], detail: `refusing the bundle: ${detail}` });
}

/** The output's digest, or `null` where it is sealed and two runs cannot be told apart by it. */
function runEnd(observation: RunObservation): RunEnd {
  return {
    exitCode: observation.exitCode,
    output: typeof observation.output === "string" ? rawId(new TextEncoder().encode(observation.output)) : null,
  };
}

/** Each record placed by its bytes as a merge places it, so it keeps the version and id sent. */
async function seeded(opened: Workspace, files: ReadonlyMap<string, Uint8Array>): Promise<RecordId[]> {
  const items: PlacedItem[] = [];
  const ids: RecordId[] = [];
  for (const [path, bytes] of files) {
    if (TRUST_FILES.includes(path as (typeof TRUST_FILES)[number]) || path === MANIFEST) {
      continue;
    }
    if (path.startsWith(`${BLOBS_DIR}/`)) {
      if (blobPath(rawId(bytes)) !== path) {
        throw corrupted(path, `${path} does not digest to its name`);
      }
      await opened.blobs.put(bytes);
      continue;
    }
    if (isSidecarPath(path)) {
      continue;
    }
    let id: RecordId;
    try {
      id = idFromPath(path);
    } catch {
      throw corrupted(path, `${path} is no file a bundle carries`);
    }
    if (rawId(bytes) !== id) {
      throw corrupted(path, `${path} does not digest to its name`);
    }
    const signature = files.get(`${path}.sig`);
    items.push({
      kind: kindFromPath(path),
      bytes,
      ...(signature === undefined ? {} : { signature: new TextDecoder().decode(signature) }),
    });
    ids.push(id);
  }
  await opened.store.placeMany(items);
  return ids;
}

/** A check names its repository `git:<oldest root commit>`, all a receiver can find it by. */
function outsideCheckout(workspace: string, files: ReadonlyMap<string, Uint8Array>): OperationError {
  const subject = [...files]
    .filter(([path]) => path.startsWith("records/claim/"))
    .map(
      ([, bytes]) =>
        (JSON.parse(new TextDecoder().decode(bytes)) as { conditions?: Record<string, unknown> }).conditions?.[
          "subject"
        ],
    )
    .find((value): value is string => typeof value === "string" && value.startsWith("git:"));
  const repository =
    subject === undefined
      ? "the repository the bundle's claims name"
      : `the repository whose first commit is ${subject.slice(4)}`;
  return new OperationError({
    reason: "invalid-input",
    about: [workspace],
    detail: `refusing to rerun: ${workspace} is in no git working tree, and a bundle's commands run in a checkout of the repository they checked; clone ${repository} and rerun from inside it`,
  });
}

/** The release the manifest names must stand for its root, read as the verifier reads it. */
async function releaseOf(opened: Workspace, files: ReadonlyMap<string, Uint8Array>): Promise<RerunOutput["release"]> {
  const manifest = files.get(MANIFEST);
  if (manifest === undefined) {
    return null;
  }
  const { root, audience, at } = JSON.parse(new TextDecoder().decode(manifest)) as {
    root: RecordId;
    audience: string;
    at: string;
  };
  const { standing } = await releaseStanding(opened, root);
  const covering = coveringRelease(standing, audience, opened.audiences, timestamp(at));
  if (covering === undefined) {
    throw new OperationError({
      reason: "not-authorised",
      about: [root, audience],
      detail: `refusing the bundle: no release standing for ${root} covers ${audience}, the audience it was cut for`,
    });
  }
  const principal = covering.record.principal;
  return { audience, covered: true, signer: { principal, name: aliasOf(opened.allowedSigners, principal) ?? null } };
}

async function refuseBadSignatures(
  opened: Workspace,
  ids: readonly RecordId[],
  files: ReadonlyMap<string, Uint8Array>,
): Promise<void> {
  for (const id of ids) {
    const path = sidecarPath(id);
    if (!files.has(path)) {
      continue;
    }
    const check = await signatureCheck(opened, { id, record: opened.read(id) as AttestationRecord });
    if (!check.good) {
      throw corrupted(path, `the signature on ${id} does not verify against the bundle's allowed signers`);
    }
  }
}

interface BundledRun {
  readonly id: RecordId;
  readonly run: PerformedRunRecord;
}

/** Every performed run the bundle carries, each tree it read bound to `top`. */
async function bundledRuns(opened: Workspace, ids: readonly RecordId[], top: string): Promise<BundledRun[]> {
  const runs: BundledRun[] = [];
  for (const id of ids.filter((record) => opened.index.recordById(record)?.record.kind === "run")) {
    const record = (await opened.store.read(id, "run")) as RunRecord;
    if (isComputedRun(record)) {
      continue;
    }
    const run = performedRun(id, record);
    for (const descriptor of run.recipe.substrates.filter(namesTree)) {
      await bindCheckout(opened.localDir, descriptor.name!, top);
    }
    runs.push({ id, run });
  }
  return runs;
}

/** A claim current at its slot, with the interpreter's parameters it holds. */
interface BundledClaim {
  readonly slot: string;
  readonly conditions: Conditions;
  readonly parameters: DeclarativeParameters | null;
}

/** The current claim at each slot the bundle carries a claim for, in slot order. */
function bundledClaims(opened: Workspace, ids: readonly RecordId[]): BundledClaim[] {
  const slots = new Set<string>();
  for (const id of ids) {
    const record = opened.index.recordById(id)?.record;
    if (record?.kind === "claim") {
      slots.add(record.slot);
    }
  }
  return [...slots].sort().map((slot) => {
    const { id, record } = opened.index.claimAtSlot(slot)!;
    const { conditions } = record as ClaimRecord;
    return { slot, conditions, parameters: declarativeParametersOf(id, conditions) };
  });
}

interface CheckReceipt {
  readonly slot: string;
  readonly expected: number;
  readonly run: PerformedRunRecord;
  readonly id: RecordId;
}

/** Each claim the interpreter judges by one recipe's exit code, with the runs of that recipe. */
function receipts(claims: readonly BundledClaim[], runs: readonly BundledRun[]): CheckReceipt[] {
  const found: CheckReceipt[] = [];
  for (const { slot, parameters } of claims) {
    const expected = expectedExitCodeOf(parameters);
    if (expected === null) {
      continue;
    }
    const named = recordId(checkRecipesOf(parameters)[0]!);
    for (const { id, run } of runs.filter((entry) => recordId(entry.run.recipe) === named)) {
      found.push({ slot, expected, id, run });
    }
  }
  return found;
}

interface JudgedClaim {
  readonly slot: string;
  readonly rule: string;
  readonly recorded: { readonly label: "holds" | "fails"; readonly runs: readonly BundledRun[] } | null;
  readonly why: string | null;
}

/** What the claim's rule concludes over the receipts held here, spawning nothing. */
async function ruleVerdictHere(
  opened: Workspace,
  slot: string,
): Promise<{ readonly label: "holds" | "fails" | "open"; readonly reason: string; readonly runs: BundledRun[] }> {
  const { verdict, runs } = await recordedRuleVerdict(opened, slot);
  return { label: verdict.label, reason: verdict.reason, runs: runs.map(({ id, record }) => ({ id, run: record })) };
}

/** Whether a condition key names a rule other than the interpreter: one installed from the
 * bundle, or one whose module stayed home. */
function judgingKey(opened: Workspace, key: string): boolean {
  const kind = opened.index.contributionById(key)?.entry.kind;
  return key !== DECLARATIVE_RULE && (kind === undefined || kind === "rule");
}

/** Each claim a module's rule judges, or the interpreter by anything but one recipe's exit code,
 * whatever its type, with the verdict that rule reaches over the bundle's receipts. */
async function judgedClaims(
  opened: Workspace,
  claims: readonly BundledClaim[],
  files: ReadonlyMap<string, Uint8Array>,
): Promise<JudgedClaim[]> {
  const judged: JudgedClaim[] = [];
  for (const { slot, conditions, parameters } of claims.filter(
    (claim) => expectedExitCodeOf(claim.parameters) === null,
  )) {
    const rule =
      checkRecipesOf(parameters).length > 0
        ? DECLARATIVE_RULE
        : contributionKeysOf(conditions).find((key) => judgingKey(opened, key));
    if (rule === undefined) {
      continue;
    }
    const underivable = (why: string): JudgedClaim => ({ slot, rule, recorded: null, why });
    if (opened.index.contributionById(rule) === undefined) {
      judged.push(underivable(`the bundle carries no module contributing ${rule}`));
      continue;
    }
    const uncarried = judgingModulesOf(opened, conditions, parameters).find(
      ({ module }) => !buildCarried(opened, module, files),
    );
    if (uncarried !== undefined) {
      const named = judgingModuleName(opened, uncarried);
      judged.push(underivable(`${named} was not carried: no build on the exporting machine`));
      continue;
    }
    try {
      const { label, reason, runs } = await ruleVerdictHere(opened, slot);
      judged.push(
        label === "open"
          ? underivable(`over the bundle's receipts it reads open: ${reason}`)
          : { slot, rule, recorded: { label, runs }, why: null },
      );
    } catch (error) {
      if (!isKernelError(error) && !isOperationError(error)) {
        throw error;
      }
      judged.push(underivable(error.message));
    }
  }
  return judged;
}

async function treeHere(recipe: RunRecipe, localDir: string, workspace: string): Promise<string | null> {
  const trees = recipe.substrates.filter(namesTree);
  const resolved = await resolveSubstrates(trees, await checkoutBindingsFor(trees, localDir), [workspace]);
  return resolved[0]?.digest?.gitTree ?? null;
}

function recordedTree(run: PerformedRunRecord): RerunRun["tree"] {
  const position = run.recipe.substrates.findIndex(namesTree);
  if (position === -1) {
    return null;
  }
  const name = run.recipe.substrates[position]!.name!;
  return { name, recorded: run.observation.resolved[position]?.digest?.gitTree ?? null, here: null };
}

/** A receipt beside what its recipe ended with here, where it was performed. */
async function shownRun(
  opened: Workspace,
  workspace: string,
  { id, run }: BundledRun,
  here: RunObservation | null,
): Promise<RerunRun> {
  const recorded = runEnd(run.observation);
  const tree = recordedTree(run);
  const rerun = here === null ? null : runEnd(here);
  return {
    receipt: id,
    command: run.recipe.command,
    tools: run.recipe.tooling ?? [],
    tree: tree === null ? null : { ...tree, here: await treeHere(run.recipe, opened.localDir, workspace) },
    recorded,
    rerun,
    outputMatches:
      rerun === null || rerun.output === null || recorded.output === null ? null : rerun.output === recorded.output,
  };
}

function statementAt(opened: Workspace, slot: string): string {
  return renderedTextOf((opened.index.claimAtSlot(slot)!.record as ClaimRecord).rendering);
}

/** Performs each receipt's recipe here and keeps the run, then asks the rule again over those. */
async function rederived(
  opened: Workspace,
  reopen: () => Promise<Workspace>,
  workspace: string,
  slot: string,
  receipts: readonly BundledRun[],
  now: () => Timestamp,
): Promise<Pick<RerunRule, "runs" | "rerun">> {
  const runs: RerunRun[] = [];
  for (const bundled of receipts) {
    const { recipe, observation } = await performRecipe(bundled.run.recipe, { localDir: opened.localDir, now });
    await opened.store.put("run", {
      kind: "run",
      schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
      runKind: "run",
      performer: RUNNER_PERFORMER,
      determinism: "nondeterministic",
      recipe,
      observation,
      supersedes: [],
    } satisfies RunRecord);
    runs.push(await shownRun(opened, workspace, bundled, observation));
  }
  return { runs, rerun: (await ruleVerdictHere(await reopen(), slot)).label };
}

function endText(end: RunEnd): string {
  return `exit ${end.exitCode} · output ${end.output === null ? "sealed" : end.output.slice(7, 19)}`;
}

function markOfVerdict(verdict: RerunRule["verdict"]): string {
  return verdict === "matches" ? markOf("holds") : verdict === "differs" ? markOf("fails") : "·";
}

function treeText(tree: NonNullable<RerunRun["tree"]>): string {
  const recorded = tree.recorded?.slice(0, 12) ?? "none";
  if (tree.here === null) {
    return `recorded ${recorded}, here unmeasured`;
  }
  return tree.here === tree.recorded
    ? `the tree the receipt read (${recorded})`
    : `another tree than the receipt read (recorded ${recorded}, here ${tree.here.slice(0, 12)})`;
}

function runLines(run: RerunRun): string[] {
  const tree = run.tree === null ? [] : [`  ${run.tree.name}: ${treeText(run.tree)}`];
  return [
    `  ${commandText(run.command)}${run.tools.length > 0 ? ` · tools ${run.tools.join(", ")}` : ""}`,
    ...tree,
    `  recorded ${endText(run.recorded)}`,
    ...(run.rerun === null
      ? []
      : [
          `  rerun    ${endText(run.rerun)}${run.outputMatches === false ? " · output differs, which a check does not judge" : ""}`,
        ]),
  ];
}

function ruleLines(rule: RerunRule): string[] {
  if (rule.verdict === "not-re-derivable") {
    return [`· ${rule.statement} (${rule.short}) · rule ${rule.rule} not re-derivable here: ${rule.why}`];
  }
  return [
    `${markOfVerdict(rule.verdict)} ${rule.statement} (${rule.short}) · ${rule.verdict}`,
    `  rule ${rule.rule}: recorded ${rule.recorded}${rule.rerun === null ? "" : `, rerun ${rule.rerun}`}`,
    ...rule.runs.flatMap(runLines),
  ];
}

function checkHeadline(claim: RerunClaim): string {
  const { recorded, rerun, matches } = claim.verdicts;
  if (claim.rerun === null) {
    return `${claim.verdict}, recorded ${recorded}`;
  }
  const codes =
    claim.verdict === "matches" ? `${claim.recorded.exitCode}` : `${claim.recorded.exitCode} → ${claim.rerun.exitCode}`;
  const verdicts = matches ? `both ${recorded === "holds" ? "hold" : "fail"}` : `${recorded} → ${rerun}`;
  return `exit code ${claim.verdict} (${codes}); verdict ${matches ? "matches" : "differs"} (${verdicts})`;
}

function signerText(signer: { readonly principal: string; readonly name: string | null }): string {
  return signer.name === null ? signer.principal : `${signer.name} (${signer.principal})`;
}

function renderRerunText(output: RerunOutput): string {
  const release =
    output.release === null
      ? "release: unchecked, the bundle names no audience"
      : `release: covered for ${output.release.audience}, signed by ${signerText(output.release.signer)}`;
  const claims = output.claims.flatMap((claim) => [
    `${markOfVerdict(claim.verdict)} ${claim.statement} (${claim.short}) · ${checkHeadline(claim)}`,
    ...runLines(claim),
  ]);
  const footer = output.performed ? [] : ["nothing ran: `musai rerun <bundle> --yes` performs each recipe above here"];
  return [release, ...claims, ...(output.rules ?? []).flatMap(ruleLines), ...footer].join("\n");
}

const VERDICT_SCHEMA = { enum: ["holds", "fails"] } as const;

const RUN_END_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["exitCode", "output"],
  properties: { exitCode: { type: "integer" }, output: { type: ["string", "null"] } },
} as const;

const RERUN_RUN_PROPERTIES = {
  receipt: { type: "string" },
  command: { type: "array", items: { type: "string" } },
  tools: { type: "array", items: { type: "string" } },
  tree: {
    oneOf: [
      { type: "null" },
      {
        type: "object",
        additionalProperties: false,
        required: ["name", "recorded", "here"],
        properties: {
          name: { type: "string" },
          recorded: { type: ["string", "null"] },
          here: { type: ["string", "null"] },
        },
      },
    ],
  },
  recorded: RUN_END_SCHEMA,
  rerun: { oneOf: [{ type: "null" }, RUN_END_SCHEMA] },
  outputMatches: { type: ["boolean", "null"] },
} as const;

const RERUN_RUN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: Object.keys(RERUN_RUN_PROPERTIES),
  properties: RERUN_RUN_PROPERTIES,
} as const;

const RERUN_CLAIM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [...Object.keys(RERUN_RUN_PROPERTIES), "statement", "short", "verdict", "verdicts"],
  properties: {
    ...RERUN_RUN_PROPERTIES,
    statement: { type: "string" },
    short: { type: "string" },
    verdict: { enum: ["matches", "differs", "not-run"] },
    verdicts: {
      type: "object",
      additionalProperties: false,
      required: ["recorded", "rerun", "matches"],
      properties: {
        recorded: VERDICT_SCHEMA,
        rerun: { enum: ["holds", "fails", null] },
        matches: { type: ["boolean", "null"] },
      },
    },
  },
} as const;

const RERUN_RULE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["statement", "short", "rule", "runs", "recorded", "rerun", "verdict", "why"],
  properties: {
    statement: { type: "string" },
    short: { type: "string" },
    rule: { type: "string" },
    runs: { type: "array", items: RERUN_RUN_SCHEMA },
    recorded: { enum: ["holds", "fails", null] },
    rerun: { enum: ["holds", "fails", "open", null] },
    verdict: { enum: ["matches", "differs", "not-run", "not-re-derivable"] },
    why: { type: ["string", "null"] },
  },
} as const;

export const RERUN_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["release", "performed", "claims"],
  properties: {
    release: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["audience", "covered", "signer"],
          properties: {
            audience: { type: "string" },
            covered: { const: true },
            signer: {
              type: "object",
              additionalProperties: false,
              required: ["principal", "name"],
              properties: { principal: { type: "string" }, name: { type: ["string", "null"] } },
            },
          },
        },
      ],
    },
    performed: { type: "boolean" },
    claims: { type: "array", items: RERUN_CLAIM_SCHEMA },
    rules: { type: "array", items: RERUN_RULE_SCHEMA },
  },
} as const;

/** `bundle.rerun@3`: a bundle checked as the verifier checks it, each recipe shown, and with `yes`
 * performed against this checkout in a scratch workspace that is removed after. */
export const bundleRerun: OperationDescriptor<RerunInput, RerunOutput> = {
  id: "bundle.rerun",
  version: versionString("3"),
  input: {
    type: "object",
    additionalProperties: false,
    required: ["bundle"],
    properties: {
      bundle: { type: "string", minLength: 1 },
      yes: { type: "boolean", description: "perform each recipe here; without it, rerun only shows them" },
    },
  },
  output: RERUN_OUTPUT_SCHEMA,
  effect: "performs",
  authority: null,
  plans: true,
  reasons: ["invalid-input", "record-corrupted", "not-authorised", "no-such-record"],
  documentation:
    "Checks a bundle's ids, signatures and release, shows each recipe it carries, and with yes performs them here and compares each with its receipt.",
  paths: ["bundle"],
  cli: {
    verb: "rerun",
    positional: ["bundle"],
    flags: ["yes"],
    describe: "check a bundle, show what it would run here, and with --yes run it and compare with its receipts",
  },
  renderText: renderRerunText,
  exitCode: (output) =>
    output.claims.some((claim) => claim.verdict === "differs") ||
    (output.rules ?? []).some((rule) => rule.verdict === "differs" || rule.verdict === "not-re-derivable")
      ? exitCodeForClass("unheld")
      : 0,
  async handler(input, context) {
    const files = await readBundle(input.bundle);
    if ((await resolveWorkTree(context.workspace)) === null) {
      throw outsideCheckout(context.workspace, files);
    }
    const { top } = await repositoryOf(context.workspace);
    const scratch = await mkdtemp(join(tmpdir(), "musai-rerun-"));
    try {
      await runHandler(workspaceInit, { workspace: scratch }, { ...context, workspace: scratch, mode: "perform" });
      const trust = Object.fromEntries(
        TRUST_FILES.flatMap((name) => {
          const bytes = files.get(name);
          return bytes === undefined ? [] : [[name, new TextDecoder().decode(bytes)]];
        }),
      );
      await writeMainFiles({ gitDir: join(scratch, MUSAI_DIR) }, trust, context.now);
      // The scratch holds only the bundle its caller handed in, so no clearance narrows it.
      const inScratch = { ...context, workspace: scratch, reportRefusal: undefined, clearance: undefined };
      const ids = await seeded(await openWorkspace(inScratch), files);
      const opened = await openWorkspace(inScratch);
      await refuseBadSignatures(opened, ids, files);
      const release = await releaseOf(opened, files);
      const claimed = bundledClaims(opened, ids);
      const found = receipts(claimed, await bundledRuns(opened, ids, top));
      const judged = await judgedClaims(opened, claimed, files);
      const image = [...found, ...judged.flatMap((claim) => claim.recorded?.runs ?? [])].find(({ run }) =>
        run.recipe.substrates.some(isContainerImageSubstrate),
      );
      if (image !== undefined) {
        throw new OperationError({
          reason: "invalid-input",
          about: [image.id],
          detail: `refusing to rerun ${image.id}: its recipe declares a container image, which rerun does not run`,
        });
      }
      const performed = input.yes === true && context.mode !== "plan";
      const claims: RerunClaim[] = [];
      for (const { slot, expected, run, id } of found) {
        const here = performed
          ? (await performRecipe(run.recipe, { localDir: opened.localDir, now: context.now })).observation
          : null;
        const shown = await shownRun(opened, context.workspace, { id, run }, here);
        const met = (end: RunEnd): "holds" | "fails" => (end.exitCode === expected ? "holds" : "fails");
        const recorded = met(shown.recorded);
        const rerun = shown.rerun === null ? null : met(shown.rerun);
        claims.push({
          statement: statementAt(opened, slot),
          short: shortIdOf(slot),
          ...shown,
          verdict:
            shown.rerun === null ? "not-run" : shown.rerun.exitCode === shown.recorded.exitCode ? "matches" : "differs",
          verdicts: { recorded, rerun, matches: rerun === null ? null : rerun === recorded },
        });
      }
      const rules: RerunRule[] = [];
      for (const claim of judged) {
        const named = { statement: statementAt(opened, claim.slot), short: shortIdOf(claim.slot), rule: claim.rule };
        if (claim.recorded === null) {
          rules.push({ ...named, runs: [], recorded: null, rerun: null, verdict: "not-re-derivable", why: claim.why });
          continue;
        }
        const { runs, rerun } = performed
          ? await rederived(
              opened,
              () => openWorkspace(inScratch),
              context.workspace,
              claim.slot,
              claim.recorded.runs,
              context.now,
            )
          : {
              runs: await Promise.all(claim.recorded.runs.map((run) => shownRun(opened, context.workspace, run, null))),
              rerun: null,
            };
        const verdict = rerun === null ? "not-run" : rerun === claim.recorded.label ? "matches" : "differs";
        rules.push({ ...named, runs, recorded: claim.recorded.label, rerun, verdict, why: null });
      }
      return { release, performed, claims, ...(rules.length === 0 ? {} : { rules }) };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
};
