import type { PrincipalClass, Scope, Timestamp } from "@musai/records";
import type { RoleMatrix } from "@musai/trust";
import { type AttackGraph, resolveDefeats } from "./defeat.js";
import { type ClaimEvaluationInput, evaluateClaims, type Labelling } from "./fixpoint.js";
import type { Argument } from "./ordering.js";
import {
  authorityOf,
  type FloorRuling,
  orderRulings,
  type PinnedRuling,
  type Ruling,
  type RulingAuthority,
  resolveClaimRulings,
  SiblingConflictError,
  weighedWithFloor,
} from "./rulings.js";
import type { ClaimStatus } from "./status.js";

export interface EvaluateClaim {
  readonly id: string;
  readonly applicable: boolean;
  readonly overBudget: boolean;
  readonly supportingArgumentIds: readonly string[];
  readonly stale?: boolean;
}

/** `authority` is unchecked until `evaluate` mints it; the ruling is stale once `briefReads` names
 * an id `currentIds` does not hold. */
export interface EvaluateRuling {
  readonly id: string;
  readonly claim: string;
  readonly principal: string;
  readonly principalClass?: PrincipalClass;
  readonly scope: Scope;
  readonly authority: RulingAuthority;
  readonly decidedAt: Timestamp;
  readonly verdict: "holds" | "fails";
  readonly briefReads: readonly string[];
  readonly currentIds: readonly string[];
}

export interface EvaluateInput {
  readonly claims: readonly EvaluateClaim[];
  readonly arguments: ReadonlyMap<string, Argument>;
  readonly attacks: AttackGraph;
  readonly rulings: readonly EvaluateRuling[];
  readonly matrix: RoleMatrix;
  readonly floor: FloorRuling | null;
}

export interface ClaimStatusEntry {
  readonly id: string;
  readonly status: ClaimStatus;
}

export interface EvaluationResult {
  readonly statuses: readonly ClaimStatusEntry[];
  readonly labelling: Labelling;
}

/** Labels a claim graph; a ruling whose authority does not check refuses the whole call. */
export function evaluate(input: EvaluateInput): EvaluationResult {
  const nodeIds = [...new Set([...input.claims.map((claim) => claim.id), ...input.arguments.keys()])];

  function argumentOf(id: string): Argument {
    const found = input.arguments.get(id);
    if (found === undefined) {
      throw new RangeError(`no argument registered for node id: ${id}`);
    }
    return found;
  }

  const defeats = resolveDefeats(input.attacks, { argumentOf });

  const rulingsByClaim = new Map<string, PinnedRuling[]>();
  for (const ruling of input.rulings) {
    const checked: PinnedRuling = {
      id: ruling.id,
      authority: authorityOf(input.matrix, ruling.principal, ruling.scope, ruling.authority, ruling.principalClass),
      decidedAt: ruling.decidedAt,
      verdict: ruling.verdict,
      evidenceSnapshot: ruling.briefReads,
      currentEvidenceIds: ruling.currentIds,
    };
    const forClaim = rulingsByClaim.get(ruling.claim);
    if (forClaim) {
      forClaim.push(checked);
    } else {
      rulingsByClaim.set(ruling.claim, [checked]);
    }
  }

  const claimInputs: ClaimEvaluationInput[] = input.claims.map((claim) => ({
    id: claim.id,
    applicable: claim.applicable,
    overBudget: claim.overBudget,
    supportingArgumentIds: claim.supportingArgumentIds,
    ruling: resolveClaimRulings({
      rulings: rulingsByClaim.get(claim.id) ?? [],
      floor: input.floor,
    }),
    stale: claim.stale,
  }));

  const { labelling, statuses } = evaluateClaims(claimInputs, nodeIds, defeats, argumentOf);

  const sortedIds = [...statuses.keys()].sort();
  const entries: ClaimStatusEntry[] = sortedIds.map((id) => ({ id, status: statuses.get(id)! }));
  return { statuses: entries, labelling };
}

export interface SiblingClaim {
  readonly id: string;
  readonly exclusiveGroup: string | null;
}

export interface SiblingRuling extends Ruling {
  readonly claim: string;
}

export interface HoldingSibling {
  readonly member: string;
  readonly derivedFrom: string;
}

/** A verdict derived from another member's ruling: a labelling fact, never a minted record. */
export interface SiblingDerivation {
  readonly claim: string;
  readonly verdict: "fails";
  readonly derivedFrom: string;
}

/** The member whose rulings and the floor resolve `holds` under the ordering its own labelling
 * uses; a contested member does not hold. */
export function holdingSibling(
  group: string,
  siblings: readonly SiblingClaim[],
  rulings: readonly SiblingRuling[],
  floor: FloorRuling | null,
): HoldingSibling | null {
  const members = [
    ...new Set(siblings.filter((sibling) => sibling.exclusiveGroup === group).map((sibling) => sibling.id)),
  ];
  const holding: HoldingSibling[] = [];
  for (const member of members.sort()) {
    const own = rulings.filter((ruling) => ruling.claim === member);
    if (own.length === 0) {
      continue;
    }
    const resolution = orderRulings(weighedWithFloor(own, floor));
    if (resolution.outcome === "decided" && resolution.winner.verdict === "holds") {
      holding.push({ member, derivedFrom: resolution.winner.id });
    }
  }
  if (holding.length > 1) {
    throw new SiblingConflictError(group, holding[0]!.member, holding[1]!.member);
  }
  return holding[0] ?? null;
}

/** Every member but the holder fails from the holder's ruling; nothing is minted for them. */
export function deriveSiblingVerdicts(
  group: string,
  siblings: readonly SiblingClaim[],
  rulings: readonly SiblingRuling[],
  floor: FloorRuling | null,
): readonly SiblingDerivation[] {
  const holder = holdingSibling(group, siblings, rulings, floor);
  if (holder === null) {
    return [];
  }
  const members = new Set(siblings.filter((sibling) => sibling.exclusiveGroup === group).map((sibling) => sibling.id));
  return [...members]
    .filter((member) => member !== holder.member)
    .sort()
    .map((member) => ({ claim: member, verdict: "fails" as const, derivedFrom: holder.derivedFrom }));
}
