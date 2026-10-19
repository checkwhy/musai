import { describe, expect, it } from "vitest";
import { canonicalBytes, rawId, recordId } from "../src/canonical/canonicalize.js";
import { exactDecimal, timestamp, versionString } from "../src/canonical/numbers.js";
import { EVALUATOR_VERSION } from "../src/canonical/version.js";
import type { Conditions } from "../src/conditions/condition-value.js";
import { type ClaimTypeDeclaration, claimTypesFrom, NO_CLAIM_TYPES, slotFor } from "../src/record/claim-types.js";
import type { ValidationOptions } from "../src/record/contract.js";
import { renderSelector, type Selector } from "../src/record/evidence.js";
import type { ArgumentRecord } from "../src/record/kinds/argument.js";
import type { ArtifactRecord } from "../src/record/kinds/artifact.js";
import type { AttestationRecord } from "../src/record/kinds/attestation.js";
import type { CaseRecord } from "../src/record/kinds/case.js";
import type { ClaimRecord } from "../src/record/kinds/claim.js";
import type { ModuleRecord } from "../src/record/kinds/module.js";
import type { RuleRecord } from "../src/record/kinds/rule.js";
import { type RulingRecord, rulingContract } from "../src/record/kinds/ruling.js";
import { BRIEF_MEDIA_TYPE, CREW_MEDIA_TYPE, MODEL_MEDIA_TYPE, type RunRecord } from "../src/record/kinds/run.js";
import { RECORD_KINDS, type RecordKind } from "../src/record/kinds.js";
import {
  CURRENT_SCHEMA_VERSIONS,
  KIND_CONTRACTS,
  type MusaiRecord,
  SALTABLE_KINDS,
  type ValidationResult,
  validateRecord,
} from "../src/record/schema.js";

const RUN_ID = recordId({ marker: "run" });
const CLAIM_ID = recordId({ marker: "claim" });
const CASE_ID = recordId({ marker: "case" });
const ITEM_ID = recordId({ marker: "item" });
const BRIEF_ID = recordId({ marker: "brief" });
const PRESET_MODULE_RECORD_ID = recordId({ marker: "preset-module" });

const CLAIM_TYPE = "musai.demo/claim@1";
const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: CLAIM_TYPE, identityDimensions: ["subject"] };
const CLAIM_CONDITIONS: Conditions = { subject: "one" };

function wellFormedSelector(): Selector {
  return { module: "musai.core", parser: "exit-code", version: versionString("1"), key: "exitCode" };
}

/** A caller knowing the one claim type these fixtures are minted as. */
const DEMO_VALIDATION: ValidationOptions = {
  unregisteredClaimTypes: "refuse",
  claimTypes: claimTypesFrom([CLAIM_DECLARATION]),
};

function validated(value: unknown): ValidationResult {
  return validateRecord(value, DEMO_VALIDATION);
}

function wellFormedClaim(): ClaimRecord {
  return {
    kind: "claim",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: CLAIM_TYPE,
    about: ["urn:example:one"],
    slot: slotFor(CLAIM_DECLARATION, CLAIM_CONDITIONS),
    conditions: CLAIM_CONDITIONS,
    canonical: { statement: "a claim a case says is true" },
    rendering: "A claim a case says is true.",
    evidence: [{ run: RUN_ID, selector: wellFormedSelector(), item: ITEM_ID }],
    exclusiveGroup: null,
  };
}

function wellFormedArgument(): ArgumentRecord {
  return {
    kind: "argument",
    premises: [],
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.argument,
    target: CLAIM_ID,
    reason: "the receipt shows a different result",
    evidence: [{ run: RUN_ID, selector: wellFormedSelector(), item: ITEM_ID }],
  };
}

function wellFormedRun(): RunRecord {
  return {
    kind: "run",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
    runKind: "run",
    determinism: "nondeterministic",
    performer: { kind: "runner", version: EVALUATOR_VERSION },
    recipe: {
      command: ["true"],
      workingDirectory: "/work",
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
      output: "ok",
      outputLossy: false,
      exitCode: 0,
      scrubbed: [],
      startedAt: timestamp("2026-01-01T00:00:00.000Z"),
      finishedAt: timestamp("2026-01-01T00:00:00.000Z"),
      reads: [],
      cost: {},
    },
  };
}

function wellFormedTestimonyRun(): RunRecord {
  return {
    kind: "run",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
    runKind: "testimony",
    determinism: "nondeterministic",
    performer: { kind: "runner", version: EVALUATOR_VERSION },
    recipe: {
      command: ["ask", "musai.core/judge"],
      workingDirectory: "",
      environment: {},
      declared: [],
      substrates: [
        { mediaType: BRIEF_MEDIA_TYPE, digest: { sha256: "a".repeat(64) } },
        { mediaType: CREW_MEDIA_TYPE, digest: { sha256: "b".repeat(64) } },
        { mediaType: MODEL_MEDIA_TYPE, uri: "model://anthropic/claude" },
      ],
      isolation: "none",
    },
    observation: {
      resolved: [],
      isolationHeld: "none",
      binaries: [],
      bindings: [],
      output: "the transcript a testimony run produced",
      outputLossy: false,
      exitCode: 0,
      scrubbed: [],
      startedAt: timestamp("2026-01-01T00:00:00.000Z"),
      finishedAt: timestamp("2026-01-01T00:00:00.000Z"),
      reads: [],
      cost: {},
    },
  };
}

function wellFormedRuling(): RulingRecord {
  return {
    kind: "ruling",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.ruling,
    over: { claim: CLAIM_ID },
    verdict: "fails",
    reason: "the flaky run does not reflect the fix",
    brief: BRIEF_ID,
  };
}

function wellFormedRule(): RuleRecord {
  return {
    kind: "rule",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.rule,
    name: "demo-rule",
    scope: { version: { kind: "from", value: "2.0" } },
    weight: exactDecimal("1"),
    contribution: null,
  };
}

function wellFormedCase(): CaseRecord {
  return {
    kind: "case",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.case,
    type: null,
    slug: "demo-case",
    claims: [CLAIM_ID],
    preset: { module: "musai.core", contribution: "musai.core/interactive", moduleRecord: PRESET_MODULE_RECORD_ID },
    projectCommit: "0".repeat(40),
    overrides: {},
    evaluatorVersion: versionString("1"),
  };
}

function wellFormedArtifact(): ArtifactRecord {
  return {
    kind: "artifact",
    schemaVersion: CURRENT_SCHEMA_VERSIONS.artifact,
    case: CASE_ID,
    lifecycle: "drafted",
    content: "draft text",
    format: "markdown",
    supersedes: [],
  };
}

function wellFormedAttestation(): AttestationRecord {
  return {
    kind: "attestation",
    schemaVersion: CURRENT_SCHEMA_VERSIONS.attestation,
    subject: CLAIM_ID,
    principal: `key:SHA256:${"a".repeat(43)}`,
    principalClass: "person",
    via: "tty",
    purpose: "made",
    supersedes: [],
    at: timestamp("2026-01-03T00:00:00.000Z"),
  };
}

