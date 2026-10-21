import type { Workspace } from "@musai/api-core";
import { OperationError, principalClassForVia, retirementOf, saltAsked } from "@musai/api-core";
import { authorityOf, type CheckedAuthority, type RulingAuthority } from "@musai/evaluate";
import type { OperationPlan } from "@musai/modules";
import {
  ANY_SCOPE,
  type ClaimRecord,
  CURRENT_SCHEMA_VERSIONS,
  isRelayedChannel,
  type RecordId,
  type RulingRecord,
  type RunRecord,
  type ViaChannel,
} from "@musai/records";
import { applicabilityAt, groupHolder, missingClaimDetail } from "../claim.js";

/** What minting a ruling needs. It carries no principal class: the channel is the check. */
export interface RulingMintInput {
  readonly claim: RecordId;
  readonly verdict: "holds" | "fails";
  readonly reason: string;
  readonly brief: RecordId;
  /** The live rulings on the ruled claim this one retires; empty where it retires none. */
  readonly supersedes: readonly RecordId[];
  readonly via: ViaChannel;
  readonly principal: string;
  readonly salt?: boolean;
}

/** The tier a channel alone establishes, as `authorityFromAttestation` derives it at read time. */
function declaredTierForVia(via: ViaChannel): RulingAuthority {
  return isRelayedChannel(via) ? "delegate" : "person";
}

/** Plans the one commit a ruling is. Every route to a ruling passes here and a minted ruling is
 * permanent, so every check a ruling needs is made here, before anything is planned. */
export async function mintRuling(
  view: Workspace,
  input: RulingMintInput,
): Promise<Pick<OperationPlan, "put" | "attest">> {
  const principalClass = principalClassForVia(input.via);
  const declared = declaredTierForVia(input.via);

  const settled = view.read(input.claim);
  if (settled.kind !== "claim") {
    throw new OperationError({
      reason: "no-such-record",
      about: [input.claim],
      detail: `${input.claim} is a ${settled.kind} record, and a ruling settles a claim`,
    });
  }
  if (view.index.successorsOf(input.claim).length > 0) {
    throw new OperationError({
      reason: "no-such-record",
      about: [input.claim],
      detail: await missingClaimDetail(view, input.claim),
    });
  }

  const governing = (view.index.claimAtSlot(settled.slot)?.record ?? settled) as ClaimRecord;
  const applies = applicabilityAt(view, settled.slot, governing);
  if (applies.outcome !== "valid") {
    throw new OperationError({
      reason: "inapplicable",
      about: [input.claim],
      detail: `${input.claim} does not apply in this workspace, so there is nothing for a ruling to decide: ${applies.reason}`,
    });
  }

  const asked = view.read(input.brief);
  if (asked.kind !== "run" || (asked as RunRecord).runKind !== "brief") {
    const what = asked.kind === "run" ? `a ${(asked as RunRecord).runKind} run` : `a ${asked.kind} record`;
    throw new OperationError({
      reason: "no-such-record",
      about: [input.brief],
      detail: `${input.brief} is ${what}, and a ruling is made against a brief`,
    });
  }

  // Finer than the action every plan is gated on: the channel's tier itself must be granted.
  let checked: CheckedAuthority;
  try {
    checked = authorityOf(view.matrix, input.principal, ANY_SCOPE, declared, principalClass);
  } catch (error) {
    throw new OperationError({
      reason: "not-authorised",
      about: [input.principal, declared],
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  for (const name of input.supersedes) {
    await refuseUnretirable(view, input, settled.slot, name, checked);
  }

  // Under a floor declaring holds, even a fails ruling makes its member hold.
  if (input.verdict === "holds" || view.floor?.verdict === "holds") {
    const group = governing.exclusiveGroup;
    const holder = group === null ? null : await groupHolder(view, group);
    if (group !== null && holder !== null && holder.slot !== settled.slot) {
      const ruling = `a ${input.verdict} ruling on ${input.claim} would make it hold`;
      throw new OperationError(
        holder.groundsWithheld
          ? {
              reason: "sibling-conflict",
              about: [group],
              detail: `${ruling}, and another member of exclusive group ${group} already holds on grounds withheld under the clearance ${view.clearance}`,
            }
          : {
              reason: "sibling-conflict",
              about: [group, holder.slot],
              detail: `${ruling}, and the member at slot ${holder.slot} already holds in exclusive group ${group}`,
            },
      );
    }
  }

  const ruling: RulingRecord = {
    kind: "ruling",
    supersedes: [...input.supersedes].sort(),
    schemaVersion: CURRENT_SCHEMA_VERSIONS.ruling,
    over: { claim: input.claim },
    verdict: input.verdict,
    reason: input.reason,
    brief: input.brief,
  };

  return {
    put: [{ kind: "ruling", value: ruling, ...saltAsked(input.salt) }],
    attest: [{ subject: { put: 0 }, purpose: "made" }],
  };
}

async function refuseUnretirable(
  view: Workspace,
  input: RulingMintInput,
  slot: string,
  name: RecordId,
  tier: CheckedAuthority,
): Promise<void> {
  const named = view.read(name);
  if (named.kind !== "ruling") {
    throw new OperationError({
      reason: "no-such-record",
      about: [name],
      detail: `${name} is a ${named.kind} record, and a ruling supersedes a ruling`,
    });
  }
  const retired = named as RulingRecord;
  if (!("claim" in retired.over)) {
    throw new OperationError({
      reason: "invalid-input",
      about: [name],
      detail: `${name} is a policy over type ${retired.over.type}, and a ruling on one claim does not retire it`,
    });
  }
  const retirement = await retirementOf(view, name, { principal: input.principal, tier, slot });
  if (retirement.retires) {
    return;
  }
  if (retirement.why === "retired") {
    throw new OperationError({
      reason: "invalid-input",
      about: [name],
      detail: `${name} is already superseded by ${retirement.by}; supersede the ruling that replaced it instead`,
    });
  }
  if (retirement.why === "not-on-slot") {
    throw new OperationError({
      reason: "invalid-input",
      about: [name],
      detail: notOnSlotDetail(view, name, retired.over.claim, slot),
    });
  }
  const { principals, tier: standing } = retirement.name;
  const by = principals.length === 0 ? "attested by nobody" : `attested by ${principals.join(", ")}`;
  const at = standing === null ? "nothing vouches for it" : `at tier ${standing}`;
  throw new OperationError({
    reason: "not-authorised",
    about: [name, input.principal],
    detail: `${input.principal}, ruling at tier ${tier}, may not retire ruling ${name} (${by}; ${at}): a higher tier retires a lower; at the same tier a principal retires a ruling only it attests; any other, including one nothing vouches for, takes a person-tier ruling from a principal holding override-person`,
  });
}

function notOnSlotDetail(view: Workspace, name: RecordId, claim: RecordId, slot: string): string {
  const claimSuccessors = view.index.successorsOf(claim);
  if (claimSuccessors.length > 0) {
    return `${name} rules on claim record ${claim}, which ${claimSuccessors.map((entry) => entry.successor).join(", ")} supersedes, so it bears on nothing`;
  }
  const ruled = view.read(claim) as ClaimRecord;
  return `${name} rules on a claim at slot ${ruled.slot}, not on the claim at slot ${slot} this ruling settles`;
}
