import { readFile, writeFile } from "node:fs/promises";
import { ENVELOPE_PROTOCOL } from "@musai/modules";
import {
  BlobCorruptedError,
  CURRENT_SCHEMA_VERSIONS,
  type ModuleRecord,
  type RecordId,
  recordId,
  versionString,
} from "@musai/records";
import { blobStoreOf, cachedBlobPath, installEmptyModule, rewriteBlob } from "@musai/test-support";
import { describe, expect, test } from "vitest";
import { buildAdmissionWorkspace } from "../src/admission.js";
import { installedModules } from "../src/events.js";
import { openWorkspace } from "../src/open-workspace.js";
import { FIXTURE_CLOCK, type FixtureWorkspace, fixtureWorkspace, refusalOf } from "./fixture-distribution.js";

const MODULE_NAME = "fixture-bundled";
const UNBUNDLED_MODULE_NAME = "fixture-unbundled";
const BUNDLE_SOURCE = "export function invoke() { return new Uint8Array(); }\n";

/** Written through the store rather than built, so none of an install's checks run. */
async function installBundledModule(workspace: FixtureWorkspace): Promise<RecordId> {
  const bundle = await blobStoreOf(workspace.dir).put(new TextEncoder().encode(BUNDLE_SOURCE));
  const moduleRecord: ModuleRecord = {
    kind: "module",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.module,
    name: MODULE_NAME,
    version: versionString("1"),
    manifest: {
      protocolVersion: ENVELOPE_PROTOCOL,
      contributions: [],
      sourceTree: { digest: { gitTree: "a".repeat(40) } },
      toolchain: [],
      packages: [],
    },
    bundle,
    build: recordId({ marker: "the build record a fixture module names, never read here" }),
  };
  await workspace.store().putMany([{ kind: "module", value: moduleRecord }]);
  return bundle;
}

async function admission(workspace: FixtureWorkspace): Promise<Awaited<ReturnType<typeof buildAdmissionWorkspace>>> {
  const opened = await openWorkspace({ workspace: workspace.dir, scope: workspace.scope, now: FIXTURE_CLOCK });
  return buildAdmissionWorkspace(opened, await installedModules(opened));
}

describe("buildAdmissionWorkspace, the admission a module is loaded through", () => {
  test("hands no invocation limits over a fold where no installed module declares the slot", async () => {
    const workspace = await fixtureWorkspace();
    await installBundledModule(workspace);

    expect((await admission(workspace)).invocationLimits).toBeUndefined();
  });

  test("hands out the path of an installed module's bundle, materialised from the store", async () => {
    const workspace = await fixtureWorkspace();
    const bundle = await installBundledModule(workspace);

    const path = (await admission(workspace)).modulePath(MODULE_NAME);

    expect(path).toBe(cachedBlobPath(workspace.dir, bundle));
    expect(await readFile(path, "utf8")).toBe(BUNDLE_SOURCE);
  });

  test("rewrites a materialised bundle whose bytes were swapped before handing its path out", async () => {
    const workspace = await fixtureWorkspace();
    const bundle = await installBundledModule(workspace);
    await admission(workspace);
    await writeFile(cachedBlobPath(workspace.dir, bundle), BUNDLE_SOURCE.replace("invoke", "swapped"));

    const path = (await admission(workspace)).modulePath(MODULE_NAME);

    expect(await readFile(path, "utf8")).toBe(BUNDLE_SOURCE);
  });

  test("refuses a bundle whose bytes in the store no longer digest to its id, record-corrupted", async () => {
    const workspace = await fixtureWorkspace();
    const bundle = await installBundledModule(workspace);
    const opened = await openWorkspace({ workspace: workspace.dir, scope: workspace.scope, now: FIXTURE_CLOCK });
    const installed = await installedModules(opened);
    await rewriteBlob(workspace.dir, bundle, new TextEncoder().encode(BUNDLE_SOURCE.replace("invoke", "swapped")));

    const refusal = await refusalOf(() => buildAdmissionWorkspace(opened, installed));

    expect(refusal).toBeInstanceOf(BlobCorruptedError);
    expect(refusal).toMatchObject({ reason: "record-corrupted", code: "workspace", expectedId: bundle });
  });

  test("refuses a module path for a module installed with no bundle, workspace-incomplete, naming the module", async () => {
    const workspace = await fixtureWorkspace();
    await installEmptyModule(workspace.dir, workspace.scope, UNBUNDLED_MODULE_NAME, FIXTURE_CLOCK);
    const admitted = await admission(workspace);

    const refusal = await refusalOf(() => admitted.modulePath(UNBUNDLED_MODULE_NAME));

    expect(refusal).toMatchObject({
      reason: "workspace-incomplete",
      code: "workspace",
      about: [UNBUNDLED_MODULE_NAME],
    });
    expect(refusal.message).toBe(`${UNBUNDLED_MODULE_NAME} is installed with no bundle to load; install its build`);
  });
});
