import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OperationContext, openWorkspace, runHandler } from "@musai/api-core";
import { ENVELOPE_PROTOCOL } from "@musai/modules";
import { CURRENT_SCHEMA_VERSIONS, type ModuleRecord, type RecordId, recordPath, versionString } from "@musai/records";
import { gitCatFile, initWorkspace, MUSAI_DIR, Store, scopeRefName } from "@musai/store";
import { commitAroundTheStore, fixedClock } from "@musai/test-support";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { storeRelayout } from "../src/ops/store.js";

const now = fixedClock("2026-10-03T00:00:00.000Z");

const MODULE: ModuleRecord = {
  kind: "module",
  supersedes: [],
  schemaVersion: CURRENT_SCHEMA_VERSIONS.module,
  name: "relayout-fixture",
  version: versionString("1"),
  manifest: {
    protocolVersion: ENVELOPE_PROTOCOL,
    contributions: [],
    sourceTree: { digest: { gitTree: "a".repeat(40) } },
    toolchain: [],
    packages: [],
  },
  bundle: null,
  build: null,
};

describe("store relayout: a scope's one-level history rewritten two levels deep", () => {
  let workspace: string;
  let context: OperationContext;
  let id: RecordId;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-store-relayout-"));
    await initWorkspace(workspace, { now });
    const ctx = { gitDir: join(workspace, MUSAI_DIR) };
    [id] = await new Store({ ctx, scope: "minted", now }).putMany([{ kind: "module", value: MODULE }]);
    const bytes = await gitCatFile(ctx, `${scopeRefName("minted")}:${recordPath("module", id!)}`);
    const hex = id!.slice("sha256:".length);
    await commitAroundTheStore(
      { ctx, scope: "default", now },
      `records/module/${hex.slice(0, 2)}/${hex}.json`,
      new Uint8Array(bytes),
    );
    context = { workspace, scope: "default", now, principalName: "operator", reportRefusal: () => undefined };
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("a workspace folded before the rewrite opens after it holding every record, refusing none", async () => {
    await openWorkspace({ workspace, scope: "default", reportRefusal: () => undefined, now });

    const output = await runHandler(storeRelayout, {}, context);

    expect(output).toEqual({ commits: 1, records: 1 });
    const refusals: unknown[] = [];
    const opened = await openWorkspace({
      workspace,
      scope: "default",
      reportRefusal: (refusal) => {
        refusals.push(refusal);
      },
      now,
    });
    expect(refusals).toEqual([]);
    expect(opened.read(id)).toEqual(MODULE);
  });

  test("a planned rewrite counts what it would move and moves nothing", async () => {
    const ref = scopeRefName("default");
    const { stdout: before } = await execa("git", ["--git-dir", join(workspace, MUSAI_DIR), "rev-parse", ref]);

    const output = await runHandler(storeRelayout, {}, { ...context, mode: "plan" });

    expect(output).toEqual({ commits: 1, records: 1 });
    const { stdout: after } = await execa("git", ["--git-dir", join(workspace, MUSAI_DIR), "rev-parse", ref]);
    expect(after).toBe(before);
  });
});