const MODULE_NAME = "musai.demo";
const BUNDLE_ID = recordId({ marker: "bundle" });
const BUILD_ID = recordId({ marker: "build" });

function wellFormedModule(): ModuleRecord {
  return {
    kind: "module",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.module,
    name: MODULE_NAME,
    version: versionString("1"),
    manifest: {
      protocolVersion: 1,
      contributions: [
        {
          kind: "parser",
          id: `${MODULE_NAME}/exit-code`,
          version: versionString("1"),
          input: { type: "object" },
          output: { type: "object" },
          documentation: "Reads a run's exit code from its observation.",
        },
      ],
      sourceTree: { digest: { gitTree: "a".repeat(40) } },
      toolchain: [{ name: "node", version: versionString("24.0.0") }],
      packages: [],
    },
    bundle: BUNDLE_ID,
    build: BUILD_ID,
  };
}

function wellFormedDataOnlyModule(): ModuleRecord {
  return { ...wellFormedModule(), bundle: null, build: null };
}

describe("validateRecord accepts a well-formed example of each of the nine kinds", () => {
  it("accepts a claim", () => {
    expect(validated(wellFormedClaim())).toMatchObject({ ok: true });
  });

  it("accepts an argument", () => {
    expect(validated(wellFormedArgument())).toMatchObject({ ok: true });
  });

  it("accepts a run", () => {
    expect(validated(wellFormedRun())).toMatchObject({ ok: true });
  });

  it("accepts a ruling", () => {
    expect(validated(wellFormedRuling())).toMatchObject({ ok: true });
  });

  it("accepts a rule", () => {
    expect(validated(wellFormedRule())).toMatchObject({ ok: true });
  });

  it("accepts a case", () => {
    expect(validated(wellFormedCase())).toMatchObject({ ok: true });
  });

  it("accepts an artifact", () => {
    expect(validated(wellFormedArtifact())).toMatchObject({ ok: true });
  });

  it("accepts an attestation", () => {
    expect(validated(wellFormedAttestation())).toMatchObject({ ok: true });
  });

  it("accepts a module", () => {
    expect(validated(wellFormedModule())).toMatchObject({ ok: true });
  });
});

describe("validateRecord rebuilds a record from an allow-list of its kind's own fields", () => {
  it("drops a field that does not belong to the kind's contract", () => {
    const withInjectedField = { ...wellFormedClaim(), injected: "should not survive" };
    const result = validated(withInjectedField);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record).not.toHaveProperty("injected");
    }
  });
});

describe("validateRecord refuses a kind outside the closed nine", () => {
  it("names the offending kind in its error", () => {
    const result = validated({ kind: "bogus-kind", value: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("bogus-kind");
    }
  });

  it("refuses a value that is not an object", () => {
    const result = validated("not-a-record");
    expect(result.ok).toBe(false);
  });
});

describe("validateRecord refuses a structurally invalid record of a valid kind", () => {
  it("refuses a run whose startedAt is not an RFC 3339 timestamp", () => {
    const run = wellFormedRun();
    const invalidRun = { ...run, observation: { ...run.observation, startedAt: "not-a-timestamp" } };
    const result = validated(invalidRun);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("startedAt");
    }
  });

  it("refuses a claim whose evidence is missing the run field", () => {
    const invalidClaim = { ...wellFormedClaim(), evidence: [{ selector: wellFormedSelector(), item: ITEM_ID }] };
    const result = validated(invalidClaim);
    expect(result.ok).toBe(false);
  });

  it("refuses a null in place of a required string field, as a schema error rather than a hashed value", () => {
    const run = wellFormedRun();
    const invalidRun = { ...run, recipe: { ...run.recipe, workingDirectory: null } };
    const result = validated(invalidRun);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("workingDirectory");
    }
  });
});

describe("a ruling's verdict is validated as one of the two accepted words", () => {
  it("round-trips a ruling record for each accepted verdict", () => {
    for (const verdict of ["holds", "fails"] as const) {
      const ruling = { ...wellFormedRuling(), verdict };
      const result = validated(ruling);
      expect(result).toMatchObject({ ok: true, record: { verdict } });
    }
  });

  it("refuses a ruling whose verdict is neither holds nor fails, naming the field", () => {
    const invalidRuling = { ...wellFormedRuling(), verdict: "maybe" };
    const result = validated(invalidRuling);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("verdict");
    }
  });
});

describe("what a claim's conditions and a rule's scope may hold", () => {
  it("refuses a scope on an identity dimension by name, while a context dimension may carry any scope", () => {
    const spanned = {
      ...wellFormedClaim(),
      conditions: { ...CLAIM_CONDITIONS, subject: { kind: "set", values: ["one", "two"] } },
    };
    const refused = validated(spanned);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error).toContain("claim.conditions.subject is an identity dimension");
      expect(refused.error).toContain("one meaning has one spelling and one slot");
    }

    const contextual = {
      ...wellFormedClaim(),
      conditions: { ...CLAIM_CONDITIONS, chapter: { kind: "range", from: "01", to: "09" } },
    };
    expect(validated({ ...contextual, slot: slotFor(CLAIM_DECLARATION, contextual.conditions) })).toMatchObject({
      ok: true,
    });
  });

  it("refuses a claim spelling a point as an object, since a point is a bare string", () => {
    const claim = { ...wellFormedClaim(), conditions: { subject: { kind: "point", value: "one" } } };
    const result = validated(claim);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("a point is a bare string");
    }
  });

  it("refuses a rule whose scope is not a per-dimension map", () => {
    const result = validated({ ...wellFormedRule(), scope: "linux" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("rule.scope must be an object");
    }
  });
});

