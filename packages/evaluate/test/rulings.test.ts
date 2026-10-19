import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MadeAttestationRecord, RecordId, RulingRecord } from "@musai/records";
import { ANY_SCOPE, CURRENT_SCHEMA_VERSIONS, exactDecimal, timestamp } from "@musai/records";
import { gitRevParse, readWorkspaceConfig } from "@musai/store";
import { type FixtureRepo, makeFixtureRepo, writeTrustFile } from "@musai/test-support";
import { may, type Role, type RoleGrant, type RoleMatrix, roleMatrix } from "@musai/trust";
import { describe, expect, test } from "vitest";
import { type AttackEdge, resolveDefeats } from "../src/evaluator/defeat.js";
import type { Argument } from "../src/evaluator/ordering.js";
import {
  authorityFromAttestation,
  authorityOf,
  type CheckedAuthority,
  FLOOR_AUTHORITY,
  floorFrom,
  maySupersede,
  mintSetAside,
  orderRulings,
  pinnedEvidenceMoved,
  type Ruling,
  type RulingAuthority,
  rulingConflicts,
} from "../src/evaluator/rulings.js";

const RULINGS_FIXTURES_DIR = fileURLToPath(new URL("./fixtures/rulings", import.meta.url));

function argument(id: string, evidenceKind: Argument["evidenceKind"], weight = "1"): Argument {
  return { id, evidenceKind, scope: ANY_SCOPE, declaredWeight: exactDecimal(weight) };
}

describe("resolveDefeats", () => {
  test("an attack from a weaker argument onto a stronger one is absent from the defeat graph", () => {
    const attacks: readonly AttackEdge[] = [{ attacker: "weak", target: "strong" }];
    const arguments_ = new Map<string, Argument>([
      ["weak", argument("weak", "agent-judgment")],
      ["strong", argument("strong", "receipt")],
    ]);
    const defeats = resolveDefeats(attacks, { argumentOf: (id) => arguments_.get(id)! });
    expect(defeats).toHaveLength(0);
  });

  test("an attack from a stronger argument onto a weaker one survives as a defeat", () => {
    const attacks: readonly AttackEdge[] = [{ attacker: "strong", target: "weak" }];
    const arguments_ = new Map<string, Argument>([
      ["strong", argument("strong", "receipt")],
      ["weak", argument("weak", "agent-judgment")],
    ]);
    const defeats = resolveDefeats(attacks, { argumentOf: (id) => arguments_.get(id)! });
    expect(defeats).toEqual(attacks);
  });

  test("an attack between arguments equal in every ordering step survives as a defeat, since the attacker is not weaker", () => {
    const attacks: readonly AttackEdge[] = [{ attacker: "a", target: "b" }];
    const arguments_ = new Map<string, Argument>([
      ["a", argument("a", "receipt")],
      ["b", argument("b", "receipt")],
    ]);
    const defeats = resolveDefeats(attacks, { argumentOf: (id) => arguments_.get(id)! });
    expect(defeats).toEqual(attacks);
  });
});

/** Alice as owner, so `person` or `policy` on her behalf passes the checker. */
const OWNER_MATRIX: RoleMatrix = roleMatrix(
  [],
  [{ principal: "alice@example.com", role: "owner", scope: ANY_SCOPE }],
  "deadbeef",
);

function ruling(
  id: string,
  authority: RulingAuthority,
  decidedAt: string,
  verdict: "holds" | "fails",
  principal = "alice@example.com",
): Ruling {
  return {
    id,
    authority: authorityOf(OWNER_MATRIX, principal, ANY_SCOPE, authority),
    decidedAt: timestamp(decidedAt),
    verdict,
  };
}

const RULING_A = ruling("sha256:aaaa", "person", "2026-01-01T00:00:00.000Z", "holds");
const RULING_B = ruling("sha256:bbbb", "policy", "2026-01-02T00:00:00.000Z", "fails");
const RULING_C = ruling("sha256:cccc", "delegate", "2026-01-03T00:00:00.000Z", "holds");

