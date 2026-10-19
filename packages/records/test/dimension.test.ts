import { describe, expect, test } from "vitest";
import { compareValues, type Dimension } from "../src/conditions/dimension.js";

describe("an ordered dimension", () => {
  const dimension: Dimension = { name: "story-day", type: "ordered", data: { order: "numeric" } };

  test("compares two equal values as equal", () => {
    expect(compareValues(dimension, "3", "3")).toBe("equal");
  });

  test("compares a lower and a higher value as narrower and wider respectively", () => {
    expect(compareValues(dimension, "1", "5")).toBe("narrower");
    expect(compareValues(dimension, "5", "1")).toBe("wider");
  });
});

describe("an interval dimension", () => {
  const dimension: Dimension = { name: "measured-time", type: "interval", data: { order: "numeric" } };

  test("compares two equal values as equal", () => {
    expect(compareValues(dimension, "10", "10")).toBe("equal");
  });

  test("compares an earlier and a later instant as narrower and wider respectively", () => {
    expect(compareValues(dimension, "1", "9")).toBe("narrower");
    expect(compareValues(dimension, "9", "1")).toBe("wider");
  });
});

describe("the order a dimension declares is the order its values are compared under", () => {
  const numeric: Dimension = { name: "build", type: "ordered", data: { order: "numeric" } };
  const lexicographic: Dimension = { name: "label", type: "ordered", data: { order: "lexicographic" } };

  test("a numeric order puts 9 below 10 where a lexicographic order puts it above", () => {
    expect(compareValues(numeric, "9", "10")).toBe("narrower");
    expect(compareValues(lexicographic, "9", "10")).toBe("wider");
  });

  test("a lexicographic order compares two equal strings as equal", () => {
    expect(compareValues(lexicographic, "2.10", "2.10")).toBe("equal");
  });

  test("a numeric order reports a value that is not an exact decimal as incomparable", () => {
    expect(compareValues(numeric, "2.0.1", "3")).toBe("incomparable");
    expect(compareValues(numeric, "3", "2.0.1")).toBe("incomparable");
    expect(compareValues(numeric, 3, "3")).toBe("incomparable");
  });

  test("a value the declared order cannot read is still equal to itself", () => {
    expect(compareValues(numeric, "2.0.1", "2.0.1")).toBe("equal");
  });
});

describe("a DAG dimension", () => {
  const edges = new Map<string, ReadonlySet<string>>([
    ["engine@1.0.0", new Set(["engine@1.x"])],
    ["engine@1.x", new Set(["engine@latest"])],
    ["engine@2.0.0", new Set(["engine@2.x"])],
  ]);
  const dimension: Dimension = { name: "package-version", type: "dag", data: { edges } };

  test("compares a value against itself as equal", () => {
    expect(compareValues(dimension, "engine@1.0.0", "engine@1.0.0")).toBe("equal");
  });

  test("compares two values connected by a path as narrower and wider respectively", () => {
    expect(compareValues(dimension, "engine@1.0.0", "engine@latest")).toBe("narrower");
    expect(compareValues(dimension, "engine@latest", "engine@1.0.0")).toBe("wider");
  });

  test("reports two values with no path between them as incomparable", () => {
    expect(compareValues(dimension, "engine@1.0.0", "engine@2.0.0")).toBe("incomparable");
  });

  test("terminates over a cyclic graph rather than recursing without bound", () => {
    const cyclicEdges = new Map<string, ReadonlySet<string>>([
      ["a", new Set(["b"])],
      ["b", new Set(["a"])],
    ]);
    const cyclic: Dimension = { name: "cyclic", type: "dag", data: { edges: cyclicEdges } };
    expect(compareValues(cyclic, "a", "b")).toBe("narrower");
    expect(compareValues(cyclic, "b", "a")).toBe("narrower");
  });
});

describe("a hierarchical dimension", () => {
  const parentOf = new Map<string, string | null>([
    ["linux", null],
    ["ubuntu", "linux"],
    ["debian", "linux"],
    ["windows", null],
  ]);
  const dimension: Dimension = { name: "platform", type: "hierarchical", data: { parentOf } };

  test("compares a value against itself as equal", () => {
    expect(compareValues(dimension, "linux", "linux")).toBe("equal");
  });

  test("compares a child and its parent as narrower and wider respectively", () => {
    expect(compareValues(dimension, "ubuntu", "linux")).toBe("narrower");
    expect(compareValues(dimension, "linux", "ubuntu")).toBe("wider");
  });

  test("reports two siblings as incomparable", () => {
    expect(compareValues(dimension, "ubuntu", "debian")).toBe("incomparable");
  });
});

describe("an identity-only dimension", () => {
  const dimension: Dimension = { name: "run-id", type: "identity", data: {} };

  test("compares two equal values as equal", () => {
    expect(compareValues(dimension, "sha256:aa", "sha256:aa")).toBe("equal");
  });

  test("reports any two distinct values as incomparable", () => {
    expect(compareValues(dimension, "sha256:aa", "sha256:bb")).toBe("incomparable");
  });
});

describe("identity is settled before a dimension's type is consulted", () => {
  test("every dimension type compares a value against itself as equal, including one its order cannot read", () => {
    const dimensions: readonly Dimension[] = [
      { name: "build", type: "ordered", data: { order: "numeric" } },
      { name: "label", type: "ordered", data: { order: "lexicographic" } },
      { name: "window", type: "interval", data: { order: "numeric" } },
      { name: "lineage", type: "dag", data: { edges: new Map() } },
      { name: "platform", type: "hierarchical", data: { parentOf: new Map() } },
      { name: "run-id", type: "identity", data: {} },
    ];
    for (const dimension of dimensions) {
      expect(compareValues(dimension, "2.0.1", "2.0.1")).toBe("equal");
    }
  });
});

describe("a dimension answers incomparable only for two values it holds distinct", () => {
  test("two spellings a numeric order reads as one value compare as equal, never as incomparable", () => {
    const orders: readonly Dimension[] = [
      { name: "build", type: "ordered", data: { order: "numeric" } },
      { name: "window", type: "interval", data: { order: "numeric" } },
    ];
    for (const dimension of orders) {
      expect(compareValues(dimension, "1", "1.0")).toBe("equal");
      expect(compareValues(dimension, "01", "1")).toBe("equal");
      expect(compareValues(dimension, "-0", "0")).toBe("equal");
    }
  });

  test("a lexicographic order places every pair of values, so it answers incomparable for none", () => {
    const lexicographic: Dimension = { name: "label", type: "ordered", data: { order: "lexicographic" } };
    for (const [a, b] of [
      ["alpha", "beta"],
      ["9", "10"],
      ["2.0.1", "2.0.1"],
    ] as const) {
      expect(compareValues(lexicographic, a, b)).not.toBe("incomparable");
    }
  });
});

describe("compareValues distinguishes incomparable from equal at the type level", () => {
  test("a DAG's unreachable pair and its own value are two different literal results", () => {
    const edges = new Map<string, ReadonlySet<string>>([["a", new Set()]]);
    const dimension: Dimension = { name: "distinguish", type: "dag", data: { edges } };
    const equalResult = compareValues(dimension, "a", "a");
    const incomparableResult = compareValues(dimension, "a", "b");
    expect(equalResult).toBe("equal");
    expect(incomparableResult).toBe("incomparable");
    expect(equalResult).not.toBe(incomparableResult);
  });
});
