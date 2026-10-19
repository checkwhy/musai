import { IndexDb } from "@musai/fold";
import { installModule, readClaimTypeDeclarations } from "@musai/modules";
import type { ClaimRecord, ContributionEntry, ModuleManifest, ModuleRecord } from "@musai/records";
import {
  type ClaimTypeDeclaration,
  CURRENT_SCHEMA_VERSIONS,
  recordId,
  slotFor,
  TRIPLE_CLAIM_TYPE,
  versionString,
} from "@musai/records";
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

function claimTypeEntry(
  moduleName: string,
  type: string,
  input: unknown,
  version = versionString("1"),
): ContributionEntry {
  return {
    kind: "claim-type",
    id: `${moduleName}/${type}`,
    version,
    input,
    output: true,
    documentation: `the ${type} claim type`,
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

async function foldedDeclarations(repo: FixtureRepo): Promise<ReturnType<typeof readClaimTypeDeclarations>> {
  const index = new IndexDb(":memory:");
  await index.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
  return readClaimTypeDeclarations(index);
}

async function openOver(repo: FixtureRepo): Promise<Workspace> {
  return Workspace.open({ dir: repo.workspace, scope: repo.scope, now: fixedClock(FIXED_INSTANT) });
}

function claimOf(declaration: ClaimTypeDeclaration, subject: string): ClaimRecord {
  const conditions = { case: subject };
  return {
    kind: "claim",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: declaration.type,
    about: [],
    slot: slotFor(declaration, conditions),
    conditions,
    canonical: conditions,
    rendering: `${subject} is claimed`,
    evidence: [],
    exclusiveGroup: null,
  };
}

describe("a claim type declared by an installed module", () => {
  it("resolves to a declaration whose type is the contribution's own id", async () => {
    const repo = await trackedRepo();
    await install(
      repo,
      MODULE_NAME,
      manifestWithContributions([claimTypeEntry(MODULE_NAME, "finding@1", { identityDimensions: ["case"] })]),
    );

    const read = await foldedDeclarations(repo);

    expect(read.refused).toEqual([]);
    expect(read.declarations).toEqual([{ type: `${MODULE_NAME}/finding@1`, identityDimensions: ["case"] }]);
  });

  it("carries the schema its canonical payload satisfies, and carries none where it declares none", async () => {
    const repo = await trackedRepo();
    const canonical = { type: "object", required: ["summary"], properties: { summary: { type: "string" } } };
    await install(
      repo,
      MODULE_NAME,
      manifestWithContributions([
        claimTypeEntry(MODULE_NAME, "constrained@1", { identityDimensions: ["case"], canonical }),
        claimTypeEntry(MODULE_NAME, "unconstrained@1", { identityDimensions: ["case"] }),
      ]),
    );

    const read = await foldedDeclarations(repo);

    const constrained = read.declarations.find((declaration) => declaration.type.endsWith("constrained@1"));
    expect(constrained?.canonical).toEqual(canonical);
    const unconstrained = read.declarations.find((declaration) => declaration.type.endsWith("/unconstrained@1"));
    expect(unconstrained).toBeDefined();
    expect("canonical" in unconstrained!).toBe(false);
  });

  it("is refused by name when it declares an empty identity dimension list", async () => {
    const repo = await trackedRepo();
    await install(
      repo,
      MODULE_NAME,
      manifestWithContributions([claimTypeEntry(MODULE_NAME, "identityless@1", { identityDimensions: [] })]),
    );

    const read = await foldedDeclarations(repo);

    expect(read.declarations).toEqual([]);
    expect(read.refused.map((refusal) => refusal.contributionId)).toEqual([`${MODULE_NAME}/identityless@1`]);
    expect(read.refused[0]!.reason).toContain(`${MODULE_NAME}/identityless@1`);
  });

  it("is refused by name when an identity dimension it names carries a slash, as only a contribution id does", async () => {
    const repo = await trackedRepo();
    await install(
      repo,
      MODULE_NAME,
      manifestWithContributions([
        claimTypeEntry(MODULE_NAME, "slashed@1", { identityDimensions: ["case", `${MODULE_NAME}/tier`] }),
      ]),
    );

    const read = await foldedDeclarations(repo);

    expect(read.declarations).toEqual([]);
    expect(read.refused.map((refusal) => refusal.contributionId)).toEqual([`${MODULE_NAME}/slashed@1`]);
  });

  it("is refused by name when it carries a type of its own beside its identity dimensions", async () => {
    const repo = await trackedRepo();
    await install(
      repo,
      MODULE_NAME,
      manifestWithContributions([
        claimTypeEntry(MODULE_NAME, "self-naming@1", {
          type: `${MODULE_NAME}/self-naming@1`,
          identityDimensions: ["case"],
        }),
      ]),
    );

    const read = await foldedDeclarations(repo);

    expect(read.declarations).toEqual([]);
    expect(read.refused[0]!.reason).toContain(`${MODULE_NAME}/self-naming@1`);
  });

  it("is refused by name when the schema its canonical payload satisfies does not compile, and the workspace opens", async () => {
    const repo = await trackedRepo();
    await install(
      repo,
      MODULE_NAME,
      manifestWithContributions([
        claimTypeEntry(MODULE_NAME, "dangling@1", {
          identityDimensions: ["case"],
          canonical: { $ref: "#/definitions/missing" },
        }),
        claimTypeEntry(MODULE_NAME, "nonsense@1", { identityDimensions: ["case"], canonical: { type: "nonsense" } }),
        claimTypeEntry(MODULE_NAME, "sound@1", { identityDimensions: ["case"], canonical: { type: "object" } }),
      ]),
    );

    const opened = await openOver(repo);

    for (const type of [`${MODULE_NAME}/nonsense@1`, `${MODULE_NAME}/dangling@1`]) {
      const refused = opened.foldRefusals.filter((refusal) => refusal.contributionId === type);
      expect(refused).toHaveLength(1);
      expect(refused[0]!.reason).toContain(type);
      expect(opened.claimTypes.has(type)).toBe(false);
    }
    expect(opened.claimTypes.get(`${MODULE_NAME}/sound@1`)?.canonical).toEqual({ type: "object" });
  });

  it("stands beside another type whose canonical schema names the same $id", async () => {
    const repo = await trackedRepo();
    const shared = { $id: "https://example.test/shared-payload", type: "object" };
    await install(
      repo,
      MODULE_NAME,
      manifestWithContributions([
        claimTypeEntry(MODULE_NAME, "first@1", { identityDimensions: ["case"], canonical: shared }),
        claimTypeEntry(MODULE_NAME, "second@1", { identityDimensions: ["case"], canonical: shared }),
      ]),
    );

    const read = await foldedDeclarations(repo);

    expect(read.refused).toEqual([]);
    expect(read.declarations.map((declaration) => declaration.type)).toEqual([
      `${MODULE_NAME}/first@1`,
      `${MODULE_NAME}/second@1`,
    ]);
  });

  it("leaves neither declaration standing when one module declares one type id at two versions, and the workspace opens", async () => {
    const repo = await trackedRepo();
    await install(
      repo,
      MODULE_NAME,
      manifestWithContributions([
        claimTypeEntry(MODULE_NAME, "twice@1", { identityDimensions: ["case"] }, versionString("1")),
        claimTypeEntry(MODULE_NAME, "twice@1", { identityDimensions: ["subject"] }, versionString("2")),
      ]),
    );

    const opened = await openOver(repo);
    const read = await foldedDeclarations(repo);

    expect(read.declarations).toEqual([]);
    expect(read.refused.map((refusal) => refusal.version).sort()).toEqual(["1", "2"]);
    expect(read.refused.find((refusal) => refusal.version === "1")?.reason).toContain("at version 2");
    expect(read.refused.find((refusal) => refusal.version === "2")?.reason).toContain("at version 1");
    expect(opened.claimTypes.has(`${MODULE_NAME}/twice@1`)).toBe(false);
  });

  it("stands where the only other declaration of its id did not parse, since a malformed entry declares no type", async () => {
    const repo = await trackedRepo();
    await install(
      repo,
      MODULE_NAME,
      manifestWithContributions([
        claimTypeEntry(MODULE_NAME, "paired@1", { identityDimensions: ["case"] }, versionString("1")),
        claimTypeEntry(MODULE_NAME, "paired@1", { identityDimensions: [] }, versionString("2")),
      ]),
    );

    const read = await foldedDeclarations(repo);

    expect(read.declarations).toEqual([{ type: `${MODULE_NAME}/paired@1`, identityDimensions: ["case"] }]);
    expect(read.refused.map((refusal) => refusal.version)).toEqual(["2"]);
    const opened = await openOver(repo);
    expect(opened.claimTypes.get(`${MODULE_NAME}/paired@1`)?.identityDimensions).toEqual(["case"]);
  });

  it("leaves neither declaration standing when two modules whose names nest declare one type id, and the workspace opens", async () => {
    const repo = await trackedRepo();
    const inner = `${MODULE_NAME}/inner`;
    await install(
      repo,
      MODULE_NAME,
      manifestWithContributions([claimTypeEntry(MODULE_NAME, "inner/nested@1", { identityDimensions: ["case"] })]),
    );
    // Install refuses a second declaration of one id, so this lands as a record from git would.
    const innerRecord: ModuleRecord = {
      kind: "module",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.module,
      name: inner,
      version: versionString("1.0.0"),
      manifest: manifestWithContributions([claimTypeEntry(inner, "nested@1", { identityDimensions: ["subject"] })]),
      bundle: recordId({ marker: `bundle-for-${inner}` }),
      build: recordId({ marker: `build-for-${inner}` }),
    };
    await new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }).put("module", innerRecord);

    const opened = await openOver(repo);
    const read = await foldedDeclarations(repo);

    expect(read.declarations).toEqual([]);
    expect(read.refused).toHaveLength(2);
    expect(read.refused.map((refusal) => refusal.contributionId)).toEqual([`${inner}/nested@1`, `${inner}/nested@1`]);
    const reasons = read.refused.map((refusal) => refusal.reason);
    expect(reasons.some((reason) => reason.includes(`by ${MODULE_NAME} at version`))).toBe(true);
    expect(reasons.some((reason) => reason.includes(`by ${inner} at version`))).toBe(true);
    expect(opened.claimTypes.has(`${inner}/nested@1`)).toBe(false);
    expect([...opened.claimTypes.keys()]).toEqual([TRIPLE_CLAIM_TYPE]);
  });
});

