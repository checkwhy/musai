import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runHandler } from "@musai/api-core";
import { IndexDb } from "@musai/fold";
import { CURRENT_SCHEMA_VERSIONS, versionString } from "@musai/records";
import { MUSAI_DIR, Store } from "@musai/store";
import { fixedClock, manifestWithContributions } from "@musai/test-support";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { moduleBuild } from "../src/ops/module.js";
import { workspaceInit } from "../src/ops/workspace.js";
import { repoGitDir } from "./repo-git-dir.js";

const SKILLFUL_FIXTURE_DIR = fileURLToPath(new URL("./fixtures/skillful", import.meta.url));

describe("module.build@1", () => {
  let workspace: string;
  const scope = "default";
  const now = fixedClock("2026-10-12T00:00:00.000Z");

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-module-build-handles-"));
    await runHandler(workspaceInit, { workspace }, { workspace, scope, now });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(workspace, { recursive: true, force: true });
  });

  async function build(): Promise<{ readonly settled: "built" | "refused"; readonly leftOpen: unknown[] }> {
    const folded = vi.spyOn(IndexDb.prototype, "fold");
    const closed = vi.spyOn(IndexDb.prototype, "close");
    const settled = await runHandler(
      moduleBuild,
      { dir: SKILLFUL_FIXTURE_DIR, sourceGitDir: await repoGitDir() },
      { workspace, scope, now },
    ).then(
      () => "built" as const,
      () => "refused" as const,
    );
    const opened = new Set<unknown>(folded.mock.contexts);
    const released = new Set<unknown>(closed.mock.contexts);
    return { settled, leftOpen: [...opened].filter((index) => !released.has(index)) };
  }

  test("closes every index it opens when the skills sync that follows the build succeeds", async () => {
    expect(await build()).toEqual({ settled: "built", leftOpen: [] });
  }, 120_000);

  test("closes every index it opens when the skills sync that follows the build is refused", async () => {
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
    expect(await build()).toEqual({ settled: "refused", leftOpen: [] });
  }, 120_000);
});
