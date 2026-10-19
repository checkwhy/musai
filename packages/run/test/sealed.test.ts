import type { ValidationOptions } from "@musai/records";
import {
  CURRENT_SCHEMA_VERSIONS,
  claimTypesFrom,
  isSealedValue,
  misplacedSealedPath,
  recordId,
  SEALED_KEY,
  type SealedValue,
  SealedValueError,
  slotFor,
  TRIPLE_CLAIM_TYPE,
  TRIPLE_DECLARATION,
  textOf,
  timestamp,
  validateRecord,
  versionString,
} from "@musai/records";
import { describe, expect, test } from "vitest";
import { RUNNER_PERFORMER } from "../src/performer.js";

/** The base triple and the one type every claim in this file is minted as. */
const TRIPLE_VALIDATION: ValidationOptions = {
  unregisteredClaimTypes: "refuse",
  claimTypes: claimTypesFrom([TRIPLE_DECLARATION]),
};

const FIXED_INSTANT = timestamp("2026-01-01T00:00:00.000Z");
const SUBJECT = recordId({ example: "a record a sealed value stands in" });

function sealed(ciphertext: string): SealedValue {
  return { [SEALED_KEY]: { alg: "aes-256-gcm", keyId: "key-1", ciphertext, digest: "a".repeat(64) } };
}

function claimWith(rendering: unknown): Record<string, unknown> {
  const conditions = { subject: "urn:example:one", predicate: "concerns", object: "sealing" };
  return {
    kind: "claim",
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: TRIPLE_CLAIM_TYPE,
    about: [],
    slot: slotFor(TRIPLE_DECLARATION, conditions),
    conditions,
    canonical: conditions,
    rendering,
    evidence: [],
    exclusiveGroup: null,
    supersedes: [],
  };
}

function runWith(output: unknown): Record<string, unknown> {
  return {
    kind: "run",
    schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
    runKind: "run",
    performer: RUNNER_PERFORMER,
    determinism: "nondeterministic",
    supersedes: [],
    recipe: {
      command: ["true"],
      workingDirectory: "/",
      environment: {},
      declared: [],
      substrates: [],
      isolation: "hygiene",
    },
    observation: {
      resolved: [],
      isolationHeld: "hygiene",
      binaries: [],
      bindings: [],
      output,
      outputLossy: false,
      exitCode: 0,
      scrubbed: [],
      startedAt: FIXED_INSTANT,
      finishedAt: FIXED_INSTANT,
      reads: [],
      cost: {},
    },
  };
}

const AT_EACH_POSITION: ReadonlyArray<{ where: string; record: (value: unknown) => Record<string, unknown> }> = [
  { where: "a claim's rendering", record: claimWith },
  {
    where: "an argument's reason",
    record: (reason) => ({
      kind: "argument",
      schemaVersion: CURRENT_SCHEMA_VERSIONS.argument,
      target: SUBJECT,
      reason,
      evidence: [],
      premises: [],
      supersedes: [],
    }),
  },
  {
    where: "a ruling's reason",
    record: (reason) => ({
      kind: "ruling",
      schemaVersion: CURRENT_SCHEMA_VERSIONS.ruling,
      over: { claim: SUBJECT },
      verdict: "holds",
      reason,
      brief: recordId({ example: "a brief" }),
      supersedes: [],
    }),
  },
  { where: "a run's output", record: runWith },
  {
    where: "an artifact's content",
    record: (content) => ({
      kind: "artifact",
      schemaVersion: CURRENT_SCHEMA_VERSIONS.artifact,
      case: SUBJECT,
      lifecycle: "drafted",
      content,
      format: "text/markdown",
      supersedes: [],
    }),
  },
];

