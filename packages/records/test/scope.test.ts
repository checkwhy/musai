import { describe, expect, test } from "vitest";
import { canonicalBytes, recordId } from "../src/canonical/canonicalize.js";
import { versionString } from "../src/canonical/numbers.js";
import type { Dimension } from "../src/conditions/dimension.js";
import {
  ANY_SCOPE,
  type CodedScopeReference,
  type CodedScopeResolver,
  coded,
  contains,
  EMPTY_SCOPE,
  except,
  from,
  narrowerThan,
  point,
  range,
  type Scope,
  set,
  UnresolvedCodedScopeError,
  until,
} from "../src/conditions/scope.js";

const SEVEN_CONSTRUCTORS: readonly Scope[] = [
  point(5),
  from(1),
  until(10),
  range(2, 8),
  set([1, 2, 3]),
  except(range(0, 10), point(5)),
  ANY_SCOPE,
];

/** A coded contribution naming even numbers, asked with no arguments. */
const EVEN: CodedScopeReference = { module: "musai.demo", name: "even", version: versionString("1"), args: {} };

/** A value line compared as exact decimals rather than as text. */
const NUMERIC_LINE: Dimension = { name: "line", type: "ordered", data: { order: "numeric" } };

describe("the closed scope algebra", () => {
  test("contains is exercised for every ordered pair of the seven constructors", () => {
    let pairsExercised = 0;
    for (const outer of SEVEN_CONSTRUCTORS) {
      for (const inner of SEVEN_CONSTRUCTORS) {
        expect(() => contains(outer, inner)).not.toThrow();
        pairsExercised += 1;
      }
    }
    expect(pairsExercised).toBe(SEVEN_CONSTRUCTORS.length * SEVEN_CONSTRUCTORS.length);
  });

  test("the universal scope contains every constructor, including itself", () => {
    for (const inner of SEVEN_CONSTRUCTORS) {
      expect(contains(ANY_SCOPE, inner)).toBe(true);
    }
  });

  test("every constructor contains the empty scope", () => {
    for (const outer of SEVEN_CONSTRUCTORS) {
      expect(contains(outer, EMPTY_SCOPE)).toBe(true);
    }
  });

  test("the empty scope contains only itself", () => {
    expect(contains(EMPTY_SCOPE, EMPTY_SCOPE)).toBe(true);
    expect(contains(EMPTY_SCOPE, point(5))).toBe(false);
    expect(contains(EMPTY_SCOPE, ANY_SCOPE)).toBe(false);
  });

  test("a scope carved out by a set does not contain a span the carved-out values fall inside", () => {
    const everywhereButFive = except(ANY_SCOPE, set(["5"]));
    // "5" lies inside "1".."9" but at neither endpoint: the shape an endpoint check gets wrong.
    expect(contains(everywhereButFive, ANY_SCOPE)).toBe(false);
    expect(contains(everywhereButFive, range("1", "9"))).toBe(false);
    expect(contains(everywhereButFive, range("6", "9"))).toBe(true);
    expect(contains(everywhereButFive, point("5"))).toBe(false);
    expect(contains(everywhereButFive, point("6"))).toBe(true);
  });

  test("an exclusion this algebra cannot subtract is treated as reaching the span, never as missing it", () => {
    // Neither can be ruled out of a span, so "everywhere but here" must not cover here.
    const nested = except(ANY_SCOPE, except(ANY_SCOPE, point("5")));
    expect(contains(nested, range("1", "9"))).toBe(false);

    const codedExclusion = except(
      ANY_SCOPE,
      coded({ module: "musai.demo", name: "even", version: versionString("1"), args: {} }),
    );
    expect(contains(codedExclusion, range("1", "9"))).toBe(false);
  });

  test("a coded scope asked to contain a span refuses by name rather than answering that it does not", () => {
    const evens = coded({ module: "musai.demo", name: "even", version: versionString("1"), args: {} });
    expect(() => contains(evens, range("1", "9"))).toThrow(UnresolvedCodedScopeError);
    expect(() => contains(evens, from("5"))).toThrow(UnresolvedCodedScopeError);
    expect(() => contains(evens, point("5"))).toThrow(UnresolvedCodedScopeError);
    expect(contains(evens, range("1", "9"), { resolver: (_scope, value) => value === "2" })).toBe(false);
  });

  test("except over the universal scope contains nothing", () => {
    const nothing = except(ANY_SCOPE, ANY_SCOPE);
    expect(contains(nothing, point(0))).toBe(false);
    expect(contains(nothing, point(-1))).toBe(false);
  });

  test("from and until both include their own bound", () => {
    expect(contains(from(5), point(5))).toBe(true);
    expect(contains(until(5), point(5))).toBe(true);
  });

  test("a range includes both of its endpoints", () => {
    expect(contains(range(1, 10), point(1))).toBe(true);
    expect(contains(range(1, 10), point(10))).toBe(true);
  });

  test("two ranges sharing only one endpoint neither contain nor are narrower than each other", () => {
    const lower = range(1, 5);
    const upper = range(5, 10);
    expect(contains(lower, upper)).toBe(false);
    expect(contains(upper, lower)).toBe(false);
    expect(narrowerThan(lower, upper)).toBe(false);
    expect(narrowerThan(upper, lower)).toBe(false);
  });

  test("neither of two scopes containing the other reports containment false in both directions", () => {
    const a = range(0, 5);
    const b = set([100, 200]);
    expect(contains(a, b)).toBe(false);
    expect(contains(b, a)).toBe(false);
  });

  test("a coded scope is a reference the caller's resolver decides, and is never narrower than anything", () => {
    const isEven = coded(EVEN);
    const resolver: CodedScopeResolver = (reference, value) =>
      reference.name === "even" && typeof value === "number" && value % 2 === 0;
    expect(contains(isEven, point(4), { resolver })).toBe(true);
    expect(contains(isEven, point(5), { resolver })).toBe(false);
    expect(narrowerThan(isEven, range(0, 100), { resolver })).toBe(false);
    expect(narrowerThan(range(0, 100), isEven, { resolver })).toBe(false);
    expect(narrowerThan(isEven, isEven, { resolver })).toBe(false);
  });

  test("evaluating a coded scope with no resolver refuses by name rather than guessing", () => {
    expect(() => contains(coded(EVEN), point(4))).toThrow(UnresolvedCodedScopeError);
    expect(() => contains(coded(EVEN), point(4))).toThrow("musai.demo/even@1");
  });

  test("a bound compares under the dimension the caller named, not under the algebra's own order", () => {
    // "9" is past "10" as text and inside it as a number, so the answer shows which was read.
    expect(contains(range("2", "10"), point("9"), { dimension: NUMERIC_LINE })).toBe(true);
    expect(contains(range("2", "10"), point("9"))).toBe(false);
    expect(narrowerThan(point("9"), range("2", "10"), { dimension: NUMERIC_LINE })).toBe(true);
    expect(narrowerThan(point("9"), range("2", "10"))).toBe(false);
  });

  test("an exclusion the named dimension cannot place against a span is treated as reaching it", () => {
    // A numeric order cannot place a word, so every undecided pair says the exclusion might reach.
    const exclusions: readonly (readonly [Scope, Scope])[] = [
      [except(ANY_SCOPE, point("alpha")), range("2", "10")],
      [except(ANY_SCOPE, set(["alpha"])), range("2", "10")],
      [except(ANY_SCOPE, set(["10"])), range("2", "alpha")],
      [except(ANY_SCOPE, range("alpha", "1")), range("2", "10")],
      [except(ANY_SCOPE, range("20", "alpha")), range("2", "10")],
      [except(ANY_SCOPE, from("alpha")), until("10")],
    ];
    for (const [outer, inner] of exclusions) {
      expect(contains(outer, inner, { dimension: NUMERIC_LINE })).toBe(false);
      expect(contains(outer, inner)).toBe(true);
    }
  });

  test("a scope contains its own bound under a dimension whose order cannot read it", () => {
    // Identity is settled before any order, so an unreadable bound still equals itself.
    for (const outer of [point("alpha"), set(["alpha"]), range("alpha", "alpha")]) {
      expect(contains(outer, point("alpha"), { dimension: NUMERIC_LINE })).toBe(true);
    }
  });

  test("two scopes the named dimension cannot place against each other are narrower in neither direction", () => {
    // The negated half is asked only once b contains a, so an undecided pair fails before it.
    const unplaceable: readonly (readonly [Scope, Scope])[] = [
      [point("5"), point("alpha")],
      [range("2", "10"), range("alpha", "beta")],
      [set(["5"]), set(["alpha"])],
    ];
    for (const [a, b] of unplaceable) {
      expect(narrowerThan(a, b, { dimension: NUMERIC_LINE })).toBe(false);
      expect(narrowerThan(b, a, { dimension: NUMERIC_LINE })).toBe(false);
    }
  });

  test("a value the named dimension cannot place against an exclusion's bounds is excluded, never admitted", () => {
    // A numeric order cannot place a word, so a span carved out around it must count it inside.
    for (const excluded of [range("1", "9"), from("1"), until("9")]) {
      expect(contains(except(ANY_SCOPE, excluded), point("alpha"), { dimension: NUMERIC_LINE })).toBe(false);
    }
  });

  test("an exclusion of single values takes out exactly those values, under a dimension that cannot place the rest", () => {
    // Membership is equality, decided exactly, so excluding a word excludes that word alone.
    for (const excluded of [point("alpha"), set(["alpha"]), range("alpha", "alpha")]) {
      const carvedOut = except(ANY_SCOPE, excluded);
      expect(contains(carvedOut, point("alpha"), { dimension: NUMERIC_LINE })).toBe(false);
      expect(contains(carvedOut, point("5"), { dimension: NUMERIC_LINE })).toBe(true);
    }
  });

  test("an exclusion of single values admits every distinct value under identity, a DAG and a hierarchy", () => {
    // Incomparable for two distinct values is a decided answer: they are not equal.
    const identity: Dimension = { name: "run", type: "identity", data: {} };
    const dag: Dimension = {
      name: "package",
      type: "dag",
      data: { edges: new Map([["engine@1.0.0", new Set(["engine@1.x"])]]) },
    };
    const hierarchy: Dimension = {
      name: "region",
      type: "hierarchical",
      data: {
        parentOf: new Map<string, string | null>([
          ["world", null],
          ["europe", "world"],
          ["asia", "world"],
        ]),
      },
    };
    const cases: readonly (readonly [Dimension, string, string])[] = [
      [identity, "a", "b"],
      [dag, "engine@1.0.0", "engine@2.0.0"],
      [dag, "engine@1.x", "engine@1.0.0"],
      [hierarchy, "europe", "asia"],
      [hierarchy, "europe", "world"],
    ];
    for (const [dimension, carved, other] of cases) {
      for (const excluded of [point(carved), set([carved])]) {
        const carvedOut = except(ANY_SCOPE, excluded);
        expect(contains(carvedOut, point(other), { dimension })).toBe(true);
        expect(contains(carvedOut, point(carved), { dimension })).toBe(false);
      }
    }
  });

  test("one value and the span of that value alone are decided alike against an exclusion", () => {
    // A point reaches the value arm and a one-value range the span arm; the two must agree.
    const pairs: readonly (readonly [Scope, string])[] = [
      [point("alpha"), "alpha"],
      [set(["alpha"]), "alpha"],
      [range("alpha", "alpha"), "alpha"],
      [set(["alpha"]), "5"],
      [range("1", "9"), "5"],
      [range("1", "9"), "alpha"],
    ];
    for (const [excluded, value] of pairs) {
      const carvedOut = except(ANY_SCOPE, excluded);
      expect(contains(carvedOut, point(value), { dimension: NUMERIC_LINE })).toBe(
        contains(carvedOut, range(value, value), { dimension: NUMERIC_LINE }),
      );
    }
  });

  test("an exclusion whose bounds admit nothing excludes no value, even one the dimension cannot place", () => {
    // An inverted range has no inside, so the value arm must agree the whole line is contained.
    const carvedOut = except(ANY_SCOPE, range("5", "2"));
    expect(contains(carvedOut, ANY_SCOPE, { dimension: NUMERIC_LINE })).toBe(true);
    for (const value of ["alpha", "3", "5", "2"]) {
      expect(contains(carvedOut, point(value), { dimension: NUMERIC_LINE })).toBe(true);
    }
  });

  test("an exclusion that itself carves a value back out leaves that value admitted", () => {
    // The nested difference takes 5 back out of the exclusion, under either order.
    const stillFive = except(ANY_SCOPE, except(range("1", "9"), point("5")));
    expect(contains(stillFive, point("5"))).toBe(true);
    expect(contains(stillFive, point("5"), { dimension: NUMERIC_LINE })).toBe(true);
    expect(contains(stillFive, point("3"))).toBe(false);
    expect(contains(stillFive, point("3"), { dimension: NUMERIC_LINE })).toBe(false);
  });

  test("a nested exclusion carves back only the values it decides, under a dimension that cannot place the rest", () => {
    // "alpha" might lie within 1 to 9, so it stays excluded unless the nested exclusion names it.
    const carvedAtFive = except(ANY_SCOPE, except(range("1", "9"), point("5")));
    const carvedAtAlpha = except(ANY_SCOPE, except(range("1", "9"), point("alpha")));
    expect(contains(carvedAtFive, point("alpha"), { dimension: NUMERIC_LINE })).toBe(false);
    expect(contains(carvedAtAlpha, point("alpha"), { dimension: NUMERIC_LINE })).toBe(true);
  });

  test("a coded scope is data, so it canonicalises and two spellings of one reference share an id", () => {
    const one = coded(EVEN);
    const other = coded({ args: EVEN.args, version: EVEN.version, name: EVEN.name, module: EVEN.module });
    expect(recordId(one)).toBe(recordId(other));
    expect(JSON.parse(new TextDecoder().decode(canonicalBytes(one)))).toEqual({
      kind: "coded",
      module: "musai.demo",
      name: "even",
      version: "1",
      args: {},
    });
  });
});