describe("orderRulings", () => {
  test("a ruling carrying an authority outside the ordering is refused rather than ranked above the floor", () => {
    const smuggled = { ...RULING_A, id: "sha256:9999", authority: "anything" as unknown as CheckedAuthority };
    expect(() => orderRulings([RULING_A, smuggled])).toThrow("not an authority the ordering ranks: anything");
  });

  test("person outranks policy outranks delegate", () => {
    expect(orderRulings([RULING_A, RULING_B])).toEqual({
      outcome: "decided",
      winner: RULING_A,
      decidedBy: "authority",
    });
    expect(orderRulings([RULING_B, RULING_C])).toEqual({
      outcome: "decided",
      winner: RULING_B,
      decidedBy: "authority",
    });
    expect(orderRulings([RULING_A, RULING_C])).toEqual({
      outcome: "decided",
      winner: RULING_A,
      decidedBy: "authority",
    });
  });

  test("two equal-authority rulings in conflict resolve to contested rather than picking either by time", () => {
    const earlier = ruling("sha256:1111", "person", "2026-01-01T00:00:00.000Z", "holds");
    const later = ruling("sha256:2222", "person", "2026-01-02T00:00:00.000Z", "fails");
    const resolution = orderRulings([earlier, later]);
    expect(resolution.outcome).toBe("contested");
  });

  test("three equal-authority rulings split two against one report the actual dissent, not the pair an id sort happens to group first", () => {
    // By id this trio sorts holds, holds, fails, so an id sort would drop the dissent.
    const firstHolds = ruling("sha256:1111", "person", "2026-01-01T00:00:00.000Z", "holds");
    const secondHolds = ruling("sha256:2222", "person", "2026-01-02T00:00:00.000Z", "holds");
    const dissent = ruling("sha256:3333", "person", "2026-01-03T00:00:00.000Z", "fails");
    const resolution = orderRulings([firstHolds, secondHolds, dissent]);
    expect(resolution.outcome).toBe("contested");
    if (resolution.outcome === "contested") {
      const verdicts = new Set(resolution.tied.map((entry) => entry.verdict));
      expect(verdicts).toEqual(new Set(["holds", "fails"]));
      expect(resolution.tied).toContain(dissent);
      // The holding side is represented by its most recent ruling, not its lowest id.
      expect(resolution.tied).toContain(secondHolds);
    }
  });

  test("a tier split three ways still reports two rulings that genuinely disagree, never a crash or a dropped side silently merged into one already shown", () => {
    // A third verdict is smuggled past the closed type; a real three-way split cannot occur.
    const holds = ruling("sha256:1111", "person", "2026-01-01T00:00:00.000Z", "holds");
    const fails = ruling("sha256:2222", "person", "2026-01-02T00:00:00.000Z", "fails");
    const abstains = {
      ...ruling("sha256:3333", "person", "2026-01-03T00:00:00.000Z", "holds"),
      verdict: "abstains" as unknown as "holds",
    };

    const resolution = orderRulings([holds, fails, abstains]);
    expect(resolution.outcome).toBe("contested");
    if (resolution.outcome === "contested") {
      // The most recently decided ruling overall is always named.
      expect(resolution.tied).toContain(abstains);
      // Its partner genuinely disagrees with it, however many sides exist.
      const [first, second] = resolution.tied;
      expect(first.verdict).not.toBe(second.verdict);
      // The third side ("holds") is real but absent from the pair.
      const shown = new Set(resolution.tied.map((entry) => entry.id));
      expect(shown.has(holds.id)).toBe(false);
    }
  });

  test("two equal-authority rulings that agree resolve to the most recently decided one", () => {
    const earlier = ruling("sha256:1111", "policy", "2026-01-01T00:00:00.000Z", "holds");
    const later = ruling("sha256:2222", "policy", "2026-01-02T00:00:00.000Z", "holds");
    const resolution = orderRulings([earlier, later]);
    expect(resolution).toEqual({ outcome: "decided", winner: later, decidedBy: "time" });
  });

  test("the most recently decided one wins by the instant its timestamp names, not by the characters of its spelling", () => {
    const earlierByOffset = ruling("sha256:1111", "policy", "2026-01-01T23:00:00.000+10:00", "holds");
    const laterByZ = ruling("sha256:2222", "policy", "2026-01-01T14:00:00.000Z", "holds");
    expect(earlierByOffset.decidedAt > laterByZ.decidedAt).toBe(true);
    const resolution = orderRulings([earlierByOffset, laterByZ]);
    expect(resolution).toEqual({ outcome: "decided", winner: laterByZ, decidedBy: "time" });
  });

  test("the floor beats a person's ruling", () => {
    const floorRuling: Ruling = {
      id: "sha256:floor",
      authority: FLOOR_AUTHORITY as CheckedAuthority,
      decidedAt: timestamp("2020-01-01T00:00:00.000Z"),
      verdict: "fails",
    };
    const resolution = orderRulings([floorRuling, RULING_A]);
    expect(resolution).toEqual({ outcome: "decided", winner: floorRuling, decidedBy: "authority" });
  });
});

