import { dirname } from "node:path";
import type { Workspace } from "@musai/api-core";
import {
  buildAdmissionWorkspace,
  DECLARATIVE_RULE,
  installedModules,
  isOperationError,
  OperationError,
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
  type ClaimRecord,
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
  renderSelector,
  type SlotLayers,
  type SlotRegistry,
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
  secretReadId,
} from "@musai/run";
import { listKeys, readKeyFile } from "@musai/store";
import { briefLines, lineReadIds } from "./brief/render.js";
import { citedEvidence, type FoundCase, findCaseForClaim } from "./cases.js";
import { CHECK_CLAIM_TYPE, claimSlotNamed } from "./claim-ref.js";
import {
  evaluationMoved,
  evaluationRecipe,
  type IndexedEvaluation,
  latestEvaluation,
  mintEvaluation,
  recordedEvaluation,
} from "./evaluation.js";

/** The content ids a brief read, which stand as its ruling's evidence snapshot. */
export function contentIdsOf(reads: readonly ReadEntry[]): string[] {
  return reads
    .map((entry) => (entry.consumed.sha256 !== undefined ? `sha256:${entry.consumed.sha256}` : null))
    .filter((id): id is string => id !== null);
}

/** What a brief over this claim reads besides its case: the set `renderBrief` packs. */
function briefReadsOf(opened: Workspace, claim: IndexedClaim): string[] {
  const { direct, attacking } = briefLines(
    opened,
    claim.record as ClaimRecord,
    opened.index.argumentsAgainst(claim.id),
  );
  return [claim.id, ...[...direct, ...attacking].flatMap(lineReadIds)];
}

/** The weight every evidence argument carries: an edge declares none, so edges compare by kind. */
export const EVIDENCE_ARGUMENT_WEIGHT = exactDecimal("1");

export interface LabelledClaim {
  readonly indexed: NonNullable<ReturnType<IndexDb["claimAtSlot"]>>;
  readonly status: ClaimStatus;
  readonly labelling: Labelling;
  readonly argumentsById: ReadonlyMap<string, Argument>;
  readonly runIdByArgumentId: ReadonlyMap<string, RecordId>;
  readonly rulingsById: ReadonlyMap<string, RulingRecord>;
  /** Every attestation behind each ruling; two principals agreeing on one ruling both appear. */
  readonly attestationsByRulingId: ReadonlyMap<string, readonly MadeAttestationRecord[]>;
  /** The rule that concluded the claim and the runs its conclusion rests on, the first deciding. */
  readonly concluded?: { readonly rule: IndexedContribution; readonly runs: readonly RecordId[] };
  /** Why the claim reads open, when its gate or its own check said why. */
  readonly detail?: string;
  /** Read open without performing, its check naming a recipe nothing has run here. */
  readonly unchecked?: true;
}

/** `perform` runs a claim's check; `recorded` evaluates it against the latest receipts, spawning
 * nothing; `none` leaves the check out and reports what is settled. */
export type Evaluation = "perform" | "recorded" | "none";

/** A ruling an attestation vouches for, with its checked authority and when it was made. */
export interface VouchedRuling extends IndexedRuling {
  readonly authority: CheckedAuthority;
  readonly decidedAt: Timestamp;
}

/** The rulings on a slot an attestation vouches for within the matrix. Every reader of a slot
 * uses this, so no verb reports settled what another still offers. */