describe("what a run says about its own performing", () => {
  it("accepts a performer that is the runner, a module or a foreign tool, and refuses one of any other kind", () => {
    const performers = [
      { kind: "runner", version: versionString("1") },
      { kind: "module", module: "musai.core", name: "musai.core/exit-code", version: versionString("1") },
      { kind: "foreign", principal: "alice@example.com", tool: "timbre", version: versionString("2") },
    ];
    for (const performer of performers) {
      expect(validated({ ...wellFormedRun(), performer })).toMatchObject({ ok: true });
    }

    const refused = validated({
      ...wellFormedRun(),
      performer: { kind: "somebody", version: versionString("1") },
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error).toContain("run.performer.kind must be one of runner, module, foreign");
    }
  });

  it("refuses a module performer naming no contribution, and a foreign one naming no principal", () => {
    const noContribution = validated({
      ...wellFormedRun(),
      performer: { kind: "module", module: "musai.core", version: versionString("1") },
    });
    expect(noContribution).toMatchObject({ ok: false });

    const noPrincipal = validated({
      ...wellFormedRun(),
      performer: { kind: "foreign", tool: "timbre", version: versionString("1") },
    });
    expect(noPrincipal).toMatchObject({ ok: false });
  });

  it("refuses a run declaring a determinism outside the three the performer may assert", () => {
    const result = validated({ ...wellFormedRun(), determinism: "mostly" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("run.determinism must be one of deterministic, seeded, nondeterministic");
    }
  });

  it("carries cost as exact strings and refuses a bare number under it", () => {
    const measured = {
      ...wellFormedRun(),
      observation: {
        ...wellFormedRun().observation,
        cost: { cpuMs: "1200", tokens: "98765432109876543210", money: { amount: "0.0031", currency: "USD" } },
      },
    };
    expect(validated(measured)).toMatchObject({ ok: true });

    const bare = {
      ...wellFormedRun(),
      observation: { ...wellFormedRun().observation, cost: { tokens: 1200 } },
    };
    expect(validated(bare)).toMatchObject({ ok: false });
  });

  it("refuses a cost carrying a key it does not know, so a misspelling never reads as unmeasured", () => {
    const result = validated({
      ...wellFormedRun(),
      observation: { ...wellFormedRun().observation, cost: { tokenz: "10" } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("tokenz");
    }
  });
});

describe("a rule's declared weight is carried as exact digits, never a bare number", () => {
  it("accepts a string weight of exact digits and round-trips it through validation", () => {
    const rule = wellFormedRule();
    const result = validated(rule);
    expect(result).toMatchObject({ ok: true, record: { weight: "1" } });
  });

  it("refuses a rule offering a bare number for its weight, naming the weight field", () => {
    const invalidRule = { ...wellFormedRule(), weight: 1 };
    const result = validated(invalidRule);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("weight");
    }
  });

  it("refuses a weight in exponential form, with a leading plus, or with trailing text", () => {
    for (const malformed of ["1e10", "+1", "1abc"]) {
      const invalidRule = { ...wellFormedRule(), weight: malformed };
      const result = validated(invalidRule);
      expect(result.ok).toBe(false);
    }
  });

  it("mints two different record ids for two rules whose weights differ only past a double's precision", () => {
    const lower = { ...wellFormedRule(), weight: exactDecimal("0.10000000000000000001") };
    const higher = { ...wellFormedRule(), weight: exactDecimal("0.10000000000000000002") };
    expect(Number(lower.weight)).toBe(Number(higher.weight));

    const lowerResult = validated(lower);
    const higherResult = validated(higher);
    expect(lowerResult.ok).toBe(true);
    expect(higherResult.ok).toBe(true);
    if (lowerResult.ok && higherResult.ok) {
      expect(recordId(lowerResult.record)).not.toBe(recordId(higherResult.record));
    }
  });
});

describe("a rule record names the contribution whose policy it states, or null for a lesson", () => {
  it("refuses a rule missing its contribution, naming the field", () => {
    const { contribution: _omitted, ...withoutContribution } = wellFormedRule();
    const result = validated(withoutContribution);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("rule.contribution is required");
    }
  });

  it("refuses a rule whose contribution is a number or the empty string, naming the field", () => {
    for (const contribution of [1, ""]) {
      const result = validated({ ...wellFormedRule(), contribution });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("rule.contribution must be the contribution id");
      }
    }
  });

  it("accepts a rule naming a contribution and a lesson naming none", () => {
    expect(validated({ ...wellFormedRule(), contribution: "musai.demo/reproduces" })).toMatchObject({
      ok: true,
      record: { contribution: "musai.demo/reproduces" },
    });
    expect(validated({ ...wellFormedRule(), contribution: null })).toMatchObject({
      ok: true,
      record: { contribution: null },
    });
  });

  it("reads a rule declared before the field existed as a lesson naming no contribution", () => {
    const { contribution: _omitted, ...current } = wellFormedRule();
    const result = validated({ ...current, schemaVersion: 2 });
    expect(result).toMatchObject({
      ok: true,
      record: { schemaVersion: CURRENT_SCHEMA_VERSIONS.rule, contribution: null },
    });
  });
});

describe("one number-policy declaration per record kind, exhaustive over the closed kind list", () => {
  it("declares one for every member of the record-kind list", () => {
    for (const kind of RECORD_KINDS) {
      expect(KIND_CONTRACTS[kind].numberPolicy).toBeDefined();
    }
  });

  it("refuses a run offering a string for its exit code, naming the offending path", () => {
    const run = wellFormedRun();
    const invalidRun = { ...run, observation: { ...run.observation, exitCode: "0" } };
    const result = validated(invalidRun);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("exitCode");
    }
  });

  it("refuses a run offering a number for its start time, naming the offending path", () => {
    const run = wellFormedRun();
    const invalidRun = { ...run, observation: { ...run.observation, startedAt: 12345 } };
    const result = validated(invalidRun);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("startedAt");
    }
  });
});

describe("an attestation's principal class is required and closed", () => {
  it("refuses an attestation naming no principal class", () => {
    const { principalClass: _omitted, ...withoutPrincipalClass } = wellFormedAttestation();
    const result = validated(withoutPrincipalClass);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("principalClass");
    }
  });

  it("refuses an attestation naming a principal class outside the closed list, naming the value", () => {
    const invalidAttestation = { ...wellFormedAttestation(), principalClass: "robot" };
    const result = validated(invalidAttestation);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("robot");
    }
  });
});

describe("no exported function widens the closed set of record kinds", () => {
  it("has no registerKind, addRecordKind or extendKinds export", async () => {
    const schemaModule = await import("../src/record/schema.js");
    const barrel = await import("../src/index.js");
    for (const forbidden of ["registerKind", "addRecordKind", "extendKinds"]) {
      expect(schemaModule).not.toHaveProperty(forbidden);
      expect(barrel).not.toHaveProperty(forbidden);
    }
  });
});

describe("claimTypesFrom", () => {
  it("accepts a new claim type naming its id and the conditions that identify it", () => {
    const typeId = `test.demo@${Math.random()}`;
    const claimTypes = claimTypesFrom([{ type: typeId, identityDimensions: ["about"] }]);
    expect(claimTypes.get(typeId)?.type).toBe(typeId);
    expect(claimTypes.get(typeId)?.identityDimensions).toEqual(["about"]);
  });

  it("refuses a second declaration of an already-held type id, naming the type", () => {
    const typeId = `test.duplicate@${Math.random()}`;
    const declaration = { type: typeId, identityDimensions: ["marker"] };
    expect(() => claimTypesFrom([declaration, declaration])).toThrow(typeId);
  });

  it("refuses a claim type declaring no identity dimensions, naming the type", () => {
    const typeId = `test.no-identity@${Math.random()}`;
    expect(() => claimTypesFrom([{ type: typeId, identityDimensions: [] }])).toThrow(typeId);
  });
});

