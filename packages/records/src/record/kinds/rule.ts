import type { RecordId } from "../../canonical/canonicalize.js";
import { type ExactDecimal, isExactDecimal } from "../../canonical/numbers.js";
import { type Conditions, parseConditions } from "../../conditions/condition-value.js";
import type { DraftResult, KindContract } from "../contract.js";
import { invalid, parseRecordIdList } from "../fields.js";

/** A rule a module seeds, or a lesson the retro writes. The weight is exact digits, since it is
 * hashed into the id. */
export interface RuleRecord {
  kind: "rule";
  schemaVersion: number;
  name: string;
  scope: Conditions;
  weight: ExactDecimal;
  /** The records this one replaces; a correction is a successor, never an edit. */
  supersedes: RecordId[];
  /** The contribution whose policy this states; null for a lesson, which applies by scope alone. */
  contribution: string | null;
}

export type RuleDraft = Omit<RuleRecord, "schemaVersion">;

function validateRule(fields: Record<string, unknown>): DraftResult<RuleDraft> {
  const { name, scope, weight, contribution } = fields;
  if (typeof name !== "string") {
    return invalid("rule.name must be a string");
  }
  if (!("scope" in fields)) {
    return invalid("rule.scope is required");
  }
  const scopeResult = parseConditions(scope, "rule.scope");
  if (!scopeResult.ok) {
    return invalid(scopeResult.error);
  }
  if (!isExactDecimal(weight)) {
    return invalid("rule.weight must be carried as digits in a string, not a bare number");
  }
  const supersedes = parseRecordIdList(fields["supersedes"], "rule", "supersedes", "empty when nothing is replaced");
  if (!supersedes.ok) {
    return invalid(supersedes.error);
  }
  if (!("contribution" in fields)) {
    return invalid("rule.contribution is required");
  }
  if (contribution !== null && (typeof contribution !== "string" || contribution.length === 0)) {
    return invalid(
      "rule.contribution must be the contribution id whose policy the record states, or null for a lesson",
    );
  }
  const record: RuleDraft = {
    kind: "rule",
    name,
    scope: scopeResult.conditions,
    weight,
    supersedes: supersedes.ids,
    contribution,
  };
  return { ok: true, record };
}

export const ruleContract: KindContract<"rule", RuleDraft> = {
  kind: "rule",
  version: 3,
  normalizers: {
    // No writer minted a v1 rule; its scope is left for the validator, and it reads as a lesson.
    1: (fields) => ({ ...fields, supersedes: [], contribution: null }),
    // A rule written before the field existed named no contribution.
    2: (fields) => ({ ...fields, contribution: null }),
  },
  numberPolicy: { schemaVersion: "measured", weight: "exact" },
  sealedPaths: new Set(),
  packMayDraft: false,
  saltable: false,
  validate: validateRule,
};
