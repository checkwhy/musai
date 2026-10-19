import { isPrincipalClass, type PrincipalClass, type RunRecord } from "@musai/records";

/** The evidence kinds the kernel ranks, strongest first. */
export const EVIDENCE_ORDER = ["receipt", "citation", "person-judgment", "agent-judgment"] as const;

export type EvidenceKind = (typeof EVIDENCE_ORDER)[number];

function rankOf(kind: EvidenceKind): number {
  return EVIDENCE_ORDER.indexOf(kind);
}

export interface RunKindSource {
  readonly runKind: RunRecord["runKind"];
}

export interface AttestationPrincipalSource {
  readonly principalClass: PrincipalClass;
}

/** Never read from the claim, since a claim declaring its own evidence kind would be a spoof. */
export function evidenceKindOf(run: RunKindSource, attestation: AttestationPrincipalSource | null): EvidenceKind {
  if (run.runKind === "run") {
    return "receipt";
  }
  if (run.runKind === "citation") {
    return "citation";
  }
  if (run.runKind === "brief") {
    throw new RangeError("a brief run is what a decider was shown, never evidence a claim cites directly");
  }
  if (run.runKind === "evaluation") {
    throw new RangeError("an evaluation run is a rule's verdict over evidence, never evidence a claim cites directly");
  }
  if (attestation === null || !isPrincipalClass(attestation.principalClass)) {
    throw new RangeError("a testimony run's evidence kind requires an attestation naming its principal's class");
  }
  return attestation.principalClass === "person" ? "person-judgment" : "agent-judgment";
}

export interface EvidenceHop {
  readonly id: string;
  readonly kind: EvidenceKind;
}

export interface WeakestLink {
  readonly kind: EvidenceKind;
  readonly settledBy: EvidenceHop;
}

/** The caller supplies the whole chain, so a judgment any number of hops back caps the result. */
export function weakestLink(chain: readonly EvidenceHop[]): WeakestLink {
  if (chain.length === 0) {
    throw new RangeError("weakestLink requires at least one hop");
  }
  let weakest = chain[0]!;
  for (const hop of chain) {
    if (rankOf(hop.kind) > rankOf(weakest.kind)) {
      weakest = hop;
    }
  }
  return { kind: weakest.kind, settledBy: weakest };
}