describe("a run recipe names the tools it reaches for beyond its command, or carries no such field", () => {
  it("round-trips a run whose recipe names its tooling, keeping the list and its order", () => {
    const run = wellFormedRun();
    const result = validated({ ...run, recipe: { ...run.recipe, tooling: ["git", "sh"] } });
    expect(result).toMatchObject({ ok: true, record: { recipe: { tooling: ["git", "sh"] } } });
    if (result.ok) {
      expect(rawId(canonicalBytes(result.record))).toBe(recordId(result.record));
    }
  });

  it("validates a recipe naming no tooling to bytes carrying no tooling key, so its id is the one it always had", () => {
    const run = wellFormedRun();
    const result = validated(run);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record).not.toHaveProperty(["recipe", "tooling"]);
      expect(new TextDecoder().decode(canonicalBytes(result.record))).not.toContain("tooling");
      expect(recordId(result.record)).toBe(recordId(run));
    }
  });

  it("refuses a tooling entry that is a machine path without repeating the path", () => {
    const run = wellFormedRun();
    const result = validated({ ...run, recipe: { ...run.recipe, tooling: ["/usr/local/bin/git"] } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain("/usr/local/bin");
    }
  });

  for (const [description, tooling] of [
    ["an empty list", []],
    ["a list naming one tool twice", ["git", "git"]],
    ["a list repeating the command's own program", ["true"]],
    ["a name carrying a slash", ["/usr/bin/git"]],
    ["a name carrying a backslash", ["bin\\git"]],
    ["an empty name", [""]],
    ["a name that is not a string", [7]],
    ["a value that is not a list", "git"],
  ] as const) {
    it(`refuses a recipe whose tooling is ${description}, naming the field`, () => {
      const run = wellFormedRun();
      const result = validated({ ...run, recipe: { ...run.recipe, tooling } });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("run.recipe.tooling");
      }
    });
  }
});

describe("a testimony run is a run of the same shape, its three roles enforced by the validator", () => {
  it("accepts a testimony run naming all three roles and round-trips it through the validator", () => {
    const run = wellFormedTestimonyRun();
    const result = validated(run);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      const bytes = canonicalBytes(result.record);
      expect(rawId(bytes)).toBe(recordId(result.record));
    }
  });

  it("refuses a testimony run missing the brief, naming the brief", () => {
    const run = wellFormedTestimonyRun();
    const substrates = run.recipe.substrates.filter((substrate) => substrate.mediaType !== BRIEF_MEDIA_TYPE);
    const result = validated({ ...run, recipe: { ...run.recipe, substrates } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("brief");
    }
  });

  it("refuses a testimony run missing the crew definition, naming the crew", () => {
    const run = wellFormedTestimonyRun();
    const substrates = run.recipe.substrates.filter((substrate) => substrate.mediaType !== CREW_MEDIA_TYPE);
    const result = validated({ ...run, recipe: { ...run.recipe, substrates } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("crew");
    }
  });

  it("refuses a testimony run missing the model, naming the model", () => {
    const run = wellFormedTestimonyRun();
    const substrates = run.recipe.substrates.filter((substrate) => substrate.mediaType !== MODEL_MEDIA_TYPE);
    const result = validated({ ...run, recipe: { ...run.recipe, substrates } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("model");
    }
  });

  it("refuses a brief descriptor carrying no digest", () => {
    const run = wellFormedTestimonyRun();
    const substrates = run.recipe.substrates.map((substrate) =>
      substrate.mediaType === BRIEF_MEDIA_TYPE
        ? { mediaType: BRIEF_MEDIA_TYPE, uri: "https://example.invalid/brief" }
        : substrate,
    );
    const result = validated({ ...run, recipe: { ...run.recipe, substrates } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("brief");
    }
  });

  it("refuses a testimony run whose command is not ask plus a contribution id", () => {
    const run = wellFormedTestimonyRun();
    const invalidRun = { ...run, recipe: { ...run.recipe, command: ["ask"] } };
    const result = validated(invalidRun);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("command");
    }
  });

  it("validates a command run carrying the same three role descriptors as an ordinary command, since the roles bind only under testimony", () => {
    const run = wellFormedRun();
    const withRoleSubstrates = {
      ...run,
      recipe: { ...run.recipe, substrates: wellFormedTestimonyRun().recipe.substrates },
    };
    const result = validated(withRoleSubstrates);
    expect(result.ok).toBe(true);
  });
});

const WELL_FORMED_RECORDS: Record<RecordKind, () => MusaiRecord> = {
  claim: wellFormedClaim,
  argument: wellFormedArgument,
  run: wellFormedRun,
  ruling: wellFormedRuling,
  rule: wellFormedRule,
  case: wellFormedCase,
  artifact: wellFormedArtifact,
  attestation: wellFormedAttestation,
  module: wellFormedModule,
};

const SALT = "5a".repeat(32);

describe("a claim, an argument, a ruling, a case and an artifact may carry a salt", () => {
  it("names those five kinds as the ones a writer may salt, and no other", () => {
    expect(SALTABLE_KINDS).toEqual(["claim", "argument", "ruling", "case", "artifact"]);
  });

  for (const kind of SALTABLE_KINDS) {
    it(`keeps the salt ${kind} records carry, so a salted one is another record than the unsalted one`, () => {
      const unsalted = validated(WELL_FORMED_RECORDS[kind]());
      const salted = validated({ ...WELL_FORMED_RECORDS[kind](), salt: SALT });
      expect(salted).toMatchObject({ ok: true, record: { salt: SALT } });
      if (!unsalted.ok || !salted.ok) {
        throw new Error("expected both records to validate");
      }
      expect(recordId(salted.record)).not.toBe(recordId(unsalted.record));
    });

    it(`refuses a salt on ${kind} records unless it is 64 lowercase hex digits, naming the field`, () => {
      for (const salt of ["", "5A".repeat(32), "5a".repeat(31), `sha256:${"5a".repeat(32)}`, 7, null]) {
        const result = validated({ ...WELL_FORMED_RECORDS[kind](), salt });
        expect(result).toMatchObject({ ok: false, error: expect.stringContaining(`${kind}.salt`) });
      }
    });

    it(`drops a salt from ${kind} records declaring a version before salts, as any field outside its contract`, () => {
      const current = WELL_FORMED_RECORDS[kind]();
      const previous = { ...current, schemaVersion: CURRENT_SCHEMA_VERSIONS[kind] - 1, salt: SALT };
      expect(validated(previous)).toEqual({ ok: true, record: current });
    });

    it(`reads ${kind} records written at the version before salts as the same fields at the current version`, () => {
      const current = WELL_FORMED_RECORDS[kind]();
      const previous = { ...current, schemaVersion: CURRENT_SCHEMA_VERSIONS[kind] - 1 };
      expect(validated(previous)).toEqual({ ok: true, record: current });
    });
  }

  it("leaves a salt off a record of a kind no writer salts, as it leaves any field its kind lacks", () => {
    for (const kind of RECORD_KINDS.filter((each) => !SALTABLE_KINDS.includes(each))) {
      const result = validated({ ...WELL_FORMED_RECORDS[kind](), salt: SALT });
      expect(result.ok).toBe(true);
      expect(result.ok && "salt" in result.record).toBe(false);
    }
  });
});

describe("every record kind carries an integer schema version, checked at one validation site", () => {
  for (const kind of RECORD_KINDS) {
    it(`refuses a ${kind} record missing its schema version, naming the kind`, () => {
      const { schemaVersion: _omitted, ...withoutVersion } = WELL_FORMED_RECORDS[kind]() as unknown as Record<
        string,
        unknown
      >;
      const result = validated(withoutVersion);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain(kind);
        expect(result.error).toContain("schemaVersion");
      }
    });

    it(`refuses a ${kind} record naming no supersedes, since every kind says what it replaces`, () => {
      const { supersedes: _omitted, ...withoutSuccession } = WELL_FORMED_RECORDS[kind]() as unknown as Record<
        string,
        unknown
      >;
      const result = validated(withoutSuccession);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain(`${kind}.supersedes`);
      }
    });

    it(`refuses a ${kind} record declaring a schema version above the one this kernel writes, naming the kind and both versions`, () => {
      const current = CURRENT_SCHEMA_VERSIONS[kind];
      const fromTheFuture = {
        ...(WELL_FORMED_RECORDS[kind]() as unknown as Record<string, unknown>),
        schemaVersion: current + 1,
      };
      const result = validated(fromTheFuture);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain(kind);
        expect(result.error).toContain(String(current + 1));
        expect(result.error).toContain(String(current));
      }
    });
  }

  it("normalises a record declared at a lower schema version into the current shape before the kind's own validator sees it", () => {
    const OLDER_VERSION = 2;
    const { verdict, reason, brief } = wellFormedRuling();
    const olderRuling = { kind: "ruling", schemaVersion: OLDER_VERSION, claim: CLAIM_ID, verdict, reason, brief };

    const result = validated(olderRuling);
    expect(result).toMatchObject({
      ok: true,
      record: { schemaVersion: CURRENT_SCHEMA_VERSIONS.ruling, over: { claim: CLAIM_ID }, supersedes: [] },
    });

    // Unnormalised, the old top-level `claim` is refused: the pipeline normalises first.
    const unnormalised = rulingContract.validate(olderRuling, {
      unregisteredClaimTypes: "refuse",
      claimTypes: NO_CLAIM_TYPES,
    });
    expect(unnormalised.ok).toBe(false);
    if (!unnormalised.ok) {
      expect(unnormalised.error).toContain("ruling.claim");
    }
  });
});

