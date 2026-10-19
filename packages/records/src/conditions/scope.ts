import type { VersionString } from "../canonical/numbers.js";
import { KernelError } from "../reason/error.js";
import { type CompareResult, compareValues, type Dimension, readBySide } from "./dimension.js";

/** The contribution a coded scope names, and its arguments; no function rides on a scope. */
export interface CodedScopeReference {
  readonly module: string;
  readonly name: string;
  readonly version: VersionString;
  readonly args: unknown;
}

/** Whether the named contribution admits a value; the kernel supplies it, the algebra is pure. */
export type CodedScopeResolver = (reference: CodedScopeReference, value: unknown) => boolean;

/** What a comparison is made under; an absent `dimension` means the algebra's own order. */
export interface ScopeComparison {
  readonly dimension?: Dimension;
  readonly resolver?: CodedScopeResolver;
}

/** Raised rather than guessing: a coded scope read as admitting nothing or everything is a policy
 * that quietly does not apply. */
export class UnresolvedCodedScopeError extends KernelError {
  readonly reference: CodedScopeReference;

  constructor(reference: CodedScopeReference) {
    super({
      reason: "workspace-incomplete",
      detail: `no resolver was supplied for the coded scope ${reference.module}/${reference.name}@${reference.version}`,
      about: [`${reference.module}/${reference.name}@${reference.version}`],
    });
    this.name = "UnresolvedCodedScopeError";
    this.reference = reference;
  }
}

/** A closed algebra whose containment is computed, never declared; a coded scope names a
 * contribution rather than carrying it. */
export type Scope =
  | { readonly kind: "point"; readonly value: unknown }
  | { readonly kind: "from"; readonly value: unknown }
  | { readonly kind: "until"; readonly value: unknown }
  | { readonly kind: "range"; readonly from: unknown; readonly to: unknown }
  | { readonly kind: "set"; readonly values: readonly unknown[] }
  | { readonly kind: "except"; readonly base: Scope; readonly excluded: Scope }
  | { readonly kind: "any" }
  | ({ readonly kind: "coded" } & CodedScopeReference);

export function point(value: unknown): Scope {
  return { kind: "point", value };
}

export function from(value: unknown): Scope {
  return { kind: "from", value };
}

export function until(value: unknown): Scope {
  return { kind: "until", value };
}

export function range(rangeFrom: unknown, rangeTo: unknown): Scope {
  return { kind: "range", from: rangeFrom, to: rangeTo };
}

export function set(values: readonly unknown[]): Scope {
  return { kind: "set", values };
}

export function except(base: Scope, excluded: Scope): Scope {
  return { kind: "except", base, excluded };
}

export function coded(reference: CodedScopeReference): Scope {
  return {
    kind: "coded",
    module: reference.module,
    name: reference.name,
    version: reference.version,
    args: reference.args,
  };
}

/** The universal scope: contains every scope, including itself. */
export const ANY_SCOPE: Scope = { kind: "any" };

/** The empty scope: contained by every scope, and contains only itself. */
export const EMPTY_SCOPE: Scope = { kind: "set", values: [] };

function assertNever(value: never): never {
  throw new TypeError(`unreachable scope kind: ${JSON.stringify(value)}`);
}

function compareOrdered(a: unknown, b: unknown): number {
  if (a === b) {
    return 0;
  }
  if (typeof a === "number" && typeof b === "number") {
    return a < b ? -1 : 1;
  }
  if (typeof a === "string" && typeof b === "string") {
    return a < b ? -1 : 1;
  }
  const aText = String(a);
  const bText = String(b);
  return aText < bText ? -1 : aText > bText ? 1 : 0;
}

/** The one place a bound is compared: under the named dimension, else the algebra's own order. */
function compareBound(a: unknown, b: unknown, dimension?: Dimension): CompareResult {
  if (dimension !== undefined) {
    return compareValues(dimension, a, b);
  }
  const ordered = compareOrdered(a, b);
  return ordered === 0 ? "equal" : ordered < 0 ? "narrower" : "wider";
}

function atLeast(result: CompareResult): boolean {
  return result === "equal" || result === "wider";
}

function atMost(result: CompareResult): boolean {
  return result === "equal" || result === "narrower";
}

interface Bound {
  readonly value: unknown;
}

