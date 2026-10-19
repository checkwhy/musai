import { isRecordId, type RecordId } from "../../canonical/canonicalize.js";
import type { DraftResult, KindContract } from "../contract.js";
import { type EvidenceEdge, parseEvidenceEdges } from "../evidence.js";
import { invalid, parseRecordIdList, parseSalt, type Salted, withoutSalt } from "../fields.js";
import { isSealedValue, type SealableText } from "../sealed.js";

/** A challenge when it attacks a claim or a run, an answer when it attacks a challenge. */
export interface ArgumentRecord extends Salted {
  kind: "argument";
  schemaVersion: number;
  target: RecordId;
  reason: SealableText;
  evidence: EvidenceEdge[];
  /** Conjunctive: a premise that stops holding is an attack on this argument. */
  premises: RecordId[];
  /** The records this one replaces; a correction is a successor, never an edit. */
  supersedes: RecordId[];
}

export type ArgumentDraft = Omit<ArgumentRecord, "schemaVersion">;

function validateArgument(fields: Record<string, unknown>): DraftResult<ArgumentDraft> {
  const { target, reason, evidence } = fields;
  if (!isRecordId(target)) {
    return invalid("argument.target must be a record id");
  }
  if (typeof reason !== "string" && !isSealedValue(reason)) {
    return invalid("argument.reason must be a string or a sealed value");
  }
  const evidenceResult = parseEvidenceEdges(evidence, "argument");
  if (!evidenceResult.ok) {
    return evidenceResult;
  }
  const supersedes = parseRecordIdList(
    fields["supersedes"],
    "argument",
    "supersedes",
    "empty when nothing is replaced",
  );
  if (!supersedes.ok) {
    return invalid(supersedes.error);
  }
  const premises = parseRecordIdList(
    fields["premises"],
    "argument",
    "premises",
    "empty when it rests on its evidence alone",
  );
  if (!premises.ok) {
    return invalid(premises.error);
  }
  const salt = parseSalt(fields, "argument");
  if (!salt.ok) {
    return salt;
  }
  const record: ArgumentDraft = {
    kind: "argument",
    target,
    reason: reason as SealableText,
    evidence: evidenceResult.edges,
    premises: premises.ids,
    supersedes: supersedes.ids,
    ...salt.field,
  };
  return { ok: true, record };
}

export const argumentContract: KindContract<"argument", ArgumentDraft> = {
  kind: "argument",
  version: 4,
  normalizers: {
    1: (fields) => ({ ...withoutSalt(fields), supersedes: [], premises: [] }),
    2: (fields) => ({ ...withoutSalt(fields), premises: [] }),
    3: withoutSalt,
  },
  numberPolicy: { schemaVersion: "measured" },
  sealedPaths: new Set(["$.reason"]),
  packMayDraft: true,
  saltable: true,
  validate: validateArgument,
};
