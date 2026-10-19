import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OperationContext, openWorkspace, releaseStanding, runHandler } from "@musai/api-core";
import { type Audience, type RecordId, timestamp } from "@musai/records";
import { MUSAI_DIR, Store } from "@musai/store";
import { allowedSignersLine, fixedClock, generateTestKey, type TestKey, writeTrustFile } from "@musai/test-support";
import { mintAttestation, signAttestation } from "@musai/trust";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { caseBook } from "../src/ops/case.js";
import { bundleExport } from "../src/ops/export.js";
import { releaseGrant } from "../src/ops/release.js";
import { workspaceInit } from "../src/ops/workspace.js";

const PRINCIPAL = "releaser@example.test";
const now = fixedClock(timestamp("2026-10-11T00:00:00.000Z"));

describe("a release is a person's, never a model's relay", () => {
  let key: TestKey;
  const scratch: string[] = [];

  beforeAll(async () => {
    key = await generateTestKey(PRINCIPAL);
  }, 60_000);

  afterAll(async () => {
    await rm(key.dir, { recursive: true, force: true });
    for (const dir of scratch) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function releasable() {
    const workspace = await mkdtemp(join(tmpdir(), "musai-release-"));
    scratch.push(workspace);
    const context: OperationContext = { workspace, scope: "default", now, via: "tty", principalName: PRINCIPAL };
    await runHandler(workspaceInit, { workspace }, context);
    const gitDir = join(workspace, MUSAI_DIR);
    await writeTrustFile({ gitDir }, "allowed-signers", allowedSignersLine(key));
    await writeTrustFile({ gitDir }, "roles", `${key.principal} owner any\n`);
    const booked = await runHandler(caseBook, { slug: "released", about: ["https://example.test/released"] }, context);
    const claim = booked.minted.find((item) => item.kind === "claim")!.id;
    const store = new Store({ ctx: { gitDir }, scope: "default", now });
    const relayed: OperationContext = { ...context, via: "model" };
    const standing = async () =>
      (await releaseStanding(await openWorkspace(context), claim)).standing.map((release) => release.id);
    return { workspace, context, relayed, claim, store, standing };
  }

  async function exists(path: string): Promise<boolean> {
    return access(path).then(
      () => true,
      () => false,
    );
  }

  test("refuses a grant through model before anything is written", async () => {
    const { relayed, claim, store } = await releasable();
    const before = await store.tip();

    await expect(
      runHandler(releaseGrant, { id: claim, to: "public", key: key.keyPath }, relayed),
    ).rejects.toMatchObject({ reason: "not-authorised", about: ["release.grant@2", "model"] });
    expect(await store.tip()).toBe(before);
  }, 120_000);

  test("a person's grant mints one signed release that stands", async () => {
    const { context, claim, standing } = await releasable();

    const granted = await runHandler(releaseGrant, { id: claim, to: "public", key: key.keyPath }, context);

    expect(granted.minted[0]!.record).toMatchObject({ purpose: "released", principalClass: "person", via: "tty" });
    expect(await standing()).toEqual([granted.minted[0]!.id]);
  }, 120_000);

  test("an export through model refuses to release what no person released, and writes nothing", async () => {
    const { workspace, relayed, claim, store } = await releasable();
    const before = await store.tip();
    const out = join(workspace, "bundle.tar.gz");

    await expect(
      runHandler(bundleExport, { id: claim, to: "public", out, key: key.keyPath }, relayed),
    ).rejects.toMatchObject({ reason: "not-authorised", about: ["release.grant@2", "model"] });
    expect([await store.tip(), await exists(out)]).toEqual([before, false]);
  }, 120_000);

  test("a release relayed through a model, minted by another path, lets nothing leave", async () => {
    const { workspace, relayed, claim, store, standing } = await releasable();
    const attestation = mintAttestation({
      subject: claim,
      principal: key.principal,
      principalClass: "agent",
      via: "model",
      purpose: "released",
      at: timestamp("2026-10-11T00:00:00.000Z"),
      release: {
        audience: "public" as Audience,
        extent: "closure",
        terms: { form: "bytes", uses: ["review", "cite"], from: null, until: null, marking: null },
      },
    });
    const signature = await signAttestation({ attestation, keyPath: key.keyPath });
    await store.putMany([{ kind: "attestation", value: attestation.record, signature }]);
    const before = await store.tip();
    const out = join(workspace, "bundle.tar.gz");

    expect(await standing()).toEqual([] as RecordId[]);
    await expect(
      runHandler(bundleExport, { id: claim, to: "public", out, key: key.keyPath }, relayed),
    ).rejects.toMatchObject({ reason: "not-authorised", about: ["release.grant@2", "model"] });
    expect([await store.tip(), await exists(out)]).toEqual([before, false]);
  }, 120_000);
});
