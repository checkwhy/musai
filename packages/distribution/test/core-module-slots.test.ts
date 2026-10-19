import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildModule } from "@musai/devkit";
import { IndexDb } from "@musai/fold";
import {
  DEFAULT_MEMORY_LIMIT_MB,
  DEFAULT_TIME_LIMIT_MS,
  invocationLimitsFromSlots,
  readPresetDeclarations,
  readSlotDeclarations,
} from "@musai/modules";
import {
  LayerRefusedError,
  PACK_IRREVERSIBLE_SLOT_ID,
  PROJECT_ONLY_SLOTS,
  type PresetRegistry,
  resolveSlot,
  type SlotRegistry,
} from "@musai/records";
import { type GitContext, initWorkspace, Store } from "@musai/store";
import { blobStoreOf, fixedClock } from "@musai/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { repoGitDir } from "./repo-git-dir.js";

const CORE_MODULE_DIR = fileURLToPath(new URL("../../core-module", import.meta.url));

const FIXED_NOW = fixedClock("2026-08-30T00:00:00.000Z");

/** The slot and preset registries of the real core module, built and folded as an install is. */
async function coreModuleRegistries(): Promise<{
  readonly registry: SlotRegistry;
  readonly presets: PresetRegistry;
  readonly index: IndexDb;
  cleanup(): Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "musai-core-module-slots-"));
  const { gitDir } = await initWorkspace(dir, { now: FIXED_NOW });
  const ctx: GitContext = { gitDir };
  const store = new Store({ ctx, scope: "slots", now: FIXED_NOW });
  const sourceGitDir = await repoGitDir();
  const index = new IndexDb(":memory:");
  await index.fold(store);
  await buildModule(CORE_MODULE_DIR, store, {
    blobs: blobStoreOf(dir),
    index,
    sourceGitDir,
    now: FIXED_NOW,
  });
  await index.fold(store);
  const registry = readSlotDeclarations(index);
  return {
    registry,
    presets: readPresetDeclarations(index, registry),
    index,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function coreModuleSlotRegistry(): Promise<{ readonly registry: SlotRegistry; cleanup(): Promise<void> }> {
  const { registry, cleanup } = await coreModuleRegistries();
  return { registry, cleanup };
}

describe("the core module's own eight slots", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it("declares eight settings and no more", async () => {
    const { registry, cleanup } = await coreModuleSlotRegistry();
    cleanups.push(cleanup);
    expect([...registry.keys()].sort()).toEqual(
      [
        "musai.core/brief-budget",
        "musai.core/invocation-limits",
        "musai.core/isolation-policy",
        "musai.core/need-concurrency",
        PACK_IRREVERSIBLE_SLOT_ID,
        "musai.core/resolution-age",
        "musai.core/signing-level",
        "musai.core/staleness-policy",
      ].sort(),
    );
  });

  it("holds no kernel-side default for any of the eight: resolving with an empty project layer and empty preset matches the slot's own declared default", async () => {
    const { registry, cleanup } = await coreModuleSlotRegistry();
    cleanups.push(cleanup);
    const limits = resolveSlot("musai.core/invocation-limits", registry, {}).value as {
      timeLimitMs: number;
      memoryLimitMb: number;
    };
    expect(limits).toEqual({ timeLimitMs: DEFAULT_TIME_LIMIT_MS, memoryLimitMb: DEFAULT_MEMORY_LIMIT_MB });
    expect(resolveSlot("musai.core/isolation-policy", registry, {}).value).toBe("refuse");
    expect(resolveSlot("musai.core/resolution-age", registry, {}).value).toBe(0);
    expect(resolveSlot("musai.core/need-concurrency", registry, {}).value).toBe(1);
    expect(resolveSlot("musai.core/signing-level", registry, {}).value).toBe("off");
    expect(resolveSlot("musai.core/staleness-policy", registry, {}).value).toBe("strict");
    expect(resolveSlot("musai.core/brief-budget", registry, {}).value).toBe(20000);
    expect(resolveSlot(PACK_IRREVERSIBLE_SLOT_ID, registry, {}).value).toBe(false);
  });

  it("resolves the invocation-limits slot's own value through invocationLimitsFromSlots", async () => {
    const { registry, cleanup } = await coreModuleSlotRegistry();
    cleanups.push(cleanup);
    expect(invocationLimitsFromSlots(registry)).toEqual({
      timeLimitMs: DEFAULT_TIME_LIMIT_MS,
      memoryLimitMb: DEFAULT_MEMORY_LIMIT_MB,
    });
    expect(
      invocationLimitsFromSlots(registry, {
        booking: { "musai.core/invocation-limits": { timeLimitMs: 10, memoryLimitMb: 8 } },
      }),
    ).toEqual({ timeLimitMs: 10, memoryLimitMb: 8 });
    expect(
      invocationLimitsFromSlots(registry, {
        project: { "musai.core/invocation-limits": { timeLimitMs: 200, memoryLimitMb: 32 } },
      }),
    ).toEqual({ timeLimitMs: 200, memoryLimitMb: 32 });
  });

  it("is refused, naming the slot and the layer, when a preset or a booking tries to assign the signing-level slot", async () => {
    const { registry, cleanup } = await coreModuleSlotRegistry();
    cleanups.push(cleanup);
    expect(() =>
      resolveSlot("musai.core/signing-level", registry, { preset: { "musai.core/signing-level": "all" } }),
    ).toThrow(LayerRefusedError);
    expect(() =>
      resolveSlot("musai.core/signing-level", registry, { booking: { "musai.core/signing-level": "all" } }),
    ).toThrow(LayerRefusedError);
    expect(
      resolveSlot("musai.core/signing-level", registry, { project: { "musai.core/signing-level": "all" } }).value,
    ).toBe("all");
  });
});

