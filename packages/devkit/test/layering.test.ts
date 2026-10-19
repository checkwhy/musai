import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRestartLoop } from "@musai/evaluate";
import { IndexDb } from "@musai/fold";
import type { RuleInput, RuleOutput } from "@musai/modules";
import {
  CURRENT_SCHEMA_VERSIONS,
  LAYER_ORDER,
  LayerRefusedError,
  type PresetDeclaration,
  recordId,
  resolveSlot,
  type SlotDeclaration,
  type SlotLayers,
  SlotRefusedError,
  type SlotRegistry,
  slotReadId,
  validatePresetAssignments,
  validateRecord,
  versionString,
} from "@musai/records";
import { bindDeclaredNames, containerPolicyFromSlot, layerDeclarationsFromConfig } from "@musai/run";
import type { GitContext } from "@musai/store";
import { initWorkspace, Store } from "@musai/store";
import { fixedClock, invokerFromRule } from "@musai/test-support";
import { describe, expect, it } from "vitest";

function registryOf(...declarations: readonly SlotDeclaration[]): SlotRegistry {
  return new Map(declarations.map((declaration) => [declaration.id, declaration]));
}

function boundedCount(id: string, layers: readonly ("project" | "preset" | "booking")[]): SlotDeclaration {
  return {
    id,
    schema: { type: "integer", minimum: 0, maximum: 10 },
    hasDefault: true,
    default: 0,
    documentation: "a bounded count",
    layers,
  };
}

describe("layer resolution order", () => {
  it("is the four-member tuple: pack defaults, project, preset, booking", () => {
    expect(LAYER_ORDER).toEqual(["pack-defaults", "project", "preset", "booking"]);
  });
});

describe("a value at a slot's own schema bound", () => {
  it("is accepted and one step outside is refused naming the slot, the layer and the bound", () => {
    const registry = registryOf(boundedCount("example/count", ["project", "preset", "booking"]));
    const atBound = resolveSlot("example/count", registry, { booking: { "example/count": 10 } });
    expect(atBound.value).toBe(10);

    expect(() => resolveSlot("example/count", registry, { booking: { "example/count": 11 } })).toThrow(
      LayerRefusedError,
    );
    try {
      resolveSlot("example/count", registry, { booking: { "example/count": 11 } });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toMatch(/example\/count/);
      expect((error as Error).message).toMatch(/booking/);
      expect((error as Error).message).toMatch(/10/);
    }
  });
});

describe("two slot ids differing by one character", () => {
  it("are two slots, and a layer assigning both assigns each independently", () => {
    const registry = registryOf(
      {
        id: "example/limit",
        schema: { type: "integer" },
        hasDefault: true,
        default: 1,
        documentation: "d",
        layers: ["booking"],
      },
      {
        id: "example/limits",
        schema: { type: "integer" },
        hasDefault: true,
        default: 2,
        documentation: "d",
        layers: ["booking"],
      },
    );
    const layers: SlotLayers = { booking: { "example/limit": 5, "example/limits": 9 } };
    expect(resolveSlot("example/limit", registry, layers).value).toBe(5);
    expect(resolveSlot("example/limits", registry, layers).value).toBe(9);
  });
});

describe("a slot with no assignment anywhere", () => {
  it("resolves to its declared default", () => {
    const registry = registryOf(boundedCount("example/count", ["project"]));
    const resolution = resolveSlot("example/count", registry, {});
    expect(resolution.value).toBe(0);
    expect(resolution.layer).toBe("pack-defaults");
  });

  it("is refused naming the slot when it has neither a default nor an assignment", () => {
    const registry = registryOf({
      id: "example/required",
      schema: { type: "string" },
      hasDefault: false,
      default: undefined,
      documentation: "d",
      layers: ["project"],
    });
    expect(() => resolveSlot("example/required", registry, {})).toThrow(LayerRefusedError);
    expect(() => resolveSlot("example/required", registry, {})).toThrow(/example\/required/);
  });
});

describe("the last permitted layer to assign a slot", () => {
  it("wins, in the order the tuple declares", () => {
    const registry = registryOf(boundedCount("example/count", ["project", "preset", "booking"]));
    const projectOnly = resolveSlot("example/count", registry, { project: { "example/count": 3 } });
    expect(projectOnly).toMatchObject({ value: 3, layer: "project" });

    const projectAndPreset = resolveSlot("example/count", registry, {
      project: { "example/count": 3 },
      preset: { "example/count": 7 },
    });
    expect(projectAndPreset).toMatchObject({ value: 7, layer: "preset" });

    const allThree = resolveSlot("example/count", registry, {
      project: { "example/count": 3 },
      preset: { "example/count": 7 },
      booking: { "example/count": 9 },
    });
    expect(allThree).toMatchObject({ value: 9, layer: "booking" });
  });
});

