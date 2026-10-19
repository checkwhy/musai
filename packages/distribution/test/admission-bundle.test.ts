import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Workspace } from "@musai/api-core";
import { buildAdmissionWorkspace, installedModules, invokeContribution, openWorkspace } from "@musai/api-core";
import { buildModule } from "@musai/devkit";
import { IndexDb } from "@musai/fold";
import { ENVELOPE_PROTOCOL, INVOCATION_LIMITS_SLOT_ID } from "@musai/modules";
import {
  BlobCorruptedError,
  type CaseRecord,
  type ContributionEntry,
  CURRENT_SCHEMA_VERSIONS,
  type ModuleRecord,
  recordId,
  versionString,
} from "@musai/records";
import { initWorkspace, SLOTS_CONFIG_KEY, Store } from "@musai/store";
import { blobStoreOf, cachedBlobPath, fixedClock, rewriteBlob, writeTrustFile } from "@musai/test-support";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { installDistributionModule, readDistributionArtefacts } from "../src/distribution.js";
import { resolveDraftTemplate } from "../src/view/render.js";
import { repoGitDir } from "./repo-git-dir.js";

const SKILLFUL_FIXTURE_DIR = fileURLToPath(new URL("./fixtures/skillful", import.meta.url));
const MODULE_NAME = "skillful";
const RENDERED = "skillful's own conversational entry, rendered for real.";
const SWAPPED = "skillful's own conversational entry, rendered by a bundle swapped under its record.";
const now = fixedClock("2026-08-31T00:00:00.000Z");

describe("a contribution invocation admits a module's bundle only by the id its module record names", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-admission-bundle-"));
    await initWorkspace(workspace, { now });
    const store = new Store({ ctx: { gitDir: join(workspace, ".musai") }, scope: "default", now });
    const index = new IndexDb(":memory:");
    await index.fold(store);
    await buildModule(SKILLFUL_FIXTURE_DIR, store, {
      blobs: blobStoreOf(workspace),
      index,
      sourceGitDir: await repoGitDir(),
      now,
    });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  async function installedSkillful(opened: Workspace): Promise<{ record: ModuleRecord; entry: ContributionEntry }> {
    const installed = await installedModules(opened);
    const record = opened.read(installed.byName.get(MODULE_NAME)!.moduleRecordId) as ModuleRecord;
    const entry = record.manifest.contributions.find((contribution) => contribution.kind === "template")!;
    return { record, entry };
  }

  test("loads the bundle its module record names when the materialised copy was swapped", async () => {
    const opened = await openWorkspace({ workspace, scope: "default", now });
    const { record, entry } = await installedSkillful(opened);

    const answered = await invokeContribution(opened, MODULE_NAME, entry, {});
    expect(answered).toMatchObject({ ok: true, output: { content: RENDERED } });

    const bundleFile = cachedBlobPath(workspace, record.bundle!);
    const original = await readFile(bundleFile, "utf8");
    expect(original).toContain(RENDERED);
    await writeFile(bundleFile, original.replace(RENDERED, SWAPPED));

    const again = await invokeContribution(opened, MODULE_NAME, entry, {});
    expect(again).toMatchObject({ ok: true, output: { content: RENDERED } });
  });

  test("refuses by name a bundle whose bytes were swapped in the store under its module record", async () => {
    const opened = await openWorkspace({ workspace, scope: "default", now });
    const { record, entry } = await installedSkillful(opened);
    const original = await readFile(await opened.blobs.materialise(record.bundle!), "utf8");
    await rewriteBlob(workspace, record.bundle!, new TextEncoder().encode(original.replace(RENDERED, SWAPPED)));

    const refusal = await invokeContribution(opened, MODULE_NAME, entry, {}).then(
      (response) => response,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(BlobCorruptedError);
    expect(refusal).toMatchObject({ reason: "record-corrupted", expectedId: record.bundle });
  });
});

describe("the invocation limits an admission workspace hands the parsers it admits through", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-admission-limits-"));
    await initWorkspace(workspace, { now });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  async function admissionOf(): Promise<Awaited<ReturnType<typeof buildAdmissionWorkspace>>> {
    const opened = await openWorkspace({ workspace, scope: "default", now });
    return buildAdmissionWorkspace(opened, await installedModules(opened));
  }

  test("a fold declaring no invocation-limits slot hands none, so a host bounds a parser by its own fallback", async () => {
    expect((await admissionOf()).invocationLimits).toBeUndefined();
  });

  test("a fold holding the core module hands the limits the project layer assigns", async () => {
    const store = new Store({ ctx: { gitDir: join(workspace, ".musai") }, scope: "default", now });
    const index = new IndexDb(":memory:");
    await index.fold(store);
    await installDistributionModule(await readDistributionArtefacts(), store, blobStoreOf(workspace), index);
    expect((await admissionOf()).invocationLimits).toEqual({ timeLimitMs: 2000, memoryLimitMb: 64 });

    await writeTrustFile(
      { gitDir: join(workspace, ".musai") },
      "config.json",
      JSON.stringify({ [SLOTS_CONFIG_KEY]: { [INVOCATION_LIMITS_SLOT_ID]: { timeLimitMs: 300, memoryLimitMb: 16 } } }),
    );

    expect((await admissionOf()).invocationLimits).toEqual({ timeLimitMs: 300, memoryLimitMb: 16 });
  });
});

