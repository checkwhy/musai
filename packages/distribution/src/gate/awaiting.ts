import type { Workspace } from "@musai/api-core";
import type { ClaimStatus } from "@musai/evaluate";
import type { ClaimRecord, RecordId } from "@musai/records";
import { applicabilityAt, applyingMembers, groupHolder, labelledClaim, vouchedRulingsFor } from "../claim.js";

/** How a gate stands: awaiting an answer, by the claim naming it, or answered by the claim whose
 * status its rulings settle, read when asked; neither where nothing in it applies or is open. */
export type GateStanding =
  | { readonly awaiting: RecordId }
  | {
      readonly awaiting: null;
      readonly answered: { readonly claim: RecordId; readonly status: () => Promise<ClaimStatus> } | null;
    };

/** A gate's status as its vouched rulings on briefs this view holds settle it, its check left out,
 * or `null` where no such ruling stands. */
async function rulingsSettle(opened: Workspace, slot: string): Promise<ClaimStatus | null> {
  if ((await vouchedRulingsFor(opened, slot)).length === 0) {
    return null;
  }
  return (await labelledClaim(opened, slot, "none")).status;
}

const unanswered = (settled: ClaimStatus | null): boolean => settled === null || settled.label === "open";

/** Where `claim`'s gate stands: one that applies awaits an answer until a vouched ruling decides
 * it, whatever its evidence says; a menu until a member holds, by its first undecided member. */
export async function gateStanding(
  opened: Workspace,
  claim: { readonly id: RecordId; readonly record: ClaimRecord },
): Promise<GateStanding> {
  const { slot, exclusiveGroup } = claim.record;
  if (exclusiveGroup === null) {
    if (applicabilityAt(opened, slot, claim.record).outcome !== "valid") {
      return { awaiting: null, answered: null };
    }
    const settled = await rulingsSettle(opened, slot);
    return unanswered(settled)
      ? { awaiting: claim.id }
      : { awaiting: null, answered: { claim: claim.id, status: async () => settled! } };
  }
  const holder = await groupHolder(opened, exclusiveGroup);
  if (holder !== null) {
    const status = async () => (await labelledClaim(opened, holder.slot, "none")).status;
    return { awaiting: null, answered: { claim: opened.index.claimAtSlot(holder.slot)!.id, status } };
  }
  for (const member of applyingMembers(opened, exclusiveGroup)) {
    if (unanswered(await rulingsSettle(opened, member.slot))) {
      return { awaiting: member.id };
    }
  }
  return { awaiting: null, answered: null };
}
