import type { Labelling } from "../evaluator/fixpoint.js";
import type { DerivationHop, DerivationNode } from "./render.js";

export type Hop = DerivationHop;
export type Derivation = DerivationNode;

/** One node's description; an absent `beat` is read from the fixpoint's witness for that node. */
export interface DerivationNodeSource {
  readonly kind: string;
  readonly decidedBy: string;
  readonly beat?: string | null;
  readonly childIds: readonly string[];
}

export interface DerivationSource {
  readonly nodeOf: (id: string) => DerivationNodeSource;
}

/** Walks a derivation from `rootId` by reading recorded state only; it never runs a comparison. */
export function walkWitnesses(labelling: Labelling, source: DerivationSource, rootId: string): Derivation {
  function walk(id: string): Derivation {
    const described = source.nodeOf(id);
    const witness = labelling.witnesses.get(id);
    const beat = described.beat !== undefined ? described.beat : (witness?.defeatedBy ?? null);
    return {
      hop: { label: described.kind, id, decidedBy: described.decidedBy, beat },
      children: described.childIds.map(walk),
    };
  }
  return walk(rootId);
}