describe("a module record's manifest is validated at admission, never by running the module", () => {
  it("accepts a data-only module naming no bundle and no build", () => {
    const result = validated(wellFormedDataOnlyModule());
    expect(result).toMatchObject({ ok: true, record: { bundle: null, build: null } });
  });

  it("accepts a manifest declaring a requirement contribution", () => {
    const module = wellFormedModule();
    const withRequirement = {
      ...module,
      manifest: {
        ...module.manifest,
        contributions: [
          ...module.manifest.contributions,
          {
            kind: "requirement",
            id: `${MODULE_NAME}/some-tool`,
            version: versionString("1"),
            input: { binary: "some-tool", versionPredicate: null, neededBy: "a fixture", install: "install it" },
            output: true,
            documentation: "some-tool, needed by a fixture",
          },
        ],
      },
    };
    const result = validated(withRequirement);
    expect(result).toMatchObject({ ok: true });
  });

  describe("an operation contribution declares its effect and its authority, and no other kind declares either", () => {
    function withContribution(entry: Record<string, unknown>): unknown {
      const module = wellFormedModule();
      return {
        ...module,
        manifest: { ...module.manifest, contributions: [...module.manifest.contributions, entry] },
      };
    }

    const operation = {
      kind: "operation",
      id: `${MODULE_NAME}/stamps`,
      version: versionString("1"),
      input: { type: "object", additionalProperties: false, properties: {} },
      output: true,
      documentation: "an operation contribution",
    };

    it("accepts an operation contribution declaring both, carrying each through", () => {
      for (const authority of [null, "publish"]) {
        const result = validated(withContribution({ ...operation, effect: "write", authority }));
        expect(result).toMatchObject({ ok: true });
        const record = (result as { record: ModuleRecord }).record;
        expect(record.manifest.contributions.find((entry) => entry.kind === "operation")).toMatchObject({
          effect: "write",
          authority,
        });
      }
    });

    it("refuses an operation contribution declaring no effect, or no authority, naming the contribution", () => {
      const noEffect = validated(withContribution({ ...operation, authority: null }));
      expect(noEffect).toMatchObject({ ok: false });
      expect((noEffect as { error: string }).error).toContain(`${MODULE_NAME}/stamps must declare its effect`);

      const noAuthority = validated(withContribution({ ...operation, effect: "read" }));
      expect(noAuthority).toMatchObject({ ok: false });
      expect((noAuthority as { error: string }).error).toContain(`${MODULE_NAME}/stamps must declare its authority`);
    });

    it("refuses an operation contribution declaring an effect or an authority outside the closed vocabularies", () => {
      expect(validated(withContribution({ ...operation, effect: "destroys", authority: null }))).toMatchObject({
        ok: false,
      });
      expect(validated(withContribution({ ...operation, effect: "read", authority: "anything" }))).toMatchObject({
        ok: false,
      });
    });

    it("refuses a contribution of any other kind carrying an effect or an authority", () => {
      const slot = {
        kind: "slot",
        id: `${MODULE_NAME}/some-slot`,
        version: versionString("1"),
        input: {},
        output: {},
        documentation: "a slot",
      };
      for (const declared of [{ effect: "read" }, { authority: null }]) {
        const result = validated(withContribution({ ...slot, ...declared }));
        expect(result).toMatchObject({ ok: false });
        expect((result as { error: string }).error).toContain("is not an operation contribution");
      }
    });
  });

  it("refuses a contribution whose kind is not a string, naming the id", () => {
    const module = wellFormedModule();
    const entry = module.manifest.contributions[0]!;
    const invalid = {
      ...module,
      manifest: { ...module.manifest, contributions: [{ ...entry, kind: 7 }] },
    };
    const result = validated(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(entry.id);
    }
  });

  it("refuses two contributions sharing one id inside one manifest, naming the id, the module and the version", () => {
    const module = wellFormedModule();
    const entry = module.manifest.contributions[0]!;
    const invalid = {
      ...module,
      manifest: { ...module.manifest, contributions: [entry, { ...entry, kind: "rule" }] },
    };
    const result = validated(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(entry.id);
      expect(result.error).toContain(module.name);
      expect(result.error).toContain(module.version);
    }
  });

  it("refuses a contribution id not namespaced by its own module's name", () => {
    const module = wellFormedModule();
    const invalid = {
      ...module,
      manifest: {
        ...module.manifest,
        contributions: [{ ...module.manifest.contributions[0]!, id: "someone-else/exit-code" }],
      },
    };
    const result = validated(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("someone-else/exit-code");
    }
  });

  it("refuses a module naming a bundle with no build", () => {
    const result = validated({ ...wellFormedModule(), build: null });
    expect(result.ok).toBe(false);
  });

  it("refuses a module naming a build with no bundle", () => {
    const result = validated({ ...wellFormedModule(), bundle: null });
    expect(result.ok).toBe(false);
  });

  it("refuses an unsorted contribution array, naming the field", () => {
    const module = wellFormedModule();
    const first = module.manifest.contributions[0]!;
    const second = { ...first, id: `${module.name}/aaa-parser` };
    const invalid = {
      ...module,
      manifest: { ...module.manifest, contributions: [first, second] },
    };
    const result = validated(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("sorted");
    }
  });

  it("refuses an unsorted package array, naming the field", () => {
    const module = wellFormedModule();
    const invalid = {
      ...module,
      manifest: { ...module.manifest, packages: ["pkg:npm/zeta@1", "pkg:npm/alpha@1"] },
    };
    const result = validated(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("sorted");
    }
  });
});

