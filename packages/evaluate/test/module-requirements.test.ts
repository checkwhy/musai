import { installModule, type Need, needId, readRequirementDeclarations } from "@musai/modules";
import type { ContributionEntry, ModuleRecord, RunRecipe } from "@musai/records";
import { CURRENT_SCHEMA_VERSIONS, recordId, versionString } from "@musai/records";
import { ConflictingRequirementError } from "@musai/run";
import { Store } from "@musai/store";
import {
  blobStoreOf,
  type FixtureRepo,
  foldedIndex,
  makeFixtureRepo,
  manifestWithContributions,
  writeFixtureRecords,
} from "@musai/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { satisfyNeeds } from "../src/evaluator/restart.js";

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

function storeOf(repo: FixtureRepo): Store {
  return new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
}

/** A `requirement` contribution of `module`'s declaring `binary` under `versionPredicate`. */
function requirement(module: string, binary: string, versionPredicate: string | null): ContributionEntry {
  return {
    kind: "requirement",
    id: `${module}/${binary}`,
    version: versionString("1"),
    input: { binary, versionPredicate, neededBy: `${module}'s own fixture`, install: "already on this machine" },
    output: true,
    documentation: `${binary}, needed by ${module}`,
  };
}

/** Installs through the one install path, against a fold of the workspace before the install. */
async function install(repo: FixtureRepo, name: string, version: string, contributions: readonly ContributionEntry[]) {
  return installModule(
    name,
    versionString(version),
    manifestWithContributions(contributions),
    new TextEncoder().encode(`bundle for ${name}@${version}`),
    recordId({ marker: `build-for-${name}-${version}` }),
    storeOf(repo),
    blobStoreOf(repo.workspace),
    await foldedIndex(storeOf(repo)),
  );
}

/** Writes a module record straight through the store, bypassing the install-time checks. */
async function writeModuleRecord(repo: FixtureRepo, name: string, contributions: readonly ContributionEntry[]) {
  const moduleRecord: ModuleRecord = {
    kind: "module",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.module,
    name,
    version: versionString("1"),
    manifest: manifestWithContributions(contributions),
    bundle: null,
    build: null,
  };
  await writeFixtureRecords(repo, [{ kind: "module", value: moduleRecord }]);
}

/** A run need over a bare command, run from the filesystem root. */
function runNeed(command: string[]): Need {
  const recipe: RunRecipe = {
    command,
    workingDirectory: "/",
    environment: {},
    declared: [],
    substrates: [],
    isolation: "hygiene",
  };
  return { kind: "run", recipe };
}

describe("installing a module whose requirements meet an installed module's", () => {
  it("an install whose requirement disagrees with an installed module's is refused, naming both modules, and writes nothing", async () => {
    const repo = await trackedRepo();
    await install(repo, "a.pack", "1.0.0", [requirement("a.pack", "git", ">=2.40")]);
    const tip = await storeOf(repo).tip();

    const error = await install(repo, "b.pack", "1.0.0", [requirement("b.pack", "git", ">=2.45")]).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ConflictingRequirementError);
    expect((error as Error).message).toContain("b.pack and a.pack declare it with different version predicates");
    expect(await storeOf(repo).tip()).toBe(tip);
  });

  it("an install agreeing with an installed module's predicate is admitted", async () => {
    const repo = await trackedRepo();
    await install(repo, "a.pack", "1.0.0", [requirement("a.pack", "git", ">=2.40")]);
    const tip = await storeOf(repo).tip();

    await install(repo, "b.pack", "1.0.0", [requirement("b.pack", "git", ">=2.40")]);

    expect(await storeOf(repo).tip()).not.toBe(tip);
  });

  it("a re-pin changing its own module's predicate is admitted", async () => {
    const repo = await trackedRepo();
    await install(repo, "a.pack", "1.0.0", [requirement("a.pack", "git", ">=2.40")]);
    const tip = await storeOf(repo).tip();

    await install(repo, "a.pack", "1.1.0", [requirement("a.pack", "git", ">=2.45")]);

    expect(await storeOf(repo).tip()).not.toBe(tip);
  });
});

/** A requirement entry the point's schema refuses: its input is no object. */
function malformedRequirement(module: string): ContributionEntry {
  return { ...requirement(module, "tool", null), input: null };
}

