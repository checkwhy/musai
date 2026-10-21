import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANY_SCOPE,
  exactDecimal,
  point,
  REASON_PRECEDENCE,
  type ReasonClass,
  reasonPrecedence,
  type Scope,
  timestamp,
} from "@musai/records";
import { type Role, type RoleMatrix, roleMatrix } from "@musai/trust";
import { describe, expect, test } from "vitest";
import { type EvaluateClaim, type EvaluateRuling, evaluate } from "../src/evaluator/evaluate.js";
import { type ClaimEvaluationInput, evaluateClaims, groundedLabelling } from "../src/evaluator/fixpoint.js";
import type { Argument } from "../src/evaluator/ordering.js";
import {
  authorityOf,
  type ClaimRulingOutcome,
  type FloorRuling,
  floorFrom,
  type PinnedRuling,
  type RulingAuthority,
  resolveClaimRulings,
} from "../src/evaluator/rulings.js";
import type { ClaimStatus } from "../src/evaluator/status.js";

const CYCLES_FIXTURES_DIR = fileURLToPath(new URL("./fixtures/cycles", import.meta.url));

function receipt(id: string, scope: Scope = ANY_SCOPE, weight = "1"): Argument {
  return { id, evidenceKind: "receipt", scope, declaredWeight: exactDecimal(weight) };
}

function selfReferentialClaim(id: string, ruling: ClaimRulingOutcome | null = null): ClaimEvaluationInput {
  return { id, applicable: true, overBudget: false, supportingArgumentIds: [id], ruling };
}

/** Alice as owner, for tests that need a checked ruling without exercising the matrix. */
const OWNER_MATRIX: RoleMatrix = roleMatrix(
  [],
  [{ principal: "alice@example.com", role: "owner", scope: ANY_SCOPE }],
  "deadbeef",
);

function pinnedRuling(
  id: string,
  verdict: "holds" | "fails",
  evidenceSnapshot: readonly string[] = [],
  currentEvidenceIds: readonly string[] = [],
): PinnedRuling {
  return {
    id,
    authority: authorityOf(OWNER_MATRIX, "alice@example.com", ANY_SCOPE, "person"),
    decidedAt: timestamp("2026-01-01T00:00:00.000Z"),
    verdict,
    evidenceSnapshot,
    currentEvidenceIds,
  };
}

/** A floor from a fixture configuration, for tests that do not exercise `floorFrom` itself. */
function fixtureFloor(verdict: "holds" | "fails"): FloorRuling {
  return floorFrom({ commit: "deadbeef", values: { floor: { verdict } } })!;
}

describe("groundedLabelling on the raw fixpoint", () => {
  test("an empty attack graph produces an empty labelling with no error", () => {
    const labelling = groundedLabelling([], []);
    expect(labelling.labels.size).toBe(0);
    expect(labelling.witnesses.size).toBe(0);
  });

  test("a single unattacked node is labelled in without entering the cycle path", () => {
    const labelling = groundedLabelling(["only"], []);
    expect(labelling.labels.get("only")).toBe("in");
  });
});