const ALL_EIGHT_SLOT_IDS = [
  "musai.core/brief-budget",
  "musai.core/invocation-limits",
  "musai.core/isolation-policy",
  "musai.core/need-concurrency",
  PACK_IRREVERSIBLE_SLOT_ID,
  "musai.core/resolution-age",
  "musai.core/signing-level",
  "musai.core/staleness-policy",
];

describe("the core module's three shipped presets", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it("appear in the derived manifest, all three validating against the current slot schemas", async () => {
    const { presets, cleanup } = await coreModuleRegistries();
    cleanups.push(cleanup);
    expect([...presets.keys()].sort()).toEqual(["musai.core/bare", "musai.core/ci", "musai.core/interactive"]);
  });

  it("interactive and ci differ in exactly the slots the decisions say they differ in and agree everywhere else, asserted slot by slot", async () => {
    const { presets, cleanup } = await coreModuleRegistries();
    cleanups.push(cleanup);
    const interactive = presets.get("musai.core/interactive")!;
    const ci = presets.get("musai.core/ci")!;

    for (const slotId of ALL_EIGHT_SLOT_IDS) {
      const interactiveValue = interactive.assignments[slotId];
      const ciValue = ci.assignments[slotId];
      if (slotId === "musai.core/isolation-policy" || slotId === "musai.core/resolution-age") {
        expect(interactiveValue).not.toEqual(ciValue);
      } else {
        expect(interactiveValue).toBeUndefined();
        expect(ciValue).toBeUndefined();
      }
    }
    expect(interactive.assignments["musai.core/isolation-policy"]).toBe("ask");
    expect(ci.assignments["musai.core/isolation-policy"]).toBe("refuse");
  });

  it("never assign the degrade value", async () => {
    const { presets, cleanup } = await coreModuleRegistries();
    cleanups.push(cleanup);
    for (const preset of presets.values()) {
      expect(Object.values(preset.assignments)).not.toContain("degrade");
    }
  });

  it("never assign a project-only slot", async () => {
    const { presets, cleanup } = await coreModuleRegistries();
    cleanups.push(cleanup);
    for (const preset of presets.values()) {
      for (const slotId of PROJECT_ONLY_SLOTS) {
        expect(preset.assignments[slotId]).toBeUndefined();
      }
    }
  });

  it("leave a workspace whose project layer assigns nothing resolving every one of the eight slots through the defaults layer", async () => {
    const { registry, cleanup } = await coreModuleRegistries();
    cleanups.push(cleanup);
    for (const slotId of ALL_EIGHT_SLOT_IDS) {
      const resolution = resolveSlot(slotId, registry, {});
      expect(resolution.layer).toBe("pack-defaults");
    }
  });

  it("resolve a case booked under a preset with an override the same slot, naming both the preset and the booking as the layer each effective value came from", async () => {
    const { registry, presets, cleanup } = await coreModuleRegistries();
    cleanups.push(cleanup);
    const ci = presets.get("musai.core/ci")!;
    const withOnlyPreset = resolveSlot("musai.core/isolation-policy", registry, { preset: ci.assignments });
    expect(withOnlyPreset).toMatchObject({ value: "refuse", layer: "preset" });

    const withBookingOverride = resolveSlot("musai.core/isolation-policy", registry, {
      preset: ci.assignments,
      booking: { "musai.core/isolation-policy": "degrade" },
    });
    expect(withBookingOverride).toMatchObject({ value: "degrade", layer: "booking" });
  });
});
