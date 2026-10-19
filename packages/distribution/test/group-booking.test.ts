import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OperationContext } from "@musai/api-core";
import { openWorkspace, runHandler } from "@musai/api-core";
import { buildModule } from "@musai/devkit";
import { IndexDb } from "@musai/fold";
import { initWorkspace, Store } from "@musai/store";
import { blobStoreOf, fixedClock } from "@musai/test-support";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { caseBook } from "../src/ops/case.js";

const CORE_MODULE_DIR = fileURLToPath(new URL("../../core-module", import.meta.url));
const TWIN_OPTIONS_MODULE_DIR = fileURLToPath(new URL("./fixtures/twin-options", import.meta.url));
const KIND = "twin-options/menu";

describe("a booking whose kind opens a menu offering one option twice", () => {
  let workspace: string;
  const scope = "default";
  const now = fixedClock("2026-09-23T00:00:00.000Z");

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-group-booking-"));
    const { gitDir } = await initWorkspace(workspace, { now });
    const store = new Store({ ctx: { gitDir }, scope, now });
    const index = new IndexDb(":memory:");
    await index.fold(store);
    await buildModule(CORE_MODULE_DIR, store, { blobs: blobStoreOf(workspace), index, now });
    await buildModule(TWIN_OPTIONS_MODULE_DIR, store, { blobs: blobStoreOf(workspace), index, now });
  }, 180_000);

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  function ctx(): OperationContext {
    return { workspace, scope, now };
  }

  async function tip(): Promise<string | null> {
    return (await openWorkspace({ workspace, scope, now })).store.tip();
  }

  test("is refused in either mode, naming the option both members offer, and nothing is written", async () => {
    const before = await tip();
    const booking = { slug: "filed-from-both-sides", kind: KIND };

    const previewed = await runHandler(caseBook, booking, { ...ctx(), mode: "plan" }).catch((error: unknown) => error);
    const performed = await runHandler(caseBook, booking, ctx()).catch((error: unknown) => error);

    for (const refusal of [previewed, performed]) {
      expect(refusal).toMatchObject({
        reason: "invalid-input",
        detail: expect.stringContaining("offers the same menu option file at another slot"),
      });
    }
    expect(await tip()).toBe(before);
  }, 60_000);
});