describe("a preset or a booking assigning a project-only slot", () => {
  it("is refused naming the slot and the layer, whichever of the two tries", () => {
    const registry = registryOf({
      id: "example/project-only",
      schema: { type: "string" },
      hasDefault: true,
      default: "off",
      documentation: "d",
      layers: ["project"],
    });

    expect(() => resolveSlot("example/project-only", registry, { preset: { "example/project-only": "on" } })).toThrow(
      LayerRefusedError,
    );
    try {
      resolveSlot("example/project-only", registry, { preset: { "example/project-only": "on" } });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toMatch(/example\/project-only/);
      expect((error as Error).message).toMatch(/preset/);
    }

    expect(() => resolveSlot("example/project-only", registry, { booking: { "example/project-only": "on" } })).toThrow(
      LayerRefusedError,
    );
    try {
      resolveSlot("example/project-only", registry, { booking: { "example/project-only": "on" } });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toMatch(/example\/project-only/);
      expect((error as Error).message).toMatch(/booking/);
    }
  });
});

describe("a value in the wrong number form", () => {
  it("is refused: an exact count declared to travel as a string never accepts a bare number", () => {
    const registry = registryOf({
      id: "example/exact-count",
      schema: { type: "string", pattern: "^[0-9]+$" },
      hasDefault: false,
      default: undefined,
      documentation: "an exact count, carried as digits in a string so no digit is lost past the safe integer range",
      layers: ["booking"],
    });

    const huge = "9007199254740993"; // one past Number.MAX_SAFE_INTEGER
    const resolution = resolveSlot("example/exact-count", registry, { booking: { "example/exact-count": huge } });
    expect(resolution.value).toBe(huge);

    expect(() =>
      // biome-ignore lint/correctness/noPrecisionLoss: the test's subject is a value a double cannot hold
      resolveSlot("example/exact-count", registry, { booking: { "example/exact-count": 9007199254740993 } }),
    ).toThrow(LayerRefusedError);
  });
});

describe("resolving a slot", () => {
  it("records a read whose content id changes when the value changes and not otherwise", () => {
    const registry = registryOf(boundedCount("example/count", ["booking"]));
    const first = resolveSlot("example/count", registry, { booking: { "example/count": 1 } });
    const same = resolveSlot("example/count", registry, { booking: { "example/count": 1 } });
    const changed = resolveSlot("example/count", registry, { booking: { "example/count": 2 } });

    expect(first.readId).toBe(same.readId);
    expect(first.readId).not.toBe(changed.readId);
    expect(first.readId).toBe(slotReadId("example/count", recordId(1)));
  });
});

/** The one instant every commit and receipt this file mints is stamped with. */
const FIXED_NOW = fixedClock("2026-08-30T00:00:00.000Z");

describe("the isolation-policy slot, consulted by the runner", () => {
  it("changes containerPolicyFromSlot's answer and nothing else, one value at a time", () => {
    const refusing = registryOf({
      id: "musai.core/isolation-policy",
      schema: { type: "string", enum: ["refuse", "ask", "degrade"] },
      hasDefault: true,
      default: "refuse",
      documentation: "d",
      layers: ["project", "preset", "booking"],
    });
    expect(containerPolicyFromSlot(refusing, {})).toBe("refuse");
    expect(containerPolicyFromSlot(refusing, { booking: { "musai.core/isolation-policy": "degrade" } })).toBe(
      "degrade",
    );
    expect(containerPolicyFromSlot(refusing, { booking: { "musai.core/isolation-policy": "ask" } })).toBe("refuse");
    expect(containerPolicyFromSlot(undefined, undefined)).toBe("refuse");
  });
});

const HOLDS_WITH_NO_EVIDENCE: RuleOutput = { kind: "verdict", label: "holds", reason: "nothing to check" };
const holdsImmediately = () => HOLDS_WITH_NO_EVIDENCE;