describe("a ruling's authority cannot be constructed from a bare string, and a ruling record carries none of its own", () => {
  test("the branded checked authority is not assignable from a bare string literal", () => {
    const bare: Ruling = {
      id: "sha256:x",
      // @ts-expect-error a Ruling's authority must be a CheckedAuthority minted by authorityOf or floorFrom, never a bare string
      authority: "person",
      decidedAt: timestamp("2026-01-01T00:00:00.000Z"),
      verdict: "holds",
    };
    void bare;
  });

  test("a ruling record has no authority, principal or decidedAt field to read one off of", () => {
    const record: RulingRecord = {
      kind: "ruling",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.ruling,
      over: { claim: "sha256:claim" as RecordId },
      verdict: "holds",
      reason: "because the evidence was wrong",
      brief: "sha256:brief" as RecordId,
    };
    for (const removed of ["principal", "authority", "decidedAt", "evidenceSnapshot"] as const) {
      expect(record).not.toHaveProperty(removed);
    }
  });
});

describe("authorityOf", () => {
  function matrixWith(grants: readonly RoleGrant[]): RoleMatrix {
    return roleMatrix(
      [
        {
          principals: "alice@example.com",
          certAuthority: false,
          keyType: "ssh-ed25519",
          key: "AAAA",
        },
        {
          principals: "the-agent",
          certAuthority: false,
          keyType: "ssh-ed25519",
          key: "BBBB",
        },
      ],
      grants,
      "deadbeef",
    );
  }

  test("a principal holding a human-eligible role is trusted for the authority its ruling declares", () => {
    const matrix = matrixWith([{ principal: "alice@example.com", role: "owner", scope: ANY_SCOPE }]);
    expect(authorityOf(matrix, "alice@example.com", ANY_SCOPE, "person")).toBe("person");
    expect(authorityOf(matrix, "alice@example.com", ANY_SCOPE, "policy")).toBe("policy");
  });

  test("a principal holding no role beyond delegate cannot declare itself person or policy, and the refusal names the principal and the declared tier", () => {
    const matrix = matrixWith([{ principal: "the-agent", role: "delegate", scope: ANY_SCOPE }]);
    expect(authorityOf(matrix, "the-agent", ANY_SCOPE, "delegate")).toBe("delegate");
    expect(() => authorityOf(matrix, "the-agent", ANY_SCOPE, "person")).toThrow(
      "the-agent holds no role beyond delegate and cannot rule as person",
    );
    expect(() => authorityOf(matrix, "the-agent", ANY_SCOPE, "policy")).toThrow(
      "the-agent holds no role beyond delegate and cannot rule as policy",
    );
  });

  test("a principal the matrix grants nothing cannot rule even as delegate, and the refusal names the principal and the tier", () => {
    const matrix = matrixWith([{ principal: "alice@example.com", role: "owner", scope: ANY_SCOPE }]);
    expect(() => authorityOf(matrix, "the-agent", ANY_SCOPE, "delegate")).toThrow(
      "the-agent holds no role granting rule and cannot rule as delegate",
    );
    expect(() => authorityOf(matrix, "the-agent", ANY_SCOPE, "person")).toThrow(
      "the-agent holds no role beyond delegate and cannot rule as person",
    );
  });

  test("a principal attested as an agent may rule only as a delegate, whatever roles it holds", () => {
    const matrix = matrixWith([{ principal: "the-agent", role: "owner", scope: ANY_SCOPE }]);
    expect(authorityOf(matrix, "the-agent", ANY_SCOPE, "delegate", "agent")).toBe("delegate");
    expect(() => authorityOf(matrix, "the-agent", ANY_SCOPE, "person", "agent")).toThrow(
      "the-agent is attested as an agent and cannot rule as person",
    );
    expect(() => authorityOf(matrix, "the-agent", ANY_SCOPE, "policy", "agent")).toThrow(
      "the-agent is attested as an agent and cannot rule as policy",
    );
  });

  test("a principal attested as a person is trusted for whichever tier its roles allow", () => {
    const matrix = matrixWith([{ principal: "alice@example.com", role: "owner", scope: ANY_SCOPE }]);
    expect(authorityOf(matrix, "alice@example.com", ANY_SCOPE, "person", "person")).toBe("person");
    expect(authorityOf(matrix, "alice@example.com", ANY_SCOPE, "policy", "person")).toBe("policy");
    expect(authorityOf(matrix, "alice@example.com", ANY_SCOPE, "delegate", "person")).toBe("delegate");
  });

  test("a declared value outside the three tiers is refused whatever the grants, so the floor's own tier can never be handed in through a ruling", () => {
    const matrix = matrixWith([{ principal: "alice@example.com", role: "owner", scope: ANY_SCOPE }]);
    for (const smuggled of ["floor", "", "owner"]) {
      expect(() => authorityOf(matrix, "alice@example.com", ANY_SCOPE, smuggled as RulingAuthority)).toThrow(
        `alice@example.com declares an authority no ruling may carry: ${smuggled}`,
      );
    }
    const empty = roleMatrix([], [], "deadbeef");
    expect(() => authorityOf(empty, "anyone", ANY_SCOPE, "floor" as RulingAuthority)).toThrow(
      "declares an authority no ruling may carry",
    );
  });

  test("with both trust files empty every tier is the workspace's own to declare", () => {
    const matrix = roleMatrix([], [], "deadbeef");
    expect(authorityOf(matrix, "anyone", ANY_SCOPE, "person")).toBe("person");
    expect(authorityOf(matrix, "anyone", ANY_SCOPE, "delegate")).toBe("delegate");
  });
});

