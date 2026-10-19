import { IndexDb } from "@musai/fold";
import type { ContributionEntry, ModuleManifest, ModuleRecord } from "@musai/records";
import {
  CURRENT_SCHEMA_VERSIONS,
  PACK_IRREVERSIBLE_SLOT_ID,
  PROJECT_ONLY_SLOTS,
  recordId,
  SIGNING_LEVEL_SLOT_ID,
  type SlotDeclaration,
  SlotRefusedError,
  validateSlotValue,
  versionString,
} from "@musai/records";
import { Store } from "@musai/store";
import { blobStoreOf, type FixtureRepo, makeFixtureRepo, manifestWithContributions } from "@musai/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { installModule } from "../src/module/install.js";
import { readSlotDeclarations } from "../src/module/slot-registry.js";
import { INVOCATION_LIMITS_SLOT_ID, invocationLimitsFromSlots } from "../src/rule/host.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

async function trackedRepo(): Promise<FixtureRepo> {
  const repo = await makeFixtureRepo();
  cleanups.push(repo.cleanup);
  return repo;
}

function slotEntry(
  moduleName: string,
  name: string,
  schema: unknown,
  layers: readonly string[],
  hasDefault: boolean,
  defaultValue: unknown,
): ContributionEntry {
  return {
    kind: "slot",
    id: `${moduleName}/${name}`,
    version: versionString("1"),
    input: { layers: [...layers], hasDefault, default: defaultValue },
    output: schema,
    documentation: `the ${name} slot`,
  };
}

async function install(repo: FixtureRepo, name: string, manifest: ModuleManifest) {
  const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
  const index = new IndexDb(":memory:");
  await index.fold(store);
  const buildReceiptId = recordId({ marker: `build-for-${name}` });
  return installModule(
    name,
    versionString("1.0.0"),
    manifest,
    new TextEncoder().encode(`bundle for ${name}`),
    buildReceiptId,
    store,
    blobStoreOf(repo.workspace),
    index,
  );
}

/** A slot entry declaring neither layers nor default: a valid contribution, refused as a slot. */
function malformedSlot(moduleName: string): ContributionEntry {
  return {
    kind: "slot",
    id: `${moduleName}/broken`,
    version: versionString("1"),
    input: {},
    output: true,
    documentation: "d",
  };
}

/** Writes a module record straight through the store, as git lands it: no install check runs. */
async function writeModule(repo: FixtureRepo, name: string, contributions: readonly ContributionEntry[]) {
  const record: ModuleRecord = {
    kind: "module",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.module,
    name,
    version: versionString("1.0.0"),
    manifest: manifestWithContributions(contributions),
    bundle: recordId({ marker: `bundle-for-${name}` }),
    build: recordId({ marker: `build-for-${name}` }),
  };
  await new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }).put("module", record);
}

async function foldedRegistry(repo: FixtureRepo): Promise<Map<string, SlotDeclaration>> {
  const index = new IndexDb(":memory:");
  await index.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
  return new Map(readSlotDeclarations(index));
}

describe("a slot declared by an installed module", () => {
  it("appears in the registry with no module code ever evaluated", async () => {
    const repo = await trackedRepo();
    const moduleName = "example.module";
    await install(
      repo,
      moduleName,
      manifestWithContributions([slotEntry(moduleName, "greeting", { type: "string" }, ["project"], true, "hello")]),
    );
    // The fold reads the manifest inline on the record; the bundle bytes are never read.
    const registry = await foldedRegistry(repo);
    const declaration = registry.get(`${moduleName}/greeting`);
    expect(declaration).toBeDefined();
    expect(declaration?.default).toBe("hello");
    expect(declaration?.hasDefault).toBe(true);
    expect(declaration?.layers).toEqual(["project"]);
  });

  it("is refused naming the slot on every read of the registry when a record arriving through git carries no layer list", async () => {
    const repo = await trackedRepo();
    const moduleName = "malformed.module";
    await writeModule(repo, moduleName, [malformedSlot(moduleName)]);
    const index = new IndexDb(":memory:");
    await index.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
    expect(() => readSlotDeclarations(index)).toThrow(SlotRefusedError);
    expect(() => readSlotDeclarations(index)).toThrow(/malformed\.module\/broken/);
  });
});

