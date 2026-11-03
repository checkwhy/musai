import { dirname } from "node:path";
import type { Workspace } from "@musai/api-core";
import {
  buildAdmissionWorkspace,
  checkRecipesOf,
  DECLARATIVE_RULE,
  givesPrincipalClass,
  installedModules,
  isOperationError,
  makerFirst,
  OperationError,
  readDeclarativeParameters,
  rulesNamedBy,
  verifiedAttestationFor,
  weighedRulingsFor,
} from "@musai/api-core";
import {
  type Argument,
  type AttackEdge,
  type CheckedAuthority,
  type ClaimStatus,
  deriveSiblingVerdicts,
  EVIDENCE_ORDER,
  type EvaluateClaim,
  type EvaluateRuling,
  type EvidenceHop,
  type EvidenceKind,
  evaluate,
  evidenceKindOf,
  type FloorRuling,
  holdingSibling,
  type Labelling,
  type RuleVerdict,
  type RulingAuthority,
  runRestartLoop,
  type SiblingClaim,
  type SiblingRuling,
  type Validity,
  validity,
  weakestLink,
} from "@musai/evaluate";
import type { IndexDb, IndexedClaim, IndexedContribution, IndexedRuling } from "@musai/fold";
import {
  firstAvailableHost,
  HOSTS,
  invocationLimitsFromSlots,
  invokerFromModuleHost,
  pointFor,
  readPresetDeclarations,
  readSlotDeclarations,
} from "@musai/modules";
import {
  ANY_SCOPE,
  type Audience,
  type ClaimRecord,
  type ComputedRunRecord,
  type EvidenceEdge,
  exactDecimal,
  type MadeAttestationRecord,
  type PerformedRunRecord,
  performedRun,
  type ReadEntry,
  type RecordId,
  type ResourceDescriptor,
  type RulingRecord,
  type RunRecord,
  recipeOfReadKey,
  renderSelector,
  type SlotLayers,
  type SlotRegistry,
  slotOfReadKey,
  type Timestamp,
} from "@musai/records";
import {
  BindingError,
  checkoutBindingsFor,
  movedSecretReads,
  namesTree,
  RunRefusedError,
  readBindings,
  resolveSubstrates,
  STATION_IMAGE_CONFIG_KEY,
  StationRefusedError,
  secretReadId,
  stationRecipe,
} from "@musai/run";
import { listKeys, readKeyFile } from "@musai/store";
import { briefClearanceOf } from "./brief/recipe.js";
import { type BriefLine, briefLines, lineReadIds, packedCheck } from "./brief/render.js";
import { cited, citedEvidence, type FoundCase, findCaseForClaim, standingCase } from "./cases.js";
import { CHECK_CLAIM_TYPE, claimSlotNamed, forkRemedy, shortIdOf, statusAdvice } from "./claim-ref.js";
import {
  type ConcludedCheck,
  checkEvaluation,
  concludedCheck,
  evaluationRecipe,
  type IndexedEvaluation,
  mintEvaluation,
  movedReads,
  recordedEvaluation,
} from "./evaluation.js";

/** The content ids a brief read, which stand as its ruling's evidence snapshot. */
export function contentIdsOf(reads: readonly ReadEntry[]): string[] {
  return reads
    .map((entry) => (entry.consumed.sha256 !== undefined ? `sha256:${entry.consumed.sha256}` : null))
    .filter((id): id is string => id !== null);
}

/** What a brief over this claim resting on `check` reads besides its case, with each attestation
 * of a testimony maker's class, so one landing later stales a ruling only if the kind moves. */
function briefReadsOf(opened: Workspace, claim: IndexedClaim, check: ConcludedCheck | null): string[] {
  const { direct, failing, attacking, withheld } = briefLines(
    opened,
    claim.id,
    claim.record as ClaimRecord,
    (target) => opened.index.argumentsAgainst(target),
    check,
  );
  return [
    claim.id,
    ...[...direct, ...failing, ...attacking].flatMap((line) => [
      ...lineReadIds(line),
      ...kindReads(opened, line, check),
    ]),
    ...withheld.map((attack) => attack.argument),
  ];
}

/** The checks one call performed, by claim, which the fold it reads does not hold yet. */
type PerformedChecks = ReadonlyMap<RecordId, ConcludedCheck | null>;

/** What `brief`, over `covered`, would read now under its clearance, its case included. */
function briefsReadNow(
  opened: Workspace,
  covered: readonly IndexedClaim[],
  briefCase: string | null,
  brief: ComputedRunRecord,
  performed: PerformedChecks,
): string[] {
  const clearance = briefClearanceOf(brief.recipe);
  const checkOf = (claim: IndexedClaim) => {
    const own = clearance === opened.clearance ? performed.get(claim.id) : undefined;
    return own === undefined ? concludedCheck(opened.index, claim.record as ClaimRecord, () => true, clearance) : own;
  };
  return [
    ...(briefCase === null ? [] : [briefCase]),
    ...covered.flatMap((claim) => briefReadsOf(opened, claim, checkOf(claim))),
  ];
}

function kindReads(opened: Workspace, line: BriefLine, check: ConcludedCheck | null): RecordId[] {
  // A check's receipt may be one this call performed, unfolded yet, and is never a testimony.
  if (check?.receipts.includes(line.run) || (opened.read(line.run) as RunRecord).runKind !== "testimony") {
    return [];
  }
  const giving = opened.index.attestationsBySubject(line.run).filter(({ record }) => givesPrincipalClass(record));
  const makerClass = makerFirst(giving)?.record.principalClass;
  return giving.filter(({ record }) => record.principalClass === makerClass).map(({ id }) => id);
}

