import { IndexDb } from "@musai/fold";
import { installModule, readDimensionDeclarations } from "@musai/modules";
import type { ContributionEntry, ModuleManifest } from "@musai/records";
import { recordId, versionString } from "@musai/records";
import { Store } from "@musai/store";
import {
  blobStoreOf,
  type FixtureRepo,
  fixedClock,
  makeFixtureRepo,
  manifestWithContributions,
} from "@musai/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace.js";

const FIXED_INSTANT = "2026-01-01T00:00:00.000Z";
const MODULE_NAME = "example.pack";

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

function dimensionEntry(moduleName: string, id: string, input: unknown): ContributionEntry {
  return {
    kind: "dimension",
    id: `${moduleName}/${id}`,
    version: versionString("1"),
    input,
    output: true,
    documentation: `the ${id} dimension`,
  };
}

async function install(repo: FixtureRepo, name: string, manifest: ModuleManifest): Promise<void> {
  const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
  const index = new IndexDb(":memory:");
  await index.fold(store);
  await installModule(
    name,
    versionString("1.0.0"),
    manifest,
    new TextEncoder().encode(`bundle for ${name}`),
    recordId({ marker: `build-for-${name}` }),
    store,
    blobStoreOf(repo.workspace),
    index,
  );
}

async function foldedDimensions(repo: FixtureRepo): Promise<ReturnType<typeof readDimensionDeclarations>> {
  const index = new IndexDb(":memory:");
  await index.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
  return readDimensionDeclarations(index);
}

async function openOver(repo: FixtureRepo): Promise<Workspace> {
  return Workspace.open({ dir: repo.workspace, scope: repo.scope, now: fixedClock(FIXED_INSTANT) });
}

describe("the five dimension types an installed module can declare", () => {
  it("each resolve to the arm the union declares, a graph and a hierarchy built as the maps the comparison walks", async () => {
    const repo = await trackedRepo();
    await install(
      repo,
      MODULE_NAME,
      manifestWithContributions([
        dimensionEntry(MODULE_NAME, "build", { name: "build", type: "ordered", data: { order: "numeric" } }),
        dimensionEntry(MODULE_NAME, "package", {
          name: "package",
          type: "dag",
          data: { edges: { "engine@1.0.0": ["engine@1.x"], "engine@1.x": [] } },
        }),
        dimensionEntry(MODULE_NAME, "platform", {
          name: "platform",
          type: "hierarchical",
          data: { parentOf: { ubuntu: "linux", linux: null } },
        }),
        dimensionEntry(MODULE_NAME, "run", { name: "run", type: "identity", data: {} }),
        dimensionEntry(MODULE_NAME, "span", { name: "span", type: "interval", data: { order: "lexicographic" } }),
      ]),
    );

    const read = await foldedDimensions(repo);

    expect(read.refused).toEqual([]);
    expect([...read.dimensions.keys()].sort()).toEqual(["build", "package", "platform", "run", "span"]);
    expect(read.dimensions.get("build")).toEqual({ name: "build", type: "ordered", data: { order: "numeric" } });
    expect(read.dimensions.get("span")).toEqual({ name: "span", type: "interval", data: { order: "lexicographic" } });
    expect(read.dimensions.get("run")).toEqual({ name: "run", type: "identity", data: {} });
    const graph = read.dimensions.get("package");
    expect(graph?.type).toBe("dag");
    expect(graph?.type === "dag" && graph.data.edges.get("engine@1.0.0")).toEqual(new Set(["engine@1.x"]));
    const hierarchy = read.dimensions.get("platform");
    expect(hierarchy?.type).toBe("hierarchical");
    expect(hierarchy?.type === "hierarchical" && hierarchy.data.parentOf.get("ubuntu")).toBe("linux");
    expect(hierarchy?.type === "hierarchical" && hierarchy.data.parentOf.get("linux")).toBeNull();
  });

  it("refuse by name a declaration naming an order this kernel does not implement", async () => {
    const repo = await trackedRepo();
    await install(
      repo,
      MODULE_NAME,
      manifestWithContributions([
        dimensionEntry(MODULE_NAME, "release", { name: "release", type: "ordered", data: { order: "version" } }),
      ]),
    );

    const read = await foldedDimensions(repo);

    expect(read.dimensions.size).toBe(0);
    expect(read.refused.map((refusal) => refusal.contributionId)).toEqual([`${MODULE_NAME}/release`]);
    expect(read.refused[0]!.reason).toContain(`${MODULE_NAME}/release`);
  });
});