/** The bounds a point, from, until, range or any scope describes; `null` is unbounded. */
interface Interval {
  readonly lower: Bound | null;
  readonly upper: Bound | null;
}

/** Each bound read by its side: a point is one value, read as a value asked about. */
function intervalOf(
  scope: { readonly kind: "point" | "from" | "until" | "range" | "any" } & Scope,
  dimension?: Dimension,
): Interval {
  const first = (value: unknown): Bound => ({ value: readBySide(dimension, value, "first") });
  const last = (value: unknown): Bound => ({ value: readBySide(dimension, value, "last") });
  if (scope.kind === "point") {
    return { lower: last(scope.value), upper: last(scope.value) };
  }
  if (scope.kind === "from") {
    return { lower: first(scope.value), upper: null };
  }
  if (scope.kind === "until") {
    return { lower: null, upper: last(scope.value) };
  }
  if (scope.kind === "range") {
    return { lower: first(scope.from), upper: last(scope.to) };
  }
  return { lower: null, upper: null };
}

function isIntervalRepresentable(
  scope: Scope,
): scope is { readonly kind: "point" | "from" | "until" | "range" | "any" } & Scope {
  return (
    scope.kind === "point" ||
    scope.kind === "from" ||
    scope.kind === "until" ||
    scope.kind === "range" ||
    scope.kind === "any"
  );
}

function intervalContainsInterval(outer: Interval, inner: Interval, comparison?: ScopeComparison): boolean {
  const dimension = comparison?.dimension;
  const lowerOk =
    outer.lower === null ||
    (inner.lower !== null && atLeast(compareBound(inner.lower.value, outer.lower.value, dimension)));
  const upperOk =
    outer.upper === null ||
    (inner.upper !== null && atMost(compareBound(inner.upper.value, outer.upper.value, dimension)));
  return lowerOk && upperOk;
}

/** Whether a scope admits one value, exactly. An unplaceable value is not admitted, so `except`
 * asks its excluded side through `mightAdmit`, since that answer is negated. */
function admits(scope: Scope, value: unknown, comparison?: ScopeComparison): boolean {
  const dimension = comparison?.dimension;
  if (isIntervalRepresentable(scope)) {
    const { lower, upper } = intervalOf(scope, dimension);
    const asked = readBySide(dimension, value, "last");
    if (scope.kind === "point") {
      return compareBound(lower!.value, asked, dimension) === "equal";
    }
    return (
      (lower === null || atLeast(compareBound(asked, lower.value, dimension))) &&
      (upper === null || atMost(compareBound(asked, upper.value, dimension)))
    );
  }
  if (scope.kind === "set") {
    const asked = readBySide(dimension, value, "last");
    return scope.values.some(
      (candidate) => compareBound(readBySide(dimension, candidate, "last"), asked, dimension) === "equal",
    );
  }
  if (scope.kind === "except") {
    return admits(scope.base, value, comparison) && !mightAdmit(scope.excluded, value, comparison);
  }
  if (scope.kind === "coded") {
    const resolver = comparison?.resolver;
    if (resolver === undefined) {
      throw new UnresolvedCodedScopeError(scope);
    }
    return resolver(scope, value);
  }
  return assertNever(scope);
}

/** Whether a scope might admit a value, sound under negation: an unplaceable value counts as in.
 * A set is asked exactly, since every dimension decides equality exactly. */
function mightAdmit(scope: Scope, value: unknown, comparison?: ScopeComparison): boolean {
  if (scope.kind === "set") {
    return admits(scope, value, comparison);
  }
  if (scope.kind === "except") {
    // The negated exclusion is read exactly, so a value only possibly excluded stays possibly in.
    return mightAdmit(scope.base, value, comparison) && !admits(scope.excluded, value, comparison);
  }
  if (scope.kind === "coded") {
    const resolver = comparison?.resolver;
    if (resolver === undefined) {
      throw new UnresolvedCodedScopeError(scope);
    }
    return resolver(scope, value);
  }
  return intervalAdmits(intervalOf(scope, comparison?.dimension), value, comparison);
}

/** The interval half of `mightAdmit`: an unplaceable value is inside. Inverted bounds admit
 * nothing, and equal bounds admit that one value only. */
