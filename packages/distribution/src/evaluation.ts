import { EVALUATE_COMMAND, rulesNamedBy, type Workspace } from "@musai/api-core";
import type { RuleVerdict } from "@musai/evaluate";
import type { IndexDb, IndexedContribution } from "@musai/fold";
import {
  type Audience,
  type ClaimRecord,
  type ComputedRecipe,
  type ComputedRunRecord,
  CURRENT_SCHEMA_VERSIONS,
  canonicalBytes,
  hexOfRecordId,
  type ReadEntry,
  type RecordId,
  recipeOfReadKey,
  recordId,
} from "@musai/records";
import { RUNNER_PERFORMER } from "@musai/run";
import type { HeldWrites } from "@musai/store";

/** An evaluation's recipe: the rule by its module's digest, over the claim at a slot, so every
 * evaluation of one claim by one build of its rule under one clearance shares it. */
export function evaluationRecipe(
  contribution: IndexedContribution,
  slot: string,
  clearance: Audience | undefined,
): ComputedRecipe {
  return {
    command: [EVALUATE_COMMAND, contribution.entry.id, slot, ...(clearance === undefined ? [] : [clearance])],
    substrates: [
      {
        name: "rule",
        digest: { sha256: hexOfRecordId(contribution.moduleRecord) },
        annotations: { version: contribution.entry.version },
      },
    ],
  };
}

function textOf(value: unknown): string {
  return new TextDecoder().decode(canonicalBytes(value));
}

/** Mints an evaluation only where the claim's latest read or concluded otherwise, superseding it,
 * in one commit with the receipts its loop `performed`, so no reader sees them land apart. */
export async function mintEvaluation(
  opened: Workspace,
  performed: HeldWrites,
  recipe: ComputedRecipe,
  reads: readonly ReadEntry[],
  verdict: RuleVerdict,
): Promise<RecordId | null> {
  const observation = {
    output: textOf({ label: verdict.label, reason: verdict.reason }),
    reads: [...reads],
    cost: {},
  };
  const latest = opened.index.receiptByRecipe(recordId(recipe));
  if (latest !== undefined) {
    const held = (latest.record as ComputedRunRecord).observation;
    if (textOf({ reads: held.reads, output: held.output }) === textOf({ reads, output: observation.output })) {
      await performed.land([]);
      return null;
    }
  }
  const run: ComputedRunRecord = {
    kind: "run",
    supersedes: latest === undefined ? [] : [latest.recordId],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
    runKind: "evaluation",
    performer: RUNNER_PERFORMER,
    determinism: "deterministic",
    recipe,
    observation,
  };
  const [minted] = await performed.land([{ kind: "run", value: run }]);
  return minted!;
}

export interface IndexedEvaluation {
  readonly id: RecordId;
  readonly run: ComputedRunRecord;
}

/** Whether an evaluation read anything that has moved since: the fold's first hop, per read. */
export function evaluationMoved(index: IndexDb, evaluation: IndexedEvaluation): boolean {
  return evaluation.run.observation.reads.some((read) => index.readMoved(evaluation.id, read));
}

/** An unmoved evaluation's verdict and the receipts its run and fetch needs rested on, read back
 * with no rule invoked. */
export function recordedEvaluation(evaluation: IndexedEvaluation): {
  readonly verdict: RuleVerdict;
  readonly receipts: readonly RecordId[];
} {
  const { label, reason } = JSON.parse(evaluation.run.observation.output as string) as Omit<RuleVerdict, "kind">;
  const receipts = evaluation.run.observation.reads
    .filter((read) => recipeOfReadKey(read.key) !== undefined)
    .map((read) => `sha256:${read.consumed.sha256}` as RecordId);
  return { verdict: { kind: "verdict", label, reason }, receipts };
}

/** The evaluation a check is read from as of the records `landed` holds: the latest under
 * `clearance` by its rule's build installed then, what a brief packs and a read answers from. */
export function checkEvaluation(
  index: IndexDb,
  claim: Pick<ClaimRecord, "slot" | "conditions">,
  landed: (id: RecordId) => boolean,
  clearance: Audience | undefined,
): { readonly rule: IndexedContribution; readonly evaluation: IndexedEvaluation } | null {
  const [rule] = rulesNamedBy(index, claim.conditions, landed);
  if (rule === undefined) {
    return null;
  }
  const recipe = recordId(evaluationRecipe(rule, claim.slot, clearance));
  const latest = index.receiptsByRecipe(recipe).find((receipt) => landed(receipt.recordId));
  return latest === undefined
    ? null
    : { rule, evaluation: { id: latest.recordId, run: latest.record as ComputedRunRecord } };
}

/** The rule a check rests on and the receipts it holds on. */
export interface HoldingCheck {
  readonly rule: string;
  readonly receipts: readonly RecordId[];
}

/** The rule and receipts of the evaluation a check is read from, where that evaluation holds. */
export function holdingCheck(
  index: IndexDb,
  claim: Pick<ClaimRecord, "slot" | "conditions">,
  landed: (id: RecordId) => boolean,
  clearance: Audience | undefined,
): HoldingCheck | null {
  const chosen = checkEvaluation(index, claim, landed, clearance);
  if (chosen === null) {
    return null;
  }
  const { verdict, receipts } = recordedEvaluation(chosen.evaluation);
  return verdict.label === "holds" ? { rule: chosen.rule.entry.id, receipts } : null;
}