describe("one dimension name declared more than once", () => {
  it("leaves neither declaration standing when two installed modules declare it, each refusal naming the other, and the workspace opens", async () => {
    const repo = await trackedRepo();
    const other = "other.pack";
    await install(
      repo,
      MODULE_NAME,
      manifestWithContributions([dimensionEntry(MODULE_NAME, "tier", { name: "tier", type: "identity", data: {} })]),
    );
    await install(
      repo,
      other,
      manifestWithContributions([
        dimensionEntry(other, "tier", { name: "tier", type: "ordered", data: { order: "numeric" } }),
      ]),
    );

    const read = await foldedDimensions(repo);

    expect(read.dimensions.size).toBe(0);
    expect(read.refused.map((refusal) => refusal.contributionId).sort()).toEqual([
      `${MODULE_NAME}/tier`,
      `${other}/tier`,
    ]);
    const reasonOf = (id: string): string => read.refused.find((refusal) => refusal.contributionId === id)!.reason;
    expect(reasonOf(`${MODULE_NAME}/tier`)).toContain(`also declared at ${other}/tier`);
    expect(reasonOf(`${other}/tier`)).toContain(`also declared at ${MODULE_NAME}/tier`);
    expect(reasonOf(`${MODULE_NAME}/tier`)).not.toEqual(reasonOf(`${other}/tier`));
    const opened = await openOver(repo);
    expect(opened.dimensions.has("tier")).toBe(false);
    expect(opened.foldRefusals.filter((refusal) => refusal.reason.includes("tier"))).toHaveLength(2);
  });

  it("leaves neither standing when one module declares it at two versions, and the workspace opens", async () => {
    const repo = await trackedRepo();
    await install(
      repo,
      MODULE_NAME,
      manifestWithContributions([
        { ...dimensionEntry(MODULE_NAME, "tier", { name: "tier", type: "identity", data: {} }) },
        {
          ...dimensionEntry(MODULE_NAME, "tier", { name: "tier", type: "ordered", data: { order: "numeric" } }),
          version: versionString("2"),
        },
      ]),
    );

    const read = await foldedDimensions(repo);

    expect(read.dimensions.size).toBe(0);
    expect(read.refused.map((refusal) => refusal.version).sort()).toEqual(["1", "2"]);
    expect(read.refused[0]!.reason).not.toEqual(read.refused[1]!.reason);
    const opened = await openOver(repo);
    expect(opened.dimensions.has("tier")).toBe(false);
  });

  it("stands where the only other declaration of its name did not parse, since a malformed entry declares no dimension", async () => {
    const repo = await trackedRepo();
    const other = "other.pack";
    await install(
      repo,
      MODULE_NAME,
      manifestWithContributions([
        dimensionEntry(MODULE_NAME, "tier", { name: "tier", type: "ordered", data: { order: "numeric" } }),
      ]),
    );
    await install(
      repo,
      other,
      manifestWithContributions([dimensionEntry(other, "tier", { name: "tier", type: "ordered" })]),
    );

    const read = await foldedDimensions(repo);

    expect(read.dimensions.get("tier")).toEqual({ name: "tier", type: "ordered", data: { order: "numeric" } });
    expect(read.refused.map((refusal) => refusal.contributionId)).toEqual([`${other}/tier`]);
    expect(read.refused[0]!.reason).toContain("must declare its name and the data that type compares by");
  });
});

describe("a dimension whose name carries a slash", () => {
  it("is refused by name, since only a module's contribution id is a condition key with a slash, and the workspace opens", async () => {
    const repo = await trackedRepo();
    await install(
      repo,
      MODULE_NAME,
      manifestWithContributions([
        dimensionEntry(MODULE_NAME, "slashed", { name: `${MODULE_NAME}/tier`, type: "identity", data: {} }),
        dimensionEntry(MODULE_NAME, "sound", { name: "sound", type: "identity", data: {} }),
      ]),
    );

    const opened = await openOver(repo);

    expect([...opened.dimensions.keys()]).toEqual(["sound"]);
    const refused = opened.foldRefusals.filter((refusal) => refusal.contributionId === `${MODULE_NAME}/slashed`);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toContain("declaration/name");
  });
});

describe("a workspace opened over a fold holding a malformed dimension declaration", () => {
  it("opens, reports the declaration it refused, and holds every dimension that stood", async () => {
    const repo = await trackedRepo();
    await install(
      repo,
      MODULE_NAME,
      manifestWithContributions([
        dimensionEntry(MODULE_NAME, "malformed", { name: "malformed", type: "ordered" }),
        dimensionEntry(MODULE_NAME, "sound", { name: "sound", type: "ordered", data: { order: "numeric" } }),
      ]),
    );

    const opened = await openOver(repo);

    const refused = opened.foldRefusals.filter((refusal) => refusal.contributionId.endsWith("/malformed"));
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toContain(`${MODULE_NAME}/malformed`);
    expect([...opened.dimensions.keys()]).toEqual(["sound"]);
    expect(opened.dimensions.get("sound")).toEqual({ name: "sound", type: "ordered", data: { order: "numeric" } });
  });
});

describe("a DAG dimension that spells its coarse values", () => {
  const edges = { "d1-h1": ["d1-h2"], "d1-h2": ["d2-h1"], "d2-h1": [] };

  it("carries its expansions to the workspace as the map the comparison reads", async () => {
    const repo = await trackedRepo();
    await install(
      repo,
      MODULE_NAME,
      manifestWithContributions([
        dimensionEntry(MODULE_NAME, "leg", {
          name: "leg",
          type: "dag",
          data: { edges, expansions: { "day-1": { first: "d1-h1", last: "d1-h2" } } },
        }),
      ]),
    );

    const opened = await openOver(repo);

    const leg = opened.dimensions.get("leg");
    expect(leg?.type === "dag" && leg.data.expansions).toEqual(new Map([["day-1", { first: "d1-h1", last: "d1-h2" }]]));
  });

  it.each([
    ["a coarse value that is also a node", { "d1-h1": { first: "d1-h1", last: "d1-h2" } }, "is a node"],
    ["an end that is no node", { "day-1": { first: "d1-h1", last: "d1-h9" } }, "d1-h9"],
    ["a last node its first cannot reach", { "day-1": { first: "d2-h1", last: "d1-h1" } }, "cannot reach"],
  ])("refuses by name %s, and the workspace opens", async (_case, expansions, says) => {
    const repo = await trackedRepo();
    await install(
      repo,
      MODULE_NAME,
      manifestWithContributions([
        dimensionEntry(MODULE_NAME, "leg", { name: "leg", type: "dag", data: { edges, expansions } }),
      ]),
    );

    const opened = await openOver(repo);

    expect(opened.dimensions.has("leg")).toBe(false);
    const refused = opened.foldRefusals.filter((refusal) => refusal.contributionId === `${MODULE_NAME}/leg`);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toContain(says);
  });
});
