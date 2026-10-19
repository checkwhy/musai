import { canonicalBytes } from "../canonical/canonicalize.js";
import { isVersionString, type VersionString } from "../canonical/numbers.js";
import { isPlainObject } from "../canonical/plain-object.js";
import type { DimensionRegistry } from "./dimension.js";
import { contains, point, type Scope } from "./scope.js";

/** Always a string: the number policy does not walk conditions, so a bound `2.10` would become
 * `2.1`. */
export type ScopeBound = string;

/** A scope as a record spells it. A point is a bare string, so one meaning has one spelling and
 * one id. */
export type ScopeValue =
  | { readonly kind: "from"; readonly value: ScopeBound }
  | { readonly kind: "until"; readonly value: ScopeBound }
  | { readonly kind: "range"; readonly from: ScopeBound; readonly to: ScopeBound }
  | { readonly kind: "set"; readonly values: readonly ScopeBound[] }
  | { readonly kind: "except"; readonly base: ScopeValue; readonly excluded: ScopeValue }
  | { readonly kind: "any" }
  | {
      readonly kind: "coded";
      readonly module: string;
      readonly name: string;
      readonly version: VersionString;
      readonly args: unknown;
    };

/** What one dimension holds: a point, spelled as a bare string, or a scope. */
export type ConditionValue = string | ScopeValue;

/** What a claim holds under, or what a rule applies under: one value per dimension. */
export type Conditions = Record<string, ConditionValue>;

const SCOPE_KINDS = ["from", "until", "range", "set", "except", "any", "coded"] as const;

export type ParseConditionsResult =
  | { readonly ok: true; readonly conditions: Conditions }
  | { readonly ok: false; readonly error: string };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

type ParsedScope = { readonly ok: true; readonly scope: ScopeValue } | { readonly ok: false; readonly error: string };

/** Rebuilds a scope from its known fields alone, so a stray field cannot mint a second id. */
function parseScopeValue(value: unknown, path: string): ParsedScope {
  if (!isPlainObject(value)) {
    return { ok: false, error: `${path} must be a bare string naming a point, or an object naming a scope` };
  }
  const kind = value["kind"];
  if (kind === "point") {
    return {
      ok: false,
      error: `${path} spells a point as an object; a point is a bare string, and a point inside a scope is a one-member set`,
    };
  }
  if (typeof kind !== "string" || !(SCOPE_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: `${path} names a scope kind outside ${SCOPE_KINDS.join(", ")}: ${String(kind)}` };
  }

  if (kind === "any") {
    return { ok: true, scope: { kind: "any" } };
  }
  if (kind === "from" || kind === "until") {
    const bound = value["value"];
    if (typeof bound !== "string") {
      return { ok: false, error: `${path}.value must be a string, since a record's bounds are exact` };
    }
    return { ok: true, scope: { kind, value: bound } };
  }
  if (kind === "range") {
    const lower = value["from"];
    const upper = value["to"];
    if (typeof lower !== "string" || typeof upper !== "string") {
      return { ok: false, error: `${path} must carry from and to as strings, since a record's bounds are exact` };
    }
    return { ok: true, scope: { kind, from: lower, to: upper } };
  }
  if (kind === "set") {
    const values = value["values"];
    if (!isStringArray(values)) {
      return { ok: false, error: `${path}.values must be an array of strings` };
    }
    return { ok: true, scope: { kind, values: [...values] } };
  }
  if (kind === "except") {
    const base = parseScopeValue(value["base"], `${path}.base`);
    if (!base.ok) {
      return base;
    }
    const excluded = parseScopeValue(value["excluded"], `${path}.excluded`);
    if (!excluded.ok) {
      return excluded;
    }
    return { ok: true, scope: { kind, base: base.scope, excluded: excluded.scope } };
  }
  const module = value["module"];
  const name = value["name"];
  const version = value["version"];
  if (typeof module !== "string" || typeof name !== "string" || !isVersionString(version)) {
    return {
      ok: false,
      error: `${path} must name the module, contribution and version of the coded scope it refers to`,
    };
  }
  if (!("args" in value)) {
    return {
      ok: false,
      error: `${path} must carry the args the coded scope is asked under, empty where it takes none`,
    };
  }
  return { ok: true, scope: { kind: "coded", module, name, version, args: value["args"] } };
}

/** Reads a per-dimension map of conditions, keeping only what the grammar admits. */
export function parseConditions(value: unknown, context: string): ParseConditionsResult {
  if (!isPlainObject(value)) {
    return { ok: false, error: `${context} must be an object naming one value per dimension` };
  }
  const conditions: Conditions = {};
  for (const [dimension, condition] of Object.entries(value)) {
    if (typeof condition === "string") {
      conditions[dimension] = condition;
      continue;
    }
    const parsed = parseScopeValue(condition, `${context}.${dimension}`);
    if (!parsed.ok) {
      return parsed;
    }
    conditions[dimension] = parsed.scope;
  }
  return { ok: true, conditions };
}

export function scopeOfCondition(value: ConditionValue): Scope {
  return typeof value === "string" ? point(value) : value;
}

/** Whether a scope contains what a claim holds on every dimension it names; a dimension missing
 * from `held` is out of scope. */
export function scopeAdmits(
  scope: Readonly<Conditions>,
  held: Readonly<Conditions>,
  dimensions: DimensionRegistry,
): boolean {
  return Object.entries(scope).every(([dimension, declared]) => {
    const value = held[dimension];
    return (
      value !== undefined &&
      contains(scopeOfCondition(declared), scopeOfCondition(value), { dimension: dimensions.get(dimension) })
    );
  });
}

/** A condition's text for a content identity; a scope reads as its canonical bytes. */
export function conditionReadText(value: ConditionValue): string {
  return typeof value === "string" ? value : new TextDecoder().decode(canonicalBytes(value));
}

/** The point one dimension holds, for a reader that cannot act on a span; a scope there throws. */
export function conditionString(conditions: Readonly<Conditions>, key: string): string | undefined {
  const value = conditions[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new RangeError(`the condition ${key} holds a scope, and this reader needs the single value a point names`);
  }
  return value;
}