/** The weight every evidence argument carries: an edge declares none, so edges compare by kind. */
export const EVIDENCE_ARGUMENT_WEIGHT = exactDecimal("1");

export interface LabelledClaim {
  readonly indexed: NonNullable<ReturnType<IndexDb["claimAtSlot"]>>;
  readonly status: ClaimStatus;
  readonly labelling: Labelling;
  readonly argumentsById: ReadonlyMap<string, Argument>;
  readonly runIdByArgumentId: ReadonlyMap<string, RecordId>;
  /** Every run `runIdByArgumentId` names, as this labelling read it. */
  readonly runs: ReadonlyMap<RecordId, PerformedRunRecord>;
  readonly rulingsById: ReadonlyMap<string, RulingRecord>;
  /** Every attestation behind each ruling; two principals agreeing on one ruling both appear. */
  readonly attestationsByRulingId: ReadonlyMap<string, readonly MadeAttestationRecord[]>;
  /** The rule that concluded the claim and the runs its conclusion rests on, the first deciding. */
  readonly concluded?: { readonly rule: IndexedContribution; readonly runs: readonly RecordId[] };
  /** Why the claim reads open, when its gate or its own check said why, or which sibling's
   * unrun check the ruling deciding it waits on. */
  readonly detail?: string;
  /** Read open without performing, its check judged by no evaluation here. */
  readonly unchecked?: true;
  /** Read without performing, the applicable check no evaluation by this installed rule judged. */
  readonly unevaluated?: { readonly rule: string };
  /** Read open on a contest this view withholds the grounds of, so no ruling on it decided. */
  readonly groundsWithheld?: true;
}

/** `perform` runs a claim's check; `recorded` reads it from the evaluation its brief packs,
 * invoking no rule; `none` leaves the check out and reports what is settled. */
export type Evaluation = "perform" | "recorded" | "none";

/** A ruling an attestation vouches for, with its checked authority and when it was made. */
export interface VouchedRuling extends IndexedRuling {
  readonly authority: CheckedAuthority;
  readonly decidedAt: Timestamp;
}

/** The rulings on a slot an attestation vouches for within the matrix, each marked by whether this
 * view holds the brief it rests on. */
async function rulingsVouchedOn(
  opened: Workspace,
  slot: string,
): Promise<readonly { readonly ruling: VouchedRuling; readonly briefHeld: boolean }[]> {
  const vouched: { ruling: VouchedRuling; briefHeld: boolean }[] = [];
  for (const ruling of await weighedRulingsFor(opened, slot)) {
    if (ruling.retiredBy === null && ruling.tier !== null) {
      vouched.push({
        ruling: { id: ruling.id, record: ruling.record, authority: ruling.tier, decidedAt: ruling.decidedAt! },
        briefHeld: cited(opened, ruling.record.brief),
      });
    }
  }
  return vouched;
}

/** The rulings on a slot an attestation vouches for within the matrix, on a brief this view
 * holds. */
export async function vouchedRulingsFor(opened: Workspace, slot: string): Promise<readonly VouchedRuling[]> {
  return (await rulingsVouchedOn(opened, slot)).filter(({ briefHeld }) => briefHeld).map(({ ruling }) => ruling);
}

/** The members of `group` that apply here; only these are on the menu. */
export function applyingMembers(opened: Workspace, group: string): readonly IndexedClaim[] {
  const knownClaimTypes = declaredClaimTypes(opened);
  return opened.index.claimsInGroup(group).filter((member) => {
    const record = member.record as ClaimRecord;
    return (
      applicabilityOf(opened, record, ruleNamedBy(opened, member.slot, record), knownClaimTypes).outcome === "valid"
    );
  });
}

/** A menu's members and the vouched rulings on those that apply, `held` being those on a brief
 * this view holds. */
interface GroupRulings {
  readonly group: string;
  readonly siblings: readonly SiblingClaim[];
  readonly every: readonly SiblingRuling[];
  readonly held: readonly SiblingRuling[];
}

async function groupRulings(opened: Workspace, group: string): Promise<GroupRulings> {
  const every: SiblingRuling[] = [];
  const held: SiblingRuling[] = [];
  for (const member of applyingMembers(opened, group)) {
    for (const { ruling, briefHeld } of await rulingsVouchedOn(opened, member.slot)) {
      const sibling: SiblingRuling = {
        id: ruling.id,
        claim: member.slot,
        authority: ruling.authority,
        decidedAt: ruling.decidedAt,
        verdict: ruling.record.verdict,
      };
      every.push(sibling);
      if (briefHeld) {
        held.push(sibling);
      }
    }
  }
  const siblings = opened.index.claimsInGroup(group).map((member) => ({ id: member.slot, exclusiveGroup: group }));
  return { group, siblings, every, held };
}

function restsOnWithheldGrounds(rulings: GroupRulings): boolean {
  return rulings.held.length < rulings.every.length;
}

/** The member of `group` its vouched rulings make hold, or `null`, weighed whether or not this view
 * holds their briefs, so no view can rule a second member into holding. */
export async function groupHolder(
  opened: Workspace,
  group: string,
): Promise<{ readonly slot: string; readonly groundsWithheld: boolean } | null> {
  const rulings = await groupRulings(opened, group);
  const holder = holdingSibling(group, rulings.siblings, rulings.every, opened.floor);
  return holder === null ? null : { slot: holder.member, groundsWithheld: restsOnWithheldGrounds(rulings) };
}

/** Whether a sibling of `ownSlot` holds as this view reads the menu: a ruling on grounds it does
 * not hold leaves none holding. */