describe("a workspace opened over a fold holding a malformed claim-type declaration", () => {
  it("opens, reports the declaration it refused, and validates every claim of every type that stood", async () => {
    const repo = await trackedRepo();
    await install(
      repo,
      MODULE_NAME,
      manifestWithContributions([
        claimTypeEntry(MODULE_NAME, "malformed@1", { identityDimensions: "not a list" }),
        claimTypeEntry(MODULE_NAME, "sound@1", { identityDimensions: ["case"] }),
      ]),
    );

    const opened = await openOver(repo);

    const refused = opened.foldRefusals.filter((refusal) => refusal.contributionId.endsWith("/malformed@1"));
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toContain(`${MODULE_NAME}/malformed@1`);
    expect(opened.claimTypes.has(`${MODULE_NAME}/malformed@1`)).toBe(false);
    const sound = opened.claimTypes.get(`${MODULE_NAME}/sound@1`);
    expect(sound).toBeDefined();
    const claim = claimOf(sound!, "still-good");
    const [written] = await opened.put([{ kind: "claim", value: claim }]);
    expect(opened.read(written!)).toEqual(claim);
    await expect(
      opened.store.putMany([
        { kind: "claim", value: claimOf({ type: `${MODULE_NAME}/malformed@1`, identityDimensions: ["case"] }, "no") },
      ]),
    ).rejects.toThrow(`claim names an unregistered type: ${MODULE_NAME}/malformed@1`);
  });
});