describe("an evidence edge's selector is stored as four named parts, never as one joined string", () => {
  it("round-trips a key holding a slash and a colon to the same four parts", () => {
    const selector: Selector = {
      module: "musai.core",
      parser: "line-range",
      version: versionString("1"),
      key: "path/to/file.txt:42",
    };
    const claim = { ...wellFormedClaim(), evidence: [{ run: RUN_ID, selector, item: ITEM_ID }] };
    const result = validated(claim);
    expect(result.ok).toBe(true);
    if (result.ok && result.record.kind === "claim") {
      expect(result.record.evidence[0]!.selector).toEqual(selector);
      expect(renderSelector(result.record.evidence[0]!.selector)).toBe("musai.core/line-range@1:path/to/file.txt:42");
    }
  });

  it("refuses an edge whose selector is missing any of the four parts, naming the part", () => {
    const full = wellFormedSelector();
    for (const part of ["module", "parser", "version", "key"] as const) {
      const { [part]: _omitted, ...withoutPart } = full;
      const claim = { ...wellFormedClaim(), evidence: [{ run: RUN_ID, selector: withoutPart, item: ITEM_ID }] };
      const result = validated(claim);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain(part);
      }
    }
  });

  it("refuses an edge missing its item id", () => {
    const claim = { ...wellFormedClaim(), evidence: [{ run: RUN_ID, selector: wellFormedSelector() }] };
    const result = validated(claim);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("item");
    }
  });

  it("keeps two edges differing only in the selector's key as two edges, and collapses two identical edges to one", () => {
    const first = { run: RUN_ID, selector: wellFormedSelector(), item: ITEM_ID };
    const second = { run: RUN_ID, selector: { ...wellFormedSelector(), key: "otherKey" }, item: ITEM_ID };
    const duplicateOfFirst = { ...first };
    const claim = { ...wellFormedClaim(), evidence: [first, second, duplicateOfFirst] };
    const result = validated(claim);
    expect(result.ok).toBe(true);
    if (result.ok && result.record.kind === "claim") {
      expect(result.record.evidence).toHaveLength(2);
    }
  });

  it("accepts a claim with no evidence as an empty array, and refuses one whose evidence field is absent", () => {
    const withEmptyEvidence = { ...wellFormedClaim(), evidence: [] };
    expect(validated(withEmptyEvidence)).toMatchObject({ ok: true, record: { evidence: [] } });

    const { evidence: _omitted, ...withoutEvidence } = wellFormedClaim();
    const result = validated(withoutEvidence);
    expect(result.ok).toBe(false);
  });
});

describe("a case names the commit, the preset and the overrides it was booked under, and stores no effective value", () => {
  it("round-trips a case carrying its preset reference, trust-branch commit and overrides", () => {
    const result = validated(wellFormedCase());
    expect(result).toMatchObject({
      ok: true,
      record: {
        preset: {
          module: "musai.core",
          contribution: "musai.core/interactive",
          moduleRecord: PRESET_MODULE_RECORD_ID,
        },
        projectCommit: "0".repeat(40),
        overrides: {},
      },
    });
  });

  it("refuses a case whose preset reference is missing its module record id", () => {
    const kase = wellFormedCase();
    const { moduleRecord: _omitted, ...presetWithoutModuleRecord } = kase.preset;
    const invalidCase = { ...kase, preset: presetWithoutModuleRecord };
    const result = validated(invalidCase);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("moduleRecord");
    }
  });

  it("refuses a case carrying an effective slot value", () => {
    const invalidCase = { ...wellFormedCase(), effective: { "musai.core/some-slot": "value" } };
    const result = validated(invalidCase);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("effective");
    }
  });
});

describe("the shapes each record kind honours", () => {
  it("accepts an argument resting on named claims, and refuses one whose premises are not record ids", () => {
    expect(validated({ ...wellFormedArgument(), premises: [CLAIM_ID] })).toMatchObject({ ok: true });
    const result = validated({ ...wellFormedArgument(), premises: ["not-a-record-id"] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("argument.premises");
    }
  });

  it("refuses an argument naming no premises, since an argument says what it rests on", () => {
    const { premises: _omitted, ...withoutPremises } = wellFormedArgument() as unknown as Record<string, unknown>;
    const result = validated(withoutPremises);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("argument.premises");
    }
  });

  it("accepts a ruling over one claim and a ruling over a type at a scope, and refuses an extent that is neither", () => {
    expect(validated(wellFormedRuling())).toMatchObject({ ok: true });
    expect(
      validated({
        ...wellFormedRuling(),
        over: { type: CLAIM_TYPE, scope: { subject: { kind: "set", values: ["one", "two"] } } },
      }),
    ).toMatchObject({ ok: true });

    for (const neither of [{ claim: CLAIM_ID, type: CLAIM_TYPE }, { type: CLAIM_TYPE }, { scope: {} }, "a claim"]) {
      const result = validated({ ...wellFormedRuling(), over: neither });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("ruling.over must name either one claim");
      }
    }
  });

  it("refuses a ruling naming the claim at the top level, since the extent is what says which of two shapes it takes", () => {
    const result = validated({ ...wellFormedRuling(), claim: CLAIM_ID });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ruling.claim no longer belongs on a ruling record");
      expect(result.error).toContain("named under over");
    }
  });

  it("refuses a ruling naming principal, authority, decidedAt or evidenceSnapshot by name", () => {
    for (const removed of ["principal", "authority", "decidedAt", "evidenceSnapshot"]) {
      const invalidRuling = { ...wellFormedRuling(), [removed]: "smuggled" };
      const result = validated(invalidRuling);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain(removed);
      }
    }
  });

  it("accepts a ruling carrying exactly the fields a ruling record has, and no field a reader could mistake for authority", () => {
    const result = validated(wellFormedRuling());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.record).sort()).toEqual([
        "brief",
        "kind",
        "over",
        "reason",
        "schemaVersion",
        "supersedes",
        "verdict",
      ]);
    }
  });

  it("accepts an attestation naming via model", () => {
    const result = validated({ ...wellFormedAttestation(), via: "model" });
    expect(result).toMatchObject({ ok: true, record: { via: "model" } });
  });

  it("refuses an attestation whose via is outside the four-value tuple, naming the field and the permitted values", () => {
    const result = validated({ ...wellFormedAttestation(), via: "carrier-pigeon" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("via");
      expect(result.error).toContain("elicitation");
      expect(result.error).toContain("tty");
      expect(result.error).toContain("signature");
      expect(result.error).toContain("model");
    }
  });

  it("refuses an attestation naming no via", () => {
    const { via: _omitted, ...withoutVia } = wellFormedAttestation();
    const result = validated(withoutVia);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("via");
    }
  });

  it("accepts an artifact naming format markdown and an empty supersedes", () => {
    const result = validated(wellFormedArtifact());
    expect(result).toMatchObject({ ok: true, record: { format: "markdown", supersedes: [] } });
  });

  it("accepts an artifact whose supersedes names two parents", () => {
    const parents = [recordId({ marker: "parent-a" }), recordId({ marker: "parent-b" })];
    const result = validated({ ...wellFormedArtifact(), supersedes: parents });
    expect(result).toMatchObject({ ok: true, record: { supersedes: parents } });
  });

  it("refuses an artifact naming no format", () => {
    const { format: _omitted, ...withoutFormat } = wellFormedArtifact();
    const result = validated(withoutFormat);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("format");
    }
  });

  it("refuses a case record with no evaluator-version pin", () => {
    const { evaluatorVersion: _omitted, ...withoutVersion } = wellFormedCase();
    const result = validated(withoutVersion);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("evaluatorVersion");
    }
  });

  it("accepts a case record carrying a VersionString evaluator-version pin", () => {
    const result = validated({ ...wellFormedCase(), evaluatorVersion: versionString("2.3.1") });
    expect(result).toMatchObject({ ok: true, record: { evaluatorVersion: "2.3.1" } });
  });

  it("a manifest declaring a view, kind or operation contribution loads", () => {
    const module = wellFormedModule();
    for (const kind of ["view", "kind", "operation"] as const) {
      const entry =
        kind === "operation"
          ? {
              kind,
              id: `${MODULE_NAME}/${kind}-entry`,
              version: versionString("1"),
              input: { type: "object", additionalProperties: false, properties: {} },
              output: true,
              documentation: `a ${kind} contribution`,
              effect: "read" as const,
              authority: null,
            }
          : {
              kind,
              id: `${MODULE_NAME}/${kind}-entry`,
              version: versionString("1"),
              input: {},
              output: {},
              documentation: `a ${kind} contribution`,
            };
      const withEntry = {
        ...module,
        manifest: { ...module.manifest, contributions: [...module.manifest.contributions, entry] },
      };
      const result = validated(withEntry);
      expect(result, `manifest declaring a ${kind} contribution`).toMatchObject({ ok: true });
    }
  });
});