export async function vouchedRulingsFor(opened: Workspace, slot: string): Promise<readonly VouchedRuling[]> {
  const vouched: VouchedRuling[] = [];
  for (const ruling of await weighedRulingsFor(opened, slot)) {
    if (ruling.retiredBy === null && ruling.tier !== null) {
      vouched.push({ id: ruling.id, record: ruling.record, authority: ruling.tier, decidedAt: ruling.decidedAt! });
    }
  }
  return vouched;
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

async function groupRulings(
  opened: Workspace,
  group: string,
): Promise<{ readonly siblings: readonly SiblingClaim[]; readonly rulings: readonly SiblingRuling[] }> {
  const members = opened.index.claimsInGroup(group);
  const rulings: SiblingRuling[] = [];
  for (const member of applyingMembers(opened, group)) {
    for (const vouched of await vouchedRulingsFor(opened, member.slot)) {
      rulings.push({
        id: vouched.id,
        claim: member.slot,
        authority: vouched.authority,
        decidedAt: vouched.decidedAt,
        verdict: vouched.record.verdict,
      });
    }
  }
  return { siblings: members.map((member) => ({ id: member.slot, exclusiveGroup: group })), rulings };
}

/** The slot of the member of `group` that holds, or `null`, as every reader of a menu reads it. */
export async function groupHolder(opened: Workspace, group: string): Promise<string | null> {
  const { siblings, rulings } = await groupRulings(opened, group);
  return holdingSibling(group, siblings, rulings, opened.floor)?.member ?? null;
}

async function siblingHoldsElsewhere(opened: Workspace, group: string, ownSlot: string): Promise<boolean> {
  const { siblings, rulings } = await groupRulings(opened, group);
  return deriveSiblingVerdicts(group, siblings, rulings, opened.floor).some((entry) => entry.claim === ownSlot);
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

/** Answers a need from the latest receipt whose working trees measure what it recorded, else the
 * latest, never spawning: what a claim read without performing rests on, as performing it would. */
function recordedReceipt(
  opened: Workspace,
  unrun: Set<RecordId>,
): (recipe: unknown, recipeId: RecordId) => Promise<RecordId> {
  return async (_recipe, recipeId) => {
    const receipts = opened.index.receiptsByRecipe(recipeId);
    if (receipts.length === 0) {
      unrun.add(recipeId);
      throw new RunRefusedError(
        opened.station === undefined
          ? "nothing has run this recipe here yet; `status` runs it"
          : `nothing has run this recipe in the station's image yet; \`status\` under the clearance ${opened.station.clearance} runs it there`,
      );
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
  /** Whether a recipe the check named has no receipt here, so only performing would answer it. */
  readonly unrun: boolean;
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
  const unrun = new Set<RecordId>();
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
      now: opened.now,
      station: opened.station,
      ...(perform
        ? {}
        : {
            performRun: recordedReceipt(opened, unrun),
            performFetchNeed: recordedReceipt(opened, unrun),
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
    // From the store, not the fold: the loop mints its receipts below the layer that folds.
    const runs: IndexedRun[] = [];
    for (const entry of result.receipts) {
      if (entry.need === "run" || entry.need === "fetch") {
        runs.push({
          id: entry.id,
          record: performedRun(entry.id, (await performed.read(entry.id, "run")) as RunRecord),
        });
      }
    }
    return { verdict: result.verdict, runs, unrun: unrun.size > 0 };
  } finally {
    await host.close?.();
  }
}

function recordsOf(runs: readonly IndexedRun[]): PerformedRunRecord[] {
  return runs.map((run) => run.record);
}

/** A check an unmoved evaluation decided, its receipts read back with no rule invoked. */
async function checkFromEvaluation(opened: Workspace, evaluation: IndexedEvaluation): Promise<CheckOutcome> {
  const { verdict, receipts } = recordedEvaluation(evaluation);
  const runs: IndexedRun[] = [];
  for (const id of receipts) {
    runs.push({ id, record: performedRun(id, (await opened.store.read(id, "run")) as RunRecord) });
  }
  return { verdict, runs, unrun: false };
}

/** The case citing a claim, or `null` where none does. */
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

/** A claim's status as `evaluate` computes it, and the graph behind it. */
export async function labelledClaim(
  opened: Workspace,
  claimName: string,
  evaluation: Evaluation,
): Promise<LabelledClaim> {
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

  // Found once: a check's run layers through the case, and a ruling's staleness pins it.
  const owningCase = await owningCaseOf(opened, indexed.id);

  // Applicability comes first; an inapplicable claim runs no check but still gets its graph.
  const named = ruleNamedBy(opened, slot, indexed.record);
  const gate = applicabilityOf(opened, indexed.record, named, declaredClaimTypes(opened));
  const applicable = gate.outcome === "valid";

  // Supporting nodes are kept apart: an attacker counted as support would vouch for its target.
  const argumentsById = new Map<string, Argument>();
  const attacks: AttackEdge[] = [];
  const supportingIds: string[] = [];
  const runIdByArgumentId = new Map<string, RecordId>();
  const supportingRunIds = new Set<RecordId>();
  const supportingIdsByRun = new Map<RecordId, string[]>();

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
    argumentsById.set(argumentId, {
      id: argumentId,
      evidenceKind,
      scope: ANY_SCOPE,
      declaredWeight: EVIDENCE_ARGUMENT_WEIGHT,
    });
    return argumentId;
  }

  // A rule concludes once, so its verdict is one node that falls with any receipt under it.
  const rule = evaluation !== "none" && applicable ? named : null;
  let openCheckReason: string | undefined;
  let checkUnrun = false;
  let concluded: LabelledClaim["concluded"];
  let treeMoved: string | null = null;
  let readMoved = false;
  if (rule !== null) {
    const recorded =
      evaluation === "recorded"
        ? latestEvaluation(opened.index, evaluationRecipe(rule, slot, opened.clearance))
        : undefined;
    readMoved = recorded !== undefined && evaluationMoved(opened.index, recorded);
    let check = recorded !== undefined && !readMoved ? await checkFromEvaluation(opened, recorded) : undefined;
    // A check reads the working tree too: where it moved off these receipts, the rule picks again.
    if (check !== undefined && (await treeMovement(opened, recordsOf(check.runs), measureTreeOnce)) !== null) {
      check = undefined;
    }
    check ??= await performCheck(opened, indexed, indexed.record, rule, owningCase, evaluation === "perform");
    if (evaluation === "recorded") {
      const movement = await treeMovement(opened, recordsOf(check.runs), measureTreeOnce);
      treeMoved = movement === null ? null : describeMovement(movement);
    }
    if (check.verdict.label === "open") {
      openCheckReason = check.verdict.reason;
      checkUnrun = check.unrun;
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
          supportingRunIds.add(runId);
          supportingIdsByRun.set(runId, [...(supportingIdsByRun.get(runId) ?? []), node]);
        }
      }
      const decidedBy = check.runs[0]?.id;
      if (grounds.length > 0 && decidedBy !== undefined) {
        argumentsById.set(node, {
          id: node,
          evidenceKind: weakestLink(grounds).kind,
          scope: ANY_SCOPE,
          declaredWeight: EVIDENCE_ARGUMENT_WEIGHT,
        });
        // A derivation walks from a node to one run: the first recipe the rule named.
        runIdByArgumentId.set(node, decidedBy);
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
    supportingRunIds.add(edge.run);
    supportingIdsByRun.set(edge.run, [...(supportingIdsByRun.get(edge.run) ?? []), argumentId]);
  }

  // An attack on the claim fails it; one on a supporting run only removes that support.
  for (const argument of opened.index.argumentsAgainst(indexed.id)) {
    for (const edge of argument.record.evidence) {
      const attacker = await nodeForEdge(edge, false);
      if (attacker !== null) {
        attacks.push({ attacker, target: slot });
      }
    }
  }
  for (const runId of supportingRunIds) {
    for (const argument of opened.index.argumentsAgainst(runId)) {
      for (const edge of argument.record.evidence) {
        const attacker = await nodeForEdge(edge, false);
        if (attacker === null) {
          continue;
        }
        for (const supported of supportingIdsByRun.get(runId) ?? []) {
          attacks.push({ attacker, target: supported });
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

  const rulingsById = new Map<string, RulingRecord>();
  const attestationsByRulingId = new Map<string, readonly MadeAttestationRecord[]>();
  const rulings: EvaluateRuling[] = [];
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

    const briefRun = opened.read(indexedRuling.record.brief) as RunRecord;
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
      briefReads: contentIdsOf(briefRun.observation.reads),
    });
  }

  // A ruling's snapshot names run ids, not selector-qualified argument ids, so both are compared.
  const currentRunIds = new Set(supportingRunIds);

  // Pinned apart from support: a brief also reads the case and the claim, which are not arguments.
  const pinnedContentIds = briefReadsOf(opened, indexed);
  if (owningCase !== null) {
    pinnedContentIds.push(owningCase.id);
  }
  // A menu's brief covers every member, so each member's ruling pins what that brief read.
  const group = (indexed.record as ClaimRecord).exclusiveGroup;
  if (group !== null) {
    for (const member of opened.index.claimsInGroup(group)) {
      if (member.id !== indexed.id) {
        pinnedContentIds.push(...briefReadsOf(opened, member));
      }
    }
  }

  const claim: EvaluateClaim = {
    id: slot,
    applicable,
    overBudget: false,
    stale: treeMoved !== null || readMoved || (await boundSecretsMoved(opened, supportingRuns)),
    supportingArgumentIds: [...supportingIds, ...currentRunIds],
    pinnedContentIds,
  };
  const { statuses, labelling } = evaluate({
    claims: [claim],
    arguments: argumentsById,
    attacks,
    rulings,
    matrix: opened.matrix,
    floor: opened.floor,
  });

  // An unvouched ruling leaves the claim open, never falling back to the evidence alone.
  let status: ClaimStatus =
    hasUnvouchedRuling && applicable
      ? { label: "open", reason: "contested-authority", comparison: statuses[0]!.status.comparison }
      : statuses[0]!.status;

  // A menu member with no decision of its own fails once a sibling holds.
  if (status.label === "open" && applicable && group !== null && (await siblingHoldsElsewhere(opened, group, slot))) {
    status = { label: "fails", comparison: status.comparison };
  }
  const detail = gate.outcome === "valid" ? (treeMoved ?? openCheckReason) : gate.reason;

  return {
    indexed,
    status,
    labelling,
    argumentsById,
    runIdByArgumentId,
    rulingsById,
    attestationsByRulingId,
    ...(concluded === undefined ? {} : { concluded }),
    ...(status.label === "open" && detail !== undefined ? { detail } : {}),
    ...(status.label === "open" && checkUnrun ? { unchecked: true } : {}),
  };
}

/** The run a claim's status rests on, or `null` where a ruling, the floor or nothing decided it. */
export async function decidingRun(opened: Workspace, labelled: LabelledClaim): Promise<IndexedRun | null> {
  const id = labelled.runIdByArgumentId.get(labelled.status.comparison.winner);
  // From the store, not the fold: this call's own check may have minted the run.
  return id === undefined ? null : { id, record: performedRun(id, (await opened.store.read(id, "run")) as RunRecord) };
}
