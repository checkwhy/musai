import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installedModules, openWorkspace, runHandler } from "@musai/api-core";
import { CURRENT_SCHEMA_VERSIONS, KernelError, versionString } from "@musai/records";
import { MUSAI_DIR, Store } from "@musai/store";
import { fixedClock, manifestWithContributions } from "@musai/test-support";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { moduleBuild } from "../src/ops/module.js";
import { workspaceInit } from "../src/ops/workspace.js";
import { repoGitDir } from "./repo-git-dir.js";

const SKILLFUL_FIXTURE_DIR = fileURLToPath(new URL("./fixtures/skillful", import.meta.url));

describe("module.build@1 over a fold whose slot set the registry refuses", () => {
  let workspace: string;
  const scope = "default";
  const now = fixedClock("2026-10-12T00:00:00.000Z");

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-module-build-skills-"));
    await runHandler(workspaceInit, { workspace }, { workspace, scope, now });
    const store = new Store({ ctx: { gitDir: join(workspace, MUSAI_DIR) }, scope, now });
    await store.put("module", {
      kind: "module",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.module,
      name: "arrived",
      version: versionString("1.0.0"),
      manifest: manifestWithContributions([
        {
          kind: "slot",
          id: "arrived/slot",
          version: versionString("1"),
          input: true,
          output: true,
          documentation: "a slot declared without its layers, which the registry refuses",
        },
      ]),
      bundle: null,
      build: null,
    });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("names the module record it landed when the skills sync that follows is refused", async () => {
    const outcome = await runHandler(
      moduleBuild,
      { dir: SKILLFUL_FIXTURE_DIR, sourceGitDir: await repoGitDir() },
      { workspace, scope, now },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    const landed = (await installedModules(await openWorkspace({ workspace, scope, now }))).byName.get("skillful");
    expect(landed).toBeDefined();
    expect(outcome).toBeInstanceOf(KernelError);
    const detail = (outcome as KernelError).detail;
    expect(detail).toContain(landed!.moduleRecordId);
    expect(detail).toContain("skills");
  }, 120_000);
});