describe("maySupersede", () => {
  const MATRIX: RoleMatrix = roleMatrix(
    [],
    [
      { principal: "owner@example.com", role: "owner", scope: ANY_SCOPE },
      { principal: "maintainer@example.com", role: "maintainer", scope: ANY_SCOPE },
      { principal: "second-maintainer@example.com", role: "maintainer", scope: ANY_SCOPE },
      { principal: "the-agent", role: "delegate", scope: ANY_SCOPE },
      { principal: "the-agent", role: "arbiter", scope: ANY_SCOPE },
    ],
    "deadbeef",
  );

  function successor(principal: string, tier: RulingAuthority) {
    return { principal, authority: authorityOf(MATRIX, principal, ANY_SCOPE, tier) };
  }

  function ruledBy(principals: readonly string[], tier: RulingAuthority) {
    return { principals, authority: authorityOf(MATRIX, principals[0]!, ANY_SCOPE, tier) };
  }

  function overrides(principal: string): boolean {
    return may(MATRIX, principal, "override-person", ANY_SCOPE);
  }

  test("a person retires a delegate's ruling", () => {
    expect(overrides("maintainer@example.com")).toBe(false);
    expect(
      maySupersede(
        successor("maintainer@example.com", "person"),
        ruledBy(["the-agent"], "delegate"),
        overrides("maintainer@example.com"),
      ),
    ).toBe(true);
  });

  test("a delegate does not retire a person's ruling, even holding override-person", () => {
    expect(overrides("the-agent")).toBe(true);
    expect(
      maySupersede(
        successor("the-agent", "delegate"),
        ruledBy(["owner@example.com"], "person"),
        overrides("the-agent"),
      ),
    ).toBe(false);
  });

  test("a principal retires its own ruling at the same tier", () => {
    expect(
      maySupersede(
        successor("maintainer@example.com", "person"),
        ruledBy(["maintainer@example.com"], "person"),
        overrides("maintainer@example.com"),
      ),
    ).toBe(true);
  });

  test("a peer at the same tier does not retire a ruling without override-person", () => {
    expect(
      maySupersede(
        successor("second-maintainer@example.com", "person"),
        ruledBy(["maintainer@example.com"], "person"),
        overrides("second-maintainer@example.com"),
      ),
    ).toBe(false);
  });

  test("a person holding override-person retires a peer's ruling", () => {
    expect(overrides("owner@example.com")).toBe(true);
    expect(
      maySupersede(
        successor("owner@example.com", "person"),
        ruledBy(["maintainer@example.com"], "person"),
        overrides("owner@example.com"),
      ),
    ).toBe(true);
  });

  test("a ruling two principals attested is not retired by one of them alone at the same tier", () => {
    expect(
      maySupersede(
        successor("maintainer@example.com", "person"),
        ruledBy(["maintainer@example.com", "second-maintainer@example.com"], "person"),
        overrides("maintainer@example.com"),
      ),
    ).toBe(false);
  });

  test("a ruling nothing vouches for is retired only through override-person at person tier", () => {
    const unvouched = { principals: ["maintainer@example.com"], authority: null };
    expect(maySupersede(successor("owner@example.com", "person"), unvouched, overrides("owner@example.com"))).toBe(
      true,
    );
    expect(
      maySupersede(successor("maintainer@example.com", "person"), unvouched, overrides("maintainer@example.com")),
    ).toBe(false);
    expect(maySupersede(successor("the-agent", "delegate"), unvouched, overrides("the-agent"))).toBe(false);
  });

  test("a ruling with no attesting principal is not retired through the own-principal arm", () => {
    const unattested = {
      principals: [],
      authority: authorityOf(MATRIX, "maintainer@example.com", ANY_SCOPE, "person"),
    };
    expect(
      maySupersede(successor("maintainer@example.com", "person"), unattested, overrides("maintainer@example.com")),
    ).toBe(false);
  });
});