describe("a DAG dimension whose days expand to their hours", () => {
  const hours = (day: string) => [1, 2, 3].map((hour) => `${day}-h${hour}`);
  const [d1h1, d1h2, d1h3] = hours("d1") as [string, string, string];
  const [d2h1, d2h2, d2h3] = hours("d2") as [string, string, string];
  const chain = [d1h1, d1h2, d1h3, d2h1, d2h2, d2h3];
  const edges = new Map(chain.map((hour, index) => [hour, new Set(chain.slice(index + 1, index + 2))]));
  const expanded: Dimension = {
    name: "leg",
    type: "dag",
    data: {
      edges,
      expansions: new Map([
        ["day-1", { first: d1h1, last: d1h3 }],
        ["day-2", { first: d2h1, last: d2h3 }],
      ]),
    },
  };
  const plain: Dimension = { name: "leg", type: "dag", data: { edges } };
  const under = { dimension: expanded };

  test("a coarse value as a lower bound reads as its first node", () => {
    expect(contains(from("day-2"), point(d2h1), under)).toBe(true);
    expect(contains(from("day-2"), point(d1h3), under)).toBe(false);
  });

  test("a coarse value as an upper bound reads as its last node, so a day's range holds every hour of it", () => {
    for (const hour of [d2h1, d2h2, d2h3]) {
      expect(contains(range("day-2", "day-2"), point(hour), under)).toBe(true);
    }
    expect(contains(until("day-1"), point(d2h1), under)).toBe(false);
  });

  test("a coarse value asked about reads as its last node", () => {
    expect(contains(range(d1h2, d1h3), point("day-1"), under)).toBe(true);
    expect(contains(range(d1h1, d1h2), point("day-1"), under)).toBe(false);
  });

  test("a bare coarse point is equal to the day and its last hour and to nothing else", () => {
    expect(contains(point("day-2"), point(d2h3), under)).toBe(true);
    expect(contains(point("day-2"), point("day-2"), under)).toBe(true);
    expect(contains(point("day-2"), point(d2h1), under)).toBe(false);
  });

  test("a DAG with no expansions compares as it did, with a coarse value placed nowhere", () => {
    expect(contains(range(d1h1, d1h3), point(d1h2), { dimension: plain })).toBe(true);
    expect(contains(from("day-2"), point(d2h1), { dimension: plain })).toBe(false);
  });

  test("an exclusion of a coarse day carves out every hour of it", () => {
    const allButDayTwo = except(ANY_SCOPE, range("day-2", "day-2"));
    for (const hour of [d2h1, d2h2, d2h3]) {
      expect(contains(allButDayTwo, point(hour), under)).toBe(false);
    }
    expect(contains(allButDayTwo, point(d1h2), under)).toBe(true);
  });

  test("an hour span inside a day reads narrower than the day's span", () => {
    expect(narrowerThan(range(d2h1, d2h2), range("day-2", "day-2"), under)).toBe(true);
    expect(narrowerThan(range("day-2", "day-2"), range(d2h1, d2h2), under)).toBe(false);
  });
});