describe("evaluateClaims: cycles leave every member open with reason cycle", () => {
  const argumentsOf = (ids: readonly string[]) => new Map(ids.map((id) => [id, receipt(id)] as const));

  test("a claim that attacks itself is open with reason cycle", () => {
    const claims = [selfReferentialClaim("a")];
    const { statuses } = evaluateClaims(
      claims,
      ["a"],
      [{ attacker: "a", target: "a" }],
      (id) => argumentsOf(["a"]).get(id)!,
    );
    expect(statuses.get("a")).toEqual({ label: "open", reason: "cycle", comparison: expect.any(Object) });
  });

  test("a two-node mutual attack leaves both open with reason cycle", () => {
    const ids = ["a", "b"];
    const claims = ids.map((id) => selfReferentialClaim(id));
    const defeats = [
      { attacker: "a", target: "b" },
      { attacker: "b", target: "a" },
    ];
    const { statuses } = evaluateClaims(claims, ids, defeats, (id) => argumentsOf(ids).get(id)!);
    for (const id of ids) {
      expect(statuses.get(id)).toMatchObject({ label: "open", reason: "cycle" });
    }
  });

  test("a three-node cycle leaves all three open with reason cycle", () => {
    const ids = ["a", "b", "c"];
    const claims = ids.map((id) => selfReferentialClaim(id));
    const defeats = [
      { attacker: "a", target: "b" },
      { attacker: "b", target: "c" },
      { attacker: "c", target: "a" },
    ];
    const { statuses } = evaluateClaims(claims, ids, defeats, (id) => argumentsOf(ids).get(id)!);
    for (const id of ids) {
      expect(statuses.get(id)).toMatchObject({ label: "open", reason: "cycle" });
    }
  });

  test("a four-node cycle leaves all four open with reason cycle", () => {
    const ids = ["a", "b", "c", "d"];
    const claims = ids.map((id) => selfReferentialClaim(id));
    const defeats = [
      { attacker: "a", target: "b" },
      { attacker: "b", target: "c" },
      { attacker: "c", target: "d" },
      { attacker: "d", target: "a" },
    ];
    const { statuses } = evaluateClaims(claims, ids, defeats, (id) => argumentsOf(ids).get(id)!);
    for (const id of ids) {
      expect(statuses.get(id)).toMatchObject({ label: "open", reason: "cycle" });
    }
  });

  test("a hundred shuffled node orderings over one cycle produce identical member ordering", () => {
    const ids = ["a", "b", "c"];
    const defeats = [
      { attacker: "a", target: "b" },
      { attacker: "b", target: "c" },
      { attacker: "c", target: "a" },
    ];
    const expectedCycleMembers = ["a", "b", "c"];
    for (let attempt = 0; attempt < 100; attempt++) {
      const shuffled = [...ids].sort(() => Math.random() - 0.5);
      const claims = shuffled.map((id) => selfReferentialClaim(id));
      const shuffledDefeats = [...defeats].sort(() => Math.random() - 0.5);
      const { statuses } = evaluateClaims(claims, shuffled, shuffledDefeats, (id) => argumentsOf(ids).get(id)!);
      const cycleMembers = [...statuses.entries()]
        .filter(([, status]) => status.label === "open" && status.reason === "cycle")
        .map(([id]) => id)
        .sort();
      expect(cycleMembers).toEqual(expectedCycleMembers);
    }
  });
});

