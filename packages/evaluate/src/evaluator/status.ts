import type { ReasonClass } from "@musai/records";

/** What decided a status; `why` never shows a bare label. */
export interface Comparison {
  winner: string;
  rival: string | null;
  via: string;
  /** Supports the winner neither beat nor lost to: they agree, so they hold the claim too. */
  corroborated: readonly string[];
}

/** A ruling whose pinned evidence moved still decides, for the snapshot it saw, and says so. */
export type ClaimStatus =
  | { label: "holds"; comparison: Comparison; decidedOnStaleEvidence?: true }
  | { label: "fails"; comparison: Comparison; decidedOnStaleEvidence?: true }
  | { label: "open"; reason: ReasonClass; comparison: Comparison };
