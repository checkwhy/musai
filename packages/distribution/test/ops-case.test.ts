import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { HeadMovedError, openWorkspace, runHandler } from "@musai/api-core";
import type { ModuleArtefacts } from "@musai/devkit";
import { IndexDb } from "@musai/fold";
import { initWorkspace, Store } from "@musai/store";
import { blobStoreOf, fixedClock } from "@musai/test-support";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { installDistributionModule, readDistributionArtefacts } from "../src/distribution.js";
import { caseBook } from "../src/ops/case.js";

const now = fixedClock("2026-01-01T00:00:00.000Z");

describe("case.book@1", () => {
  let workspace: string;
  let artefacts: ModuleArtefacts;
  const scope = "default";

  beforeAll(async () => {
    artefacts = await readDistributionArtefacts();
  });

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-ops-case-"));
    await initWorkspace(workspace, { now });
    const store = storeAt();
    const index = new IndexDb(":memory:");
    await index.fold(store);
    await installDistributionModule(artefacts, store, blobStoreOf(workspace), index);
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  function storeAt(): Store {
    return new Store({ ctx: { gitDir: join(workspace, ".musai") }, scope, now });
  }

  test("mints a case record and returns it with its id and body, needing no second store read", async () => {
    const output = await runHandler(caseBook, { slug: "first-case" }, { workspace, scope, now });
    expect(output.minted).toHaveLength(1);
    expect(output.minted[0]!.id).toBe(output.case);
    expect(output.minted[0]!.record).toMatchObject({ kind: "case", slug: "first-case" });
  });

  test("the minted case carries the evaluator-version pin, the project commit, the preset reference and the overrides", async () => {
    const output = await runHandler(
      caseBook,
      { slug: "pinned-case", overrides: { budget: 1000 } },
      { workspace, scope, now },
    );
    const record = output.minted.find((item) => item.id === output.case)!.record as {
      evaluatorVersion: string;
      projectCommit: string;
      preset: { module: string; contribution: string; moduleRecord: string };
      overrides: Record<string, unknown>;
    };
    expect(record.evaluatorVersion).toBeTruthy();
    expect(record.projectCommit).toBeTruthy();
    expect(record.preset.module).toBe("musai.core");
    expect(record.overrides).toEqual({ budget: 1000 });
  });

  test("--about mints one base triple claim per URI, cited by the case, and every minted record comes back", async () => {
    const output = await runHandler(
      caseBook,
      { slug: "about-case", about: ["urn:a", "urn:b"] },
      { workspace, scope, now },
    );
    expect(output.minted).toHaveLength(3);
    const caseRecord = output.minted.find((item) => item.id === output.case)!.record as { claims: string[] };
    expect(caseRecord.claims).toHaveLength(2);
    const claimIds = new Set(output.minted.filter((item) => item.kind === "claim").map((item) => item.id));
    expect(claimIds).toEqual(new Set(caseRecord.claims));
  });

  test("--plan returns the same records with the same ids and writes nothing", async () => {
    const before = await storeAt().tip();
    const planned = await runHandler(
      caseBook,
      { slug: "plan-only-case", about: ["urn:plan"] },
      {
        workspace,
        scope,
        now,
        mode: "plan",
      },
    );
    const after = await storeAt().tip();
    expect(after).toBe(before);

    const performed = await runHandler(
      caseBook,
      { slug: "plan-only-case", about: ["urn:plan"] },
      {
        workspace,
        scope,
        now,
        mode: "perform",
      },
    );
    expect(performed.minted.map((item) => item.id)).toEqual(planned.minted.map((item) => item.id));
  });

  test("--expect-head refuses with the moved-head reason after another writer has moved the tip", async () => {
    await runHandler(caseBook, { slug: "seed-case" }, { workspace, scope, now });
    const staleTip = await storeAt().tip();
    await runHandler(caseBook, { slug: "another-case" }, { workspace, scope, now });

    const error = await runHandler(
      caseBook,
      { slug: "loser-case" },
      {
        workspace,
        scope,
        now,
        expectHead: staleTip!,
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HeadMovedError);
    expect((error as HeadMovedError).reason).toBe("head-moved");
  });

  test("booking the same slug twice at the same head returns the existing case rather than minting a second one", async () => {
    const first = await runHandler(
      caseBook,
      { slug: "idempotent-case", about: ["urn:once"] },
      { workspace, scope, now },
    );
    const second = await runHandler(
      caseBook,
      { slug: "idempotent-case", about: ["urn:once"] },
      { workspace, scope, now },
    );

    expect(second.case).toBe(first.case);

    const opened = await openWorkspace({ workspace, scope, now });
    const ids = await opened.store.list("case");
    const matching = [];
    for (const id of ids) {
      const record = opened.read(id);
      if (record.kind === "case" && record.slug === "idempotent-case") {
        matching.push(id);
      }
    }
    expect(matching).toHaveLength(1);
  });

  test("the store's tip advances by exactly one commit after a booking that mints a case and two claims", async () => {
    await runHandler(caseBook, { slug: "seed-for-commit-count" }, { workspace, scope, now });
    const before = await storeAt().tip();
    await runHandler(caseBook, { slug: "one-commit-case", about: ["urn:x", "urn:y"] }, { workspace, scope, now });
    const after = await storeAt().tip();
    expect(after).not.toBe(before);

    const execFileAsync = promisify(execFile);
    const gitDir = join(workspace, ".musai");
    const { stdout } = await execFileAsync("git", ["--git-dir", gitDir, "rev-parse", `${after}^`]);
    expect(stdout.trim()).toBe(before);
  });
});
