import { type ReasonClass, reasonPrecedence } from "@musai/records";
import { type Argument, compareArguments } from "./ordering.js";
import type { ClaimRulingOutcome } from "./rulings.js";
import type { ClaimStatus, Comparison } from "./status.js";

/** An argument's label under grounded semantics. */
export type Label = "in" | "out" | "undec";

/** The `in` attacker that defeated an `out` node, recorded as the node is labelled. */
export interface Witness {
  defeatedBy: string;
}

export interface Labelling {
  labels: Map<string, Label>;
  witnesses: Map<string, Witness>;
}

export interface DefeatEdge {
  attacker: string;
  target: string;
}

/** The grounded extension by a Kahn-style worklist, leaving a cycle `undec`; ids are processed
 * sorted, so any input order gives identical labels and witnesses. */
export function groundedLabelling(nodeIds: readonly string[], defeats: readonly DefeatEdge[]): Labelling {
  const sortedNodeIds = [...nodeIds].sort();
  const sortedDefeats = [...defeats].sort((a, b) => {
    if (a.attacker !== b.attacker) {
      return a.attacker < b.attacker ? -1 : 1;
    }
    return a.target < b.target ? -1 : a.target > b.target ? 1 : 0;
  });

  const labels = new Map<string, Label>();
  for (const id of sortedNodeIds) {
    labels.set(id, "undec");
  }

  const attackersOf = new Map<string, Set<string>>();
  const targetsOf = new Map<string, string[]>();
  for (const id of sortedNodeIds) {
    attackersOf.set(id, new Set());
    targetsOf.set(id, []);
  }
  for (const edge of sortedDefeats) {
    attackersOf.get(edge.target)?.add(edge.attacker);
    targetsOf.get(edge.attacker)?.push(edge.target);
  }

  const liveAttackerCount = new Map<string, number>();
  for (const id of sortedNodeIds) {
    liveAttackerCount.set(id, attackersOf.get(id)?.size ?? 0);
  }

  const witnesses = new Map<string, Witness>();
  const queue: string[] = sortedNodeIds.filter((id) => liveAttackerCount.get(id) === 0);

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (labels.get(id) !== "undec") {
      continue;
    }
    labels.set(id, "in");

    for (const target of targetsOf.get(id) ?? []) {
      if (labels.get(target) === "undec") {
        labels.set(target, "out");
        witnesses.set(target, { defeatedBy: id });

        for (const grandchild of targetsOf.get(target) ?? []) {
          const remaining = (liveAttackerCount.get(grandchild) ?? 0) - 1;
          liveAttackerCount.set(grandchild, remaining);
          if (remaining === 0 && labels.get(grandchild) === "undec") {
            queue.push(grandchild);
          }
        }
      }
    }
  }

  return { labels, witnesses };
}

export interface ClaimEvaluationInput {
  readonly id: string;
  readonly applicable: boolean;
  readonly overBudget: boolean;
  readonly supportingArgumentIds: readonly string[];
  readonly ruling: ClaimRulingOutcome | null;
  /** A verifying trace found this claim's reads meeting a moved input, whatever its rulings. */
  readonly stale?: boolean;
}

/** `nodeIds` and `defeats` must already include every supporting argument every claim names. */
export function evaluateClaims(
  claims: readonly ClaimEvaluationInput[],
  nodeIds: readonly string[],
  defeats: readonly DefeatEdge[],
  argumentOf: (id: string) => Argument,
): { readonly labelling: Labelling; readonly statuses: ReadonlyMap<string, ClaimStatus> } {
  const labelling = groundedLabelling(nodeIds, defeats);
  const statuses = new Map<string, ClaimStatus>();
  for (const claim of claims) {
    statuses.set(claim.id, labelOneClaim(claim, labelling, argumentOf));
  }
  return { labelling, statuses };
}

/** Pairwise, not a fold: specificity is partial, so a fold would keep whichever it met first. Two
 * supports no other beats agree: the first leads and, having beaten neither, names no rival. */