describe("evaluateClaims: the reasons the fixpoint alone cannot produce", () => {
  test("a claim with no evidence and no attacks is open with reason no-evidence", () => {
    const claim: ClaimEvaluationInput = {
      id: "a",
      applicable: true,
      overBudget: false,
      supportingArgumentIds: [],
      ruling: null,
    };
    const { statuses } = evaluateClaims([claim], [], [], () => {
      throw new Error("no argument should be looked up for a claim with no supporting arguments");
    });
    expect(statuses.get("a")).toEqual({ label: "open", reason: "no-evidence", comparison: expect.any(Object) });
  });

  test("two supporting arguments equal at every ordering step corroborate: the claim holds, beating neither", () => {
    const args = new Map<string, Argument>([
      ["arg-1", receipt("arg-1")],
      ["arg-2", receipt("arg-2")],
    ]);
    const claim: ClaimEvaluationInput = {
      id: "claim",
      applicable: true,
      overBudget: false,
      supportingArgumentIds: ["arg-1", "arg-2"],
      ruling: null,
    };
    const { statuses } = evaluateClaims([claim], [...args.keys()], [], (id) => args.get(id)!);
    expect(statuses.get("claim")).toEqual({
      label: "holds",
      comparison: { winner: "arg-1", rival: null, via: "receipt", corroborated: ["arg-2"] },
    });
  });

  test("an inapplicable claim is open with reason inapplicable regardless of its evidence", () => {
    const args = new Map<string, Argument>([["arg-1", receipt("arg-1")]]);
    const claim: ClaimEvaluationInput = {
      id: "claim",
      applicable: false,
      overBudget: false,
      supportingArgumentIds: ["arg-1"],
      ruling: null,
    };
    const { statuses } = evaluateClaims([claim], [...args.keys()], [], (id) => args.get(id)!);
    expect(statuses.get("claim")).toEqual({ label: "open", reason: "inapplicable", comparison: expect.any(Object) });
  });

  test("a claim whose winning ruling is stale reads the ruling's verdict, flagged decided on stale evidence", () => {
    const args = new Map<string, Argument>([["arg-1", receipt("arg-1")]]);
    const winning = pinnedRuling(
      "sha256:ruling",
      "holds",
      ["sha256:evidence-the-ruling-saw"],
      ["sha256:evidence-since-replaced"],
    );
    const ruling = resolveClaimRulings({ rulings: [winning], floor: null });
    const claim: ClaimEvaluationInput = {
      id: "claim",
      applicable: true,
      overBudget: false,
      supportingArgumentIds: ["arg-1"],
      ruling,
    };
    const { statuses } = evaluateClaims([claim], [...args.keys()], [], (id) => args.get(id)!);
    expect(statuses.get("claim")).toEqual({
      label: "holds",
      comparison: expect.any(Object),
      decidedOnStaleEvidence: true,
    });
  });

  test("two rulings tied in authority leave the claim open with reason contested-authority", () => {
    const args = new Map<string, Argument>([["arg-1", receipt("arg-1")]]);
    const one = pinnedRuling("sha256:one", "holds");
    const two = pinnedRuling("sha256:two", "fails");
    const ruling = resolveClaimRulings({ rulings: [one, two], floor: null });
    const claim: ClaimEvaluationInput = {
      id: "claim",
      applicable: true,
      overBudget: false,
      supportingArgumentIds: ["arg-1"],
      ruling,
    };
    const { statuses } = evaluateClaims([claim], [...args.keys()], [], (id) => args.get(id)!);
    expect(statuses.get("claim")).toEqual({
      label: "open",
      reason: "contested-authority",
      comparison: expect.any(Object),
    });
  });

  test("a claim over budget is open with reason over-budget", () => {
    const claim: ClaimEvaluationInput = {
      id: "claim",
      applicable: true,
      overBudget: true,
      supportingArgumentIds: [],
      ruling: null,
    };
    const { statuses } = evaluateClaims([claim], [], [], () => {
      throw new Error("unreached");
    });
    expect(statuses.get("claim")).toEqual({ label: "open", reason: "over-budget", comparison: expect.any(Object) });
  });

  test("a decided ruling that disagrees with a decided receipt applies its own verdict", () => {
    const args = new Map<string, Argument>([["arg-1", receipt("arg-1")]]);
    const decided = pinnedRuling("sha256:ruling", "fails");
    const ruling = resolveClaimRulings({ rulings: [decided], floor: null });
    const claim: ClaimEvaluationInput = {
      id: "claim",
      applicable: true,
      overBudget: false,
      supportingArgumentIds: ["arg-1"],
      ruling,
    };
    const { statuses } = evaluateClaims([claim], [...args.keys()], [], (id) => args.get(id)!);
    expect(statuses.get("claim")).toEqual({ label: "fails", comparison: expect.any(Object) });
  });
});

describe("reasonPrecedence", () => {
  test("the fixed order is inapplicable, over-budget, cycle, contested-authority, stale, no-evidence", () => {
    expect(REASON_PRECEDENCE).toEqual([
      "inapplicable",
      "over-budget",
      "cycle",
      "contested-authority",
      "stale",
      "no-evidence",
    ]);
  });

  test("when three classes apply to one claim, the earliest in the fixed precedence is recorded", () => {
    const applicable = new Set<ReasonClass>(["stale", "cycle", "no-evidence"]);
    expect(reasonPrecedence(applicable)).toBe("cycle");
  });

  test("over-budget outranks every reason but inapplicable, asserted directly", () => {
    expect(
      reasonPrecedence(new Set<ReasonClass>(["over-budget", "cycle", "contested-authority", "stale", "no-evidence"])),
    ).toBe("over-budget");
    expect(reasonPrecedence(new Set<ReasonClass>(["inapplicable", "over-budget"]))).toBe("inapplicable");
  });

  test("supplying no applicable reason throws rather than silently falling back", () => {
    expect(() => reasonPrecedence(new Set())).toThrow();
  });
});

