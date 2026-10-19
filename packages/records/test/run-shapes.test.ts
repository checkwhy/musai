import { describe, expect, it } from "vitest";
import { recordId } from "../src/canonical/canonicalize.js";
import { timestamp } from "../src/canonical/numbers.js";
import { EVALUATOR_VERSION } from "../src/canonical/version.js";
import { NO_CLAIM_TYPES } from "../src/record/claim-types.js";
import { CURRENT_SCHEMA_VERSIONS, type ValidationResult, validateRecord } from "../src/record/schema.js";

const AT = timestamp("2026-10-07T00:00:00.000Z");
const READ = { key: recordId({ marker: "read" }), consumed: { sha256: "a".repeat(64) } };

function validated(value: unknown): ValidationResult {
  return validateRecord(value, { unregisteredClaimTypes: "refuse", claimTypes: NO_CLAIM_TYPES });
}

function computed(runKind: "brief" | "evaluation", command: string[]): Record<string, unknown> {
  return {
    kind: "run",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
    runKind,
    determinism: "deterministic",
    performer: { kind: "runner", version: EVALUATOR_VERSION },
    recipe: { command, substrates: [] },
    observation: { output: "{}", reads: [READ], cost: {} },
  };
}

function performed(determinism: string): Record<string, unknown> {
  return {
    kind: "run",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
    runKind: "run",
    determinism,
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
      output: "",
      outputLossy: false,
      exitCode: 0,
      scrubbed: [],
      startedAt: AT,
      finishedAt: AT,
      reads: [],
      cost: {},
    },
  };
}

describe("a run the kernel computes carries what it computed and nothing of an environment", () => {
  it("validates an evaluation and a brief in the computed shape", () => {
    expect(validated(computed("evaluation", ["evaluate", "musai.core/declarative"]))).toMatchObject({ ok: true });
    expect(validated(computed("brief", ["brief", "sha256:0"]))).toMatchObject({ ok: true });
  });

  it.each([
    ["an instant", "observation", "startedAt", AT],
    ["an exit code", "observation", "exitCode", 0],
    ["a working directory", "recipe", "workingDirectory", "/"],
    ["an environment", "recipe", "environment", {}],
  ])("refuses a computed run carrying %s, naming the field", (_what, part, field, value) => {
    const run = computed("evaluation", ["evaluate", "musai.core/declarative"]);
    run[part] = { ...(run[part] as Record<string, unknown>), [field]: value };

    const result = validated(run);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(field);
  });

  it("refuses a computed run that is not deterministic", () => {
    const result = validated({ ...computed("brief", ["brief", "sha256:0"]), determinism: "nondeterministic" });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("deterministic");
  });

  it("refuses a deterministic run that carries an instant, so its id is its content", () => {
    const result = validated(performed("deterministic"));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("startedAt");
    expect(validated(performed("nondeterministic"))).toMatchObject({ ok: true });
  });
});

describe("a run written before version 4 reads in the current shape", () => {
  it("reads a version 3 brief as the computed shape, its placeholders and instants gone", () => {
    const v3 = performed("deterministic");
    const result = validated({
      ...v3,
      schemaVersion: 3,
      runKind: "brief",
      recipe: { ...(v3["recipe"] as object), command: ["brief", "sha256:0"], isolation: "none" },
    });

    expect(result).toMatchObject({ ok: true });
    const record = (result as { record: { recipe: object; observation: object } }).record;
    expect(record.recipe).toEqual({ command: ["brief", "sha256:0"], substrates: [] });
    expect(record.observation).toEqual({ output: "", reads: [], cost: {} });
  });

  it("reads a brief as deterministic whatever an older version said, since the kernel computes it", () => {
    const v3 = performed("nondeterministic");
    const v1: Record<string, unknown> = {
      ...v3,
      schemaVersion: 1,
      runKind: "brief",
      observation: { ...(v3["observation"] as object), reads: [] },
    };
    for (const unwritten of ["performer", "supersedes", "determinism"]) {
      delete v1[unwritten];
    }

    for (const old of [v1, { ...v3, schemaVersion: 3, runKind: "brief" }]) {
      expect(validated(old)).toMatchObject({ ok: true, record: { determinism: "deterministic" } });
    }
  });

  it("reads a version 3 deterministic command run without its instants", () => {
    const result = validated({ ...performed("nondeterministic"), schemaVersion: 3, determinism: "deterministic" });

    expect(result.ok).toBe(true);
    const observation = (result as { record: { observation: object } }).record.observation;
    expect(observation).not.toHaveProperty("startedAt");
    expect(observation).not.toHaveProperty("finishedAt");
  });

  it("reads a version 3 command run unchanged", () => {
    const current = performed("nondeterministic");

    expect(validated({ ...current, schemaVersion: 3 })).toMatchObject({
      ok: true,
      record: { recipe: current["recipe"], observation: current["observation"] },
    });
  });
});