describe("authorityFromAttestation", () => {
  const RULING_ID = `sha256:${"1".repeat(64)}`;

  function madeAttestation(overrides: Partial<MadeAttestationRecord>): MadeAttestationRecord {
    return {
      kind: "attestation",
      schemaVersion: CURRENT_SCHEMA_VERSIONS.attestation,
      subject: RULING_ID as RecordId,
      principal: "alice@example.com",
      principalClass: "person",
      via: "tty",
      purpose: "made",
      at: timestamp("2026-01-01T00:00:00.000Z"),
      supersedes: [],
      ...overrides,
    };
  }

  const OWNER_GRANTS_ALICE: RoleMatrix = roleMatrix(
    [],
    [{ principal: "alice@example.com", role: "owner", scope: ANY_SCOPE }],
    "deadbeef",
  );

  test("a ruling whose made attestation names a principal the roles file grants the action to evaluates as within authority", () => {
    const evaluated = authorityFromAttestation({ id: RULING_ID }, madeAttestation({}), OWNER_GRANTS_ALICE, ANY_SCOPE);
    expect(evaluated).not.toBeNull();
    expect(evaluated!.withinAuthority).toBe(true);
    expect(evaluated!.class).toBe("person");
  });

  test("the same ruling with the roles file at a commit that does not grant it evaluates as outside, with no change to the ruling record", () => {
    const matrixWithNoGrant = roleMatrix(
      [],
      [{ principal: "someone-else@example.com", role: "owner", scope: ANY_SCOPE }],
      "deadbeef",
    );
    const evaluated = authorityFromAttestation({ id: RULING_ID }, madeAttestation({}), matrixWithNoGrant, ANY_SCOPE);
    expect(evaluated).not.toBeNull();
    expect(evaluated!.withinAuthority).toBe(false);
    expect(evaluated!.class).toBeNull();
  });

  test("a via of model never evaluates person-class, whatever principal class the attestation asserts", () => {
    const evaluated = authorityFromAttestation(
      { id: RULING_ID },
      madeAttestation({ via: "model", principalClass: "person" }),
      OWNER_GRANTS_ALICE,
      ANY_SCOPE,
    );
    expect(evaluated).not.toBeNull();
    expect(evaluated!.class).not.toBe("person");
    expect(evaluated!.provisional).toBe(true);
  });

  test("a via of model is always provisional; a live channel is not", () => {
    const provisional = authorityFromAttestation(
      { id: RULING_ID },
      madeAttestation({ via: "model" }),
      OWNER_GRANTS_ALICE,
      ANY_SCOPE,
    );
    const settled = authorityFromAttestation(
      { id: RULING_ID },
      madeAttestation({ via: "signature" }),
      OWNER_GRANTS_ALICE,
      ANY_SCOPE,
    );
    expect(provisional!.provisional).toBe(true);
    expect(settled!.provisional).toBe(false);
  });

  test("a ruling with no made attestation has no authority to evaluate", () => {
    expect(authorityFromAttestation({ id: RULING_ID }, null, OWNER_GRANTS_ALICE, ANY_SCOPE)).toBeNull();
  });

  test("an attestation naming an agent evaluates as delegate, whatever channel it arrived through", () => {
    const matrix = roleMatrix([], [{ principal: "the-agent", role: "delegate", scope: ANY_SCOPE }], "deadbeef");
    const evaluated = authorityFromAttestation(
      { id: RULING_ID },
      madeAttestation({ principal: "the-agent", principalClass: "agent", via: "signature" }),
      matrix,
      ANY_SCOPE,
    );
    expect(evaluated!.class).toBe("delegate");
    expect(evaluated!.withinAuthority).toBe(true);
  });

  test("an attestation naming a subject other than the ruling it is checked against is refused", () => {
    const mismatched = madeAttestation({ subject: `sha256:${"2".repeat(64)}` as RecordId });
    expect(() => authorityFromAttestation({ id: RULING_ID }, mismatched, OWNER_GRANTS_ALICE, ANY_SCOPE)).toThrow();
  });
});