function siblingHoldsElsewhere(menu: GroupRulings, ownSlot: string, floor: FloorRuling | null): boolean {
  return (
    !restsOnWithheldGrounds(menu) &&
    deriveSiblingVerdicts(menu.group, menu.siblings, menu.held, floor).some((entry) => entry.claim === ownSlot)
  );
}

/** Why nothing answers for a name; a superseded record id names its successors. */
export async function missingClaimDetail(opened: Workspace, named: string): Promise<string> {
  const successors = opened.index.successorsOf(named as RecordId);
  if (successors.length === 0) {
    return `no claim at slot: ${named}`;
  }
  const replacements = await Promise.all(
    successors.map(async ({ successor, kind }) => {
      if (kind !== "claim") {
        return `${successor}`;
      }
      const record = opened.read(successor) as ClaimRecord;
      return `${successor} at slot ${record.slot}`;
    }),
  );
  return `no claim at slot: ${named} — that record was superseded by ${replacements.join(", ")}`;
}

/** Whether a secret the runs read no longer resolves to its value. Only literal bindings resolve,
 * since a passive read must not spawn a helper; an unreadable workspace reads as moved. */
async function boundSecretsMoved(opened: Workspace, runs: readonly PerformedRunRecord[]): Promise<boolean> {
  const reads = new Set<string>();
  for (const run of runs) {
    for (const binding of run.observation.bindings) {
      if (binding.secret && binding.keyId !== null && binding.keyedHash !== null) {
        reads.add(secretReadId(binding.name, binding.keyId, binding.keyedHash));
      }
    }
  }
  if (reads.size === 0) {
    return false;
  }
  try {
    if ((await listKeys(opened.localDir)).length === 0) {
      return false;
    }
    const bindings = await readBindings(opened.localDir);
    const literal = new Map(
      Object.entries(bindings)
        .filter(([, source]) => source.value !== undefined)
        .map(([name, source]) => [name, source.value!]),
    );
    const file = await readKeyFile(opened.localDir);
    return movedSecretReads(file, reads, (name) => literal.get(name)).size > 0;
  } catch {
    return true;
  }
}

/** A working tree a run stood on that measures other than its receipt recorded. */
export interface TreeMovement {
  readonly name: string;
  readonly recorded: string | undefined;
  /** `undefined` where this machine cannot measure the tree. */
  readonly measured: string | undefined;
}

/** The tree a substrate names as it stands now; `undefined` where it cannot be measured here. */
export async function measureTreeNow(opened: Workspace, declared: ResourceDescriptor): Promise<string | undefined> {
  try {
    const checkouts = await checkoutBindingsFor([declared], opened.localDir);
    const [resolved] = await resolveSubstrates([declared], checkouts, [dirname(opened.localDir)]);
    return resolved?.digest?.gitTree;
  } catch (error) {
    if (!(error instanceof RunRefusedError || error instanceof BindingError)) {
      throw error;
    }
    return undefined;
  }
}

/** A tree's measurement for each opened workspace a read without performing serves, which writes
 * nothing into the tree, so every claim it labels is read against one moment. */
const measuredForReads = new WeakMap<Workspace, Map<string, Promise<string | undefined>>>();

export function measureTreeOnce(opened: Workspace, declared: ResourceDescriptor): Promise<string | undefined> {
  const measured = measuredForReads.get(opened) ?? new Map<string, Promise<string | undefined>>();
  measuredForReads.set(opened, measured);
  const key = declared.name!;
  const measurement = measured.get(key) ?? measureTreeNow(opened, declared);
  measured.set(key, measurement);
  return measurement;
}

/** The first working tree under the runs that moved, as `measure` reads it; `null` when every one
 * measures what its receipt recorded. */
export async function treeMovement(
  opened: Workspace,
  runs: readonly PerformedRunRecord[],
  measure: (opened: Workspace, declared: ResourceDescriptor) => Promise<string | undefined>,
): Promise<TreeMovement | null> {
  for (const run of runs) {
    for (const [position, declared] of run.recipe.substrates.entries()) {
      if (!namesTree(declared)) {
        continue;
      }
      const recorded = run.observation.resolved[position]?.digest?.gitTree;
      const measured = await measure(opened, declared);
      if (measured !== recorded) {
        return { name: declared.name!, recorded, measured };
      }
    }
  }
  return null;
}

function describeMovement({ name, recorded, measured }: TreeMovement): string {
  return `the working tree \`${name}\` moved: its receipt recorded ${recorded}, and it measures ${measured ?? "as nothing this machine can read"}`;
}

/** What moved under the reads of the evaluation judging `slot`, or `null` where nothing did. */
function describeReadMove(index: IndexDb, evaluation: IndexedEvaluation, slot: string): string | null {
  const moved = movedReads(index, evaluation);
  if (moved.length === 0) {
    return null;
  }
  if (moved.some((read) => slotOfReadKey(read.key) === slot)) {
    return "this claim changed since its check was evaluated";
  }
  return moved.some((read) => recipeOfReadKey(read.key) !== undefined)
    ? "a newer receipt landed for a recipe this check's evaluation read"
    : "a record this check's evaluation read holds another now";
}

/** Answers a need from the latest receipt whose working trees measure what it recorded, else the
 * latest, never spawning: what a rerun's verdict over recorded receipts rests on. */