describe("a slot no installed module declares", () => {
  it("a registry no installed module of which declares it refuses the invocation-limits slot, workspace-incomplete, naming it", async () => {
    const registry = await foldedRegistry(await trackedRepo());

    expect(() => invocationLimitsFromSlots(registry)).toThrow(
      expect.objectContaining({
        reason: "workspace-incomplete",
        code: "workspace",
        about: [INVOCATION_LIMITS_SLOT_ID],
      }),
    );
  });
});

describe("one slot id declared twice", () => {
  it("is refused on every read of the registry, naming its one declaring module, when a record arriving through git declares it at two versions", async () => {
    const repo = await trackedRepo();
    const first = slotEntry("twice.module", "limit", { type: "integer" }, ["project"], true, 1);
    await writeModule(repo, "twice.module", [first, { ...first, version: versionString("2") }]);
    const index = new IndexDb(":memory:");
    await index.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));

    expect(() => readSlotDeclarations(index)).toThrow(
      "refusing to register twice.module/limit: it is declared more than once, by twice.module",
    );
  });
});

describe("a slot declaration the registry would refuse", () => {
  it("is refused at install naming the slot when its input carries no layer list, and mints nothing", async () => {
    const repo = await trackedRepo();
    const moduleName = "malformed.module";

    const installing = install(repo, moduleName, manifestWithContributions([malformedSlot(moduleName)]));

    await expect(installing).rejects.toBeInstanceOf(SlotRefusedError);
    await expect(installing).rejects.toThrow(/malformed\.module\/broken/);
    expect(await new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }).list("module")).toEqual([]);
  });

  it("is refused at install when one manifest declares one slot id at two versions, naming the slot and its one declaring module", async () => {
    const repo = await trackedRepo();
    const moduleName = "twice.module";
    const first = slotEntry(moduleName, "limit", { type: "integer" }, ["project"], true, 1);

    const installing = install(
      repo,
      moduleName,
      manifestWithContributions([first, { ...first, version: versionString("2") }]),
    );

    await expect(installing).rejects.toBeInstanceOf(SlotRefusedError);
    await expect(installing).rejects.toThrow(
      "refusing to register twice.module/limit: it is declared more than once, by twice.module",
    );
  });

  it("is refused at install when a module whose name nests inside an installed one's declares the same slot id, naming both modules", async () => {
    const repo = await trackedRepo();
    const nested = slotEntry("a/b", "limit", { type: "integer" }, ["project"], true, 1);
    await install(repo, "a", manifestWithContributions([nested]));

    const installing = install(repo, "a/b", manifestWithContributions([nested]));

    await expect(installing).rejects.toBeInstanceOf(SlotRefusedError);
    await expect(installing).rejects.toThrow(
      "refusing to register a/b/limit: it is declared more than once, by a, a/b",
    );
  });

  it("installs beside a slot declaration already standing refused in the workspace, which costs its own pack alone", async () => {
    const repo = await trackedRepo();
    await writeModule(repo, "malformed.module", [malformedSlot("malformed.module")]);

    const installed = install(
      repo,
      "sound.module",
      manifestWithContributions([slotEntry("sound.module", "limit", { type: "integer" }, ["project"], true, 1)]),
    );

    await expect(installed).resolves.toMatchObject({ moduleRecordId: expect.stringMatching(/^sha256:/) });
  });
});

