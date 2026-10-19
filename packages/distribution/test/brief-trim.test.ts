import { isOperationError } from "@musai/api-core";
import { describe, expect, test } from "vitest";
import { byteLengthUtf8, omissionLine, TRIM_ORDER, type TrimItem, trimToBudget } from "../src/brief/trim.js";

function item(overrides: Partial<TrimItem>): TrimItem {
  return {
    id: `sha256:${"0".repeat(64)}`,
    evidenceKind: "receipt",
    setAside: false,
    pinned: false,
    bytes: 10,
    ...overrides,
  };
}

describe("TRIM_ORDER is the evidence order reversed", () => {
  test("agent judgments trim first, receipts trim last", () => {
    expect(TRIM_ORDER).toEqual(["agent-judgment", "person-judgment", "citation", "receipt"]);
  });
});

describe("a pinned item is never trimmed", () => {
  test("the claim and its direct evidence survive a budget too small to hold them, by the trim refusing rather than dropping them", () => {
    const claim = item({ id: "sha256:claim", pinned: true, bytes: 500 });
    const direct = item({ id: "sha256:direct", pinned: true, bytes: 500 });

    expect(() => trimToBudget([claim, direct], 100)).toThrow();
    try {
      trimToBudget([claim, direct], 100);
      throw new Error("expected trimToBudget to throw");
    } catch (error) {
      expect(isOperationError(error) && error.reason).toBe("over-budget");
    }
  });

  test("a pinned item survives even when every trimmable item is removed and the budget still cannot hold it", () => {
    const claim = item({ id: "sha256:claim", pinned: true, bytes: 10 });
    const trimmable = item({ id: "sha256:trimmable", pinned: false, bytes: 500 });
    const result = trimToBudget(
      [claim, trimmable],
      10 + byteLengthUtf8(omissionLine({ id: trimmable.id, reason: "over-budget" })),
    );
    expect(result.kept.map((kept) => kept.id)).toEqual([claim.id]);
    expect(result.omissions.map((omission) => omission.id)).toEqual([trimmable.id]);
  });
});

describe("the omission list is sized inside the budget, never appended on top of it", () => {
  test("kept items plus the omission list never exceed the budget, for every budget at least the worst-case floor", () => {
    const pinned = item({ id: "sha256:claim", pinned: true, bytes: 50 });
    const trimmable = [
      item({ id: "sha256:t1", evidenceKind: "agent-judgment", bytes: 80 }),
      item({ id: "sha256:t2", evidenceKind: "person-judgment", bytes: 80 }),
      item({ id: "sha256:t3", evidenceKind: "citation", bytes: 80 }),
    ];
    const worstCaseOmissionBytes = trimmable.reduce(
      (total, candidate) => total + byteLengthUtf8(omissionLine({ id: candidate.id, reason: "over-budget" })),
      0,
    );
    const floor = pinned.bytes + worstCaseOmissionBytes;

    for (const budget of [floor, floor + 50, floor + 150, floor + 240]) {
      const result = trimToBudget([pinned, ...trimmable], budget);
      const totalBytes =
        result.kept.reduce((total, kept) => total + kept.bytes, 0) +
        result.omissions.reduce((total, omission) => total + byteLengthUtf8(omissionLine(omission)), 0);
      expect(totalBytes).toBeLessThanOrEqual(budget);
    }
  });
});

describe("the trim order removes the weakest evidence first", () => {
  test("two items equal in evidence kind and set-aside status trim in record-id ascending order", () => {
    const a = item({ id: "sha256:aaa", bytes: 100 });
    const b = item({ id: "sha256:bbb", bytes: 100 });
    const budget = 100 + byteLengthUtf8(omissionLine({ id: a.id, reason: "over-budget" }));

    const result = trimToBudget([a, b], budget);
    expect(result.omissions.map((omission) => omission.id)).toEqual([a.id]);
    expect(result.kept.map((kept) => kept.id)).toEqual([b.id]);
  });

  test("a set-aside run trims before a standing run of the same evidence kind, whatever their ids sort as", () => {
    const standing = item({ id: "sha256:aaa-standing", setAside: false, bytes: 100 });
    const setAside = item({ id: "sha256:zzz-set-aside", setAside: true, bytes: 100 });
    const budget = 100 + byteLengthUtf8(omissionLine({ id: setAside.id, reason: "over-budget" }));

    const result = trimToBudget([standing, setAside], budget);
    expect(result.omissions.map((omission) => omission.id)).toEqual([setAside.id]);
    expect(result.kept.map((kept) => kept.id)).toEqual([standing.id]);
  });

  test("an agent judgment trims before a receipt of the same relative strength", () => {
    const receipt = item({ id: "sha256:receipt", evidenceKind: "receipt", bytes: 100 });
    const agentJudgment = item({ id: "sha256:agent-judgment", evidenceKind: "agent-judgment", bytes: 100 });
    const budget = 100 + byteLengthUtf8(omissionLine({ id: agentJudgment.id, reason: "over-budget" }));

    const result = trimToBudget([receipt, agentJudgment], budget);
    expect(result.omissions.map((omission) => omission.id)).toEqual([agentJudgment.id]);
    expect(result.kept.map((kept) => kept.id)).toEqual([receipt.id]);
  });
});

describe("defined results at the edges", () => {
  test("a budget of zero refuses rather than crashing", () => {
    const single = item({ id: "sha256:only", bytes: 10 });
    expect(() => trimToBudget([single], 0)).not.toThrow(TypeError);
    expect(() => trimToBudget([single], 0)).toThrow();
  });

  test("a single trimmable item within budget is kept with no omissions", () => {
    const single = item({ id: "sha256:only", bytes: 10 });
    const result = trimToBudget([single], 1000);
    expect(result.kept.map((kept) => kept.id)).toEqual([single.id]);
    expect(result.omissions).toEqual([]);
  });
});

describe("trimToBudget is a pure function of its two arguments", () => {
  test("two calls with the same items and budget produce the same kept set and the same omissions", () => {
    const items = [
      item({ id: "sha256:pinned", pinned: true, bytes: 30 }),
      item({ id: "sha256:t1", evidenceKind: "agent-judgment", bytes: 80 }),
      item({ id: "sha256:t2", evidenceKind: "citation", bytes: 80 }),
    ];
    const first = trimToBudget(items, 140);
    const second = trimToBudget(items, 140);
    expect(second).toEqual(first);
  });
});