async function scratchRepo(
  scope: string,
): Promise<{ readonly store: Store; readonly index: IndexDb; readonly ctx: GitContext; cleanup(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "musai-restart-slots-"));
  const { gitDir } = await initWorkspace(dir, { now: FIXED_NOW });
  const ctx: GitContext = { gitDir };
  return {
    store: new Store({ ctx, scope, now: FIXED_NOW }),
    index: new IndexDb(":memory:"),
    ctx,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe("the restart loop's satisfaction and concurrency, consulted from the resolution-age and need-concurrency slots", () => {
  it("changes with the resolution-age slot's own value and nothing else", async () => {
    const repo = await scratchRepo("restart-age");
    try {
      const registry = registryOf(
        {
          id: "musai.core/resolution-age",
          schema: { type: "integer", minimum: 0 },
          hasDefault: true,
          default: 0,
          documentation: "d",
          layers: ["project", "preset", "booking"],
        },
        {
          id: "musai.core/need-concurrency",
          schema: { type: "integer", minimum: 1 },
          hasDefault: true,
          default: 1,
          documentation: "d",
          layers: ["project", "preset", "booking"],
        },
      );
      const input: RuleInput = { claimId: "claim-age", conditions: {}, evidence: [] };
      const fresh = await runRestartLoop({
        invoker: invokerFromRule(holdsImmediately),
        input,
        store: repo.store,
        index: repo.index,
        slotRegistry: registry,
        now: FIXED_NOW,
      });
      expect(fresh.verdict).toEqual(HOLDS_WITH_NO_EVIDENCE);

      const withAge = await runRestartLoop({
        invoker: invokerFromRule(holdsImmediately),
        input,
        store: repo.store,
        index: repo.index,
        slotRegistry: registry,
        slotLayers: { project: { "musai.core/resolution-age": 999999 } },
        now: FIXED_NOW,
      });
      expect(withAge.verdict).toEqual(HOLDS_WITH_NO_EVIDENCE);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("declared environment names, as slots of a binding type", () => {
  it("take their secret flag from the project layer's declaration while their value comes from the local bindings file, and secrecy only ratchets up", async () => {
    const layerDeclarations = layerDeclarationsFromConfig({
      values: { declaredNames: { API_TOKEN: { secret: true }, LOG_LEVEL: { secret: false } } },
    });
    expect(layerDeclarations.get("API_TOKEN")).toEqual({ secret: true });
    expect(layerDeclarations.get("LOG_LEVEL")).toEqual({ secret: false });

    const { resolved } = await bindDeclaredNames(
      [
        { name: "API_TOKEN", secret: false },
        { name: "LOG_LEVEL", secret: false },
      ],
      { API_TOKEN: { secret: false, value: "token-value" }, LOG_LEVEL: { secret: false, value: "debug" } },
      layerDeclarations,
    );
    const apiToken = resolved.find((entry) => entry.name === "API_TOKEN");
    const logLevel = resolved.find((entry) => entry.name === "LOG_LEVEL");
    expect(apiToken).toMatchObject({ secret: true, value: "token-value" });
    expect(logLevel).toMatchObject({ secret: false, value: "debug" });
  });
});

describe("a case record's own preset and overrides", () => {
  it("records both verbatim; a case with no override records an empty override object; a case naming no preset is refused", () => {
    const withPresetAndOverride = validateRecord({
      kind: "case",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.case,
      type: null,
      slug: "example-case",
      claims: [],
      preset: {
        module: "musai.core",
        contribution: "musai.core/ci",
        moduleRecord: recordId({ marker: "core-module" }),
      },
      projectCommit: "a".repeat(40),
      overrides: { "musai.core/isolation-policy": "degrade" },
      evaluatorVersion: versionString("1"),
    });
    expect(withPresetAndOverride.ok).toBe(true);
    if (withPresetAndOverride.ok && withPresetAndOverride.record.kind === "case") {
      expect(withPresetAndOverride.record.preset.contribution).toBe("musai.core/ci");
      expect(withPresetAndOverride.record.overrides).toEqual({ "musai.core/isolation-policy": "degrade" });
    }

    const withNoOverride = validateRecord({
      kind: "case",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.case,
      type: null,
      slug: "no-override-case",
      claims: [],
      preset: {
        module: "musai.core",
        contribution: "musai.core/ci",
        moduleRecord: recordId({ marker: "core-module" }),
      },
      projectCommit: "a".repeat(40),
      overrides: {},
      evaluatorVersion: versionString("1"),
    });
    expect(withNoOverride.ok).toBe(true);
    if (withNoOverride.ok && withNoOverride.record.kind === "case") {
      expect(withNoOverride.record.overrides).toEqual({});
    }

    const withNoPreset = validateRecord({
      kind: "case",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.case,
      type: null,
      slug: "no-preset-case",
      claims: [],
      projectCommit: "a".repeat(40),
      overrides: {},
      evaluatorVersion: versionString("1"),
    });
    expect(withNoPreset.ok).toBe(false);
  });
});

describe("revalidation when the installed module set no longer admits a shipped preset's value", () => {
  it("refuses, naming both the preset and the slot", () => {
    const narrowedRegistry = registryOf({
      id: "musai.core/isolation-policy",
      schema: { type: "string", enum: ["refuse"] },
      hasDefault: true,
      default: "refuse",
      documentation: "d",
      layers: ["project", "preset", "booking"],
    });
    const preset: PresetDeclaration = {
      id: "musai.core/interactive",
      assignments: { "musai.core/isolation-policy": "ask" },
      documentation: "d",
    };
    expect(() => validatePresetAssignments(preset, narrowedRegistry)).toThrow(SlotRefusedError);
    expect(() => validatePresetAssignments(preset, narrowedRegistry)).toThrow(/musai\.core\/interactive/);
    expect(() => validatePresetAssignments(preset, narrowedRegistry)).toThrow(/musai\.core\/isolation-policy/);
  });
});
