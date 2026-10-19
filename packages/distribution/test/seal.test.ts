import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OperationContext, openWorkspace, releaseStanding, runHandler, sealStanding } from "@musai/api-core";
import { type RecordId, type SealAttestationRecord, timestamp } from "@musai/records";
import { MUSAI_DIR, Store } from "@musai/store";
import { allowedSignersLine, fixedClock, generateTestKey, type TestKey, writeTrustFile } from "@musai/test-support";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { caseBook } from "../src/ops/case.js";
import { releaseGrant, releaseRevoke, releaseSeal } from "../src/ops/release.js";
import { workspaceInit } from "../src/ops/workspace.js";

const PRINCIPAL = "sealer@example.test";
const now = fixedClock(timestamp("2026-10-08T00:00:00.000Z"));

describe("a seal is a signed attestation that a record is hidden from an audience", () => {
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

  async function sealable(): Promise<{ readonly context: OperationContext; readonly claim: RecordId }> {
    const workspace = await mkdtemp(join(tmpdir(), "musai-seal-"));
    scratch.push(workspace);
    const context: OperationContext = { workspace, scope: "default", now, via: "tty", principalName: PRINCIPAL };
    await runHandler(workspaceInit, { workspace }, context);
    const gitDir = join(workspace, MUSAI_DIR);
    await writeTrustFile({ gitDir }, "allowed-signers", allowedSignersLine(key));
    await writeTrustFile({ gitDir }, "roles", `${key.principal} owner any\n`);
    await writeTrustFile({ gitDir }, "audiences", "cast\nwriter includes cast\n");
    const booked = await runHandler(caseBook, { slug: "sealed", about: ["https://example.test/sealed"] }, context);
    return { context, claim: booked.minted.find((item) => item.kind === "claim")!.id };
  }

  async function standing(context: OperationContext, claim: RecordId) {
    const opened = await openWorkspace({ ...context, reportRefusal: undefined });
    return {
      seals: (await sealStanding(opened, claim)).standing.map((seal) => seal.id),
      releases: (await releaseStanding(opened, claim)).standing.map((release) => release.id),
    };
  }

  test("sealing mints one signed seal naming the audience, and sealing again mints nothing", async () => {
    const { context, claim } = await sealable();

    const sealed = await runHandler(releaseSeal, { id: claim, from: "cast", key: key.keyPath }, context);
    expect(sealed.minted).toHaveLength(1);
    expect(sealed.minted[0]!.record).toMatchObject({
      subject: claim,
      purpose: "sealed",
      seal: { audience: "cast" },
      principalClass: "person",
      via: "tty",
    });
    expect(await standing(context, claim)).toEqual({ seals: [sealed.minted[0]!.id], releases: [] });

    expect(await runHandler(releaseSeal, { id: claim, from: "cast", key: key.keyPath }, context)).toEqual({
      minted: [],
      unchanged: 1,
    });
  }, 120_000);

  test("a seal names no extent unless asked for its closure, and a seal of another extent replaces it", async () => {
    const { context, claim } = await sealable();
    const bare = await runHandler(releaseSeal, { id: claim, from: "cast", key: key.keyPath }, context);
    expect(Object.keys((bare.minted[0]!.record as SealAttestationRecord).seal)).toEqual(["audience"]);

    const closure = await runHandler(
      releaseSeal,
      { id: claim, from: "cast", closure: true, key: key.keyPath },
      context,
    );
    expect(closure.minted[0]!.record).toMatchObject({
      seal: { audience: "cast", extent: "closure" },
      supersedes: [bare.minted[0]!.id],
    });
    expect(await standing(context, claim)).toEqual({ seals: [closure.minted[0]!.id], releases: [] });

    const again = { id: claim, from: "cast", closure: true, key: key.keyPath };
    expect(await runHandler(releaseSeal, again, context)).toEqual({ minted: [], unchanged: 1 });
  }, 120_000);

  test("revoking the release to an audience leaves the seal from it standing", async () => {
    const { context, claim } = await sealable();
    const sealed = await runHandler(releaseSeal, { id: claim, from: "cast", key: key.keyPath }, context);
    const released = await runHandler(releaseGrant, { id: claim, to: "cast", key: key.keyPath }, context);

    const revoked = await runHandler(releaseRevoke, { id: claim, to: "cast", key: key.keyPath }, context);
    expect(revoked.minted[0]!.record).toMatchObject({ purpose: "revoked", supersedes: [released.minted[0]!.id] });
    expect(await standing(context, claim)).toEqual({ seals: [sealed.minted[0]!.id], releases: [] });
  }, 120_000);

  test("lifting the seal from an audience leaves the release to it and a seal from another standing", async () => {
    const { context, claim } = await sealable();
    const sealed = await runHandler(releaseSeal, { id: claim, from: "cast", key: key.keyPath }, context);
    const released = await runHandler(releaseGrant, { id: claim, to: "cast", key: key.keyPath }, context);
    const wider = await runHandler(releaseSeal, { id: claim, from: "writer", key: key.keyPath }, context);

    const lifted = await runHandler(releaseRevoke, { id: claim, from: "cast", key: key.keyPath }, context);
    expect(lifted.minted[0]!.record).toMatchObject({ purpose: "revoked", supersedes: [sealed.minted[0]!.id] });
    expect(await standing(context, claim)).toEqual({
      seals: [wider.minted[0]!.id],
      releases: [released.minted[0]!.id],
    });
  }, 120_000);

  test("a revocation names releases or seals, exactly one of them", async () => {
    const { context, claim } = await sealable();
    for (const input of [{ id: claim }, { id: claim, to: "cast", from: "cast" }]) {
      await expect(runHandler(releaseRevoke, { ...input, key: key.keyPath }, context)).rejects.toMatchObject({
        reason: "invalid-input",
      });
    }
  }, 120_000);

  test("refuses lifting a seal through model before anything is written", async () => {
    const { context, claim } = await sealable();
    await runHandler(releaseSeal, { id: claim, from: "cast", key: key.keyPath }, context);
    const store = new Store({ ctx: { gitDir: join(context.workspace, MUSAI_DIR) }, scope: "default", now });
    const before = await store.tip();

    await expect(
      runHandler(releaseRevoke, { id: claim, from: "cast", key: key.keyPath }, { ...context, via: "model" }),
    ).rejects.toMatchObject({ reason: "not-authorised", about: ["release.revoke@2", "model"] });
    expect(await store.tip()).toBe(before);
  }, 120_000);

  test("refuses a seal through model before anything is written", async () => {
    const { context, claim } = await sealable();
    const store = new Store({ ctx: { gitDir: join(context.workspace, MUSAI_DIR) }, scope: "default", now });
    const before = await store.tip();

    await expect(
      runHandler(releaseSeal, { id: claim, from: "cast", key: key.keyPath }, { ...context, via: "model" }),
    ).rejects.toMatchObject({ reason: "not-authorised", about: ["release.seal@1", "model"] });
    expect(await store.tip()).toBe(before);
  }, 120_000);
});
