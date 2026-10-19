import { IndexDb } from "@musai/fold";
import type { ContributionEntry, ModuleManifest } from "@musai/records";
import { recordId, versionString } from "@musai/records";
import { Store } from "@musai/store";
import { blobStoreOf, type FixtureRepo, makeFixtureRepo, manifestWithContributions } from "@musai/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { ContributionIdHeldError, installModule } from "../src/module/install.js";

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

function entry(kind: string, id: string, version = "1"): ContributionEntry {
  return { kind, id, version: versionString(version), input: true, output: true, documentation: `the ${kind} ${id}` };
}

async function foldedIndex(repo: FixtureRepo): Promise<IndexDb> {
  const index = new IndexDb(":memory:");
  await index.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
  return index;
}

async function install(repo: FixtureRepo, name: string, manifest: ModuleManifest, version = "1.0.0") {
  return installModule(
    name,
    versionString(version),
    manifest,
    new TextEncoder().encode(`bundle for ${name} at ${version}`),
    recordId({ marker: `build-for-${name}-${version}` }),
    new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }),
    blobStoreOf(repo.workspace),
    await foldedIndex(repo),
  );
}

describe("a contribution id declared by a module installed under another name", () => {
  it("is refused at install when the installing module's name nests inside the holder's, naming both, and the id keeps resolving to the holder", async () => {
    const repo = await trackedRepo();
    await install(repo, "a", manifestWithContributions([entry("rule", "a/b/x")]));

    const refusal = await install(repo, "a/b", manifestWithContributions([entry("rule", "a/b/x")])).catch(
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(ContributionIdHeldError);
    expect((refusal as ContributionIdHeldError).about).toEqual(["a/b", "a/b/x", "a"]);
    expect((await foldedIndex(repo)).contributionById("a/b/x")?.moduleName).toBe("a");
  });

  it("is refused at install when the holder's name nests inside the installing module's", async () => {
    const repo = await trackedRepo();
    await install(repo, "a/b", manifestWithContributions([entry("template", "a/b/x")]));

    const refusal = await install(repo, "a", manifestWithContributions([entry("template", "a/b/x")])).catch(
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(ContributionIdHeldError);
    expect((refusal as ContributionIdHeldError).about).toEqual(["a", "a/b/x", "a/b"]);
  });

  it("is refused at install whatever the kinds the two declarations answer at", async () => {
    const repo = await trackedRepo();
    await install(repo, "a", manifestWithContributions([entry("rule", "a/b/x")]));

    const installing = install(repo, "a/b", manifestWithContributions([entry("subscription", "a/b/x")]));

    await expect(installing).rejects.toBeInstanceOf(ContributionIdHeldError);
  });

  it("installs where two nesting names declare different ids", async () => {
    const repo = await trackedRepo();
    await install(repo, "a", manifestWithContributions([entry("rule", "a/b/x")]));

    await install(repo, "a/b", manifestWithContributions([entry("rule", "a/b/y")]));

    const index = await foldedIndex(repo);
    expect(index.contributionById("a/b/x")?.moduleName).toBe("a");
    expect(index.contributionById("a/b/y")?.moduleName).toBe("a/b");
  });

  it("installs a re-pin of the name that already declares it", async () => {
    const repo = await trackedRepo();
    await install(repo, "a", manifestWithContributions([entry("rule", "a/b/x")]));

    await install(repo, "a", manifestWithContributions([entry("rule", "a/b/x", "2")]), "2.0.0");

    expect((await foldedIndex(repo)).contributionById("a/b/x")?.entry.version).toBe("2");
  });
});

describe("a contribution id looked up after a module is re-pinned", () => {
  it("is answered by nothing once the record the name resolves to no longer declares it", async () => {
    const repo = await trackedRepo();
    await install(repo, "a", manifestWithContributions([entry("rule", "a/x"), entry("rule", "a/y")]));

    await install(repo, "a", manifestWithContributions([entry("rule", "a/x")]), "2.0.0");

    const index = await foldedIndex(repo);
    expect(index.contributionById("a/y")).toBeUndefined();
    expect(index.contributionById("a/x")?.moduleVersion).toBe("2.0.0");
  });
});