describe("the one key the canonical form reserves", () => {
  for (const position of AT_EACH_POSITION) {
    test(`a sealed value stands where ${position.where} would, and its id is taken over the ciphertext`, () => {
      const one = validateRecord(position.record(sealed("Y2lwaGVydGV4dA==")), TRIPLE_VALIDATION);
      expect(one).toMatchObject({ ok: true });

      const other = validateRecord(position.record(sealed("ZGlmZmVyZW50")), TRIPLE_VALIDATION);
      expect(other).toMatchObject({ ok: true });
      if (one.ok && other.ok) {
        expect(recordId(one.record)).not.toBe(recordId(other.record));
      }
    });
  }

  test("a sealed value anywhere else is refused, naming the path it was found at", () => {
    const underCanonical = validateRecord(
      { ...claimWith("plain text"), canonical: { note: sealed("Y2lwaGVy") } },
      TRIPLE_VALIDATION,
    );
    expect(underCanonical.ok).toBe(false);
    if (!underCanonical.ok) {
      expect(underCanonical.error).toContain("$.canonical.note");
    }

    const run = runWith("plain text");
    const recipe = run["recipe"] as Record<string, unknown>;
    const underRecipe = validateRecord({ ...run, recipe: { ...recipe, environment: { SECRET: sealed("Y2lwaGVy") } } });
    expect(underRecipe.ok).toBe(false);
    if (!underRecipe.ok) {
      expect(underRecipe.error).toContain("$.recipe.environment.SECRET");
    }

    const withinScope = validateRecord({
      kind: "rule",
      schemaVersion: CURRENT_SCHEMA_VERSIONS.rule,
      name: "a rule at a coded scope",
      scope: {
        team: {
          kind: "coded",
          module: "musai.demo",
          name: "in-team",
          version: versionString("1"),
          args: sealed("Y2lwaGVy"),
        },
      },
      weight: "1",
      supersedes: [],
      contribution: null,
    });
    expect(withinScope.ok).toBe(false);
    if (!withinScope.ok) {
      expect(withinScope.error).toContain("$.scope.team.args");
    }
  });

  test("a malformed sealed value is refused where a well-formed one would be admitted", () => {
    const malformed = [
      { [SEALED_KEY]: { alg: "rot13", keyId: "key-1", ciphertext: "Y2lwaGVy", digest: "a".repeat(64) } },
      { [SEALED_KEY]: { alg: "aes-256-gcm", keyId: "", ciphertext: "Y2lwaGVy", digest: "a".repeat(64) } },
      { [SEALED_KEY]: { alg: "aes-256-gcm", keyId: "key-1", ciphertext: "Y2lwaGVy", digest: "not hex" } },
      { [SEALED_KEY]: { alg: "aes-256-gcm", keyId: "key-1", ciphertext: "Y2lwaGVy" } },
      {
        [SEALED_KEY]: { alg: "aes-256-gcm", keyId: "key-1", ciphertext: "Y2lwaGVy", digest: "a".repeat(64) },
        note: "extra",
      },
    ];
    for (const value of malformed) {
      expect(isSealedValue(value)).toBe(false);
      const result = validateRecord(claimWith(value), TRIPLE_VALIDATION);
      expect(result.ok).toBe(false);
    }
  });

  test("a reader that needs text refuses a sealed value by name rather than handing on ciphertext", () => {
    expect(textOf("plain", "a claim's rendering")).toBe("plain");
    expect(() => textOf(sealed("Y2lwaGVy"), "a claim's rendering")).toThrow(SealedValueError);
    expect(() => textOf(sealed("Y2lwaGVy"), "a claim's rendering")).toThrow("a claim's rendering is sealed");
  });

  test("the walk finds the first offending path and passes a value carrying none", () => {
    const allowed = new Set(["$.rendering"]);
    expect(misplacedSealedPath({ rendering: sealed("Y2lwaGVy") }, allowed)).toBeNull();
    expect(misplacedSealedPath({ note: sealed("Y2lwaGVy") }, allowed)).toBe("$.note");
    expect(misplacedSealedPath({ list: [{ deep: sealed("Y2lwaGVy") }] }, allowed)).toBe("$.list[0].deep");
    expect(misplacedSealedPath({ plain: "nothing sealed here" }, allowed)).toBeNull();
  });
});