describe("constructing an open status with no reason fails at the type level", () => {
  test("the discriminated union refuses a bare open literal", () => {
    // @ts-expect-error an open ClaimStatus must carry a reason class
    const bareOpen: ClaimStatus = { label: "open", comparison: { winner: "(none)", rival: null, via: "no evidence" } };
    void bareOpen;
  });
});

describe("a claim's ruling outcome cannot be constructed outside the resolution", () => {
  test("the branded outcome is not assignable from a hand-built decided literal", () => {
    // @ts-expect-error a ClaimRulingOutcome is minted only by resolveClaimRulings
    const outcome: ClaimRulingOutcome = { outcome: "decided", winnerId: "sha256:x", verdict: "holds", stale: false };
    void outcome;
  });

  test("the branded outcome is not assignable from a hand-built contested literal", () => {
    // @ts-expect-error a ClaimRulingOutcome is minted only by resolveClaimRulings
    const outcome: ClaimRulingOutcome = { outcome: "contested", tiedIds: ["sha256:one", "sha256:two"] };
    void outcome;
  });
});

describe("evaluate: determinism regardless of insertion order", () => {
  const emptyMatrix: RoleMatrix = roleMatrix([], [], "deadbeef");

  test("two evaluations of the same graph in reversed insertion order produce byte-identical serialized output", () => {
    const claimA: EvaluateClaim = {
      id: "claim-a",
      applicable: true,
      overBudget: false,
      supportingArgumentIds: ["arg-a1", "arg-a2"],
    };
    const claimB: EvaluateClaim = {
      id: "claim-b",
      applicable: true,
      overBudget: false,
      supportingArgumentIds: ["arg-b1"],
    };

    const argsForward = new Map<string, Argument>([
      ["arg-a1", receipt("arg-a1", point("x"))],
      ["arg-a2", receipt("arg-a2", ANY_SCOPE)],
      ["arg-b1", receipt("arg-b1")],
      [
        "challenger",
        { id: "challenger", evidenceKind: "agent-judgment", scope: ANY_SCOPE, declaredWeight: exactDecimal("1") },
      ],
    ]);
    const argsReversed = new Map([...argsForward.entries()].reverse());

    const attacks = [{ attacker: "challenger", target: "arg-b1" }];

    const forward = evaluate({
      claims: [claimA, claimB],
      arguments: argsForward,
      attacks,
      rulings: [],
      matrix: emptyMatrix,
      floor: null,
    });
    const reversed = evaluate({
      claims: [claimB, claimA],
      arguments: argsReversed,
      attacks: [...attacks].reverse(),
      rulings: [],
      matrix: emptyMatrix,
      floor: null,
    });

    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });
});

