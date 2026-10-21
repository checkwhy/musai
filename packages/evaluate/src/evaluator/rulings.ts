import type { MadeAttestationRecord, PrincipalClass, Scope } from "@musai/records";
import { instantOf, isPlainObject, isRelayedChannel, KernelError, type Timestamp, timestamp } from "@musai/records";
import type { WorkspaceConfig } from "@musai/store";
import { may, type RoleMatrix } from "@musai/trust";

/** The tiers a ruling record may declare; the floor is not one of them. */
export const RULING_AUTHORITIES = ["person", "policy", "delegate"] as const;

export type RulingAuthority = (typeof RULING_AUTHORITIES)[number];

export function isRulingAuthority(value: unknown): value is RulingAuthority {
  return typeof value === "string" && (RULING_AUTHORITIES as readonly string[]).includes(value);
}

/** Outranks every ruling; only `floorFrom` mints it, from configuration, never from a record. */
export const FLOOR_AUTHORITY = "floor" as const;

type ComparableAuthority = RulingAuthority | "floor";

const AUTHORITY_ORDER: readonly ComparableAuthority[] = [FLOOR_AUTHORITY, "person", "policy", "delegate"];

/** Refuses an unranked value, which `indexOf` would place above the floor. */
function authorityRank(authority: ComparableAuthority): number {
  const rank = AUTHORITY_ORDER.indexOf(authority);
  if (rank < 0) {
    throw new RangeError(`not an authority the ordering ranks: ${String(authority)}`);
  }
  return rank;
}

declare const checkedAuthorityBrand: unique symbol;

/** An authority checked by `authorityOf` or `floorFrom`; a record's declared field never is. */
export type CheckedAuthority = ComparableAuthority & { readonly [checkedAuthorityBrand]: true };

export interface Ruling {
  readonly id: string;
  readonly authority: CheckedAuthority;
  readonly decidedAt: Timestamp;
  readonly verdict: "holds" | "fails";
}

/** Stale once its snapshot names an id `currentEvidenceIds` does not hold. */
export interface PinnedRuling extends Ruling {
  readonly evidenceSnapshot: readonly string[];
  readonly currentEvidenceIds: readonly string[];
}

export const FLOOR_CONFIG_KEY = "floor";

/** Never compared: the floor's tier outranks every other before time is weighed. */
const FLOOR_DECIDED_AT = timestamp("1970-01-01T00:00:00.000Z");

/** A floor pins no evidence, so it is never stale; `commit` is where its configuration was read. */
export interface FloorRuling extends PinnedRuling {
  readonly authority: CheckedAuthority;
  readonly commit: string;
}

function isFloorDeclaration(value: unknown): value is { readonly verdict: "holds" | "fails" } {
  return isPlainObject(value) && (value["verdict"] === "holds" || value["verdict"] === "fails");
}

/** Reads the floor from configuration; a malformed one is refused rather than read as no floor. */
export function floorFrom(config: WorkspaceConfig): FloorRuling | null {
  const declared = config.values[FLOOR_CONFIG_KEY];
  if (declared === undefined) {
    return null;
  }
  if (!isFloorDeclaration(declared)) {
    throw new RangeError(
      `refusing to read the workspace floor from ${FLOOR_CONFIG_KEY} at ${config.commit}: expected {"verdict": "holds" | "fails"}`,
    );
  }
  return {
    id: `floor@${config.commit}`,
    authority: FLOOR_AUTHORITY as CheckedAuthority,
    decidedAt: FLOOR_DECIDED_AT,
    verdict: declared.verdict,
    evidenceSnapshot: [],
    currentEvidenceIds: [],
    commit: config.commit,
  };
}

export type RulingResolution =
  | { readonly outcome: "decided"; readonly winner: Ruling; readonly decidedBy: "authority" | "time" }
  | { readonly outcome: "contested"; readonly tied: readonly [Ruling, Ruling] };

