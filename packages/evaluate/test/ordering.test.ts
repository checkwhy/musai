import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Conditions, DimensionRegistry } from "@musai/records";
import { ANY_SCOPE, exactDecimal } from "@musai/records";
import { runFixtureTable } from "@musai/test-support";
import { describe, expect, test } from "vitest";
import { EVIDENCE_ORDER, evidenceKindOf, weakestLink } from "../src/evaluator/evidence.js";
import {
  type Argument,
  applicability,
  compareArguments,
  type ValidityInput,
  type ValidityRegistry,
  validity,
} from "../src/evaluator/ordering.js";

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures", import.meta.url));

describe("EVIDENCE_ORDER", () => {
  test("ranks exactly four kinds, receipt above citation above a person's judgment above an agent's judgment", () => {
    expect(EVIDENCE_ORDER).toEqual(["receipt", "citation", "person-judgment", "agent-judgment"]);
  });
});

describe("evidenceKindOf", () => {
  test("an executed run is a receipt regardless of who ran it", () => {
    expect(evidenceKindOf({ runKind: "run" }, null)).toBe("receipt");
  });

  test("a fetched run is a citation regardless of who fetched it", () => {
    expect(evidenceKindOf({ runKind: "citation" }, null)).toBe("citation");
  });

  test("a testimony run's kind depends on the class of the principal attesting it", () => {
    expect(evidenceKindOf({ runKind: "testimony" }, { principalClass: "person" })).toBe("person-judgment");
    expect(evidenceKindOf({ runKind: "testimony" }, { principalClass: "agent" })).toBe("agent-judgment");
  });

  test("a testimony run with no attestation cannot be assigned a kind", () => {
    expect(() => evidenceKindOf({ runKind: "testimony" }, null)).toThrow();
  });
});

describe("weakestLink", () => {
  test("names the hop that set the ceiling, not only the resulting kind", () => {
    const chain = [
      { id: "a", kind: "receipt" as const },
      { id: "b", kind: "citation" as const },
      { id: "c", kind: "agent-judgment" as const },
      { id: "d", kind: "receipt" as const },
    ];
    const link = weakestLink(chain);
    expect(link.kind).toBe("agent-judgment");
    expect(link.settledBy.id).toBe("c");
  });
});

const NUMERIC_CHAPTER: DimensionRegistry = new Map([
  ["chapter", { name: "chapter", type: "ordered", data: { order: "numeric" } }],
]);

describe("applicability", () => {
  test("a rule with no declared conditions applies universally", () => {
    expect(applicability({}, {}, new Map())).toBe(true);
  });

  test("a rule's condition outside the claim's own value is not applicable", () => {
    const rule: Conditions = { platform: "linux" };
    expect(applicability(rule, { platform: "windows" }, new Map())).toBe(false);
    expect(applicability(rule, { platform: "linux" }, new Map())).toBe(true);
  });

  test("a dimension the rule cares about that the claim never declares is not applicable", () => {
    expect(applicability({ platform: { kind: "any" } }, {}, new Map())).toBe(false);
  });

  test("a rule's scope is compared under the dimension the workspace declares for it", () => {
    const rule: Conditions = { chapter: { kind: "range", from: "2", to: "10" } };
    expect(applicability(rule, { chapter: "9" }, NUMERIC_CHAPTER)).toBe(true);
    expect(applicability(rule, { chapter: "9" }, new Map())).toBe(false);
  });
});

const KNOWN_REGISTRY: ValidityRegistry = {
  knownClaimTypes: new Set(["bugs.reproduces@1"]),
  requiresSignatureFor: () => true,
};