const ALLOCATING_MODULE = "allocating-template";
const ALLOCATING_PRESET = `${ALLOCATING_MODULE}/kind`;
const ALLOCATING_TEMPLATE_ID = `${ALLOCATING_PRESET}/draft`;
const ALLOCATED_CONTENT = "a starter draft rendered after keeping tens of megabytes alive";

/** A draft template holding tens of megabytes: inside the memory default, past a ceiling of 8. */
function allocatingTemplateSource(): string {
  return [
    "export function invoke(requestBytes) {",
    "  return (async () => {",
    "    JSON.parse(new TextDecoder().decode(requestBytes));",
    "    const retained = [];",
    "    for (let index = 0; index < 3; index++) {",
    "      retained.push(new Array(1e6).fill('x'));",
    "    }",
    `    const output = { format: 'markdown', content: ${JSON.stringify(ALLOCATED_CONTENT)} + ' ' + retained.length };`,
    "    return new TextEncoder().encode(JSON.stringify({ ok: true, output, diagnostics: [] }));",
    "  })();",
    "}",
  ].join("\n");
}

const ALLOCATING_ENTRY: ContributionEntry = {
  kind: "template",
  id: ALLOCATING_TEMPLATE_ID,
  version: versionString("1"),
  input: true,
  output: true,
  documentation: "keeps tens of megabytes alive, then renders a case's starter draft",
};

describe("a contributed call and a case's draft template run under the invocation limits the project layer assigns", () => {
  let workspace: string;
  const caseRecord: CaseRecord = {
    kind: "case",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.case,
    type: null,
    slug: "allocating-draft",
    claims: [],
    preset: {
      module: ALLOCATING_MODULE,
      contribution: ALLOCATING_PRESET,
      moduleRecord: recordId({ marker: "the module record a preset names, never read here" }),
    },
    projectCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    overrides: {},
    evaluatorVersion: versionString("1"),
  };
  const caseId = recordId({ marker: "a case the draft template renders for, never stored" });

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-contribution-limits-"));
    await initWorkspace(workspace, { now });
    const store = new Store({ ctx: { gitDir: join(workspace, ".musai") }, scope: "default", now });
    const index = new IndexDb(":memory:");
    await index.fold(store);
    await installDistributionModule(await readDistributionArtefacts(), store, blobStoreOf(workspace), index);
    const bundle = await blobStoreOf(workspace).put(new TextEncoder().encode(allocatingTemplateSource()));
    const moduleRecord: ModuleRecord = {
      kind: "module",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.module,
      name: ALLOCATING_MODULE,
      version: versionString("1"),
      manifest: {
        protocolVersion: ENVELOPE_PROTOCOL,
        contributions: [ALLOCATING_ENTRY],
        sourceTree: { digest: { gitTree: "a".repeat(40) } },
        toolchain: [{ name: "node", version: versionString("24.0.0") }],
        packages: [],
      },
      bundle,
      build: recordId({ marker: "allocating-template-build" }),
    };
    await store.putMany([{ kind: "module", value: moduleRecord }]);
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  async function lowerMemoryCeiling(): Promise<void> {
    await writeTrustFile(
      { gitDir: join(workspace, ".musai") },
      "config.json",
      JSON.stringify({ [SLOTS_CONFIG_KEY]: { [INVOCATION_LIMITS_SLOT_ID]: { timeLimitMs: 2000, memoryLimitMb: 8 } } }),
    );
  }

  test("a contributed call answers under the slot's default and is refused at the memory limit under a lowered project ceiling", async () => {
    const unbounded = await invokeContribution(
      await openWorkspace({ workspace, scope: "default", now }),
      ALLOCATING_MODULE,
      ALLOCATING_ENTRY,
      { case: caseId, slug: caseRecord.slug },
    );
    expect(unbounded).toMatchObject({ ok: true, output: { format: "markdown" } });

    await lowerMemoryCeiling();
    const bounded = await invokeContribution(
      await openWorkspace({ workspace, scope: "default", now }),
      ALLOCATING_MODULE,
      ALLOCATING_ENTRY,
      { case: caseId, slug: caseRecord.slug },
    );
    expect(bounded).toMatchObject({ ok: false, error: { code: "memory-limit" } });
  }, 60_000);

  test("a case's draft template renders under the slot's default and renders no starter under a lowered project ceiling", async () => {
    const unbounded = await resolveDraftTemplate(
      await openWorkspace({ workspace, scope: "default", now }),
      caseId,
      caseRecord,
    );
    expect(unbounded?.content).toContain(ALLOCATED_CONTENT);

    await lowerMemoryCeiling();
    const bounded = await resolveDraftTemplate(
      await openWorkspace({ workspace, scope: "default", now }),
      caseId,
      caseRecord,
    );
    expect(bounded).toBeNull();
  }, 60_000);
});
