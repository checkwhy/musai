import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OperationContext } from "@musai/api-core";
import { isOperationError, openWorkspace, runHandler } from "@musai/api-core";
import { buildModule } from "@musai/devkit";
import { IndexDb } from "@musai/fold";
import { initWorkspace, Store } from "@musai/store";
import { blobStoreOf, fixedClock } from "@musai/test-support";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { caseBook } from "../src/ops/case.js";

const MISDECLARED_MODULE_DIR = fileURLToPath(new URL("./fixtures/misdeclared", import.meta.url));
const KIND = "misdeclared/entry";
const CLAIM_TYPE = "misdeclared/noted@1";

describe("a claim type whose canonical schema does not compile", () => {
  let workspace: string;
  const scope = "default";
  const now = fixedClock("2026-08-30T00:00:00.000Z");

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-claim-type-refused-"));
    const { gitDir } = await initWorkspace(workspace, { now });
    const store = new Store({ ctx: { gitDir }, scope, now });
    const index = new IndexDb(":memory:");
    await index.fold(store);
    await buildModule(MISDECLARED_MODULE_DIR, store, { blobs: blobStoreOf(workspace), index, now });
  }, 180_000);

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  function ctx(): OperationContext {
    return { workspace, scope, now };
  }

  test("is a refused row the workspace opens with, naming the type", async () => {
    const opened = await openWorkspace({ workspace, scope, now });

    const refused = opened.foldRefusals.filter((refusal) => refusal.contributionId === CLAIM_TYPE);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toContain("does not compile");
    expect(opened.claimTypes.has(CLAIM_TYPE)).toBe(false);
  });

  test("refuses a booking of a kind naming it as a claim type nothing declares, never as a failure of its own", async () => {
    const refused = await runHandler(caseBook, { slug: "noted-once", kind: KIND }, ctx()).catch(
      (error: unknown) => error,
    );

    expect(isOperationError(refused)).toBe(true);
    expect((refused as { reason: string }).reason).toBe("invalid-input");
    expect((refused as { about: readonly string[] }).about).toEqual([CLAIM_TYPE]);
    expect((refused as { detail: string }).detail).toBe(
      `claim type has no declared identity dimensions: ${CLAIM_TYPE}`,
    );
  }, 60_000);
});