describe("validity", () => {
  test("an unsigned input where signing is required is rejected, not weighed as light evidence", () => {
    const input: ValidityInput = {
      claimType: "bugs.reproduces@1",
      signed: false,
      rule: {},
      conditions: {},
      dimensions: new Map(),
      contribution: null,
    };
    const result = validity(input, "optional", KNOWN_REGISTRY);
    expect(result.outcome).toBe("rejected");
  });

  test("an unknown claim type is rejected", () => {
    const input: ValidityInput = {
      claimType: "no-such-type@1",
      signed: true,
      rule: {},
      conditions: {},
      dimensions: new Map(),
      contribution: null,
    };
    expect(validity(input, "optional", KNOWN_REGISTRY).outcome).toBe("rejected");
  });

  test("an out-of-scope condition is inapplicable", () => {
    const input: ValidityInput = {
      claimType: "bugs.reproduces@1",
      signed: true,
      rule: { platform: "linux" },
      conditions: { platform: "windows" },
      dimensions: new Map(),
      contribution: null,
    };
    expect(validity(input, "optional", KNOWN_REGISTRY).outcome).toBe("inapplicable");
  });

  test("an out-of-scope condition says which dimension fell outside and whose rule record scoped it", () => {
    const base: Omit<ValidityInput, "conditions"> = {
      claimType: "bugs.reproduces@1",
      signed: true,
      rule: { platform: "linux", tier: "gold" },
      dimensions: new Map(),
      contribution: "bugs/triage",
    };
    const outside: readonly Conditions[] = [{ platform: "linux", tier: "bronze" }, { platform: "linux" }];
    for (const conditions of outside) {
      const result = validity({ ...base, conditions }, "optional", KNOWN_REGISTRY);
      expect(result.outcome).toBe("inapplicable");
      const reason = (result as { reason: string }).reason;
      expect(reason).toContain("bugs.reproduces@1");
      expect(reason).toContain("tier");
      expect(reason).toContain("bugs/triage");
      expect(reason).not.toContain("platform");
    }
  });

  test("a signed, applicable, known claim type is valid", () => {
    const input: ValidityInput = {
      claimType: "bugs.reproduces@1",
      signed: true,
      rule: {},
      conditions: {},
      dimensions: new Map(),
      contribution: null,
    };
    expect(validity(input, "optional", KNOWN_REGISTRY).outcome).toBe("valid");
  });

  test("a rule's scope is decided under the dimensions the input hands in", () => {
    const base: Omit<ValidityInput, "dimensions"> = {
      claimType: "bugs.reproduces@1",
      signed: true,
      rule: { chapter: { kind: "range", from: "2", to: "10" } },
      conditions: { chapter: "9" },
      contribution: null,
    };
    expect(validity({ ...base, dimensions: NUMERIC_CHAPTER }, "optional", KNOWN_REGISTRY).outcome).toBe("valid");
    expect(validity({ ...base, dimensions: new Map() }, "optional", KNOWN_REGISTRY).outcome).toBe("inapplicable");
  });
});

describe("compareArguments", () => {
  test("two weights differing beyond double precision compare unequal", () => {
    const base: Omit<Argument, "declaredWeight"> = { id: "a", evidenceKind: "receipt", scope: ANY_SCOPE };
    const a: Argument = { ...base, id: "a", declaredWeight: exactDecimal("0.10000000000000000001") };
    const b: Argument = { ...base, id: "b", declaredWeight: exactDecimal("0.10000000000000000002") };
    expect(Number(a.declaredWeight)).toBe(Number(b.declaredWeight));
    const comparison = compareArguments(a, b);
    expect(comparison.decidedBy).toBe("weight");
    expect(comparison.winner).toBe("b");
  });

  test("equal declared weights fall through to open", () => {
    const a: Argument = { id: "a", evidenceKind: "receipt", scope: ANY_SCOPE, declaredWeight: exactDecimal("1") };
    const b: Argument = { id: "b", evidenceKind: "receipt", scope: ANY_SCOPE, declaredWeight: exactDecimal("1") };
    const comparison = compareArguments(a, b);
    expect(comparison.winner).toBe("open");
    expect(comparison.decidedBy).toBe("equal");
  });
});

describe("runFixtureTable", () => {
  test("runs every fixture in the corpus, asserting both label and justification", async () => {
    await runFixtureTable(FIXTURES_DIR);
  });

  test("discovers every file under the fixtures directory, including one added at test time", async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), "musai-fixtures-scratch-"));
    await writeFile(
      join(scratchDir, "existing.fixture.json"),
      JSON.stringify({
        kind: "weakest-link",
        source: "scratch",
        description: "a lone fixture before the count rises",
        chain: [{ id: "only", kind: "receipt" }],
        expected: { cappedKind: "receipt", cappedHopIndex: 0 },
      }),
    );

    try {
      const filesBefore = (await readdir(scratchDir)).filter((entry) => entry.endsWith(".json"));
      expect(filesBefore).toHaveLength(1);

      await writeFile(
        join(scratchDir, "added-later.fixture.json"),
        JSON.stringify({
          kind: "weakest-link",
          source: "scratch",
          description: "a second fixture added after the first",
          chain: [{ id: "only", kind: "citation" }],
          expected: { cappedKind: "citation", cappedHopIndex: 0 },
        }),
      );

      const filesAfter = (await readdir(scratchDir)).filter((entry) => entry.endsWith(".json"));
      expect(filesAfter.length).toBeGreaterThan(filesBefore.length);
      await expect(runFixtureTable(scratchDir)).resolves.toBeUndefined();
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test("a fixture declaring only a label, with no justification, fails the harness rather than passing", async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), "musai-fixtures-label-only-"));
    await writeFile(
      join(scratchDir, "label-only.fixture.json"),
      JSON.stringify({
        kind: "ordering",
        source: "scratch",
        description: "declares a winner but not the justification that produced it",
        arguments: [
          { id: "a", evidenceChain: [{ id: "a#0", kind: "receipt" }], scope: { kind: "any" }, weight: "1" },
          { id: "b", evidenceChain: [{ id: "b#0", kind: "receipt" }], scope: { kind: "any" }, weight: "1" },
        ],
        expected: { winner: "open" },
      }),
    );

    try {
      await expect(runFixtureTable(scratchDir)).rejects.toThrow(/justification/);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });
});
