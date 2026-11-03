import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runHandler } from "@musai/api-core";
import type { RecordId } from "@musai/records";
import { LOCAL_DIR, MUSAI_DIR } from "@musai/store";
import { generateTestKey, type TestKey } from "@musai/test-support";
import { writeSignerConfig } from "@musai/trust";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { caseBook } from "../src/ops/case.js";
import { claimStatus } from "../src/ops/claim.js";
import { gateAnswer, gateAsk, gatePending } from "../src/ops/gate.js";
import { forkKeep } from "../src/ops/keep.js";
import { moduleBuild } from "../src/ops/module.js";
import { releaseGrant } from "../src/ops/release.js";
import { scopeFork, scopeMerge } from "../src/ops/scope.js";
import { emptyWorld, opensshAvailable, PUBLISHER, seal, WRITER } from "./sealed-world.js";

const CORE_MODULE_DIR = fileURLToPath(new URL("../../core-module", import.meta.url));
const CASEBOOK_MODULE_DIR = fileURLToPath(new URL("../../scenarios/casebook/modules/casebook", import.meta.url));
const CASEBOOK_KIND = "fixture-casebook/report";

describe.skipIf(!opensshAvailable)("a kept case whose predecessor is sealed from a station", () => {
  let key: TestKey;
  const scratch: string[] = [];

  beforeAll(async () => {
    key = await generateTestKey(PUBLISHER);
  }, 60_000);

  afterAll(async () => {
    for (const dir of scratch) {
      await rm(dir, { recursive: true, force: true });
    }
    await rm(key.dir, { recursive: true, force: true });
  });

  test("leaves the station's read of a gate answered over that predecessor stale, naming nothing sealed", async () => {
    const world = await emptyWorld(key, scratch);
    for (const dir of [CORE_MODULE_DIR, CASEBOOK_MODULE_DIR]) {
      await runHandler(moduleBuild, { dir }, world.author);
    }
    await writeSignerConfig(join(world.workspace, MUSAI_DIR, LOCAL_DIR), { keyPath: key.keyPath });
    const slug = "kept-then-sealed";
    await runHandler(scopeFork, { name: `${slug}-elsewhere` }, world.author);
    const here = await runHandler(caseBook, { slug, kind: CASEBOOK_KIND }, world.author);
    const { gates } = await runHandler(gatePending, { case: slug }, { ...world.author, mode: "plan" });
    const gate = gates.find(({ gateClass }) => gateClass === "judgment")!.claim;
    const asked = await runHandler(gateAsk, { claim: gate }, world.author);
    await runHandler(
      gateAnswer,
      { pending: gate, brief: asked.brief, choice: "holds", reason: "worth fixing" },
      world.author,
    );
    const overrides = { suite: "process.exit(1)" };
    await runHandler(
      caseBook,
      { slug, kind: CASEBOOK_KIND, overrides },
      { ...world.author, scope: `${slug}-elsewhere` },
    );
    await runHandler(scopeMerge, { from: `${slug}-elsewhere` }, world.author);
    const kept = await runHandler(forkKeep, { record: here.case }, world.author);
    await seal(world, here.case);
    for (const id of [asked.brief as RecordId, kept.successor]) {
      await runHandler(releaseGrant, { id, to: WRITER, key: key.keyPath }, world.author);
    }

    const status = await runHandler(claimStatus, { claim: gate }, { ...world.station, mode: "plan" });

    expect(status).toMatchObject({ label: "holds", decidedOnStaleEvidence: true });
    expect(JSON.stringify(status)).not.toContain(here.case);
  }, 240_000);
});
