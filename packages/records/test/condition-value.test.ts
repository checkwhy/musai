import { describe, expect, test } from "vitest";
import { recordId } from "../src/canonical/canonicalize.js";
import { versionString } from "../src/canonical/numbers.js";
import {
  type Conditions,
  conditionReadText,
  conditionString,
  parseConditions,
  scopeAdmits,
  scopeOfCondition,
} from "../src/conditions/condition-value.js";
import type { DimensionRegistry } from "../src/conditions/dimension.js";
import { contains, point, UnresolvedCodedScopeError } from "../src/conditions/scope.js";

function parsed(value: unknown): Conditions {
  const result = parseConditions(value, "claim.conditions");
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.conditions;
}

function refusal(value: unknown): string {
  const result = parseConditions(value, "claim.conditions");
  if (result.ok) {
    throw new Error("expected these conditions to be refused");
  }
  return result.error;
}

describe("what one dimension may hold", () => {
  test("a bare string is a point, and an object spelling a point is refused wherever it sits", () => {
    expect(scopeOfCondition(parsed({ platform: "linux" })["platform"]!)).toEqual(point("linux"));

    expect(refusal({ platform: { kind: "point", value: "linux" } })).toContain("a point is a bare string");
    expect(
      refusal({ chapter: { kind: "except", base: { kind: "any" }, excluded: { kind: "point", value: "3" } } }),
    ).toContain("a point is a bare string");
  });

  test("every scope the algebra has except a point is sayable, and a kind outside it is refused by name", () => {
    const conditions = parsed({
      chapter: { kind: "range", from: "01", to: "09" },
      since: { kind: "from", value: "2026-01-01" },
      until: { kind: "until", value: "2026-12-31" },
      platform: { kind: "set", values: ["linux", "darwin"] },
      anything: { kind: "any" },
      weekday: { kind: "except", base: { kind: "any" }, excluded: { kind: "set", values: ["sat", "sun"] } },
      team: { kind: "coded", module: "musai.demo", name: "in-team", version: "1", args: { team: "platform" } },
    });
    expect(Object.keys(conditions)).toHaveLength(7);
    expect(contains(scopeOfCondition(conditions["chapter"]!), point("05"))).toBe(true);
    expect(contains(scopeOfCondition(conditions["chapter"]!), point("11"))).toBe(false);

    expect(refusal({ chapter: { kind: "roughly", value: "5" } })).toContain("names a scope kind outside");
  });

  test("a bound that is not a string is refused, since a record's bounds carry no exactness a number could keep", () => {
    expect(refusal({ version: { kind: "from", value: 2.1 } })).toContain("must be a string");
    expect(refusal({ chapter: { kind: "range", from: 1, to: 9 } })).toContain("must carry from and to as strings");
    expect(refusal({ platform: { kind: "set", values: ["linux", 3] } })).toContain("must be an array of strings");
  });

  test("a scope is rebuilt from its known fields, so a foreign key on it is never carried", () => {
    const conditions = parsed({ anything: { kind: "any", note: "a field the grammar does not know" } });
    expect(conditions["anything"]).toEqual({ kind: "any" });
  });

  test("a coded scope must name the contribution it refers to and the arguments it is asked under", () => {
    expect(refusal({ team: { kind: "coded", module: "musai.demo", name: "in-team", args: {} } })).toContain(
      "must name the module, contribution and version",
    );
    expect(refusal({ team: { kind: "coded", module: "musai.demo", name: "in-team", version: "1" } })).toContain(
      "must carry the args",
    );
  });
});

describe("what a reader makes of a condition", () => {
  test("a scope's read text is its canonical text, so two spellings of one scope read as one", () => {
    const one = parsed({ chapter: { kind: "range", from: "01", to: "09" } })["chapter"]!;
    const other = parsed({ chapter: { to: "09", kind: "range", from: "01" } })["chapter"]!;
    expect(conditionReadText(one)).toBe(conditionReadText(other));
    expect(recordId(one)).toBe(recordId(other));
    expect(conditionReadText(one)).toBe('{"from":"01","kind":"range","to":"09"}');
  });

  test("a point's read text is the string itself, unquoted", () => {
    expect(conditionReadText("linux")).toBe("linux");
  });

  test("a reader that asks for a string at a scope-valued key refuses rather than stringifying", () => {
    const conditions = parsed({ sink: "github", chapter: { kind: "range", from: "01", to: "09" } });
    expect(conditionString(conditions, "sink")).toBe("github");
    expect(conditionString(conditions, "absent")).toBeUndefined();
    expect(() => conditionString(conditions, "chapter")).toThrow(RangeError);
    expect(() => conditionString(conditions, "chapter")).toThrow("chapter");
  });
});

describe("what a rule's scope may hold", () => {
  test("a rule's scope is read by the same grammar a claim's conditions are", () => {
    const result = parseConditions({ version: { kind: "from", value: versionString("2.0") } }, "rule.scope");
    expect(result).toMatchObject({ ok: true });
  });

  test("a scope that is not a per-dimension map at all is refused naming the field", () => {
    const result = parseConditions(["linux"], "rule.scope");
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? "" : result.error).toContain("rule.scope must be an object");
  });
});

describe("what a scope admits", () => {
  const numeric: DimensionRegistry = new Map([
    ["chapter", { name: "chapter", type: "ordered", data: { order: "numeric" } }],
  ]);
  const chapters: Conditions = { chapter: { kind: "range", from: "2", to: "10" } };

  test("a scope is compared under the dimension declared for it, and under the algebra's own order where none is", () => {
    // "9" is numerically inside 2..10 and sorts past "10" as text.
    expect(scopeAdmits(chapters, { chapter: "9" }, numeric)).toBe(true);
    expect(scopeAdmits(chapters, { chapter: "9" }, new Map())).toBe(false);
  });

  test("the empty scope admits everything, the empty conditions among it", () => {
    expect(scopeAdmits({}, {}, new Map())).toBe(true);
    expect(scopeAdmits({}, { platform: "linux" }, new Map())).toBe(true);
  });

  test("a dimension the scope names and the conditions omit is out of scope", () => {
    expect(scopeAdmits({ platform: { kind: "any" } }, {}, new Map())).toBe(false);
    expect(scopeAdmits({ platform: "linux" }, { chapter: "9" }, new Map())).toBe(false);
  });

  test("a scope-valued condition is compared as a scope, not as a point holding an object", () => {
    expect(scopeAdmits(chapters, { chapter: { kind: "range", from: "3", to: "4" } }, numeric)).toBe(true);
    expect(scopeAdmits(chapters, { chapter: { kind: "range", from: "3", to: "11" } }, numeric)).toBe(false);
  });

  test("a coded scope with no resolver refuses rather than answering", () => {
    const coded: Conditions = {
      team: { kind: "coded", module: "musai.demo", name: "in-team", version: versionString("1"), args: {} },
    };
    expect(() => scopeAdmits(coded, { team: "core" }, new Map())).toThrow(UnresolvedCodedScopeError);
  });
});