function recordedReceipt(opened: Workspace): (recipe: unknown, recipeId: RecordId) => Promise<RecordId> {
  return async (_recipe, recipeId) => {
    const receipts = opened.index.receiptsByRecipe(recipeId);
    if (receipts.length === 0) {
      throw new RunRefusedError("no receipt of this recipe is held here, and a verdict over receipts runs nothing");
    }
    for (const receipt of receipts) {
      if ((await treeMovement(opened, [performedRun(receipt.recordId, receipt.record)], measureTreeOnce)) === null) {
        return receipt.recordId;
      }
    }
    return receipts[0]!.recordId;
  };
}

/** Whether a claim applies here: its type declared, its conditions inside its rule's scope. A
 * claim-type declaration carries no signing field, so none requires a signature. */
function applicabilityOf(
  opened: Workspace,
  record: ClaimRecord,
  named: IndexedContribution | null,
  knownClaimTypes: ReadonlySet<string>,
): Validity {
  return validity(
    {
      claimType: record.type,
      signed: false,
      rule: named === null ? {} : (opened.index.ruleFor(named.entry.id)?.record.scope ?? {}),
      conditions: record.conditions,
      dimensions: opened.dimensions,
      contribution: named === null ? null : named.entry.id,
    },
    "optional",
    { knownClaimTypes, requiresSignatureFor: () => false },
  );
}

function declaredClaimTypes(opened: Workspace): ReadonlySet<string> {
  return new Set(opened.claimTypes.keys());
}

/** Whether the claim at `slot` applies here, decided as `labelledClaim` decides it. */
export function applicabilityAt(opened: Workspace, slot: string, record: ClaimRecord): Validity {
  return applicabilityOf(opened, record, ruleNamedBy(opened, slot, record), declaredClaimTypes(opened));
}

/** The strongest of a claim's supporting kinds; a claim with no support stands at the weakest. */
function strongestEvidenceKind(kinds: readonly EvidenceKind[]): EvidenceKind {
  const floor = EVIDENCE_ORDER[EVIDENCE_ORDER.length - 1]!;
  return kinds.reduce<EvidenceKind>(
    (best, kind) => (EVIDENCE_ORDER.indexOf(kind) < EVIDENCE_ORDER.indexOf(best) ? kind : best),
    floor,
  );
}

/** The installed rule a claim's conditions name, or `null`: naming one makes the claim a check. */
function ruleNamedBy(opened: Workspace, slot: string, record: ClaimRecord): IndexedContribution | null {
  const named = rulesNamedBy(opened.index, record.conditions);
  if (named.length > 1) {
    throw new OperationError({
      reason: "invalid-input",
      about: [slot],
      detail: `claim ${slot} names more than one rule in its conditions, so nothing decides which settles it: ${named
        .map((found) => found.entry.id)
        .join(", ")}`,
    });
  }
  return named[0] ?? null;
}

export interface IndexedRun {
  readonly id: RecordId;
  readonly record: PerformedRunRecord;
}

interface CheckOutcome {
  readonly verdict: RuleVerdict;
  readonly runs: readonly IndexedRun[];
}

/** A check's slot layering: its case's preset and booking overrides, or none without a case. */
function layersFor(opened: Workspace, slotRegistry: SlotRegistry, owningCase: FoundCase | null): SlotLayers {
  if (owningCase === null) {
    return {};
  }
  const presetRegistry = readPresetDeclarations(opened.index, slotRegistry);
  return {
    preset: presetRegistry.get(owningCase.record.preset.contribution)?.assignments,
    booking: owningCase.record.overrides,
  };
}

/** Drives a check's rule through the restart loop with one host loaded for every round, minting a
 * performed evaluation. Only run and fetch receipts return, since only those rank as evidence. */
async function performCheck(
  opened: Workspace,
  claim: IndexedClaim,
  record: ClaimRecord,
  contribution: IndexedContribution,
  owningCase: FoundCase | null,
  perform: boolean,
  runTimeoutMs?: number,
): Promise<CheckOutcome> {
  const point = pointFor(contribution.entry.kind, opened.index);
  if (point === undefined) {
    throw new OperationError({
      reason: "no-such-record",
      about: [contribution.entry.id, contribution.entry.kind],
      detail: `the workspace holds no point named ${contribution.entry.kind}, the kind contribution ${contribution.entry.id} names`,
    });
  }
  const hostDescriptor = await firstAvailableHost(HOSTS);
  if (hostDescriptor === undefined) {
    throw new OperationError({
      reason: "no-such-record",
      about: [contribution.entry.id],
      detail: "this machine provides no host this kernel can invoke a contribution through",
    });
  }
  const installed = await installedModules(opened);
  const admission = await buildAdmissionWorkspace(opened, installed);
  const slotRegistry = readSlotDeclarations(opened.index);
  // The workspace's tools widen what a check's own recipe may spawn, never what a pack's rule may.
  const requirementRegistry =
    record.type === CHECK_CLAIM_TYPE && contribution.entry.id === DECLARATIVE_RULE
      ? opened.checkRequirements()
      : opened.requirements();
  const host = hostDescriptor.create();
  const performed = opened.store.held();
  try {
    const slotLayers = layersFor(opened, slotRegistry, owningCase);
    // The one slot a check resolves with the project layer too: the bound on every invocation.
    const invocationLimits = invocationLimitsFromSlots(slotRegistry, { ...slotLayers, project: opened.projectSlots });
    const loaded = await host.load(admission.modulePath(contribution.moduleName), "invoke");
    const result = await runRestartLoop({
      invoker: invokerFromModuleHost(
        host,
        loaded,
        {
          id: contribution.entry.id,
          version: contribution.entry.version,
          entry: contribution.entry,
          point,
        },
        invocationLimits,
      ),
      input: { claimId: claim.slot, conditions: record.conditions, evidence: [] },
      claim: claim.id,
      store: performed,
      index: opened.index,
      modulePath: admission.modulePath,
      localDir: opened.localDir,
      layerDeclarations: opened.layerDeclarations,
      fetchStore: opened.fetchStore,
      slotRegistry,
      requirementRegistry,
      slotLayers,
      invocationLimits,
      runTimeoutMs,
      now: opened.now,
      station: opened.station,
      ...(perform
        ? {}
        : {
            performRun: recordedReceipt(opened),
            performFetchNeed: recordedReceipt(opened),
            stationRefusalsAnswer: true,
          }),
    }).catch(async (error: unknown) => {
      // What the loop paid for lands where it can; the loop's own failure is the one reported.
      await performed.land([]).catch(() => undefined);
      throw error;
    });
    if (perform) {
      await mintEvaluation(
        opened,
        performed,
        evaluationRecipe(contribution, claim.slot, opened.clearance),
        result.readSet,
        result.verdict,
      );
    }
    // As the loop read them from the store: it mints its receipts below the layer that folds.
    const runs = result.receipts
      .filter((entry) => entry.need === "run" || entry.need === "fetch")
      .map((entry) => ({ id: entry.id, record: result.runs.get(entry.id)! }));
    return { verdict: result.verdict, runs };
  } finally {
    await host.close?.();
  }
}

