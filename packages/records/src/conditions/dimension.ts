import { compareExactDecimal, isExactDecimal } from "../canonical/numbers.js";

export type DimensionType = "ordered" | "dag" | "hierarchical" | "interval" | "identity";

/** Closed, so a module names an order the kernel implements: a comparison function is code and
 * cannot travel as contribution data. */
export const DIMENSION_ORDERS = ["lexicographic", "numeric"] as const;

export type DimensionOrder = (typeof DIMENSION_ORDERS)[number];

export function isDimensionOrder(value: unknown): value is DimensionOrder {
  return DIMENSION_ORDERS.includes(value as DimensionOrder);
}

/** Four-way, never boolean: reading incomparable as equal would make specificity wrong. */
export type CompareResult = "equal" | "narrower" | "wider" | "incomparable";

/** An open, totally ordered domain, compared by the order it names. */
interface OrderedDimensionData {
  readonly order: DimensionOrder;
}

/** The first and last node a coarse value spans, such as a day's first and last hour. */
export interface Expansion {
  readonly first: string;
  readonly last: string;
}

/** An edge from `a` to `b` means `a` is narrower than `b`; an expansion names a coarse value that
 * is no node of the order. */
interface DagDimensionData {
  readonly edges: ReadonlyMap<string, ReadonlySet<string>>;
  readonly expansions?: ReadonlyMap<string, Expansion>;
}

/** Each value's parent, `null` at the root; a child is narrower than its ancestors. */
interface HierarchicalDimensionData {
  readonly parentOf: ReadonlyMap<string, string | null>;
}

/** Compares as an ordered dimension does; kept apart for what expanding an interval will mean. */
interface IntervalDimensionData {
  readonly order: DimensionOrder;
}

type IdentityDimensionData = Record<string, never>;

export type Dimension =
  | { readonly name: string; readonly type: "ordered"; readonly data: OrderedDimensionData }
  | { readonly name: string; readonly type: "dag"; readonly data: DagDimensionData }
  | { readonly name: string; readonly type: "hierarchical"; readonly data: HierarchicalDimensionData }
  | { readonly name: string; readonly type: "interval"; readonly data: IntervalDimensionData }
  | { readonly name: string; readonly type: "identity"; readonly data: IdentityDimensionData };

/** Dimensions by name; a name absent is compared under the algebra's own default. */
export type DimensionRegistry = ReadonlyMap<string, Dimension>;

function reachable(edges: ReadonlyMap<string, ReadonlySet<string>>, from: string, to: string): boolean {
  const visited = new Set<string>([from]);
  const queue: string[] = [from];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of edges.get(current) ?? []) {
      if (next === to) {
        return true;
      }
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

function isDescendantOf(parentOf: ReadonlyMap<string, string | null>, child: string, ancestor: string): boolean {
  const visited = new Set<string>([child]);
  let current: string | null = parentOf.get(child) ?? null;
  while (current !== null) {
    if (current === ancestor) {
      return true;
    }
    if (visited.has(current)) {
      return false;
    }
    visited.add(current);
    current = parentOf.get(current) ?? null;
  }
  return false;
}

/** A record rather than a chain of tests, so an order with no entry here does not compile. */
const ORDER_COMPARISONS: Readonly<Record<DimensionOrder, (a: unknown, b: unknown) => CompareResult>> = {
  lexicographic: (a, b) => {
    const left = String(a);
    const right = String(b);
    return left === right ? "equal" : left < right ? "narrower" : "wider";
  },
  numeric: (a, b) => {
    if (!isExactDecimal(a) || !isExactDecimal(b)) {
      return "incomparable";
    }
    const comparison = compareExactDecimal(a, b);
    return comparison === 0 ? "equal" : comparison < 0 ? "narrower" : "wider";
  },
};

/** Compares under the dimension's own order. A value the order cannot read is incomparable, never
 * coerced, and a value always equals itself. */
export function compareValues(dimension: Dimension, a: unknown, b: unknown): CompareResult {
  if (a === b) {
    return "equal";
  }
  if (dimension.type === "ordered" || dimension.type === "interval") {
    return ORDER_COMPARISONS[dimension.data.order](a, b);
  }
  if (dimension.type === "identity") {
    return "incomparable";
  }
  if (dimension.type === "dag") {
    const aKey = String(a);
    const bKey = String(b);
    if (reachable(dimension.data.edges, aKey, bKey)) {
      return "narrower";
    }
    if (reachable(dimension.data.edges, bKey, aKey)) {
      return "wider";
    }
    return "incomparable";
  }
  const aKey = String(a);
  const bKey = String(b);
  if (isDescendantOf(dimension.data.parentOf, aKey, bKey)) {
    return "narrower";
  }
  if (isDescendantOf(dimension.data.parentOf, bKey, aKey)) {
    return "wider";
  }
  return "incomparable";
}

/** Which node a coarse value reads as: a lower bound its first, an upper bound or a value asked
 * about its last. */
export type BoundSide = keyof Expansion;

/** A coarse value as the node at `side`; any other value, under any other dimension, as itself. */
export function readBySide(dimension: Dimension | undefined, value: unknown, side: BoundSide): unknown {
  if (dimension?.type !== "dag") {
    return value;
  }
  return dimension.data.expansions?.get(String(value))?.[side] ?? value;
}