function leadingSupport(
  inSupport: readonly string[],
  argumentOf: (id: string) => Argument,
): { readonly winnerId: string; readonly rival: string | null; readonly corroborated: readonly string[] } {
  const sorted = [...inSupport].sort();
  const beaten = (candidateId: string) =>
    sorted.some(
      (otherId) =>
        otherId !== candidateId && compareArguments(argumentOf(candidateId), argumentOf(otherId)).winner === "b",
    );
  const unbeaten = sorted.filter((id) => !beaten(id));
  const leading = unbeaten.length > 0 ? unbeaten : sorted;
  const winnerId = leading[0]!;
  return {
    winnerId,
    rival: leading.length > 1 ? null : (inSupport.find((id) => id !== winnerId) ?? null),
    corroborated: leading.slice(1),
  };
}

function labelOneClaim(
  claim: ClaimEvaluationInput,
  labelling: Labelling,
  argumentOf: (id: string) => Argument,
): ClaimStatus {
  const reasons = new Set<ReasonClass>();
  if (!claim.applicable) {
    reasons.add("inapplicable");
  }
  if (claim.overBudget) {
    reasons.add("over-budget");
  }
  if (claim.stale === true) {
    reasons.add("stale");
  }

  let baseLabel: "holds" | "fails" = "holds";
  let baseComparison: Comparison = { winner: "(none)", rival: null, via: "no evidence", corroborated: [] };
  let baseDecided = false;

  const ownLabel = labelling.labels.get(claim.id);
  if (ownLabel === "out") {
    // A challenge that wins against the claim itself fails it, whatever evidence survives.
    const witness = labelling.witnesses.get(claim.id)!;
    baseLabel = "fails";
    baseComparison = {
      winner: witness.defeatedBy,
      rival: claim.id,
      via: "a challenge to the claim itself",
      corroborated: [],
    };
    baseDecided = true;
  } else if (ownLabel === "undec") {
    reasons.add("cycle");
  } else if (claim.supportingArgumentIds.length === 0) {
    reasons.add("no-evidence");
  } else {
    const supportLabels = claim.supportingArgumentIds.map((id) => ({ id, label: labelling.labels.get(id) }));
    const inSupport = supportLabels.filter((entry) => entry.label === "in").map((entry) => entry.id);
    const anyUndec = supportLabels.some((entry) => entry.label === "undec");

    if (inSupport.length === 0) {
      reasons.add(anyUndec ? "cycle" : "no-evidence");
    } else {
      const { winnerId, rival, corroborated } = leadingSupport(inSupport, argumentOf);
      const winner = argumentOf(winnerId);
      baseLabel = "holds";
      baseComparison = { winner: winner.id, rival, via: winner.evidenceKind, corroborated };
      baseDecided = true;
    }
  }

  let finalLabel: "holds" | "fails" = baseLabel;
  let finalComparison = baseComparison;

  if (claim.ruling !== null) {
    if (claim.ruling.outcome === "contested") {
      reasons.add("contested-authority");
      finalComparison = {
        winner: claim.ruling.tiedIds[0],
        rival: claim.ruling.tiedIds[1],
        via: "rulings equal in authority",
        corroborated: [],
      };
    } else {
      finalLabel = claim.ruling.verdict;
      finalComparison = {
        winner: claim.ruling.winnerId,
        rival: baseDecided ? baseComparison.winner : null,
        via: "ruling",
        corroborated: [],
      };
      // A deciding ruling fills exactly the gap that "no-evidence" names.
      reasons.delete("no-evidence");
    }
  }

  if (reasons.size > 0) {
    return { label: "open", reason: reasonPrecedence(reasons), comparison: finalComparison };
  }
  const flagged = claim.ruling?.outcome === "decided" && claim.ruling.stale;
  return { label: finalLabel, comparison: finalComparison, ...(flagged ? { decidedOnStaleEvidence: true } : {}) };
}