function recordsOf(runs: readonly IndexedRun[]): PerformedRunRecord[] {
  return runs.map((run) => run.record);
}

/** A check an evaluation decided, its receipts read back with no rule invoked. */
async function checkFromEvaluation(opened: Workspace, evaluation: IndexedEvaluation): Promise<CheckOutcome> {
  const { verdict, receipts } = recordedEvaluation(evaluation);
  const runs: IndexedRun[] = [];
  for (const id of receipts) {
    runs.push({ id, record: performedRun(id, (await opened.store.read(id, "run")) as RunRecord) });
  }
  return { verdict, runs };
}

/** A check no evaluation under this view's clearance has judged, read with no rule invoked. */
function unevaluatedCheck(opened: Workspace, record: ClaimRecord): CheckOutcome {
  return {
    verdict: { kind: "verdict", label: "open", reason: unevaluatedReason(opened, record) },
    runs: [],
  };
}

/** Where a station would refuse a recipe the check names, its refusal, which names the fix. */
function unevaluatedReason(opened: Workspace, record: ClaimRecord): string {
  const { station } = opened;
  if (station === undefined) {
    return "nothing has evaluated this check here yet; `status` evaluates it";
  }
  if (station.image === undefined) {
    const recipes = checkRecipesOf(readDeclarativeParameters(record.conditions));
    for (const recipe of recipes) {
      try {
        stationRecipe(recipe, station);
      } catch (error) {
        if (error instanceof StationRefusedError) {
          return error.message;
        }
        throw error;
      }
    }
    if (recipes.length === 0) {
      return `nothing has evaluated this check under the clearance ${station.clearance} yet, and the trust branch's configuration names no ${STATION_IMAGE_CONFIG_KEY}, so \`status\` under it runs only a recipe declaring its own image`;
    }
  }
  return `nothing has evaluated this check here yet; \`status\` under the clearance ${station.clearance} evaluates it`;
}

/** The case citing a claim, or `null` where none does, cases under two slugs do, or two cases of
 * a forked slug do, since nothing says whose booking a check layers. */
async function owningCaseOf(opened: Workspace, claim: RecordId): Promise<FoundCase | null> {
  try {
    return await findCaseForClaim(opened, claim);
  } catch (error) {
    if (!isOperationError(error)) {
      throw error;
    }
    return null;
  }
}

/** What the rule judging the check at `slot` concludes over the receipts held here, spawning
 * nothing, with the runs it rested on. */
export async function recordedRuleVerdict(
  opened: Workspace,
  slot: string,
): Promise<{ readonly verdict: RuleVerdict; readonly runs: readonly IndexedRun[] }> {
  const indexed = opened.index.claimAtSlot(slot)!;
  const record = indexed.record as ClaimRecord;
  const rule = ruleNamedBy(opened, slot, record)!;
  return performCheck(opened, indexed, record, rule, await owningCaseOf(opened, indexed.id), false);
}

/** A claim's check as `labelledClaim` reads it. */
interface ReadCheck {
  readonly rule: IndexedContribution;
  readonly outcome: CheckOutcome;
  /** What moved under the evaluation a read without performing answers from. */
  readonly moved: string | null;
  readonly unevaluated: boolean;
  readonly performed: boolean;
}

/** A claim found by name, whether it applies here, and its check where one is read. */
interface CheckedClaim {
  readonly slot: string;
  readonly indexed: LabelledClaim["indexed"];
  readonly gate: Validity;
  readonly check: ReadCheck | null;
  /** The slot's live contributors where they are judged differently, so no check is read. */
  readonly fork: readonly IndexedClaim[];
}