describe("evaluate: the role matrix and the trust branch's floor gate a ruling's path to a status, not just the checker in isolation", () => {
  const claimId = "claim";
  const argId = "arg-1";
  const args = new Map<string, Argument>([[argId, receipt(argId)]]);
  const claim: EvaluateClaim = { id: claimId, applicable: true, overBudget: false, supportingArgumentIds: [argId] };

  function statusFor(entries: ReturnType<typeof evaluate>["statuses"], id: string): ClaimStatus {
    const found = entries.find((entry) => entry.id === id);
    if (!found) {
      throw new Error(`no status computed for claim ${id}`);
    }
    return found.status;
  }

  test("two evaluations differing only in the matrix reach different outcomes for the same claim and the same declared ruling", () => {
    const declared: EvaluateRuling = {
      id: "sha256:ruling",
      claim: claimId,
      principal: "alice@example.com",
      scope: ANY_SCOPE,
      authority: "person",
      decidedAt: timestamp("2026-01-01T00:00:00.000Z"),
      verdict: "fails",
      briefReads: [],
      currentIds: [],
    };

    const trustingMatrix = roleMatrix(
      [],
      [{ principal: "alice@example.com", role: "owner", scope: ANY_SCOPE }],
      "deadbeef",
    );
    const trusted = evaluate({
      claims: [claim],
      arguments: args,
      attacks: [],
      rulings: [declared],
      matrix: trustingMatrix,
      floor: null,
    });
    expect(statusFor(trusted.statuses, claimId).label).toBe("fails");

    // A matrix with no grant at all: nobody, including alice, holds any role.
    const noGrantMatrix: RoleMatrix = roleMatrix(
      [{ principals: "someone-else@example.com", certAuthority: false, keyType: "ssh-ed25519", key: "AAAA" }],
      [],
      "deadbeef",
    );
    expect(() =>
      evaluate({
        claims: [claim],
        arguments: args,
        attacks: [],
        rulings: [declared],
        matrix: noGrantMatrix,
        floor: null,
      }),
    ).toThrow("alice@example.com holds no role beyond delegate and cannot rule as person");
  });

  test("two evaluations differing only in whether the configuration declares a floor produce different statuses for the same claim and the same ruling", () => {
    const declared: EvaluateRuling = {
      id: "sha256:ruling",
      claim: claimId,
      principal: "alice@example.com",
      scope: ANY_SCOPE,
      authority: "person",
      decidedAt: timestamp("2026-01-01T00:00:00.000Z"),
      verdict: "holds",
      briefReads: [],
      currentIds: [],
    };
    const trustingMatrix = roleMatrix(
      [],
      [{ principal: "alice@example.com", role: "owner", scope: ANY_SCOPE }],
      "deadbeef",
    );

    const withoutFloor = evaluate({
      claims: [claim],
      arguments: args,
      attacks: [],
      rulings: [declared],
      matrix: trustingMatrix,
      floor: null,
    });
    expect(statusFor(withoutFloor.statuses, claimId).label).toBe("holds");

    const floor = fixtureFloor("fails");
    const withFloor = evaluate({
      claims: [claim],
      arguments: args,
      attacks: [],
      rulings: [declared],
      matrix: trustingMatrix,
      floor,
    });
    expect(statusFor(withFloor.statuses, claimId).label).toBe("fails");
  });

  test("a ruling is held to its own current ids, whatever its claim's supporting arguments hold", () => {
    const trustingMatrix = roleMatrix(
      [],
      [{ principal: "alice@example.com", role: "owner", scope: ANY_SCOPE }],
      "deadbeef",
    );
    const ruled = (currentIds: readonly string[]) =>
      evaluate({
        claims: [claim],
        arguments: args,
        attacks: [],
        rulings: [
          {
            id: "sha256:ruling",
            claim: claimId,
            principal: "alice@example.com",
            scope: ANY_SCOPE,
            authority: "person",
            decidedAt: timestamp("2026-01-01T00:00:00.000Z"),
            verdict: "holds",
            briefReads: [argId],
            currentIds,
          },
        ],
        matrix: trustingMatrix,
        floor: null,
      });

    expect(statusFor(ruled([]).statuses, claimId)).toMatchObject({ label: "holds", decidedOnStaleEvidence: true });
    expect(statusFor(ruled([argId]).statuses, claimId)).not.toHaveProperty("decidedOnStaleEvidence");
  });
});

interface CycleFixtureRuling {
  readonly id: string;
  readonly principal: string;
  readonly authority: RulingAuthority;
  readonly decidedAt: string;
  readonly verdict: "holds" | "fails";
  readonly evidenceSnapshot?: readonly string[];
}

interface CycleFixtureGrant {
  readonly principal: string;
  readonly role: Role;
}

