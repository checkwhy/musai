import { IndexDb } from "@musai/fold";
import type { ContributionEntry, ModuleManifest } from "@musai/records";
import { KernelError, rawId, recordId, versionString } from "@musai/records";
import { Store } from "@musai/store";
import { blobStoreOf, type FixtureRepo, makeFixtureRepo, manifestWithContributions } from "@musai/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { installModule } from "../src/module/install.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

function requirement(input: unknown): ContributionEntry {
  return {
    kind: "requirement",
    id: "m/tool",
    version: versionString("1"),
    input,
    output: true,
    documentation: "a binary the module needs",
  };
}

const BUNDLE = new TextEncoder().encode("bundle");

/** The refusal an install of `manifest` earns, after checking it wrote no record and no blob. */
async function installRefused(manifest: unknown): Promise<unknown> {
  const repo: FixtureRepo = await makeFixtureRepo();
  cleanups.push(repo.cleanup);
  const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
  const blobs = blobStoreOf(repo.workspace);
  const index = new IndexDb(":memory:");
  await index.fold(store);
  const tipBefore = await store.tip();
  const refusal = await installModule(
    "m",
    versionString("1.0.0"),
    manifest as ModuleManifest,
    BUNDLE,
    recordId({ marker: "build" }),
    store,
    blobs,
    index,
  ).catch((error: unknown) => error);
  expect(await store.tip()).toBe(tipBefore);
  await expect(blobs.read(rawId(BUNDLE))).rejects.toThrow();
  return refusal;
}

function refusedAsInvalidInput(refusal: unknown): void {
  expect(refusal).toBeInstanceOf(KernelError);
  expect((refusal as KernelError).reason).toBe("invalid-input");
}

describe("installing a manifest that is not well formed", () => {
  it("refuses a requirement whose input is no object under invalid-input", async () => {
    refusedAsInvalidInput(await installRefused(manifestWithContributions([requirement(null)])));
  });

  it("refuses a requirement whose binary is not a string under invalid-input", async () => {
    const input = { binary: 7, versionPredicate: null, neededBy: "m/rule", install: "apt install tool" };

    refusedAsInvalidInput(await installRefused(manifestWithContributions([requirement(input)])));
  });

  it("refuses a contribution that is no object under invalid-input", async () => {
    const manifest = { ...manifestWithContributions([]), contributions: [null] };

    refusedAsInvalidInput(await installRefused(manifest));
  });

  it("refuses contributions that are no list under invalid-input", async () => {
    const manifest = { ...manifestWithContributions([]), contributions: undefined };

    refusedAsInvalidInput(await installRefused(manifest));
  });
});