describe("validateClaim recomputes a claim's slot from its own type and conditions", () => {
  it("refuses a claim naming a type nobody registered, naming the type", () => {
    const claim = { ...wellFormedClaim(), type: "musai.unregistered@1" };
    const result = validated(claim);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("musai.unregistered@1");
    }
  });

  it("refuses a claim whose declared slot does not match the slot its type and conditions compute, naming both", () => {
    const genuineSlot = slotFor(CLAIM_DECLARATION, CLAIM_CONDITIONS);
    const declaredSlot = slotFor(CLAIM_DECLARATION, { subject: "a slot nobody computed" });
    const claim = { ...wellFormedClaim(), slot: declaredSlot };
    const result = validated(claim);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(declaredSlot);
      expect(result.error).toContain(genuineSlot);
    }
  });
});

describe("a run record splits into a recipe and an observation, every field required", () => {
  it("round-trips a well-formed receipt, and its canonical bytes digest to the id naming it", () => {
    const run = wellFormedRun();
    const result = validated(run);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      const bytes = canonicalBytes(result.record);
      expect(rawId(bytes)).toBe(recordId(result.record));
    }
  });

  it("refuses a run record missing schemaVersion", () => {
    const { schemaVersion: _omitted, ...withoutVersion } = wellFormedRun();
    const result = validated(withoutVersion);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("schemaVersion");
    }
  });

  it("refuses a recipe isolation value outside the closed four, naming the field", () => {
    const run = wellFormedRun();
    const invalidRun = { ...run, recipe: { ...run.recipe, isolation: "vm" } };
    const result = validated(invalidRun);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("isolation");
    }
  });

  it("refuses an observation isolationHeld value outside the closed four, naming the field", () => {
    const run = wellFormedRun();
    const invalidRun = { ...run, observation: { ...run.observation, isolationHeld: "vm" } };
    const result = validated(invalidRun);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("isolationHeld");
    }
  });

  for (const field of ["command", "workingDirectory", "environment", "declared", "substrates", "isolation"] as const) {
    it(`refuses a run whose recipe.${field} is missing`, () => {
      const run = wellFormedRun();
      const recipe = { ...run.recipe } as Record<string, unknown>;
      delete recipe[field];
      const result = validated({ ...run, recipe });
      expect(result.ok).toBe(false);
    });
  }

  for (const field of [
    "resolved",
    "isolationHeld",
    "binaries",
    "bindings",
    "output",
    "outputLossy",
    "exitCode",
    "scrubbed",
    "startedAt",
    "finishedAt",
    "reads",
  ] as const) {
    it(`refuses a run whose observation.${field} is missing`, () => {
      const run = wellFormedRun();
      const observation = { ...run.observation } as Record<string, unknown>;
      delete observation[field];
      const result = validated({ ...run, observation });
      expect(result.ok).toBe(false);
    });
  }

  it("refuses a run record missing its observation's reads, naming the field", () => {
    const run = wellFormedRun();
    const { reads: _omitted, ...observationWithoutReads } = run.observation;
    const result = validated({ ...run, observation: observationWithoutReads });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("reads");
    }
  });

  it("refuses a reads entry naming neither a locator nor a digest", () => {
    const run = wellFormedRun();
    const invalidRun = { ...run, observation: { ...run.observation, reads: [{}] } };
    const result = validated(invalidRun);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("reads");
    }
  });

  it("accepts a run record with an empty reads and round-trips it through the validator byte for byte", () => {
    const run = wellFormedRun();
    const result = validated(run);
    expect(result).toMatchObject({ ok: true, record: { observation: { reads: [] } } });
    if (result.ok) {
      const bytes = canonicalBytes(result.record);
      expect(rawId(bytes)).toBe(recordId(result.record));
    }
  });
});