describe("a requirement entry a module record carried into the fold without install", () => {
  it("authorises nothing and costs the registry that entry alone, whatever else the set declares", async () => {
    const repo = await trackedRepo();
    await writeModuleRecord(repo, "stray.pack", [malformedRequirement("stray.pack")]);
    await writeModuleRecord(repo, "sound.pack", [requirement("sound.pack", "git", null)]);
    const index = await foldedIndex(storeOf(repo));

    const registry = readRequirementDeclarations(index, []);

    expect([...registry.byBinary.keys()]).toEqual(["git"]);
    expect(registry.conflicts.size).toBe(0);
  });

  it("does not stand in the way of installing another module", async () => {
    const repo = await trackedRepo();
    await writeModuleRecord(repo, "stray.pack", [malformedRequirement("stray.pack")]);
    const tip = await storeOf(repo).tip();

    await install(repo, "b.pack", "1.0.0", [requirement("b.pack", "git", null)]);

    expect(await storeOf(repo).tip()).not.toBe(tip);
  });

  it("is replaced by a re-pin of its own module, which is admitted", async () => {
    const repo = await trackedRepo();
    await writeModuleRecord(repo, "stray.pack", [malformedRequirement("stray.pack")]);
    const tip = await storeOf(repo).tip();

    await install(repo, "stray.pack", "1.1.0", [requirement("stray.pack", "git", null)]);

    expect(await storeOf(repo).tip()).not.toBe(tip);
  });
});

describe("the registry the installed module set declares", () => {
  it("the registry holds a binary two installed modules declare under one predicate once, and raises nothing", async () => {
    const repo = await trackedRepo();
    await install(repo, "a.pack", "1.0.0", [requirement("a.pack", "git", ">=2.40")]);
    await install(repo, "b.pack", "1.0.0", [requirement("b.pack", "git", ">=2.40")]);

    const registry = readRequirementDeclarations(await foldedIndex(storeOf(repo)), []);

    expect([...registry.byBinary.keys()]).toEqual(["git"]);
    expect(registry.byBinary.get("git")?.versionPredicate).toBe(">=2.40");
    expect(registry.conflicts.size).toBe(0);
  });

  it("a requirement only a re-pinned module record declared authorises nothing, and the record its name resolves to authorises its own", async () => {
    const repo = await trackedRepo();
    await install(repo, "a.pack", "1.0.0", [requirement("a.pack", "git", ">=2.40")]);
    await install(repo, "a.pack", "1.1.0", [requirement("a.pack", "node", ">=24")]);

    const registry = readRequirementDeclarations(await foldedIndex(storeOf(repo)), []);

    expect(registry.byBinary.has("git")).toBe(false);
    expect(registry.byBinary.get("node")?.declaredBy).toBe("a.pack");
  });

  it("a fold holding no installed module answers a registry authorising nothing", async () => {
    const repo = await trackedRepo();

    const registry = readRequirementDeclarations(await foldedIndex(storeOf(repo)), []);

    expect(registry.byBinary.size).toBe(0);
    expect(registry.conflicts.size).toBe(0);
  });

  it("a fold holding two disagreeing declarations written before the install check refuses only the run naming that binary, naming both modules, while another run in the same call is performed", async () => {
    const repo = await trackedRepo();
    await writeModuleRecord(repo, "first.pack", [requirement("first.pack", "true", null)]);
    await writeModuleRecord(repo, "second.pack", [requirement("second.pack", "true", ">=1")]);
    await writeModuleRecord(repo, "third.pack", [requirement("third.pack", "node", null)]);
    const index = await foldedIndex(storeOf(repo));

    const registry = readRequirementDeclarations(index, []);
    const conflicted = runNeed(["true"]);
    const declared = runNeed(["node", "-e", "process.exit(0)"]);
    const outcomes = await satisfyNeeds({
      needs: [conflicted, declared],
      index,
      store: storeOf(repo),
      evaluationOutcomes: new Map(),
      ageLimitMs: Number.POSITIVE_INFINITY,
      requirementRegistry: registry,
      now: repo.now,
    });

    const refused = outcomes.get(needId(conflicted));
    expect(refused).toMatchObject({ kind: "refused", reason: "declaration-conflict" });
    if (refused?.kind === "refused") {
      expect(refused.error.message).toContain(
        "first.pack and second.pack declare it with different version predicates",
      );
    }
    expect(outcomes.get(needId(declared))?.kind).toBe("satisfied");
  });
});