describe("floorFrom", () => {
  let repo: FixtureRepo;

  test("a workspace whose configuration declares no floor produces no floor ruling, and a person's ruling is the top tier", async () => {
    repo = await makeFixtureRepo("floor");
    try {
      const config = await readWorkspaceConfig(repo.ctx);
      expect(floorFrom(config)).toBeNull();

      const person = ruling("sha256:person", "person", "2026-01-01T00:00:00.000Z", "holds");
      expect(orderRulings([person])).toEqual({ outcome: "decided", winner: person, decidedBy: "authority" });
    } finally {
      await repo.cleanup();
    }
  });

  test("a workspace whose trust branch declares a floor produces one that outranks a person's ruling, reading the same commit on a second read of an unchanged branch", async () => {
    repo = await makeFixtureRepo("floor");
    try {
      await writeTrustFile(repo.ctx, "config.json", `${JSON.stringify({ floor: { verdict: "fails" } })}\n`);
      const beforeCommit = await gitRevParse(repo.ctx, "refs/heads/main");
      const configOnce = await readWorkspaceConfig(repo.ctx);
      const configTwice = await readWorkspaceConfig(repo.ctx);
      expect(configOnce.commit).toBe(beforeCommit);
      expect(configTwice.commit).toBe(beforeCommit);

      const floor = floorFrom(configOnce);
      expect(floor).not.toBeNull();
      expect(floor!.commit).toBe(beforeCommit);
      expect(floorFrom(configTwice)!.commit).toBe(floor!.commit);

      const person = ruling("sha256:person", "person", "2026-01-01T00:00:00.000Z", "holds");
      const resolution = orderRulings([floor!, person]);
      expect(resolution).toEqual({ outcome: "decided", winner: floor, decidedBy: "authority" });
    } finally {
      await repo.cleanup();
    }
  });

  test("a configuration declaring a floor in a shape the producer does not recognise is refused by name rather than silently producing no floor", async () => {
    repo = await makeFixtureRepo("floor");
    try {
      await writeTrustFile(repo.ctx, "config.json", `${JSON.stringify({ floor: { verdict: "sideways" } })}\n`);
      const config = await readWorkspaceConfig(repo.ctx);
      expect(() => floorFrom(config)).toThrow(/refusing to read the workspace floor/);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("rulingConflicts and mintSetAside", () => {
  test("a ruling agreeing with its overlapping receipt mints no set-aside", () => {
    expect(rulingConflicts("holds", "holds")).toBe(false);
  });

  test("a ruling differing from its overlapping receipt mints exactly one set-aside carrying a non-empty reason", () => {
    expect(rulingConflicts("fails", "holds")).toBe(true);
    const aside = mintSetAside(
      { id: "sha256:ruling1", principal: "alice@example.com", decidedAt: timestamp("2026-01-01T00:00:00.000Z") },
      "sha256:run1",
      "the receipt predates a since-fixed regression",
    );
    expect(aside.reason.length).toBeGreaterThan(0);
    expect(aside.run).toBe("sha256:run1");
  });

  test("a conflicting ruling with an empty reason is refused rather than recorded as a weightless set-aside", () => {
    expect(() =>
      mintSetAside(
        { id: "sha256:ruling1", principal: "alice@example.com", decidedAt: timestamp("2026-01-01T00:00:00.000Z") },
        "sha256:run1",
        "",
      ),
    ).toThrow();
    expect(() =>
      mintSetAside(
        { id: "sha256:ruling1", principal: "alice@example.com", decidedAt: timestamp("2026-01-01T00:00:00.000Z") },
        "sha256:run1",
        "   ",
      ),
    ).toThrow();
  });
});

describe("pinnedEvidenceMoved", () => {
  test("moving a ruling's pinned evidence leaves the ruling's verdict unchanged and is detectable independently of it", () => {
    const pinned = ruling("sha256:pinned", "person", "2026-01-01T00:00:00.000Z", "holds");
    expect(pinnedEvidenceMoved(["sha256:ev1", "sha256:ev2"], ["sha256:ev1", "sha256:ev3"])).toBe(true);
    expect(pinnedEvidenceMoved(["sha256:ev1", "sha256:ev2"], ["sha256:ev1", "sha256:ev2"])).toBe(false);
    expect(pinned.verdict).toBe("holds");
  });
});

interface RulingFixtureEntry {
  readonly id: string;
  readonly principal?: string;
  readonly authority: RulingAuthority | typeof FLOOR_AUTHORITY;
  readonly decidedAt: string;
  readonly verdict: "holds" | "fails";
}

interface RulingFixtureGrant {
  readonly principal: string;
  readonly role: Role;
}

interface RulingFixture {
  readonly kind: "ruling";
  readonly source: string;
  readonly description: string;
  readonly reasoning: string;
  readonly grants?: readonly RulingFixtureGrant[];
  readonly rulings: readonly RulingFixtureEntry[];
  readonly expected:
    | { readonly outcome: "decided"; readonly winnerId: string; readonly decidedBy: "authority" | "time" }
    | { readonly outcome: "contested" };
}

/** Mints each fixture authority through the checker; only the floor passes straight through. */
function mintFixtureRulings(fixture: RulingFixture): readonly Ruling[] {
  const grants: RoleGrant[] = (fixture.grants ?? []).map((grant) => ({
    principal: grant.principal,
    role: grant.role,
    scope: ANY_SCOPE,
  }));
  const matrix = roleMatrix([], grants, "deadbeef");
  return fixture.rulings.map((entry) => ({
    id: entry.id,
    authority:
      entry.authority === FLOOR_AUTHORITY
        ? (FLOOR_AUTHORITY as CheckedAuthority)
        : authorityOf(matrix, entry.principal!, ANY_SCOPE, entry.authority),
    decidedAt: timestamp(entry.decidedAt),
    verdict: entry.verdict,
  }));
}

async function runRulingFixtures(dir: string): Promise<void> {
  const entries = await readdir(dir);
  const fixtureFiles = entries.filter((entry) => entry.endsWith(".json")).sort();
  expect(fixtureFiles.length, `no fixtures found under ${dir}`).toBeGreaterThanOrEqual(8);

  for (const file of fixtureFiles) {
    const raw = await readFile(join(dir, file), "utf8");
    const fixture = JSON.parse(raw) as RulingFixture;
    if (!fixture.reasoning || fixture.reasoning.trim().length === 0) {
      throw new Error(`fixture ${file} (${fixture.source}) declares no reasoning behind its expectation`);
    }
    const context = `fixture ${file} (${fixture.source}): ${fixture.description}`;
    const resolution = orderRulings(mintFixtureRulings(fixture));
    expect(resolution.outcome, `${context} — outcome`).toBe(fixture.expected.outcome);
    if (fixture.expected.outcome === "decided" && resolution.outcome === "decided") {
      expect(resolution.winner.id, `${context} — winner`).toBe(fixture.expected.winnerId);
      expect(resolution.decidedBy, `${context} — justification`).toBe(fixture.expected.decidedBy);
    }
  }
}

describe("Musai-specific ruling, set-aside and authority-floor corpus", () => {
  test("every second-tier fixture states its expected labelling, its expected justification, and the reasoning behind it", async () => {
    await runRulingFixtures(RULINGS_FIXTURES_DIR);
  });
});
