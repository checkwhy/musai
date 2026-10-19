import { timestamp } from "@musai/records";
import { describe, expect, test } from "vitest";
import {
  deriveSiblingVerdicts,
  holdingSibling,
  type SiblingClaim,
  type SiblingRuling,
} from "../src/evaluator/evaluate.js";
import {
  type CheckedAuthority,
  FLOOR_AUTHORITY,
  type FloorRuling,
  type RulingAuthority,
  SiblingConflictError,
} from "../src/evaluator/rulings.js";

const EARLIER = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";

function claim(id: string, group: string | null): SiblingClaim {
  return { id, exclusiveGroup: group };
}

function ruling(
  id: string,
  claimId: string,
  verdict: "holds" | "fails",
  authority: RulingAuthority = "person",
  decidedAt: string = EARLIER,
): SiblingRuling {
  return { id, claim: claimId, verdict, authority: authority as CheckedAuthority, decidedAt: timestamp(decidedAt) };
}

function holdingRuling(id: string, claimId: string): SiblingRuling {
  return ruling(id, claimId, "holds");
}

function failingRuling(id: string, claimId: string): SiblingRuling {
  return ruling(id, claimId, "fails");
}

function floor(verdict: "holds" | "fails"): FloorRuling {
  return {
    id: "floor@a-commit",
    authority: FLOOR_AUTHORITY as CheckedAuthority,
    decidedAt: timestamp("1970-01-01T00:00:00.000Z"),
    verdict,
    evidenceSnapshot: [],
    commit: "a-commit",
  };
}

