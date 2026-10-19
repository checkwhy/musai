export const RECORD_KINDS = [
  "claim",
  "argument",
  "run",
  "ruling",
  "rule",
  "case",
  "artifact",
  "attestation",
  "module",
] as const;

export type RecordKind = (typeof RECORD_KINDS)[number];

export function isRecordKind(value: unknown): value is RecordKind {
  return typeof value === "string" && (RECORD_KINDS as readonly string[]).includes(value);
}
