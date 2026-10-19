export interface ReadLog {
  readonly claimId: string;
  readonly reads: ReadonlySet<string>;
}

/** Keyed by content id: staleness compares content, never what a rule reports it touched. */
export function recordRead(claimId: string, reads: Iterable<string>): ReadLog {
  return { claimId, reads: new Set(reads) };
}
