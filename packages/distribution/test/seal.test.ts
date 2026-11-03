import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OperationContext, openWorkspace, releaseStanding, runHandler, sealStanding } from "@musai/api-core";
import {
  type AttestationRecord,
  type Audience,
  CURRENT_SCHEMA_VERSIONS,
  canonicalBytes,
  type RecordId,
  rawId,
  recordId,
  recordPath,
  type SealAttestationRecord,
  sidecarPath,
  timestamp,
} from "@musai/records";
import { LOCAL_DIR, MUSAI_DIR, Store } from "@musai/store";
import {
  allowedSignersLine,
  commitAroundTheStore,
  commitFilesAroundTheStore,
  fixedClock,
  generateTestKey,
  type TestKey,
  writeTrustFile,
} from "@musai/test-support";
import { mintAttestation, signAttestation, writeSignerConfig } from "@musai/trust";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { shortIdOf } from "../src/claim-ref.js";
import { attestationShow } from "../src/ops/attestation.js";
import { caseBook } from "../src/ops/case.js";
import { doctorRun } from "../src/ops/doctor.js";
import { forkKeep } from "../src/ops/keep.js";
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
    using opened = await openWorkspace({ ...context, reportRefusal: undefined });
    return {
      seals: (await sealStanding(opened, claim)).standing.map((seal) => seal.id).sort(),
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

  /** A seal from `cast`, of the closure where asked, or a revocation of `supersedes`, in the
   * sealer's name with no signature beside it, as one stripped of it. */
  async function stripped(
    context: OperationContext,
    claim: RecordId,
    supersedes?: readonly RecordId[],
    closure = false,
  ) {
    const { id, record } = mintAttestation({
      subject: claim,
      principal: key.principal,
      principalClass: "person",
      via: "tty",
      // A day before the clock, so it is never the record a verb mints over the same seal.
      at: timestamp("2026-10-07T00:00:00.000Z"),
      ...(supersedes === undefined
        ? {
            purpose: "sealed" as const,
            seal: { audience: "cast" as Audience, ...(closure ? { extent: "closure" as const } : {}) },
          }
        : { purpose: "revoked" as const, supersedes }),
    });
    const store = new Store({ ctx: { gitDir: join(context.workspace, MUSAI_DIR) }, scope: "default", now });
    await store.putMany([{ kind: "attestation", value: record }]);
    return id;
  }

  const strippedSeal = (context: OperationContext, claim: RecordId) => stripped(context, claim);

  async function doctorRow(context: OperationContext, name: string) {
    return (await runHandler(doctorRun, {}, context)).local.filter((check) => check.name === name);
  }

  /** The attestation a doctor row's remedy shows, by the short id it names. */
  function shownIn(detail: string): string {
    const named = /`musai lab attestation show ([0-9a-f]+)`/.exec(detail)?.[1];
    expect(named, detail).toBeDefined();
    return named!;
  }

  /** The record a doctor row's `verb` remedy names, by the short id it names. */
  function subjectIn(detail: string, verb: "seal" | "revoke" | "release"): string {
    const named = new RegExp(`\`musai lab ${verb} ([0-9a-f]+) `).exec(detail)?.[1];
    expect(named, detail).toBeDefined();
    return named!;
  }

  test("an unverified seal's doctor row names its subject by short id and the command showing its audience, and the seal it names runs as pasted", async () => {
    const { context, claim } = await sealable();
    const forged = await strippedSeal(context, claim);

    const [row] = await doctorRow(context, "unverified-seals");
    const shown = await runHandler(attestationShow, { id: shownIn(row!.detail) }, context);

    expect(shown).toEqual({
      id: forged,
      schemaVersion: expect.any(Number),
      purpose: "sealed",
      subject: claim,
      principal: key.principal,
      via: "tty",
      at: "2026-10-07T00:00:00.000Z",
      audience: "cast",
      extent: "record",
      terms: null,
      supersedes: [],
      verified: false,
      failure: "no signature",
    });
    const sealed = await runHandler(
      releaseSeal,
      { id: subjectIn(row!.detail, "seal"), from: shown.audience!, key: key.keyPath },
      context,
    );
    expect(sealed.minted[0]!.record).toMatchObject({ supersedes: [forged] });
    expect((await doctorRow(context, "unverified-seals")).map((check) => check.ok)).toEqual([true]);
  }, 180_000);

  test("shows a signed release by a prefix of its id: its audience, extent, terms and signer, and that it verifies", async () => {
    const { context, claim } = await sealable();
    const released = await runHandler(
      releaseGrant,
      { id: claim, to: "cast", closure: true, key: key.keyPath },
      context,
    );
    const id = released.minted[0]!.id;

    const shown = await runHandler(attestationShow, { id: shortIdOf(id) }, context);

    expect(shown).toMatchObject({
      id,
      purpose: "released",
      subject: claim,
      principal: key.principal,
      audience: "cast",
      extent: "closure",
      terms: { form: "bytes", uses: ["review", "cite"], from: null, until: null, marking: null },
      supersedes: [],
      verified: true,
      failure: null,
    });
    expect(attestationShow.renderText(shown)).toContain("signature  verifies");
  }, 120_000);

  test("refuses an attestation named by fewer than eight hex digits, or by a record that is no attestation", async () => {
    const { context, claim } = await sealable();

    await expect(runHandler(attestationShow, { id: claim.slice(0, 12) }, context)).rejects.toMatchObject({
      reason: "invalid-input",
    });
    await expect(runHandler(attestationShow, { id: claim }, context)).rejects.toMatchObject({
      reason: "no-such-record",
      about: [claim],
    });
  }, 120_000);

  test("refuses to show an attestation under a clearance, as it refuses an id the store does not hold, so a station learns no seal exists", async () => {
    const { context, claim } = await sealable();
    const sealed = await runHandler(releaseSeal, { id: claim, from: "cast", key: key.keyPath }, context);
    const cleared = { ...context, clearance: "cast" as Audience };

    const ofSeal = await runHandler(attestationShow, { id: sealed.minted[0]!.id }, cleared).catch((e: unknown) => e);
    const ofNothing = await runHandler(attestationShow, { id: `sha256:${"0".repeat(64)}` }, cleared).catch(
      (e: unknown) => e,
    );

    expect(ofSeal).toMatchObject({ reason: "invalid-input", about: ["attestation.show@1"] });
    expect(ofNothing).toEqual(ofSeal);
  }, 120_000);

  /** A signed revocation of `release` at the next attestation version, which a fold keeps only to
   * withdraw. */
  async function laterRevocation(context: OperationContext, claim: RecordId, release: RecordId): Promise<RecordId> {
    const { record } = mintAttestation({
      subject: claim,
      principal: key.principal,
      principalClass: "person",
      via: "tty",
      purpose: "revoked",
      at: timestamp("2026-10-07T00:00:00.000Z"),
      supersedes: [release],
    });
    const later = { ...record, schemaVersion: CURRENT_SCHEMA_VERSIONS.attestation + 1, reach: "all" };
    const bytes = canonicalBytes(later);
    const id = rawId(bytes);
    const signature = await signAttestation({
      attestation: { id, record: later as unknown as AttestationRecord },
      keyPath: key.keyPath,
    });
    await commitFilesAroundTheStore({ ctx: { gitDir: join(context.workspace, MUSAI_DIR) }, scope: "default", now }, [
      { path: recordPath("attestation", id), bytes },
      { path: sidecarPath(id), bytes: new TextEncoder().encode(signature) },
    ]);
    return id;
  }

  test("shows an attestation of a later version, held only to withdraw, by a prefix of its id", async () => {
    const { context, claim } = await sealable();
    const released = await runHandler(releaseGrant, { id: claim, to: "cast", key: key.keyPath }, context);
    const id = await laterRevocation(context, claim, released.minted[0]!.id);

    expect(await runHandler(attestationShow, { id: shortIdOf(id) }, context)).toEqual({
      id,
      schemaVersion: CURRENT_SCHEMA_VERSIONS.attestation + 1,
      purpose: "revoked",
      subject: claim,
      principal: key.principal,
      via: "tty",
      at: "2026-10-07T00:00:00.000Z",
      audience: null,
      extent: null,
      terms: null,
      supersedes: [released.minted[0]!.id],
      verified: true,
      failure: null,
    });
  }, 120_000);

  /** Two unsigned seals of `claim` from `cast` whose ids share their first eight hex digits, the
   * second landed as bytes no fold reads where `unreadable` asks. */
  async function twoSharingAPrefix(
    context: OperationContext,
    claim: RecordId,
    unreadable = false,
  ): Promise<readonly [RecordId, RecordId]> {
    const seen = new Map<string, SealAttestationRecord>();
    for (let at = Date.parse("2026-01-01T00:00:00.000Z"); ; at += 1) {
      const { id, record } = mintAttestation({
        subject: claim,
        principal: key.principal,
        principalClass: "person",
        via: "tty",
        purpose: "sealed",
        at: timestamp(new Date(at).toISOString()),
        seal: { audience: "cast" as Audience },
      });
      const prefix = shortIdOf(id).slice(0, 8);
      const other = seen.get(prefix);
      if (other === undefined) {
        seen.set(prefix, record as SealAttestationRecord);
      } else {
        const repo = { ctx: { gitDir: join(context.workspace, MUSAI_DIR) }, scope: "default", now };
        const [first] = await new Store(repo).putMany([{ kind: "attestation", value: other }]);
        if (unreadable) {
          await commitAroundTheStore(repo, recordPath("attestation", id), new TextEncoder().encode("not a record"));
        } else {
          await new Store(repo).putMany([{ kind: "attestation", value: record }]);
        }
        return [first!, id];
      }
    }
  }

  test("refuses a prefix two attestations share, naming both", async () => {
    const { context, claim } = await sealable();
    const pair = await twoSharingAPrefix(context, claim);

    const refused = await runHandler(attestationShow, { id: shortIdOf(pair[0]).slice(0, 8) }, context).catch(
      (e: unknown) => e,
    );

    expect(refused).toMatchObject({ reason: "invalid-input" });
    for (const id of pair) {
      expect((refused as Error).message).toContain(id);
    }
  }, 120_000);

  /** How release, seal and revoke each answer `id`, one after another. */
  async function eachRefusal(context: OperationContext, id: string): Promise<unknown[]> {
    // A station is handed no file by path, so a cleared call names no key.
    const signing = context.clearance === undefined ? { key: key.keyPath } : {};
    const refusals: unknown[] = [];
    refusals.push(await runHandler(releaseGrant, { id, to: "cast", ...signing }, context).catch((e: unknown) => e));
    refusals.push(await runHandler(releaseSeal, { id, from: "cast", ...signing }, context).catch((e: unknown) => e));
    refusals.push(await runHandler(releaseRevoke, { id, to: "cast", ...signing }, context).catch((e: unknown) => e));
    return refusals;
  }

  test("release, seal and revoke name their record by eight or more of its hex digits", async () => {
    const { context, claim } = await sealable();
    const short = shortIdOf(claim);

    const released = await runHandler(releaseGrant, { id: short, to: "cast", key: key.keyPath }, context);
    const sealed = await runHandler(releaseSeal, { id: short.slice(0, 8), from: "writer", key: key.keyPath }, context);
    const revoked = await runHandler(releaseRevoke, { id: `sha256:${short}`, to: "cast", key: key.keyPath }, context);

    for (const { minted } of [released, sealed, revoked]) {
      expect(minted[0]!.record).toMatchObject({ subject: claim });
    }
    expect(await standing(context, claim)).toEqual({ seals: [sealed.minted[0]!.id], releases: [] });
  }, 120_000);

  test("release, seal and revoke refuse a prefix two records share, naming both, and one of fewer than eight hex digits", async () => {
    const { context, claim } = await sealable();
    const pair = await twoSharingAPrefix(context, claim);
    const shared = shortIdOf(pair[0]).slice(0, 8);

    for (const refused of await eachRefusal(context, shared)) {
      expect(refused).toMatchObject({ reason: "invalid-input", about: [shared] });
      for (const id of pair) {
        expect((refused as Error).message).toContain(id);
      }
    }
    for (const refused of await eachRefusal(context, shortIdOf(claim).slice(0, 7))) {
      expect(refused).toMatchObject({ reason: "invalid-input", about: [shortIdOf(claim).slice(0, 7)] });
    }
  }, 120_000);

  test("under a clearance, release, seal and revoke refuse a prefix only withheld records match as one matching nothing, naming none of them", async () => {
    const { context, claim } = await sealable();
    const pair = await twoSharingAPrefix(context, claim);
    const cleared = { ...context, clearance: "cast" as Audience };
    const unheld = "0".repeat(8);
    const nothing = (await eachRefusal(cleared, unheld)).map((refused) => (refused as Error).message);

    for (const named of [shortIdOf(pair[0]).slice(0, 8), shortIdOf(claim)]) {
      const refusals = await eachRefusal(cleared, named);
      for (const [at, refused] of refusals.entries()) {
        expect(refused).toMatchObject({ reason: "no-such-record", about: [named] });
        expect((refused as Error).message.replace(named, unheld)).toBe(nothing[at]);
      }
    }
  }, 120_000);

  test("release, seal, revoke, keep and attestation show refuse a refused record's id, and a prefix of it, as a read of it is refused", async () => {
    const { context } = await sealable();
    const unreadable = recordId({ marker: "a claim whose bytes no fold reads" });
    await commitAroundTheStore(
      { ctx: { gitDir: join(context.workspace, MUSAI_DIR) }, scope: "default", now },
      recordPath("claim", unreadable),
      new TextEncoder().encode("not a record"),
    );

    for (const named of [unreadable, shortIdOf(unreadable)]) {
      const refusals = [
        ...(await eachRefusal(context, named)),
        await runHandler(forkKeep, { record: named }, context).catch((e: unknown) => e),
        await runHandler(attestationShow, { id: named }, context).catch((e: unknown) => e),
      ];
      for (const refused of refusals) {
        expect(refused).toMatchObject({ reason: "record-corrupted", about: [unreadable] });
      }
    }
  }, 120_000);

  test("a prefix a held record and a refused one share is refused naming both", async () => {
    const { context, claim } = await sealable();
    const pair = await twoSharingAPrefix(context, claim, true);
    const shared = shortIdOf(pair[0]).slice(0, 8);

    const refusals = [
      ...(await eachRefusal(context, shared)),
      await runHandler(attestationShow, { id: shared }, context).catch((e: unknown) => e),
    ];
    for (const refused of refusals) {
      expect(refused).toMatchObject({ reason: "invalid-input", about: [shared] });
      for (const id of pair) {
        expect((refused as Error).message).toContain(id);
      }
    }
  }, 120_000);

  test("under a clearance, a prefix only a refusal the clearance withholds matches is refused as one matching nothing", async () => {
    const { context, claim } = await sealable();
    const released = await runHandler(releaseGrant, { id: claim, to: "cast", key: key.keyPath }, context);
    await runHandler(releaseSeal, { id: claim, from: "cast", key: key.keyPath }, context);
    const later = await laterRevocation(context, claim, released.minted[0]!.id);
    const named = shortIdOf(later);
    const cleared = { ...context, clearance: "cast" as Audience };
    const unheld = "0".repeat(8);

    for (const refused of await eachRefusal(context, named)) {
      expect(refused).toMatchObject({ reason: "record-corrupted", about: [later] });
    }
    const nothing = (await eachRefusal(cleared, unheld)).map((refused) => (refused as Error).message);
    for (const [at, refused] of (await eachRefusal(cleared, named)).entries()) {
      expect(refused).toMatchObject({ reason: "no-such-record", about: [named] });
      expect((refused as Error).message.replace(named, unheld)).toBe(nothing[at]);
    }
  }, 120_000);

  test("re-sealing over an unverified seal beside a verified closure seal keeps the closure withheld", async () => {
    const { context, claim } = await sealable();
    const closure = await runHandler(
      releaseSeal,
      { id: claim, from: "cast", closure: true, key: key.keyPath },
      context,
    );
    const forged = await strippedSeal(context, claim);

    const sealed = await runHandler(releaseSeal, { id: claim, from: "cast", key: key.keyPath }, context);
    expect(sealed.minted[0]!.record).toMatchObject({ purpose: "sealed", supersedes: [forged] });
    expect(await standing(context, claim)).toEqual({
      seals: [closure.minted[0]!.id, sealed.minted[0]!.id].sort(),
      releases: [],
    });
  }, 120_000);

  test("re-sealing over an unverified seal beside a verified one at its extent replaces the unverified one", async () => {
    const { context, claim } = await sealable();
    const signed = await runHandler(releaseSeal, { id: claim, from: "cast", key: key.keyPath }, context);
    const forged = await strippedSeal(context, claim);

    const sealed = await runHandler(releaseSeal, { id: claim, from: "cast", key: key.keyPath }, context);
    expect(sealed.minted[0]!.record).toMatchObject({
      purpose: "sealed",
      supersedes: [signed.minted[0]!.id, forged].sort(),
    });
    expect(await standing(context, claim)).toEqual({ seals: [sealed.minted[0]!.id], releases: [] });
    expect((await doctorRow(context, "unverified-seals")).map((check) => check.ok)).toEqual([true]);
  }, 180_000);

  test("a release withdrawn by an unverified revocation in a name this machine does not sign as is named to its author, and releasing it again replaces it", async () => {
    const { context, claim } = await sealable();
    const released = await runHandler(releaseGrant, { id: claim, to: "cast", key: key.keyPath }, context);
    const revocation = await stripped(context, claim, [released.minted[0]!.id]);

    const named = await doctorRow(context, "unverified-revocations");
    expect(named.map((check) => check.ok)).toEqual([false]);
    const { detail } = named[0]!;
    expect(detail).toContain(shortIdOf(revocation));
    expect(detail).toContain("in a name this machine does not sign as");
    expect(detail.indexOf("musai lab revoke")).toBeGreaterThan(-1);
    expect(detail.indexOf("musai lab revoke")).toBeLessThan(detail.indexOf("musai lab release"));
    expect(detail).not.toContain(key.principal);
    expect(detail).not.toContain(claim);

    const shown = await runHandler(attestationShow, { id: shownIn(detail) }, context);
    expect(shown).toMatchObject({ id: released.minted[0]!.id, subject: claim, audience: "cast", verified: true });
    const withdrawing = await runHandler(attestationShow, { id: shortIdOf(revocation) }, context);
    expect(withdrawing).toMatchObject({
      purpose: "revoked",
      audience: null,
      extent: null,
      supersedes: [released.minted[0]!.id],
      verified: false,
    });
    const again = await runHandler(
      releaseGrant,
      { id: subjectIn(detail, "release"), to: shown.audience!, key: key.keyPath },
      context,
    );
    expect(again.minted[0]!.record).toMatchObject({ purpose: "released", supersedes: [released.minted[0]!.id] });
    expect(await standing(context, claim)).toEqual({ seals: [], releases: [again.minted[0]!.id] });
    expect((await doctorRow(context, "unverified-revocations")).map((check) => check.ok)).toEqual([true]);
  }, 180_000);

  test("a stripped revocation in the author's own name is named as theirs, and its remedy re-signs it", async () => {
    const { context, claim } = await sealable();
    await writeSignerConfig(join(context.workspace, MUSAI_DIR, LOCAL_DIR), { keyPath: key.keyPath });
    const released = await runHandler(releaseGrant, { id: claim, to: "cast" }, context);
    await stripped(context, claim, [released.minted[0]!.id]);

    const named = await doctorRow(context, "unverified-revocations");
    expect(named.map((check) => check.ok)).toEqual([false]);
    expect(named[0]!.detail).toContain("in your name");
    expect(named[0]!.detail).toContain("musai lab revoke");
    expect(named[0]!.detail).not.toContain("musai lab release");

    await runHandler(releaseRevoke, { id: subjectIn(named[0]!.detail, "revoke"), to: "cast" }, context);
    expect((await doctorRow(context, "unverified-revocations")).map((check) => check.ok)).toEqual([true]);
  }, 180_000);

  test("a stripped revocation in the author's older key is named as theirs while signer.json names the newer one", async () => {
    const { context, claim } = await sealable();
    const newer = await generateTestKey(PRINCIPAL);
    scratch.push(newer.dir);
    const gitDir = join(context.workspace, MUSAI_DIR);
    await writeTrustFile({ gitDir }, "allowed-signers", allowedSignersLine(key) + allowedSignersLine(newer));
    await writeTrustFile({ gitDir }, "roles", `${key.principal} owner any\n${newer.principal} owner any\n`);
    await writeSignerConfig(join(gitDir, LOCAL_DIR), { keyPath: newer.keyPath });
    const released = await runHandler(releaseGrant, { id: claim, to: "cast" }, context);
    await stripped(context, claim, [released.minted[0]!.id]);
    const home = await mkdtemp(join(tmpdir(), "musai-seal-home-"));
    scratch.push(home);
    await mkdir(join(home, ".ssh"));
    for (const half of ["", ".pub"]) {
      await copyFile(`${key.keyPath}${half}`, join(home, ".ssh", `id_older${half}`));
    }
    vi.stubEnv("HOME", home);
    const named = await doctorRow(context, "unverified-revocations").finally(() => vi.unstubAllEnvs());

    expect(named.map((check) => check.ok)).toEqual([false]);
    expect(named[0]!.detail).toContain("in your name");
    expect(named[0]!.detail).not.toContain("musai lab release");
  }, 180_000);

  test("an unverified revocation withdrawing two releases is named once for each", async () => {
    const { context, claim } = await sealable();
    const cast = await runHandler(releaseGrant, { id: claim, to: "cast", key: key.keyPath }, context);
    const writer = await runHandler(releaseGrant, { id: claim, to: "writer", key: key.keyPath }, context);
    await stripped(context, claim, [cast.minted[0]!.id, writer.minted[0]!.id]);

    const named = await doctorRow(context, "unverified-revocations");
    expect(named.map((check) => check.ok)).toEqual([false, false]);
    expect(named.map((check) => check.detail).join("\n")).toContain(shortIdOf(cast.minted[0]!.id));
    expect(named.map((check) => check.detail).join("\n")).toContain(shortIdOf(writer.minted[0]!.id));
  }, 180_000);

  test("a record-alone re-seal beside a stripped closure seal keeps the closure withheld", async () => {
    const { context, claim } = await sealable();
    const forged = await stripped(context, claim, undefined, true);

    const sealed = await runHandler(releaseSeal, { id: claim, from: "cast", key: key.keyPath }, context);
    expect(sealed.minted[0]!.record).not.toHaveProperty("supersedes", [forged]);
    expect(await standing(context, claim)).toEqual({ seals: [forged, sealed.minted[0]!.id].sort(), releases: [] });
    expect(await runHandler(releaseSeal, { id: claim, from: "cast", key: key.keyPath }, context)).toEqual({
      minted: [],
      unchanged: 1,
    });

    const closure = await runHandler(
      releaseSeal,
      { id: claim, from: "cast", closure: true, key: key.keyPath },
      context,
    );
    expect(closure.minted[0]!.record).toMatchObject({ supersedes: [forged, sealed.minted[0]!.id].sort() });
    expect(await standing(context, claim)).toEqual({ seals: [closure.minted[0]!.id], releases: [] });
  }, 180_000);

  test("revoking the release to an audience again signs a revocation over one withdrawn unverified", async () => {
    const { context, claim } = await sealable();
    const released = await runHandler(releaseGrant, { id: claim, to: "cast", key: key.keyPath }, context);
    await stripped(context, claim, [released.minted[0]!.id]);

    const revoked = await runHandler(releaseRevoke, { id: claim, to: "cast", key: key.keyPath }, context);
    expect(revoked.minted[0]!.record).toMatchObject({ purpose: "revoked", supersedes: [released.minted[0]!.id] });
    expect(await standing(context, claim)).toEqual({ seals: [], releases: [] });
    expect((await doctorRow(context, "unverified-revocations")).map((check) => check.ok)).toEqual([true]);
  }, 180_000);

  test("sealing again over a seal whose signature does not verify signs one that replaces it", async () => {
    const { context, claim } = await sealable();
    const stripped = await strippedSeal(context, claim);

    const sealed = await runHandler(releaseSeal, { id: claim, from: "cast", key: key.keyPath }, context);
    expect(sealed.minted[0]!.record).toMatchObject({ purpose: "sealed", supersedes: [stripped] });
    expect(await standing(context, claim)).toEqual({ seals: [sealed.minted[0]!.id], releases: [] });
  }, 120_000);

  test("lifting the seals from an audience lifts one whose signature does not verify", async () => {
    const { context, claim } = await sealable();
    const stripped = await strippedSeal(context, claim);

    const lifted = await runHandler(releaseRevoke, { id: claim, from: "cast", key: key.keyPath }, context);
    expect(lifted.minted[0]!.record).toMatchObject({ purpose: "revoked", supersedes: [stripped] });
    expect(await standing(context, claim)).toEqual({ seals: [], releases: [] });
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
