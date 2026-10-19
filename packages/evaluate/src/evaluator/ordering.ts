import type { DimensionRegistry } from "@musai/records";
import {
  type Conditions,
  compareExactDecimal,
  type ExactDecimal,
  narrowerThan,
  type Scope,
  scopeAdmits,
} from "@musai/records";
import { EVIDENCE_ORDER, type EvidenceKind } from "./evidence.js";

/** Whether a rule's scope admits the claim's conditions; a dimension the claim lacks never does. */
export function applicability(
  rule: Readonly<Conditions>,
  conditions: Readonly<Conditions>,
  dimensions: DimensionRegistry,
): boolean {
  return scopeAdmits(rule, conditions, dimensions);
}

export type SignatureRequirement = "required" | "optional";

export interface ValidityRegistry {
  readonly knownClaimTypes: ReadonlySet<string>;
  readonly requiresSignatureFor: (claimType: string) => boolean;
}

export interface ValidityInput {
  readonly claimType: string;
  readonly signed: boolean;
  readonly rule: Readonly<Conditions>;
  readonly conditions: Readonly<Conditions>;
  readonly dimensions: DimensionRegistry;
  /** The contribution whose rule record declares `rule`; `null` where no record does. */
  readonly contribution: string | null;
}

/** Decided before anything is weighed; neither refusal is a weaker "valid". */
export type Validity =
  | { readonly outcome: "valid" }
  | { readonly outcome: "rejected"; readonly reason: string }
  | { readonly outcome: "inapplicable"; readonly reason: string };

function outOfScopeReason(input: ValidityInput): string {
  const [dimension] = Object.entries(input.rule)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .find(([name, value]) => !applicability({ [name]: value }, input.conditions, input.dimensions))!;
  const declaredBy = input.contribution === null ? "its rule" : `the rule record for ${input.contribution}`;
  return input.conditions[dimension] === undefined
    ? `condition out of scope for ${input.claimType}: it names no ${dimension}, which ${declaredBy} scopes`
    : `condition out of scope for ${input.claimType}: its ${dimension} falls outside the scope ${declaredBy} declares`;
}

export function validity(
  input: ValidityInput,
  signatureRequirement: SignatureRequirement,
  registry: ValidityRegistry,
): Validity {
  if (!registry.knownClaimTypes.has(input.claimType)) {
    return { outcome: "rejected", reason: `unknown claim type: ${input.claimType}` };
  }
  if (!applicability(input.rule, input.conditions, input.dimensions)) {
    return { outcome: "inapplicable", reason: outOfScopeReason(input) };
  }
  const signatureRequired = signatureRequirement === "required" || registry.requiresSignatureFor(input.claimType);
  if (signatureRequired && !input.signed) {
    return { outcome: "rejected", reason: `unsigned input where signing is required: ${input.claimType}` };
  }
  return { outcome: "valid" };
}

export interface Argument {
  readonly id: string;
  readonly evidenceKind: EvidenceKind;
  readonly scope: Scope;
  readonly declaredWeight: ExactDecimal;
}

export type OrderingWinner = "a" | "b" | "open";

export interface Ordering {
  readonly winner: OrderingWinner;
  readonly decidedBy: "evidence-kind" | "specificity" | "weight" | "equal";
  readonly reason: string;
}

/** Kind, then specificity, then weight, else open; a scope names no dimension, so specificity
 * uses the algebra's own order. */
export function compareArguments(a: Argument, b: Argument): Ordering {
  const rankA = EVIDENCE_ORDER.indexOf(a.evidenceKind);
  const rankB = EVIDENCE_ORDER.indexOf(b.evidenceKind);
  if (rankA !== rankB) {
    const aWins = rankA < rankB;
    return {
      winner: aWins ? "a" : "b",
      decidedBy: "evidence-kind",
      reason: `${aWins ? a.evidenceKind : b.evidenceKind} outranks ${aWins ? b.evidenceKind : a.evidenceKind}`,
    };
  }

  if (narrowerThan(a.scope, b.scope)) {
    return { winner: "a", decidedBy: "specificity", reason: "a's scope is narrower than b's" };
  }
  if (narrowerThan(b.scope, a.scope)) {
    return { winner: "b", decidedBy: "specificity", reason: "b's scope is narrower than a's" };
  }

  const weightComparison = compareExactDecimal(a.declaredWeight, b.declaredWeight);
  if (weightComparison !== 0) {
    return {
      winner: weightComparison > 0 ? "a" : "b",
      decidedBy: "weight",
      reason: "declared weight decided between arguments equal in evidence kind and specificity",
    };
  }

  return {
    winner: "open",
    decidedBy: "equal",
    reason: "equal in evidence kind, specificity and declared weight",
  };
}