function intervalAdmits(interval: Interval, asked: unknown, comparison?: ScopeComparison): boolean {
  const dimension = comparison?.dimension;
  const value = readBySide(dimension, asked, "last");
  if (interval.lower !== null && interval.upper !== null) {
    const bounds = compareBound(interval.lower.value, interval.upper.value, dimension);
    if (bounds === "wider") {
      return false;
    }
    if (bounds === "equal") {
      return compareBound(value, interval.lower.value, dimension) === "equal";
    }
  }
  if (interval.lower !== null) {
    const lower = compareBound(value, interval.lower.value, dimension);
    if (lower === "incomparable") {
      return true;
    }
    if (!atLeast(lower)) {
      return false;
    }
  }
  if (interval.upper !== null) {
    const upper = compareBound(value, interval.upper.value, dimension);
    if (upper === "incomparable") {
      return true;
    }
    if (!atMost(upper)) {
      return false;
    }
  }
  return true;
}

/** Whether an `except`'s excluded side might overlap a span. Undecidable cases answer yes: a wrong
 * no would let a policy apply where its author excluded it. */
function excludedOverlapsInterval(excluded: Scope, interval: Interval, comparison?: ScopeComparison): boolean {
  if (excluded.kind === "set") {
    return excluded.values.some((value) => intervalAdmits(interval, value, comparison));
  }
  if (isIntervalRepresentable(excluded)) {
    const dimension = comparison?.dimension;
    const excludedInterval = intervalOf(excluded, dimension);
    let lowerBound: Bound | null;
    if (excludedInterval.lower === null) {
      lowerBound = interval.lower;
    } else if (interval.lower === null) {
      lowerBound = excludedInterval.lower;
    } else {
      const lowers = compareBound(excludedInterval.lower.value, interval.lower.value, dimension);
      if (lowers === "incomparable") {
        return true;
      }
      lowerBound = atLeast(lowers) ? excludedInterval.lower : interval.lower;
    }
    let upperBound: Bound | null;
    if (excludedInterval.upper === null) {
      upperBound = interval.upper;
    } else if (interval.upper === null) {
      upperBound = excludedInterval.upper;
    } else {
      const uppers = compareBound(excludedInterval.upper.value, interval.upper.value, dimension);
      if (uppers === "incomparable") {
        return true;
      }
      upperBound = atMost(uppers) ? excludedInterval.upper : interval.upper;
    }
    if (lowerBound === null || upperBound === null) {
      return true;
    }
    const spans = compareBound(lowerBound.value, upperBound.value, dimension);
    if (spans === "incomparable") {
      return true;
    }
    return atMost(spans);
  }
  return true;
}

/** Whether `outer` admits every value `inner` admits. Total over every pair of kinds; a pair it
 * cannot decide exactly takes the sound approximation. */
export function contains(outer: Scope, inner: Scope, comparison?: ScopeComparison): boolean {
  if (inner.kind === "point") {
    return admits(outer, inner.value, comparison);
  }
  if (inner.kind === "set") {
    return inner.values.every((value) => admits(outer, value, comparison));
  }
  if (inner.kind === "coded") {
    return outer.kind === "any";
  }
  if (inner.kind === "except") {
    return contains(outer, inner.base, comparison);
  }
  // inner is point/from/until/range/any: interval-representable.
  const innerInterval = intervalOf(
    inner as { readonly kind: "point" | "from" | "until" | "range" | "any" } & Scope,
    comparison?.dimension,
  );
  if (isIntervalRepresentable(outer)) {
    return intervalContainsInterval(intervalOf(outer, comparison?.dimension), innerInterval, comparison);
  }
  if (outer.kind === "set") {
    return false;
  }
  if (outer.kind === "coded") {
    // Without a resolver this refuses as `admits` does; with one, a span still cannot be walked.
    if (comparison?.resolver === undefined) {
      throw new UnresolvedCodedScopeError(outer);
    }
    return false;
  }
  // Sound only if the base covers inner and the exclusion cannot touch it.
  return (
    contains(outer.base, inner, comparison) && !excludedOverlapsInterval(outer.excluded, innerInterval, comparison)
  );
}

/** Whether `b` contains `a` and not the reverse; a coded scope is never narrower. An order that
 * cannot place a bound can call equal extents narrower; specificity passes no dimension. */
export function narrowerThan(a: Scope, b: Scope, comparison?: ScopeComparison): boolean {
  if (a.kind === "coded" || b.kind === "coded") {
    return false;
  }
  return contains(b, a, comparison) && !contains(a, b, comparison);
}
