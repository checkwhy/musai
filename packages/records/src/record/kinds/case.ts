import { isRecordId, type RecordId } from "../../canonical/canonicalize.js";
import { isVersionString, type VersionString } from "../../canonical/numbers.js";
import { isPlainObject } from "../../canonical/plain-object.js";
import type { DraftResult, KindContract } from "../contract.js";
import { invalid, isRecordIdArray, parseRecordIdList, parseSalt, type Salted, withoutSalt } from "../fields.js";

/** The preset a case ran under, with the module record resolved at booking. */
export interface PresetReference {
  module: string;
  contribution: string;
  moduleRecord: RecordId;
}

/** One piece of work and the layers it was booked under. A slot's value is derived from them at
 * read time, never stored, so the two cannot disagree. */
export interface CaseRecord extends Salted {
  kind: "case";
  schemaVersion: number;
  slug: string;
  /** The contribution id of the kind this case was booked under, or `null` when booked bare. */
  type: string | null;
  claims: RecordId[];
  preset: PresetReference;
  projectCommit: string;
  overrides: Record<string, unknown>;
  evaluatorVersion: VersionString;
  /** The records this one replaces; a correction is a successor, never an edit. */
  supersedes: RecordId[];
}

export type CaseDraft = Omit<CaseRecord, "schemaVersion">;

const CASE_EFFECTIVE_VALUE_FIELDS = ["effective", "effectiveSlots", "resolvedSlots"] as const;

function validateCase(fields: Record<string, unknown>): DraftResult<CaseDraft> {
  const { slug, type, claims, preset, projectCommit, overrides, evaluatorVersion } = fields;
  if (typeof slug !== "string") {
    return invalid("case.slug must be a string");
  }
  if (type !== null && typeof type !== "string") {
    return invalid(
      "case.type must be the contribution id of the kind this case was booked under, or null where it was booked bare",
    );
  }
  if (!isRecordIdArray(claims)) {
    return invalid("case.claims must be an array of record ids");
  }
  for (const field of CASE_EFFECTIVE_VALUE_FIELDS) {
    if (field in fields) {
      return invalid(
        `case must not carry ${field}: the effective value of a slot is derived from its layers at read time and never stored`,
      );
    }
  }
  if (!isPlainObject(preset)) {
    return invalid("case.preset must be an object naming module, contribution and moduleRecord");
  }
  if (typeof preset["module"] !== "string") {
    return invalid("case.preset must carry module as a string");
  }
  if (typeof preset["contribution"] !== "string") {
    return invalid("case.preset must carry contribution as a string");
  }
  if (!isRecordId(preset["moduleRecord"])) {
    return invalid("case.preset must carry moduleRecord as a record id");
  }
  if (typeof projectCommit !== "string") {
    return invalid("case.projectCommit must be a string naming the trust branch's commit");
  }
  if (!isPlainObject(overrides)) {
    return invalid("case.overrides must be an object");
  }
  if (!isVersionString(evaluatorVersion)) {
    return invalid(
      "case.evaluatorVersion must be a non-empty string with no whitespace, naming the kernel version this case was booked under",
    );
  }
  const supersedes = parseRecordIdList(fields["supersedes"], "case", "supersedes", "empty when nothing is replaced");
  if (!supersedes.ok) {
    return invalid(supersedes.error);
  }
  const salt = parseSalt(fields, "case");
  if (!salt.ok) {
    return salt;
  }
  const record: CaseDraft = {
    kind: "case",
    slug,
    type,
    claims: [...claims],
    preset: { module: preset["module"], contribution: preset["contribution"], moduleRecord: preset["moduleRecord"] },
    projectCommit,
    overrides: { ...overrides },
    evaluatorVersion,
    supersedes: supersedes.ids,
    ...salt.field,
  };
  return { ok: true, record };
}

export const caseContract: KindContract<"case", CaseDraft> = {
  kind: "case",
  version: 5,
  normalizers: {
    // No kind existed to book an older case under, so it was booked bare.
    2: (fields) => ({ ...withoutSalt(fields), supersedes: [], type: null }),
    3: (fields) => ({ ...withoutSalt(fields), type: null }),
    4: withoutSalt,
  },
  numberPolicy: { schemaVersion: "measured" },
  sealedPaths: new Set(),
  packMayDraft: true,
  saltable: true,
  validate: validateCase,
};