describe("a release names an audience, an extent and terms, and a revocation names what it withdraws", () => {
  const RELEASE_ID = recordId({ marker: "a release a revocation withdraws" });

  function release(terms: Record<string, unknown> = {}, rest: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ...wellFormedAttestation(),
      purpose: "released",
      audience: "public",
      extent: "closure",
      terms: { form: "bytes", uses: ["review", "cite"], from: null, until: null, marking: null, ...terms },
      ...rest,
    };
  }

  function errorOf(fields: Record<string, unknown>): string {
    const result = validated(fields);
    expect(result.ok).toBe(false);
    return result.ok ? "" : result.error;
  }

  it("accepts a release and a revocation of the shapes the kernel mints", () => {
    expect(validated(release()).ok).toBe(true);
    expect(validated({ ...wellFormedAttestation(), purpose: "revoked", supersedes: [RELEASE_ID] }).ok).toBe(true);
  });

  it("refuses a release whose uses grant republish without an spdx marking", () => {
    expect(errorOf(release({ uses: ["review", "republish"] }))).toContain("spdx:");
    expect(errorOf(release({ uses: ["review", "republish"], marking: "tlp:clear" }))).toContain("spdx:");
    expect(validated(release({ uses: ["review", "republish"], marking: "spdx:CC-BY-4.0" })).ok).toBe(true);
  });

  it("refuses a release that grants no use, or grants one twice", () => {
    expect(errorOf(release({ uses: [] }))).toContain("uses");
    expect(errorOf(release({ uses: ["cite", "cite"] }))).toContain("uses");
    expect(errorOf(release({ uses: ["cite", "review"] }))).toContain("uses");
  });

  it("refuses a revocation that supersedes nothing", () => {
    expect(errorOf({ ...wellFormedAttestation(), purpose: "revoked", supersedes: [] })).toContain("supersedes");
  });

  it("refuses a revocation carrying an audience, an extent or terms", () => {
    for (const field of ["audience", "extent", "terms"]) {
      const revocation = { ...wellFormedAttestation(), purpose: "revoked", supersedes: [RELEASE_ID] };
      expect(errorOf({ ...revocation, [field]: release()[field] }), field).toContain(field);
    }
  });

  it("refuses an audience outside public, a key, an identity and a bare name", () => {
    expect(errorOf(release({}, { audience: "Everyone!" }))).toContain("audience");
  });

  it("refuses a window whose from is not before its until", () => {
    const at = "2026-03-01T00:00:00.000Z";
    expect(errorOf(release({ from: at, until: at }))).toContain("until");
    expect(validated(release({ from: at, until: "2026-04-01T00:00:00.000Z" })).ok).toBe(true);
  });

  it("a made attestation minted at version 3 reads at the current version unchanged", () => {
    const made = { ...wellFormedAttestation(), schemaVersion: 3 };
    const result = validated(made);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record).toEqual({ ...made, schemaVersion: CURRENT_SCHEMA_VERSIONS.attestation });
    }
  });

  it("a release minted at version 3 is refused, naming the class it carries", () => {
    const { audience: _a, extent: _e, terms: _t, ...rest } = release();
    expect(errorOf({ ...rest, schemaVersion: 3, class: "public" })).toContain("class");
  });

  it("a release and a revocation minted at version 4 read at the current version unchanged", () => {
    const revocation = { ...wellFormedAttestation(), purpose: "revoked", supersedes: [RELEASE_ID] };
    for (const minted of [release(), revocation]) {
      const result = validated({ ...minted, schemaVersion: 4 });
      expect(result).toEqual({ ok: true, record: { ...minted, schemaVersion: CURRENT_SCHEMA_VERSIONS.attestation } });
    }
  });
});

describe("a seal names the audience a record is sealed from, and no model relays one", () => {
  function seal(rest: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...wellFormedAttestation(), purpose: "sealed", seal: { audience: "cast" }, ...rest };
  }

  function errorOf(fields: Record<string, unknown>): string {
    const result = validated(fields);
    expect(result.ok).toBe(false);
    return result.ok ? "" : result.error;
  }

  it("accepts a seal of the shape the kernel mints", () => {
    expect(validated(seal())).toEqual({ ok: true, record: seal() });
  });

  it("accepts a seal naming its closure, and keeps one naming no extent as it was minted", () => {
    const closure = seal({ seal: { audience: "cast", extent: "closure" } });
    expect(validated(closure)).toEqual({ ok: true, record: closure });
    expect(validated(seal())).toEqual({ ok: true, record: seal() });
  });

  it("refuses a seal naming its record as its extent, which a seal naming none already says", () => {
    expect(errorOf(seal({ seal: { audience: "cast", extent: "record" } }))).toContain("extent");
  });

  it("refuses a seal whose extent is neither the record nor its closure", () => {
    expect(errorOf(seal({ seal: { audience: "cast", extent: "everything" } }))).toContain("extent");
  });

  it("refuses a seal naming no audience, or one outside the audience grammar", () => {
    const { seal: _seal, ...unnamed } = seal();
    expect(errorOf(unnamed)).toContain("seal");
    expect(errorOf(seal({ seal: {} }))).toContain("audience");
    expect(errorOf(seal({ seal: { audience: "Everyone!" } }))).toContain("audience");
  });

  it("refuses a seal carrying an audience, an extent or terms of a release", () => {
    for (const field of ["audience", "extent", "terms"]) {
      expect(errorOf(seal({ [field]: "public" })), field).toContain(field);
    }
  });

  it("refuses a seal relayed through model, and takes one from a process on its signature", () => {
    expect(errorOf(seal({ via: "model", principalClass: "agent" }))).toContain("model");
    expect(validated(seal({ via: "process", principalClass: "agent" })).ok).toBe(true);
  });

  it("refuses a seal field on any attestation but a seal", () => {
    expect(errorOf({ ...wellFormedAttestation(), seal: { audience: "cast" } })).toContain("seal");
  });
});

describe("text a record states is composed, and text a record holds as data is kept as given", () => {
  const DECOMPOSED = "café";

  it("refuses a claim whose rendering is not in NFC, naming the path", () => {
    const result = validated({ ...wellFormedClaim(), rendering: `The ${DECOMPOSED} is open.` });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("$.rendering");
  });

  it("refuses a claim whose canonical form or condition value is not in NFC", () => {
    expect(validated({ ...wellFormedClaim(), canonical: { statement: DECOMPOSED } }).ok).toBe(false);
    const conditions = { subject: DECOMPOSED };
    const claim = { ...wellFormedClaim(), conditions, slot: slotFor(CLAIM_DECLARATION, conditions) };
    expect(validated(claim).ok).toBe(false);
  });

  it("refuses a dimension named in decomposed form, as a key", () => {
    const result = validated({ ...wellFormedRule(), scope: { [DECOMPOSED]: { kind: "from", value: "2.0" } } });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("$.scope");
  });

  it("refuses a case slug and an attestation principal that are not in NFC", () => {
    expect(validated({ ...wellFormedCase(), slug: DECOMPOSED }).ok).toBe(false);
    expect(validated({ ...wellFormedAttestation(), schemaVersion: 5, principal: DECOMPOSED }).ok).toBe(false);
  });

  it("keeps decomposed bytes in a run's recipe and observation, which a rerun must reproduce", () => {
    const run = wellFormedRun();
    const result = validated({
      ...run,
      recipe: { ...run.recipe, command: ["cat", DECOMPOSED] },
      observation: { ...run.observation, output: `${DECOMPOSED}\n` },
    });
    expect(result.ok).toBe(true);
    expect(result.ok && recordId(result.record)).toBe(
      recordId({
        ...run,
        recipe: { ...run.recipe, command: ["cat", DECOMPOSED] },
        observation: { ...run.observation, output: `${DECOMPOSED}\n` },
      }),
    );
  });

  it("keeps text a person wrote as a reason as given", () => {
    expect(validated({ ...wellFormedRuling(), reason: DECOMPOSED }).ok).toBe(true);
  });
});