interface CycleFixture {
  readonly kind: "cycle" | "adversarial";
  readonly source: string;
  readonly description: string;
  readonly reasoning: string;
  readonly grants?: readonly CycleFixtureGrant[];
  readonly claims: readonly {
    readonly id: string;
    readonly supportingArgumentIds: readonly string[];
    readonly applicable?: boolean;
    readonly overBudget?: boolean;
    readonly stale?: boolean;
    readonly ruling?: CycleFixtureRuling;
  }[];
  readonly arguments: readonly {
    readonly id: string;
    readonly evidenceKind: Argument["evidenceKind"];
    readonly scope: Scope;
    readonly weight: string;
  }[];
  readonly attacks: readonly { readonly attacker: string; readonly target: string }[];
  readonly expected: Readonly<
    Record<
      string,
      {
        readonly label: "holds" | "fails" | "open";
        readonly reason?: ReasonClass;
        readonly winner?: string;
        readonly rival?: string | null;
        readonly corroborated?: readonly string[];
        readonly decidedOnStaleEvidence?: true;
      }
    >
  >;
}

async function runCycleFixtures(dir: string): Promise<void> {
  const entries = await readdir(dir);
  const fixtureFiles = entries.filter((entry) => entry.endsWith(".json")).sort();
  expect(fixtureFiles.length, `no fixtures found under ${dir}`).toBeGreaterThanOrEqual(10);

  for (const file of fixtureFiles) {
    const raw = await readFile(join(dir, file), "utf8");
    const fixture = JSON.parse(raw) as CycleFixture;
    if (!fixture.reasoning || fixture.reasoning.trim().length === 0) {
      throw new Error(`fixture ${file} (${fixture.source}) declares no reasoning behind its expectation`);
    }
    const context = `fixture ${file} (${fixture.source}): ${fixture.description}`;

    const args = new Map<string, Argument>(
      fixture.arguments.map((arg) => [
        arg.id,
        { id: arg.id, evidenceKind: arg.evidenceKind, scope: arg.scope, declaredWeight: exactDecimal(arg.weight) },
      ]),
    );
    const claims: EvaluateClaim[] = fixture.claims.map((claim) => ({
      id: claim.id,
      applicable: claim.applicable ?? true,
      overBudget: claim.overBudget ?? false,
      supportingArgumentIds: claim.supportingArgumentIds,
      stale: claim.stale ?? false,
    }));
    const rulings: EvaluateRuling[] = fixture.claims.flatMap((claim) =>
      claim.ruling
        ? [
            {
              id: claim.ruling.id,
              claim: claim.id,
              principal: claim.ruling.principal,
              scope: ANY_SCOPE,
              authority: claim.ruling.authority,
              decidedAt: timestamp(claim.ruling.decidedAt),
              verdict: claim.ruling.verdict,
              briefReads: claim.ruling.evidenceSnapshot ?? [],
              currentIds: claim.supportingArgumentIds,
            },
          ]
        : [],
    );
    const grants = (fixture.grants ?? []).map((grant) => ({
      principal: grant.principal,
      role: grant.role,
      scope: ANY_SCOPE,
    }));
    const matrix = roleMatrix([], grants, "deadbeef");

    const result = evaluate({ claims, arguments: args, attacks: fixture.attacks, rulings, matrix, floor: null });
    for (const entry of result.statuses) {
      const expected = fixture.expected[entry.id];
      expect(expected, `${context} — no expectation declared for claim ${entry.id}`).toBeDefined();
      expect(entry.status.label, `${context} — claim ${entry.id} label`).toBe(expected!.label);
      if (expected!.label === "open") {
        expect((entry.status as { reason: ReasonClass }).reason, `${context} — claim ${entry.id} reason`).toBe(
          expected!.reason,
        );
      }
      expect(
        (entry.status as { decidedOnStaleEvidence?: true }).decidedOnStaleEvidence,
        `${context} — claim ${entry.id} flagged decided on stale evidence`,
      ).toBe(expected!.decidedOnStaleEvidence);
      if (expected!.winner !== undefined) {
        expect(entry.status.comparison, `${context} — claim ${entry.id} comparison`).toMatchObject({
          winner: expected!.winner,
          rival: expected!.rival,
          corroborated: expected!.corroborated ?? [],
        });
      }
    }
  }
}

describe("cycle and adversarial third-tier corpus", () => {
  test("every third-tier fixture states its expected labelling, its expected justification, and the reasoning behind it", async () => {
    await runCycleFixtures(CYCLES_FIXTURES_DIR);
  });
});