describe("deriveSiblingVerdicts", () => {
  test("one ruling holding on one sibling derives fails on every other sibling, from that one record, with nothing else minted", () => {
    const siblings = [claim("a", "disposition"), claim("b", "disposition"), claim("c", "disposition")];
    const rulings = [holdingRuling("ruling-1", "a")];

    const derived = deriveSiblingVerdicts("disposition", siblings, rulings, null);

    expect(derived).toEqual([
      { claim: "b", verdict: "fails", derivedFrom: "ruling-1" },
      { claim: "c", verdict: "fails", derivedFrom: "ruling-1" },
    ]);
  });

  test("a second ruling that would make a second sibling hold is refused closed, naming the group and the sibling already holding", () => {
    const siblings = [claim("a", "disposition"), claim("b", "disposition")];
    const rulings = [holdingRuling("ruling-1", "a"), holdingRuling("ruling-2", "b")];

    expect(() => deriveSiblingVerdicts("disposition", siblings, rulings, null)).toThrow(SiblingConflictError);
    try {
      deriveSiblingVerdicts("disposition", siblings, rulings, null);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SiblingConflictError);
      const conflict = error as SiblingConflictError;
      expect(conflict.group).toBe("disposition");
      expect(conflict.holdingMember).toBe("a");
      expect(conflict.message).toContain("disposition");
      expect(conflict.message).toContain("a");
    }
  });

  test("two rulings holding on one sibling settle the menu once: every other sibling derives fails, from the lower-id ruling, and nothing is refused", () => {
    const siblings = [claim("a", "disposition"), claim("b", "disposition")];
    const rulings = [holdingRuling("ruling-2", "a"), holdingRuling("ruling-1", "a")];

    expect(deriveSiblingVerdicts("disposition", siblings, rulings, null)).toEqual([
      { claim: "b", verdict: "fails", derivedFrom: "ruling-1" },
    ]);
  });

  test("siblings derive from the ruling that decides the holding member, the most recently decided of its top tier", () => {
    const siblings = [claim("a", "disposition"), claim("b", "disposition")];
    const rulings = [
      ruling("ruling-1", "a", "holds", "person", LATER),
      ruling("ruling-2", "a", "holds", "person", EARLIER),
      ruling("ruling-0", "a", "holds", "delegate", LATER),
    ];

    expect(deriveSiblingVerdicts("disposition", siblings, rulings, null)).toEqual([
      { claim: "b", verdict: "fails", derivedFrom: "ruling-1" },
    ]);
  });

  test("a delegate's hold on one sibling that a person's fails outranks derives nothing: the menu is open again", () => {
    const siblings = [claim("a", "disposition"), claim("b", "disposition"), claim("c", "disposition")];
    const rulings = [ruling("ruling-1", "a", "holds", "delegate"), ruling("ruling-2", "a", "fails", "person")];

    expect(deriveSiblingVerdicts("disposition", siblings, rulings, null)).toEqual([]);
  });

  test("an outranked hold on one sibling does not conflict with another sibling that holds: that one settles the menu", () => {
    const siblings = [claim("a", "disposition"), claim("b", "disposition"), claim("c", "disposition")];
    const rulings = [
      ruling("ruling-1", "a", "holds", "delegate"),
      ruling("ruling-2", "a", "fails", "person"),
      ruling("ruling-3", "b", "holds", "person"),
    ];

    expect(deriveSiblingVerdicts("disposition", siblings, rulings, null)).toEqual([
      { claim: "a", verdict: "fails", derivedFrom: "ruling-3" },
      { claim: "c", verdict: "fails", derivedFrom: "ruling-3" },
    ]);
  });

  test("a sibling whose rulings are contested at one tier does not hold, so nothing derives from it", () => {
    const siblings = [claim("a", "disposition"), claim("b", "disposition")];
    const rulings = [ruling("ruling-1", "a", "holds", "delegate"), ruling("ruling-2", "a", "fails", "delegate", LATER)];

    expect(deriveSiblingVerdicts("disposition", siblings, rulings, null)).toEqual([]);
  });

  test("a failing floor outranks every hold, so no sibling holds and nothing derives", () => {
    const siblings = [claim("a", "disposition"), claim("b", "disposition")];
    const rulings = [holdingRuling("ruling-1", "a")];

    expect(deriveSiblingVerdicts("disposition", siblings, rulings, floor("fails"))).toEqual([]);
  });

  test("under a holding floor every ruled member holds whatever its own verdict, so two ruled members conflict", () => {
    const siblings = [claim("a", "disposition"), claim("b", "disposition")];
    const rulings = [failingRuling("ruling-1", "a"), failingRuling("ruling-2", "b")];

    expect(() => deriveSiblingVerdicts("disposition", siblings, rulings, floor("holds"))).toThrow(SiblingConflictError);
  });

  test("a group of one behaves as a binary gate: nothing is derived for any other member, since there is none", () => {
    const siblings = [claim("only", "binary-gate")];
    const rulings = [holdingRuling("ruling-1", "only")];

    expect(deriveSiblingVerdicts("binary-gate", siblings, rulings, null)).toEqual([]);
  });

  test("a failing ruling on one sibling derives nothing, since only a holding ruling settles the menu", () => {
    const siblings = [claim("a", "disposition"), claim("b", "disposition")];
    const rulings = [failingRuling("ruling-1", "a")];

    expect(deriveSiblingVerdicts("disposition", siblings, rulings, null)).toEqual([]);
  });

  test("a claim outside the named group is never counted as a sibling, whatever its own rulings say", () => {
    const siblings = [claim("a", "disposition"), claim("outsider", "some-other-group")];
    const rulings = [holdingRuling("ruling-1", "a"), holdingRuling("ruling-2", "outsider")];

    expect(deriveSiblingVerdicts("disposition", siblings, rulings, null)).toEqual([]);
  });
});

describe("holdingSibling", () => {
  test("names the one member whose rulings resolve holds, and the ruling that decides it, in a group of one as in a menu", () => {
    expect(
      holdingSibling("binary-gate", [claim("only", "binary-gate")], [holdingRuling("ruling-1", "only")], null),
    ).toEqual({
      member: "only",
      derivedFrom: "ruling-1",
    });
  });

  test("names nobody where every hold in the group is outranked", () => {
    const siblings = [claim("a", "disposition"), claim("b", "disposition")];
    const rulings = [ruling("ruling-1", "a", "holds", "delegate"), ruling("ruling-2", "a", "fails", "person")];

    expect(holdingSibling("disposition", siblings, rulings, null)).toBeNull();
  });
});