async function checkedClaim(
  opened: Workspace,
  claimName: string,
  evaluation: Evaluation,
  runTimeoutMs: number | undefined,
): Promise<CheckedClaim> {
  const slot = claimSlotNamed(opened.index, claimName);
  const indexed = opened.index.claimAtSlot(slot);
  if (!indexed) {
    throw new OperationError({
      reason: "no-such-record",
      about: [slot],
      detail: await missingClaimDetail(opened, slot),
    });
  }
  if (indexed.record.kind !== "claim") {
    throw new OperationError({
      reason: "no-such-record",
      about: [slot],
      detail: `indexed record at slot ${slot} is not a claim`,
    });
  }

  // A check's run layers through the case.
  const owningCase = await owningCaseOf(opened, indexed.id);

  // Applicability comes first; an inapplicable claim runs no check but still gets its graph.
  const named = ruleNamedBy(opened, slot, indexed.record);
  const gate = applicabilityOf(opened, indexed.record, named, declaredClaimTypes(opened));
  const fork = opened.index.forkAtSlot(slot);
  const found = { slot, indexed, gate, fork };
  const rule = evaluation !== "none" && gate.outcome === "valid" && fork.length === 0 ? named : null;
  if (rule === null) {
    return { ...found, check: null };
  }
  const read = { rule, moved: null, unevaluated: false, performed: false };
  if (evaluation === "perform") {
    const outcome = await performCheck(opened, indexed, indexed.record, rule, owningCase, true, runTimeoutMs);
    return { ...found, check: { ...read, outcome, performed: true } };
  }
  const recorded = checkEvaluation(opened.index, indexed.record, () => true, opened.clearance)?.evaluation;
  if (recorded === undefined) {
    return { ...found, check: { ...read, outcome: unevaluatedCheck(opened, indexed.record), unevaluated: true } };
  }
  const outcome = await checkFromEvaluation(opened, recorded);
  return { ...found, check: { ...read, outcome, moved: await evaluationMove(opened, recorded, outcome, slot) } };
}

/** What moved under an evaluation's reads or the trees under its receipts, or `null`. */
async function evaluationMove(
  opened: Workspace,
  evaluation: IndexedEvaluation,
  outcome: CheckOutcome,
  slot: string,
): Promise<string | null> {
  const movement = await treeMovement(opened, recordsOf(outcome.runs), measureTreeOnce);
  return movement === null ? describeReadMove(opened.index, evaluation, slot) : describeMovement(movement);
}

/** What moved under the evaluation a brief over `claim` under `clearance` packs now, or `null`
 * where nothing did or the claim does not apply here, so `status` runs no check of it. */
export async function briefedEvaluationMove(
  opened: Workspace,
  claim: ClaimRecord,
  clearance: Audience | undefined,
): Promise<string | null> {
  if (applicabilityAt(opened, claim.slot, claim).outcome !== "valid") {
    return null;
  }
  const recorded = checkEvaluation(opened.index, claim, () => true, clearance)?.evaluation;
  return recorded === undefined
    ? null
    : evaluationMove(opened, recorded, await checkFromEvaluation(opened, recorded), claim.slot);
}

/** The claim a brief was rendered for, where this view holds it. */
export function briefedClaim(opened: Workspace, brief: ComputedRunRecord): ClaimRecord | undefined {
  const asked = brief.recipe.command[1];
  const record = asked === undefined ? undefined : opened.index.recordById(asked as RecordId)?.record;
  return record?.kind === "claim" ? record : undefined;
}

/** The menu sibling a brief was rendered for, packing its concluded check, whose check, applying
 * here, no evaluation by its rule's installed build has judged since, nor this call performed. */
async function unevaluatedSibling(
  opened: Workspace,
  slot: string,
  covered: readonly IndexedClaim[],
  brief: ComputedRunRecord,
  performed: PerformedChecks,
): Promise<IndexedClaim | null> {
  const briefed = briefedClaim(opened, brief);
  if (briefed === undefined) {
    return null;
  }
  const sibling = covered.find((member) => member.slot !== slot && member.slot === briefed.slot);
  if (sibling === undefined) {
    return null;
  }
  const record = sibling.record as ClaimRecord;
  const clearance = briefClearanceOf(brief.recipe);
  if (
    (clearance === opened.clearance && performed.has(sibling.id)) ||
    ruleNamedBy(opened, sibling.slot, record) === null ||
    applicabilityAt(opened, sibling.slot, record).outcome !== "valid"
  ) {
    return null;
  }
  if (checkEvaluation(opened.index, record, () => true, clearance) !== null) {
    return null;
  }
  return (await packedCheck(opened, brief, briefed)) === null ? null : sibling;
}

/** A claim's status as `evaluate` computes it, and the graph behind it; a run outliving
 * `runTimeoutMs` ends the call. */
export async function labelledClaim(
  opened: Workspace,
  claimName: string,
  evaluation: Evaluation,
  runTimeoutMs?: number,
): Promise<LabelledClaim> {
  const [labelled] = await labelledClaims(opened, [claimName], evaluation, runTimeoutMs);
  return labelled!;
}

/** Each claim's status as `labelledClaim` computes it, every check read before any is labelled,
 * so a ruling over a sibling's brief reads what that sibling's check performed in this call. */
export async function labelledClaims(
  opened: Workspace,
  claimNames: readonly string[],
  evaluation: Evaluation,
  runTimeoutMs?: number,
): Promise<LabelledClaim[]> {
  const checked: CheckedClaim[] = [];
  for (const name of claimNames) {
    checked.push(await checkedClaim(opened, name, evaluation, runTimeoutMs));
  }
  const performed = new Map<RecordId, ConcludedCheck | null>();
  for (const { indexed, check } of checked) {
    if (check?.performed) {
      const receipts = check.outcome.runs.map((run) => run.id);
      const { label } = check.outcome.verdict;
      performed.set(indexed.id, label === "open" ? null : { rule: check.rule.entry.id, verdict: label, receipts });
    }
  }
  const labelled: LabelledClaim[] = [];
  for (const claim of checked) {
    labelled.push(await labelChecked(opened, claim, performed));
  }
  return labelled;
}

