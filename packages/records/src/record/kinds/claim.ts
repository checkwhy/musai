import type { RecordId } from "../../canonical/canonicalize.js";
import { type Conditions, parseConditions } from "../../conditions/condition-value.js";
import { slotFor } from "../claim-types.js";
import type { DraftResult, KindContract, ValidationOptions } from "../contract.js";
import { type EvidenceEdge, parseEvidenceEdges } from "../evidence.js";
import { invalid, isStringArray, parseRecordIdList, parseSalt, type Salted, withoutSalt } from "../fields.js";
import { isSealedValue, type SealableText } from "../sealed.js";

/** Something a case says is true: the fixed surface every claim honours, whatever its payload. */
export interface ClaimRecord extends Salted {
  kind: "claim";
  schemaVersion: number;
  type: string;
  about: string[];
  slot: string;
  conditions: Conditions;
  canonical: unknown;
  rendering: SealableText;
  evidence: EvidenceEdge[];
  /** The exclusive gate group, or `null`: one member holding makes every sibling fail. */
  exclusiveGroup: string | null;
  /** The records this one replaces; a correction is a successor, never an edit. */
  supersedes: RecordId[];
}

export type ClaimDraft = Omit<ClaimRecord, "schemaVersion">;

/** Recomputes the slot rather than trusting it: a claim carrying an unearned slot would merge into
 * a claim it has nothing to do with. */
function validateClaim(fields: Record<string, unknown>, options: ValidationOptions): DraftResult<ClaimDraft> {
  const { type, about, slot, conditions, canonical, rendering, evidence, exclusiveGroup } = fields;
  const supersedes = parseRecordIdList(fields["supersedes"], "claim", "supersedes", "empty when nothing is replaced");
  if (!supersedes.ok) {
    return invalid(supersedes.error);
  }
  const salt = parseSalt(fields, "claim");
  if (!salt.ok) {
    return salt;
  }
  if (typeof type !== "string") {
    return invalid("claim.type must be a string");
  }
  if (!isStringArray(about)) {
    return invalid("claim.about must be an array of strings");
  }
  if (typeof slot !== "string") {
    return invalid("claim.slot must be a string");
  }
  const conditionsResult = parseConditions(conditions, "claim.conditions");
  if (!conditionsResult.ok) {
    return invalid(conditionsResult.error);
  }
  if (!("canonical" in fields)) {
    return invalid("claim.canonical is required");
  }
  if (typeof rendering !== "string" && !isSealedValue(rendering)) {
    return invalid("claim.rendering must be a string or a sealed value");
  }
  const evidenceResult = parseEvidenceEdges(evidence, "claim");
  if (!evidenceResult.ok) {
    return evidenceResult;
  }
  if (!("exclusiveGroup" in fields)) {
    return invalid("claim.exclusiveGroup is required");
  }
  if (exclusiveGroup !== null && typeof exclusiveGroup !== "string") {
    return invalid("claim.exclusiveGroup must be a string naming the sibling group, or null");
  }
  const declaration = options.claimTypes.get(type);
  if (declaration !== undefined) {
    for (const dimension of declaration.identityDimensions) {
      const value = conditionsResult.conditions[dimension];
      if (value !== undefined && typeof value !== "string") {
        return invalid(
          `claim.conditions.${dimension} is an identity dimension of ${type} and must be a bare string, since one meaning has one spelling and one slot`,
        );
      }
    }
    const computedSlot = slotFor(declaration, conditionsResult.conditions);
    if (slot !== computedSlot) {
      return invalid(
        `claim.slot ${JSON.stringify(slot)} does not match the slot its type and conditions compute: ${JSON.stringify(computedSlot)}`,
      );
    }
  } else if (options.unregisteredClaimTypes === "refuse") {
    return invalid(`claim names an unregistered type: ${type}`);
  }
  const record: ClaimDraft = {
    kind: "claim",
    type,
    about: [...about],
    slot,
    conditions: conditionsResult.conditions,
    canonical,
    rendering: rendering as SealableText,
    evidence: evidenceResult.edges,
    exclusiveGroup: exclusiveGroup as string | null,
    supersedes: supersedes.ids,
    ...salt.field,
  };
  return { ok: true, record };
}

export const claimContract: KindContract<"claim", ClaimDraft> = {
  kind: "claim",
  version: 4,
  normalizers: {
    // Every dimension of an older claim is a string, which the grammar reads as a point.
    2: (fields) => ({ ...withoutSalt(fields), supersedes: [] }),
    3: withoutSalt,
  },
  numberPolicy: { schemaVersion: "measured" },
  sealedPaths: new Set(["$.rendering"]),
  packMayDraft: true,
  saltable: true,
  validate: validateClaim,
};