function mostRecentlyDecided(rulings: readonly Ruling[]): Ruling {
  const sorted = [...rulings].sort((a, b) => {
    const instantA = instantOf(a.decidedAt);
    const instantB = instantOf(b.decidedAt);
    if (instantA !== instantB) {
      return instantA > instantB ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return sorted[0]!;
}

/** The highest tier decides; a disagreement within it is contested, never settled by time, and
 * names the latest ruling beside its latest dissenter. */
export function orderRulings(rulings: readonly Ruling[]): RulingResolution {
  if (rulings.length === 0) {
    throw new RangeError("orderRulings requires at least one ruling");
  }
  const bestRank = Math.min(...rulings.map((ruling) => authorityRank(ruling.authority)));
  const topTier = rulings.filter((ruling) => authorityRank(ruling.authority) === bestRank);
  const verdicts = new Set(topTier.map((ruling) => ruling.verdict));

  if (verdicts.size > 1) {
    const mostRecent = mostRecentlyDecided(topTier);
    const opposing = topTier.filter((ruling) => ruling.verdict !== mostRecent.verdict);
    return { outcome: "contested", tied: [mostRecent, mostRecentlyDecided(opposing)] };
  }

  return {
    outcome: "decided",
    winner: mostRecentlyDecided(topTier),
    decidedBy: topTier.length > 1 ? "time" : "authority",
  };
}

/** Checks a declared tier against the principal's grants and attested class; the only way a
 * declared tier becomes a `CheckedAuthority`. */
export function authorityOf(
  matrix: RoleMatrix,
  principal: string,
  scope: Scope,
  declared: RulingAuthority,
  principalClass?: PrincipalClass,
): CheckedAuthority {
  if (!isRulingAuthority(declared)) {
    throw new RangeError(`${principal} declares an authority no ruling may carry: ${String(declared)}`);
  }
  if (principalClass === "agent" && declared !== "delegate") {
    throw new RangeError(`${principal} is attested as an agent and cannot rule as ${declared}`);
  }
  if (declared === "delegate") {
    if (!may(matrix, principal, "rule", scope)) {
      throw new RangeError(`${principal} holds no role granting rule and cannot rule as delegate`);
    }
    return declared as CheckedAuthority;
  }
  if (!may(matrix, principal, "set-aside", scope)) {
    throw new RangeError(`${principal} holds no role beyond delegate and cannot rule as ${declared}`);
  }
  return declared as CheckedAuthority;
}

/** `authority` is `null` where nothing vouches for the ruling or its tier is no longer granted. */
export interface RetiredRuling {
  readonly principals: readonly string[];
  readonly authority: CheckedAuthority | null;
}

/** The one succession rule a writer and a reader both apply, so it reads no matrix of its own. */
export function maySupersede(
  successor: { readonly principal: string; readonly authority: CheckedAuthority },
  predecessor: RetiredRuling,
  overridesPerson: boolean,
): boolean {
  if (predecessor.authority !== null) {
    const successorRank = authorityRank(successor.authority);
    const predecessorRank = authorityRank(predecessor.authority);
    if (successorRank < predecessorRank) {
      return true;
    }
    if (
      successorRank === predecessorRank &&
      predecessor.principals.length > 0 &&
      predecessor.principals.every((principal) => principal === successor.principal)
    ) {
      return true;
    }
  }
  return successor.authority === "person" && overridesPerson;
}

/** `provisional` when the attestation came through a channel a model could forge. */
export interface RulingAuthorityEvaluation {
  readonly class: CheckedAuthority | null;
  readonly withinAuthority: boolean;
  readonly provisional: boolean;
}

/** A model's channel never yields person tier; a grant revoked since the ruling reads as outside
 * authority, not as a malformed ruling. */
export function authorityFromAttestation(
  ruling: { readonly id: string },
  attestation: MadeAttestationRecord | null,
  matrix: RoleMatrix,
  scope: Scope,
): RulingAuthorityEvaluation | null {
  if (attestation === null) {
    return null;
  }
  if (attestation.subject !== ruling.id) {
    throw new RangeError(`attestation ${JSON.stringify(attestation)} does not stand behind ruling ${ruling.id}`);
  }
  const provisional = isRelayedChannel(attestation.via);
  const declaredTier: RulingAuthority = provisional || attestation.principalClass === "agent" ? "delegate" : "person";
  try {
    const checked = authorityOf(matrix, attestation.principal, scope, declaredTier, attestation.principalClass);
    return { class: checked, withinAuthority: true, provisional };
  } catch {
    return { class: null, withinAuthority: false, provisional };
  }
}

/** Agreement mints nothing: only a ruling that challenges the evidence is a set-aside. */
export function rulingConflicts(rulingVerdict: "holds" | "fails", receiptVerdict: "holds" | "fails"): boolean {
  return rulingVerdict !== receiptVerdict;
}

/** A ruling standing over a run it conflicts with; the run stays in the graph. */
export interface SetAside {
  readonly ruling: string;
  readonly run: string;
  readonly reason: string;
  readonly ruledAt: Timestamp;
  readonly principal: string;
}

export interface SetAsideSource {
  readonly id: string;
  readonly principal: string;
  readonly decidedAt: Timestamp;
}

export function mintSetAside(ruling: SetAsideSource, run: string, reason: string): SetAside {
  if (reason.trim().length === 0) {
    throw new RangeError("a ruling conflicting with a receipt must carry a non-empty reason to mint a set-aside");
  }
  return { ruling: ruling.id, run, reason, ruledAt: ruling.decidedAt, principal: ruling.principal };
}

/** Whether the snapshot has diverged; the ruling's own verdict never moves. */
export function pinnedEvidenceMoved(
  evidenceSnapshot: readonly string[],
  currentEvidenceIds: readonly string[],
): boolean {
  const current = new Set(currentEvidenceIds);
  return evidenceSnapshot.some((id) => !current.has(id));
}

declare const rulingOutcomeBrand: unique symbol;

/** Minted only by `resolveClaimRulings`, so no verdict reaches the labelling unordered. */
export type ClaimRulingOutcome = (
  | { readonly outcome: "contested"; readonly tiedIds: readonly [string, string] }
  | {
      readonly outcome: "decided";
      readonly winnerId: string;
      readonly verdict: "holds" | "fails";
      readonly stale: boolean;
    }
) & { readonly [rulingOutcomeBrand]: true };

export interface ResolveClaimRulingsInput {
  readonly rulings: readonly PinnedRuling[];
  readonly floor: FloorRuling | null;
}

/** Called only over a non-empty set, since a floor never bears on a claim nothing else rules. */
export function weighedWithFloor<R extends Ruling>(
  rulings: readonly R[],
  floor: FloorRuling | null,
): readonly (R | FloorRuling)[] {
  return floor === null ? rulings : [...rulings, floor];
}

/** `null` for a claim with no ruling; a winner whose pinned evidence moved is stale. */
export function resolveClaimRulings(input: ResolveClaimRulingsInput): ClaimRulingOutcome | null {
  if (input.rulings.length === 0) {
    return null;
  }
  const all: readonly PinnedRuling[] = weighedWithFloor(input.rulings, input.floor);
  const resolution = orderRulings(all);

  if (resolution.outcome === "contested") {
    return {
      outcome: "contested",
      tiedIds: [resolution.tied[0].id, resolution.tied[1].id],
    } as unknown as ClaimRulingOutcome;
  }

  const winner = all.find((candidate) => candidate.id === resolution.winner.id)!;
  const stale = pinnedEvidenceMoved(winner.evidenceSnapshot, winner.currentEvidenceIds);
  return {
    outcome: "decided",
    winnerId: resolution.winner.id,
    verdict: resolution.winner.verdict,
    stale,
  } as unknown as ClaimRulingOutcome;
}

/** A second member of an exclusive group would hold; the kernel, not a playbook, enforces it. */
export class SiblingConflictError extends KernelError {
  readonly group: string;
  readonly holdingMember: string;

  constructor(group: string, holdingMember: string, attemptedMember: string) {
    super({
      reason: "sibling-conflict",
      detail: `claim ${attemptedMember} cannot hold: sibling ${holdingMember} already holds in exclusive group ${group}`,
      about: [group, holdingMember],
    });
    this.name = "SiblingConflictError";
    this.group = group;
    this.holdingMember = holdingMember;
  }
}