async function labelChecked(
  opened: Workspace,
  { slot, indexed, gate, check: read, fork }: CheckedClaim,
  performed: PerformedChecks,
): Promise<LabelledClaim> {
  const applicable = gate.outcome === "valid";
  const moved = read?.moved ?? null;

  // Supporting nodes are kept apart: an attacker counted as support would vouch for its target.
  const argumentsById = new Map<string, Argument>();
  const attacks: AttackEdge[] = [];
  const supportingIds: string[] = [];
  const runIdByArgumentId = new Map<string, RecordId>();
  const runs = new Map<RecordId, PerformedRunRecord>();
  // The nodes each run grounds, a support or a failing check's attack, and a challenge to it hits.
  const groundedByRun = new Map<RecordId, string[]>();

  const supportingRuns: PerformedRunRecord[] = [];

  /** Registers an edge as a node, or `null` where its run has no kind the ladder ranks. */
  async function nodeForEdge(edge: EvidenceEdge, supporting: boolean): Promise<string | null> {
    const run = performedRun(edge.run, opened.read(edge.run) as RunRecord);
    if (supporting) {
      supportingRuns.push(run);
    }
    const attestation = await verifiedAttestationFor(opened, edge.run);
    let evidenceKind: Argument["evidenceKind"];
    try {
      evidenceKind = evidenceKindOf(run, attestation);
    } catch {
      return null;
    }
    const argumentId = `${edge.run}#${renderSelector(edge.selector)}`;
    runIdByArgumentId.set(argumentId, edge.run);
    runs.set(edge.run, run);
    argumentsById.set(argumentId, {
      id: argumentId,
      evidenceKind,
      scope: ANY_SCOPE,
      declaredWeight: EVIDENCE_ARGUMENT_WEIGHT,
    });
    return argumentId;
  }

  let openCheckReason: string | undefined;
  let concluded: LabelledClaim["concluded"];
  // A rule concludes once, so its verdict is one node that falls with any receipt under it.
  if (read !== null) {
    const { rule, outcome: check } = read;
    if (check.verdict.label === "open") {
      openCheckReason = check.verdict.reason;
    }
    const holds = check.verdict.label === "holds";
    if (holds || check.verdict.label === "fails") {
      // A shape no selector renders, so this node never merges with a stored edge's node.
      const node = `${indexed.id}#rule:${rule.entry.id}`;
      const grounds: EvidenceHop[] = [];
      for (const { id: runId, record: run } of check.runs) {
        const attestation = await verifiedAttestationFor(opened, runId);
        try {
          grounds.push({ id: runId, kind: evidenceKindOf(run, attestation) });
        } catch {
          continue;
        }
        if (holds) {
          supportingRuns.push(run);
        }
        groundedByRun.set(runId, [...(groundedByRun.get(runId) ?? []), node]);
      }
      const decidedBy = check.runs[0];
      if (grounds.length > 0 && decidedBy !== undefined) {
        argumentsById.set(node, {
          id: node,
          evidenceKind: weakestLink(grounds).kind,
          scope: ANY_SCOPE,
          declaredWeight: EVIDENCE_ARGUMENT_WEIGHT,
        });
        // A derivation walks from a node to one run: the first recipe the rule named.
        runIdByArgumentId.set(node, decidedBy.id);
        runs.set(decidedBy.id, decidedBy.record);
        concluded = { rule, runs: check.runs.map((run) => run.id) };
        if (holds) {
          supportingIds.push(node);
        } else {
          attacks.push({ attacker: node, target: slot });
        }
      }
    }
  }

  for (const edge of citedEvidence(opened, opened.index.evidenceEdgesOf(slot))) {
    const argumentId = await nodeForEdge(edge, true);
    if (argumentId === null) {
      // A claim's own unrankable evidence is an error, not something to pass over.
      const run = opened.read(edge.run) as RunRecord;
      const attestation = await verifiedAttestationFor(opened, edge.run);
      try {
        evidenceKindOf(run, attestation);
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        throw new Error(`claim ${slot}: run ${edge.run} has no evidence kind: ${cause}`);
      }
      continue;
    }
    supportingIds.push(argumentId);
    groundedByRun.set(edge.run, [...(groundedByRun.get(edge.run) ?? []), argumentId]);
  }

  // An argument or a ruling resting on a record withheld here contests the claim unseen.
  let groundsWithheld = false;

  /** The nodes an argument's held edges attack with; a withheld edge contests unseen. */
  async function attackersOf(evidence: readonly EvidenceEdge[]): Promise<string[]> {
    const held = citedEvidence(opened, evidence);
    groundsWithheld ||= held.length < evidence.length;
    const attackers: string[] = [];
    for (const edge of held) {
      const attacker = await nodeForEdge(edge, false);
      if (attacker !== null) {
        attackers.push(attacker);
      }
    }
    return attackers;
  }

  // An attack on the claim fails it; one on a run only removes what that run grounds.
  for (const argument of opened.index.argumentsAgainst(indexed.id)) {
    for (const attacker of await attackersOf(argument.record.evidence)) {
      attacks.push({ attacker, target: slot });
    }
  }
  for (const [runId, grounded] of groundedByRun) {
    for (const argument of opened.index.argumentsAgainst(runId)) {
      for (const attacker of await attackersOf(argument.record.evidence)) {
        for (const target of grounded) {
          attacks.push({ attacker, target });
        }
      }
    }
  }

  // The claim stands as its best evidence, read off the evidence and never declared by the claim.
  argumentsById.set(slot, {
    id: slot,
    evidenceKind: strongestEvidenceKind(supportingIds.map((id) => argumentsById.get(id)!.evidenceKind)),
    scope: ANY_SCOPE,
    declaredWeight: EVIDENCE_ARGUMENT_WEIGHT,
  });

  // A menu's brief covers every member, so each member's ruling pins what that brief read.
  const group = (indexed.record as ClaimRecord).exclusiveGroup;
  const menu = group === null ? null : await groupRulings(opened, group);
  if (menu !== null) {
    groundsWithheld ||= restsOnWithheldGrounds(menu);
  }
  const covered =
    menu === null
      ? [indexed]
      : [indexed, ...opened.index.claimsInGroup(menu.group).filter(({ id }) => id !== indexed.id)];

  const rulingsById = new Map<string, RulingRecord>();
  const attestationsByRulingId = new Map<string, readonly MadeAttestationRecord[]>();
  const rulings: EvaluateRuling[] = [];
  const unrunSiblings = new Map<string, string>();
  let hasUnvouchedRuling = false;
  for (const indexedRuling of await weighedRulingsFor(opened, slot)) {
    if (indexedRuling.retiredBy !== null) {
      continue;
    }
    rulingsById.set(indexedRuling.id, indexedRuling.record);

    // A ruling names no principal; who, when and through which channel live on its attestation.
    const attestations = indexedRuling.attestations;
    attestationsByRulingId.set(indexedRuling.id, attestations);
    const primary = attestations[0] ?? null;
    if (indexedRuling.tier === null) {
      // Nothing within the matrix vouches for it, so it decides nothing and the claim is contested.
      hasUnvouchedRuling = true;
      continue;
    }
    if (!cited(opened, indexedRuling.record.brief)) {
      groundsWithheld = true;
      continue;
    }

    const briefRun = opened.read(indexedRuling.record.brief) as ComputedRunRecord;
    const unrun = await unevaluatedSibling(opened, slot, covered, briefRun, performed);
    if (unrun !== null) {
      const short = shortIdOf(unrun.slot);
      const advice = statusAdvice(unrun.slot, briefClearanceOf(briefRun.recipe), opened.clearance);
      unrunSiblings.set(
        indexedRuling.id,
        `decided on a brief over ${short}, whose check has not run since its rule was rebuilt; ${advice} evaluates it`,
      );
    }
    const briefReads = contentIdsOf(briefRun.observation.reads);
    rulings.push({
      id: indexedRuling.id,
      claim: slot,
      principal: primary!.principal,
      principalClass: primary!.principalClass,
      scope: ANY_SCOPE,
      // An attestation yields person or delegate only, never the floor's tier.
      authority: indexedRuling.tier as RulingAuthority,
      decidedAt: primary!.at,
      verdict: indexedRuling.record.verdict,
      briefReads,
      // A station and its author each evaluate under their own recipe, so each brief pins its own.
      currentIds: briefsReadNow(opened, covered, standingCase(opened, indexed.id, briefReads), briefRun, performed),
    });
  }

  const claim: EvaluateClaim = {
    id: slot,
    applicable,
    overBudget: false,
    stale: moved !== null || (await boundSecretsMoved(opened, supportingRuns)),
    forked: fork.length > 0,
    supportingArgumentIds: supportingIds,
  };
  const { statuses, labelling } = evaluate({
    claims: [claim],
    arguments: argumentsById,
    attacks,
    rulings,
    matrix: opened.matrix,
    floor: opened.floor,
  });

  // An unvouched ruling or a contest on withheld grounds leaves the claim open, whatever it cites.
  let status: ClaimStatus =
    (hasUnvouchedRuling || groundsWithheld) && applicable && fork.length === 0
      ? { label: "open", reason: "contested-authority", comparison: statuses[0]!.status.comparison }
      : statuses[0]!.status;

  // A menu member with no decision of its own fails once a sibling holds.
  if (status.label === "open" && applicable && menu !== null && siblingHoldsElsewhere(menu, slot, opened.floor)) {
    status = { label: "fails", comparison: status.comparison };
  }
  const withheldDetail = groundsWithheld
    ? `contested on grounds withheld under the clearance ${opened.clearance}`
    : undefined;
  const forkDetail =
    fork.length > 0
      ? `its live claims ${fork.map(({ id }) => shortIdOf(id)).join(", ")} are judged differently; ${forkRemedy(fork[0]!.type)}`
      : undefined;
  const detail = forkDetail ?? (gate.outcome === "valid" ? (withheldDetail ?? moved ?? openCheckReason) : gate.reason);
  const staleDetail =
    status.label !== "open" && status.decidedOnStaleEvidence ? unrunSiblings.get(status.comparison.winner) : undefined;

  return {
    indexed,
    status,
    labelling,
    argumentsById,
    runIdByArgumentId,
    runs,
    rulingsById,
    attestationsByRulingId,
    ...(concluded === undefined ? {} : { concluded }),
    ...(status.label === "open" && detail !== undefined ? { detail } : {}),
    ...(staleDetail === undefined ? {} : { detail: staleDetail }),
    ...(status.label === "open" && read?.unevaluated ? { unchecked: true } : {}),
    ...(read?.unevaluated ? { unevaluated: { rule: read.rule.entry.id } } : {}),
    ...(status.label === "open" && groundsWithheld && applicable ? { groundsWithheld: true } : {}),
  };
}

/** The run a claim's status rests on, or `null` where a ruling, the floor or nothing decided it. */
export function decidingRun(labelled: LabelledClaim): IndexedRun | null {
  const id = labelled.runIdByArgumentId.get(labelled.status.comparison.winner);
  return id === undefined ? null : { id, record: labelled.runs.get(id)! };
}
