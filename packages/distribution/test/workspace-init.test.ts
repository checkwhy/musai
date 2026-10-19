import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installedModules, openWorkspace, releaseStanding, runHandler } from "@musai/api-core";
import type { ModuleArtefacts } from "@musai/devkit";
import { IndexDb } from "@musai/fold";
import { type Audience, type ModuleRecord, type PerformedRunRecord, timestamp, versionString } from "@musai/records";
import { initWorkspace, readTrustBranch, Store } from "@musai/store";
import { blobStoreOf, fixedClock, generateTestKey } from "@musai/test-support";
import { mintAttestation, signAttestation } from "@musai/trust";
import { afterEach, beforeAll, beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";
import { installDistributionModule, readDistributionArtefacts } from "../src/distribution.js";
import { workspaceInit } from "../src/ops/workspace.js";

const opensshAvailable = spawnSync("ssh-keygen", ["-Y", "check-novalidate"], { stdio: "ignore" }).error === undefined;

const OPERATOR = "operator@example.test";

describe("workspace.init@1", () => {
  let workspace: string;
  let artefacts: ModuleArtefacts;
  const scope = "default";
  const now = fixedClock("2026-01-01T00:00:00.000Z");

  beforeAll(async () => {
    artefacts = await readDistributionArtefacts();
  });

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-workspace-init-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(workspace, { recursive: true, force: true });
  });

  test("a workspace it creates has musai.core among its installed modules, the bundle readable through the workspace's blob store", async () => {
    await runHandler(workspaceInit, { workspace }, { workspace, scope, now });

    const opened = await openWorkspace({ workspace, scope, now });
    const entry = (await installedModules(opened)).byName.get("musai.core");
    expect(entry).toBeDefined();

    const record = opened.read(entry!.moduleRecordId) as ModuleRecord;
    expect(record.bundle).not.toBeNull();
    expect(await opened.blobs.read(record.bundle!)).toEqual(artefacts.bundleBytes);
  });

  test("closes every index it folds while creating a workspace", async () => {
    const folded = vi.spyOn(IndexDb.prototype, "fold");
    const closed = vi.spyOn(IndexDb.prototype, "close");

    await runHandler(workspaceInit, { workspace }, { workspace, scope, now });

    const released = new Set<unknown>(closed.mock.contexts);
    expect(folded.mock.contexts.length).toBeGreaterThan(0);
    expect(folded.mock.contexts.filter((index) => !released.has(index))).toEqual([]);
  });

  test("the build receipt of the core module it installs carries observation timestamps pinned to the epoch", async () => {
    await runHandler(workspaceInit, { workspace }, { workspace, scope, now });

    const opened = await openWorkspace({ workspace, scope, now });
    const entry = (await installedModules(opened)).byName.get("musai.core");
    const record = opened.read(entry!.moduleRecordId) as ModuleRecord;
    const buildReceipt = opened.read(record.build!) as PerformedRunRecord;

    expect(buildReceipt.observation.startedAt).toBe("1970-01-01T00:00:00.000Z");
    expect(buildReceipt.observation.finishedAt).toBe("1970-01-01T00:00:00.000Z");
  });

  test("initialising an existing workspace that holds no core module installs it, and a second init commits nothing", async () => {
    const { gitDir } = await initWorkspace(workspace, { now });
    const store = new Store({ ctx: { gitDir }, scope, now });

    await runHandler(workspaceInit, { workspace }, { workspace, scope, now });

    const opened = await openWorkspace({ workspace, scope, now });
    const entry = (await installedModules(opened)).byName.get("musai.core");
    expect(entry).toBeDefined();
    expect(await opened.blobs.read((opened.read(entry!.moduleRecordId) as ModuleRecord).bundle!)).toEqual(
      artefacts.bundleBytes,
    );
    const tipAfterFirst = await store.tip();

    await runHandler(workspaceInit, { workspace }, { workspace, scope, now });

    expect(await store.tip()).toBe(tipAfterFirst);
  });

  test("initialising an existing workspace again leaves the core module record it resolves to unmoved, even where the distribution's own build holds another", async () => {
    const { gitDir } = await initWorkspace(workspace, { now });
    const store = new Store({ ctx: { gitDir }, scope, now });
    const index = new IndexDb(":memory:");
    await index.fold(store);
    const earlierBuild = { ...artefacts, version: versionString("0") };
    const { moduleRecordId } = await installDistributionModule(earlierBuild, store, blobStoreOf(workspace), index);
    const tipBefore = await store.tip();

    await runHandler(workspaceInit, { workspace }, { workspace, scope, now });

    const opened = await openWorkspace({ workspace, scope, now });
    expect((await installedModules(opened)).byName.get("musai.core")?.moduleRecordId).toBe(moduleRecordId);
    expect(await store.tip()).toBe(tipBefore);
  });
  test.skipIf(!opensshAvailable)(
    "init registers the operator's key under its own form, its name beside it, and grants the key owner",
    async () => {
      const key = await generateTestKey(OPERATOR);
      onTestFinished(() => rm(key.dir, { recursive: true, force: true }));

      const output = await runHandler(
        workspaceInit,
        { workspace, key: key.keyPath },
        { workspace, scope, now, principalName: OPERATOR },
      );

      const trust = await readTrustBranch({ gitDir: join(workspace, ".musai") });
      expect(trust.allowedSigners).toBe(`${OPERATOR},${key.principal} namespaces="musai" ${key.pubKeyLine}\n`);
      expect(trust.roles).toBe(`${key.principal} owner any\n`);
      expect(output.registered).toEqual({ principal: key.principal, name: OPERATOR, key: key.keyPath });
    },
  );

  test.skipIf(!opensshAvailable)(
    "init registers a key named by no one under its own form alone, and grants it owner",
    async () => {
      const key = await generateTestKey(OPERATOR);
      onTestFinished(() => rm(key.dir, { recursive: true, force: true }));

      const output = await runHandler(workspaceInit, { workspace, key: key.keyPath }, { workspace, scope, now });

      const trust = await readTrustBranch({ gitDir: join(workspace, ".musai") });
      expect(trust.allowedSigners).toBe(`${key.principal} namespaces="musai" ${key.pubKeyLine}\n`);
      expect(trust.roles).toBe(`${key.principal} owner any\n`);
      expect(output.registered).toEqual({ principal: key.principal, name: null, key: key.keyPath });
    },
  );

  test("init with no key says every role is anyone's and names both ways to attest", () => {
    const text = workspaceInit.renderText({ gitDir: "/w/.musai", registered: null });

    expect(text).toContain("every role is anyone's");
    expect(text).toContain("musai init --key <private key>");
    expect(text).toContain("MUSAI_PRINCIPAL");
  });

  test("init with no key leaves both trust files empty", async () => {
    const output = await runHandler(workspaceInit, { workspace }, { workspace, scope, now, principalName: OPERATOR });

    const trust = await readTrustBranch({ gitDir: join(workspace, ".musai") });
    expect(trust.allowedSigners).toBe("");
    expect(trust.roles).toBe("");
    expect(output.registered).toBeNull();
  });

  test.skipIf(!opensshAvailable)("a fresh workspace's signed release counts", async () => {
    const key = await generateTestKey(OPERATOR);
    onTestFinished(() => rm(key.dir, { recursive: true, force: true }));
    await runHandler(
      workspaceInit,
      { workspace, key: key.keyPath },
      { workspace, scope, now, principalName: OPERATOR },
    );
    const opened = await openWorkspace({ workspace, scope, now });
    const build = opened.read(
      (await installedModules(opened)).byName.get("musai.core")!.moduleRecordId,
    ) as ModuleRecord;
    const subject = build.build!;
    const release = mintAttestation({
      subject,
      principal: key.principal,
      principalClass: "person",
      via: "tty",
      purpose: "released",
      at: timestamp("2026-01-01T00:00:01.000Z"),
      release: {
        audience: "public" as Audience,
        extent: "record",
        terms: { form: "bytes", uses: ["review"], from: null, until: null, marking: null },
      },
    });
    const signature = await signAttestation({ attestation: release, keyPath: key.keyPath });
    await new Store({ ctx: { gitDir: join(workspace, ".musai") }, scope, now }).putMany([
      { kind: "attestation", value: release.record, signature },
    ]);

    const reopened = await openWorkspace({ workspace, scope, now });
    expect((await releaseStanding(reopened, subject)).standing.map((standing) => standing.id)).toEqual([release.id]);
  });

  test.skipIf(!opensshAvailable)("init refuses a principal the trust files cannot hold, creating nothing", async () => {
    const key = await generateTestKey(OPERATOR);
    onTestFinished(() => rm(key.dir, { recursive: true, force: true }));

    const refusal = await runHandler(
      workspaceInit,
      { workspace, key: key.keyPath },
      { workspace, scope, now, principalName: "Florin Utz" },
    ).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ reason: "invalid-input" });
    await expect(readdir(workspace)).resolves.toEqual([]);
  });

  test.skipIf(!opensshAvailable)("init refuses a name spelled as a key or a pseudonym, creating nothing", async () => {
    const key = await generateTestKey(OPERATOR);
    onTestFinished(() => rm(key.dir, { recursive: true, force: true }));

    for (const name of [key.principal, `pseudonym:k:${"0".repeat(64)}`]) {
      const refusal = await runHandler(
        workspaceInit,
        { workspace, key: key.keyPath },
        { workspace, scope, now, principalName: name },
      ).catch((error: unknown) => error);
      expect(refusal, name).toMatchObject({ reason: "invalid-input" });
    }
    await expect(readdir(workspace)).resolves.toEqual([]);
  });

  test.skipIf(!opensshAvailable)(
    "init refuses a key whose public half is no key, or whose private half is absent, creating nothing",
    async () => {
      const key = await generateTestKey(OPERATOR);
      onTestFinished(() => rm(key.dir, { recursive: true, force: true }));
      await writeFile(`${key.keyPath}.pub`, "garbage line\n");
      const absent = join(key.dir, "absent");
      await writeFile(`${absent}.pub`, `${key.pubKeyLine}\n`);

      for (const named of [key.keyPath, absent]) {
        const refusal = await runHandler(
          workspaceInit,
          { workspace, key: named },
          { workspace, scope, now, principalName: OPERATOR },
        ).catch((error: unknown) => error);
        expect(refusal, named).toMatchObject({ reason: "invalid-input" });
      }
      await expect(readdir(workspace)).resolves.toEqual([]);
    },
  );
});
