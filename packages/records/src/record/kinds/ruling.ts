import { isRecordId, type RecordId } from "../../canonical/canonicalize.js";
import { isPlainObject } from "../../canonical/plain-object.js";
import { type Conditions, parseConditions } from "../../conditions/condition-value.js";
import type { DraftResult, KindContract } from "../contract.js";
import { invalid, parseRecordIdList, parseSalt, type Salted, withoutSalt } from "../fields.js";
import { isSealedValue, type SealableText } from "../sealed.js";

/** One claim, or a policy: every claim of a type whose conditions a scope contains. */
export type RulingExtent = { claim: RecordId } | { type: string; scope: Conditions };

/** A verdict over an extent. Who ruled, when and how live on the signing attestation; authority is
 * evaluated at each read, since a stored authority is a self-assertion nobody checks. */
export interface RulingRecord extends Salted {
  kind: "ruling";
  schemaVersion: number;
  over: RulingExtent;
  verdict: "holds" | "fails";
  reason: SealableText;
  brief: RecordId;
  /** The records this one replaces; a correction is a successor, never an edit. */
  supersedes: RecordId[];
}

export type RulingDraft = Omit<RulingRecord, "schemaVersion">;

const RULING_VERDICTS = ["holds", "fails"] as const;

/** Fields of an older ruling shape, refused by name rather than accepted under it. */
const RULING_REMOVED_FIELDS: Readonly<Record<string, string>> = {
  principal: "it moved to the attestation that signs it",
  authority: "it moved to the attestation that signs it",
  decidedAt: "it moved to the attestation that signs it",
  evidenceSnapshot: "it moved to the attestation that signs it",
  claim: "the claim it binds is named under over, alongside the other shape an extent takes",
};

function parseRulingExtent(
  value: unknown,
): { readonly ok: true; readonly over: RulingExtent } | { readonly ok: false; readonly error: string } {
  const admissible = "ruling.over must name either one claim, as { claim }, or a type at a scope, as { type, scope }";
  if (!isPlainObject(value)) {
    return { ok: false, error: admissible };
  }
  if ("claim" in value && !("type" in value) && !("scope" in value)) {
    if (!isRecordId(value["claim"])) {
      return { ok: false, error: "ruling.over.claim must be a record id" };
    }
    return { ok: true, over: { claim: value["claim"] } };
  }
  if ("type" in value && "scope" in value && !("claim" in value)) {
    if (typeof value["type"] !== "string") {
      return { ok: false, error: "ruling.over.type must be a string naming the claim type the ruling governs" };
    }
    const scope = parseConditions(value["scope"], "ruling.over.scope");
    if (!scope.ok) {
      return { ok: false, error: scope.error };
    }
    return { ok: true, over: { type: value["type"], scope: scope.conditions } };
  }
  return { ok: false, error: admissible };
}

function validateRuling(fields: Record<string, unknown>): DraftResult<RulingDraft> {
  for (const [removed, reason] of Object.entries(RULING_REMOVED_FIELDS)) {
    if (removed in fields) {
      return invalid(`ruling.${removed} no longer belongs on a ruling record: ${reason}`);
    }
  }
  const { verdict, reason, brief } = fields;
  const supersedes = parseRecordIdList(fields["supersedes"], "ruling", "supersedes", "empty when nothing is replaced");
  if (!supersedes.ok) {
    return invalid(supersedes.error);
  }
  const extent = parseRulingExtent(fields["over"]);
  if (!extent.ok) {
    return invalid(extent.error);
  }
  if (typeof verdict !== "string" || !(RULING_VERDICTS as readonly string[]).includes(verdict)) {
    return invalid("ruling.verdict must be one of holds, fails");
  }
  if (typeof reason !== "string" && !isSealedValue(reason)) {
    return invalid("ruling.reason must be a string or a sealed value");
  }
  if (!isRecordId(brief)) {
    return invalid("ruling.brief must be a record id naming the brief run whose reads are this ruling's evidence");
  }
  const salt = parseSalt(fields, "ruling");
  if (!salt.ok) {
    return salt;
  }
  const record: RulingDraft = {
    kind: "ruling",
    over: extent.over,
    verdict: verdict as RulingRecord["verdict"],
    reason: reason as SealableText,
    brief,
    supersedes: supersedes.ids,
    ...salt.field,
  };
  return { ok: true, record };
}

export const rulingContract: KindContract<"ruling", RulingDraft> = {
  kind: "ruling",
  version: 4,
  normalizers: {
    // The top-level claim moves into the extent, or the removed-fields check would refuse it.
    2: ({ claim, ...rest }) => ({ ...withoutSalt(rest), over: { claim }, supersedes: [] }),
    3: withoutSalt,
  },
  numberPolicy: { schemaVersion: "measured" },
  sealedPaths: new Set(["$.reason"]),
  packMayDraft: false,
  saltable: true,
  validate: validateRuling,
};
