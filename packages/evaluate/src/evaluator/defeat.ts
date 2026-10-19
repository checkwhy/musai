import { type Argument, compareArguments } from "./ordering.js";

export interface AttackEdge {
  readonly attacker: string;
  readonly target: string;
}

export type AttackGraph = readonly AttackEdge[];

/** The attacks that survive preference resolution; the only graph the fixpoint consumes. */
export type DefeatGraph = readonly AttackEdge[];

export interface ArgumentLookup {
  readonly argumentOf: (id: string) => Argument;
}

/** Drops each attack by a weaker argument on a stronger one, as ASPIC+ and DeLP do; the fixpoint
 * weighs no preference. */
export function resolveDefeats(attacks: AttackGraph, lookup: ArgumentLookup): DefeatGraph {
  const defeats: AttackEdge[] = [];
  for (const attack of attacks) {
    const attacker = lookup.argumentOf(attack.attacker);
    const target = lookup.argumentOf(attack.target);
    const comparison = compareArguments(attacker, target);
    if (comparison.winner !== "b") {
      defeats.push(attack);
    }
  }
  return defeats;
}
