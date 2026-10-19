import type { RecordKind } from "./kinds.js";

/** What the fold says happened to a scope; closed, since readers filter on these wire names. */
export const EVENT_KINDS = [
  "claim.put",
  "case.booked",
  "ruling.made",
  "run.recorded",
  "attestation.made",
  "module.installed",
  "pin.changed",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

const [CLAIM_PUT, CASE_BOOKED, RULING_MADE, RUN_RECORDED, ATTESTATION_MADE, MODULE_INSTALLED] = EVENT_KINDS;

/** The event a folded record raises. A module record answers `module.installed`; only the fold
 * knows whether it is a pin change. */
export function eventKindForRecordKind(kind: RecordKind): EventKind | undefined {
  switch (kind) {
    case "claim":
      return CLAIM_PUT;
    case "case":
      return CASE_BOOKED;
    case "ruling":
      return RULING_MADE;
    case "run":
      return RUN_RECORDED;
    case "attestation":
      return ATTESTATION_MADE;
    case "module":
      return MODULE_INSTALLED;
    case "argument":
    case "rule":
    case "artifact":
      return undefined;
  }
}