describe("two slot ids differing by one character", () => {
  it("resolve as two slots, each declared independently", async () => {
    const repo = await trackedRepo();
    const moduleName = "distinct.module";
    await install(
      repo,
      moduleName,
      manifestWithContributions([
        slotEntry(moduleName, "count", { type: "integer" }, ["project"], true, 1),
        slotEntry(moduleName, "counts", { type: "integer" }, ["project"], true, 2),
      ]),
    );
    const registry = await foldedRegistry(repo);
    expect(registry.get(`${moduleName}/count`)?.default).toBe(1);
    expect(registry.get(`${moduleName}/counts`)?.default).toBe(2);
    expect(registry.size).toBe(2);
  });
});

describe("a project-only slot", () => {
  it("names the signing level and whether a pack's operation may be irreversible, and nothing else", () => {
    expect([...PROJECT_ONLY_SLOTS].sort()).toEqual([PACK_IRREVERSIBLE_SLOT_ID, SIGNING_LEVEL_SLOT_ID].sort());
  });

  it.each([...PROJECT_ONLY_SLOTS])(
    "%s is refused at install, and on every read of a record arriving through git, when its declared layers reach past the project layer",
    async (projectOnlyId) => {
      const repo = await trackedRepo();
      const [moduleName, name] = projectOnlyId.split("/") as [string, string];
      const reaching = slotEntry(moduleName, name, { type: "string" }, ["project", "preset"], true, "off");
      const naming = new RegExp(projectOnlyId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

      const installing = install(repo, moduleName, manifestWithContributions([reaching]));
      await expect(installing).rejects.toBeInstanceOf(SlotRefusedError);
      await expect(installing).rejects.toThrow(naming);

      await writeModule(repo, moduleName, [reaching]);
      const index = new IndexDb(":memory:");
      await index.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
      expect(() => readSlotDeclarations(index)).toThrow(SlotRefusedError);
      expect(() => readSlotDeclarations(index)).toThrow(naming);
    },
  );
});

describe("a module installed twice under one name", () => {
  it("lists each contribution once, from the record its name resolves to, and registers each slot once", async () => {
    const repo = await trackedRepo();
    const moduleName = "repinned.module";
    const first = await install(
      repo,
      moduleName,
      manifestWithContributions([
        slotEntry(moduleName, "farewell", { type: "string" }, ["project"], true, "bye"),
        slotEntry(moduleName, "greeting", { type: "string" }, ["project"], true, "hello"),
      ]),
    );
    const second = await install(
      repo,
      moduleName,
      manifestWithContributions([
        slotEntry(moduleName, "farewell", { type: "string" }, ["project"], true, "bye"),
        slotEntry(moduleName, "greeting", { type: "string" }, ["project"], true, "hi"),
      ]),
    );
    expect(second.moduleRecordId).not.toBe(first.moduleRecordId);

    const index = new IndexDb(":memory:");
    await index.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
    const listed = index.contributionsOf("slot");
    expect(listed.map((contribution) => contribution.entry.id)).toEqual([
      `${moduleName}/farewell`,
      `${moduleName}/greeting`,
    ]);
    expect(listed.every((contribution) => contribution.moduleRecord === second.moduleRecordId)).toBe(true);

    const registry = new Map(readSlotDeclarations(index));
    expect(registry.size).toBe(2);
    expect(registry.get(`${moduleName}/greeting`)?.default).toBe("hi");
  });
});

describe("a slot whose schema carries an $id", () => {
  it("checks a value against that schema on every read, not only the first", () => {
    /** A fresh declaration on every call, as the fold hands one back: equal schema, one `$id`. */
    function declared(): SlotDeclaration {
      return {
        id: "example.module/greeting",
        schema: { $id: "https://example.test/greeting-slot", type: "string" },
        hasDefault: false,
        default: undefined,
        documentation: "the greeting slot",
        layers: ["project"],
      };
    }

    expect(() => validateSlotValue(declared(), "hello")).not.toThrow();
    expect(() => validateSlotValue(declared(), "hello again")).not.toThrow();
    expect(() => validateSlotValue(declared(), 5)).toThrow(SlotRefusedError);
  });
});
