import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clockFromEnvironment,
  DECLARATIVE_RULE,
  isOperationError,
  type OperationContext,
  type OperationDescriptor,
  openWorkspace,
  runHandler,
} from "@musai/api-core";
import {
  type ArgumentRecord,
  type Audience,
  BRIEF_MEDIA_TYPE,
  type CaseRecord,
  type ClaimRecord,
  type ComputedRunRecord,
  CREW_MEDIA_TYPE,
  CURRENT_SCHEMA_VERSIONS,
  hexOfRecordId,
  MODEL_MEDIA_TYPE,
  type PerformedRunRecord,
  performedRun,
  type RecordId,
  type RunRecord,
  readEntryFor,
  recordId,
  recordPath,
  slotFor,
  textOf,
  timestamp,
} from "@musai/records";
import {
  containerEngineAvailable,
  DEFAULT_CONTAINER_ENGINE,
  isContainerImageSubstrate,
  STATION_IMAGE_CONFIG_KEY,
  stationImageFromConfig,
  stationRecipe,
} from "@musai/run";
import { initWorkspace, LOCAL_DIR, MUSAI_DIR, readTrustBranch, Store } from "@musai/store";
import {
  allowedSignersLine,
  commitAroundTheStore,
  fixedClock,
  fixtureBrief,
  fixtureCase,
  fixtureRunRecord,
  generateTestKey,
  localImageRunning,
  makeCheckout,
  pseudonymOf,
  receiptIds,
  rowsHeld,
  type TestKey,
  writeTrustFile,
} from "@musai/test-support";
import { mintAttestation, writeSignerConfig } from "@musai/trust";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, onTestFinished, test } from "vitest";
import { parseBriefSubstrates } from "../src/brief/recipe.js";
import { fullReadIds } from "../src/brief/render.js";
import { contentIdsOf } from "../src/claim.js";
import { CHECK_CLAIM_TYPE, shortIdOf } from "../src/claim-ref.js";
import { checkEvaluation, evaluationRecipe, recordedEvaluation } from "../src/evaluation.js";
import { briefRender } from "../src/ops/brief.js";
import { caseBook, caseSoundcheck } from "../src/ops/case.js";
import { caseStatus } from "../src/ops/case-status.js";
import { type CheckRunInput, checkRun, repositoryOf } from "../src/ops/check.js";
import { claimStatus } from "../src/ops/claim.js";
import { doctorRun } from "../src/ops/doctor.js";
import { eventsSinceOperation } from "../src/ops/events.js";
import { gateAnswer, gateAsk, gatePending } from "../src/ops/gate.js";
import { forkKeep } from "../src/ops/keep.js";
import { moduleBuild } from "../src/ops/module.js";
import { caseOpen } from "../src/ops/open.js";
import { releaseRevoke, releaseSeal } from "../src/ops/release.js";
import { rulingMake } from "../src/ops/ruling.js";
import { caseSave } from "../src/ops/save.js";
import { scopeDrop, scopeFork, scopeList, scopeMerge } from "../src/ops/scope.js";
import { storeRelayout } from "../src/ops/store.js";
import { viewRun } from "../src/ops/view.js";
import { claimWhy } from "../src/ops/why.js";
import { workspaceInit } from "../src/ops/workspace.js";
import {
  answerStationRun,
  CANARY,
  claim,
  emptyWorld,
  latestUnder,
  now,
  opensshAvailable,
  PUBLISHER,
  RECORD_NEED_RULE,
  rebuildCore,
  rebuildRecordNeed,
  receiptEdge,
  restingWorld,
  SCOPE,
  SEALED_ID,
  seal,
  sealAndEvaluate,
  slotOf,
  stationReceiptReadBeside,
  type World,
  WRITER,
} from "./sealed-world.js";

/** A rule running the command its condition names in the project's working tree. */
const TREE_COMMAND_MODULE_DIR = fileURLToPath(new URL("./fixtures/tree-command", import.meta.url));
const TREE_COMMAND_RULE = "tree-command/exits-cleanly";
/** Its one claim the interpreter judges over two commands reading the tracked file. */
const TREE_COMMAND_PAIR_KIND = "tree-command/pair";
const CORE_MODULE_DIR = fileURLToPath(new URL("../../core-module", import.meta.url));
/** A kind opening a menu of dispositions, one claim per option, grouped under the case's slug. */
const CASEBOOK_MODULE_DIR = fileURLToPath(new URL("../../scenarios/casebook/modules/casebook", import.meta.url));
const CASEBOOK_KIND = "fixture-casebook/report";
const CASEBOOK_DISPOSITION = "fixture-casebook/disposition@1";

/** The name a cleared fold's file takes from its clearance. */
function hexDigest(clearance: string): string {
  return createHash("sha256").update(clearance).digest("hex");
}

describe.skipIf(!opensshAvailable)(
  "a station cleared to an audience reads as if what is sealed from it never landed",
  () => {
    let key: TestKey;
    const scratch: string[] = [];

    beforeAll(async () => {
      key = await generateTestKey(PUBLISHER);
    }, 60_000);

    afterAll(async () => {
      await rm(key.dir, { recursive: true, force: true });
      for (const dir of scratch) {
        await rm(dir, { recursive: true, force: true });
      }
    });

    /** Evaluated before the sealed record lands, and where it lands, after it. */
    async function evaluatedWorld(withSealed: boolean) {
      const world = await restingWorld(key, scratch);
      await runHandler(claimStatus, { claim: slotOf("rests-on") }, world.author);
      return { ...world, derived: withSealed ? await sealAndEvaluate(world) : [] };
    }

    /** Every output a reader of the claim, its case and the log is shown, as JSON. */
    async function readings(context: OperationContext, restsOn: RecordId): Promise<string[]> {
      const planned: OperationContext = { ...context, mode: "plan" };
      return [
        await runHandler(claimStatus, { claim: slotOf("rests-on") }, planned),
        await runHandler(claimWhy, { claim: slotOf("rests-on"), full: true }, planned),
        await runHandler(briefRender, { claim: restsOn }, planned),
        await runHandler(eventsSinceOperation, {}, planned),
        await runHandler(viewRun, {}, planned),
      ].map((output) => JSON.stringify(output));
    }

    test("status, why, brief, log and view under the clearance answer as they do where the sealed record never landed", async () => {
      const [sealedWorld, neverWorld] = [await evaluatedWorld(true), await evaluatedWorld(false)];
      expect(sealedWorld.restsOn).toBe(neverWorld.restsOn);

      const seen = await readings(sealedWorld.station, sealedWorld.restsOn);

      expect(seen).toEqual(await readings(neverWorld.station, neverWorld.restsOn));
      expect(await readings(sealedWorld.author, sealedWorld.restsOn)).not.toEqual(seen);
      for (const output of seen) {
        expect(output).not.toContain(CANARY);
        for (const derived of sealedWorld.derived) {
          expect(output).not.toContain(derived);
        }
      }
    }, 240_000);

    test("an evaluation performed under the clearance leaves the author's latest evaluation where it was", async () => {
      const world = await restingWorld(key, scratch);
      const [, before] = await sealAndEvaluate(world);

      const performed = await runHandler(claimStatus, { claim: slotOf("rests-on") }, world.station);

      expect(performed.label).toBe("open");
      expect(await latestUnder(world.author)).toBe(before);
      const own = await latestUnder(world.station);
      expect(own).toBeDefined();
      expect(own).not.toBe(before);
      const station = await openWorkspace(world.station);
      onTestFinished(() => station.close());
      const evaluation = station.read(own!) as ComputedRunRecord;
      expect(evaluation.recipe.command).toEqual(["evaluate", RECORD_NEED_RULE, slotOf("rests-on"), WRITER]);
      expect(JSON.stringify(evaluation.observation.reads)).toContain(hexOfRecordId(world.stationRun));
    }, 240_000);

    test("a brief rendered under the clearance packs no sealed argument the head it reads still holds", async () => {
      const world = await emptyWorld(key, scratch);
      const [receipt, attack] = await world.store.putMany([
        { kind: "run", value: fixtureRunRecord("the claim's own receipt") },
        { kind: "run", value: fixtureRunRecord("the sealed argument's receipt") },
      ]);
      const [briefed] = await world.store.putMany([
        { kind: "claim", value: claim("briefed", {}, [receiptEdge(receipt!)]) },
      ]);
      const argument: ArgumentRecord = {
        kind: "argument",
        premises: [],
        supersedes: [],
        schemaVersion: CURRENT_SCHEMA_VERSIONS.argument,
        target: briefed!,
        reason: CANARY,
        evidence: [receiptEdge(attack!)],
      };
      const [sealedArgument] = await world.store.putMany([{ kind: "argument", value: argument }]);
      const sealId = await seal(world, sealedArgument!);
      await world.store.putMany([{ kind: "case", value: fixtureCase("briefed", [briefed!]) }]);

      const brief = await runHandler(briefRender, { claim: briefed! }, { ...world.station, mode: "plan" });

      expect(brief.output).toContain("## Attacking evidence\n(none)");
      for (const hidden of [CANARY, sealedArgument!, sealId]) {
        expect(brief.output).not.toContain(hidden);
      }
      const authors = await runHandler(briefRender, { claim: briefed! }, { ...world.author, mode: "plan" });
      expect(authors.output).toContain(CANARY);
    }, 120_000);

    test("a brief rendered under the clearance names it in its recipe, where the author's at the same head names none", async () => {
      const world = await emptyWorld(key, scratch);
      const [receipt] = await world.store.putMany([
        { kind: "run", value: fixtureRunRecord("the claim's own receipt") },
      ]);
      const [briefed] = await world.store.putMany([
        { kind: "claim", value: claim("briefed", {}, [receiptEdge(receipt!)]) },
      ]);
      await world.store.putMany([{ kind: "case", value: fixtureCase("briefed", [briefed!]) }]);
      const recipeOf = async (context: OperationContext) => {
        const brief = await runHandler(briefRender, { claim: briefed! }, { ...context, mode: "plan" });
        return (brief.minted[0]!.record as ComputedRunRecord).recipe;
      };

      const station = await recipeOf(world.station);
      const author = await recipeOf(world.author);

      expect(station.substrates).toEqual(author.substrates);
      expect(station.command).toEqual(["brief", briefed, WRITER]);
      expect(author.command).toEqual(["brief", briefed]);
    }, 120_000);

    test("a claim whose only evidence run is sealed reads under the clearance as a claim with no evidence", async () => {
      const world = await emptyWorld(key, scratch);
      const [run] = await world.store.putMany([{ kind: "run", value: fixtureRunRecord(CANARY) }]);
      const [cited, bare] = await world.store.putMany([
        { kind: "claim", value: claim("cited", {}, [receiptEdge(run!)]) },
        { kind: "claim", value: claim("bare", {}) },
      ]);
      await world.store.putMany([{ kind: "case", value: fixtureCase("cites", [cited!, bare!]) }]);
      await seal(world, run!);
      const planned: OperationContext = { ...world.station, mode: "plan" };

      const status = await runHandler(claimStatus, { claim: slotOf("cited") }, planned);
      const seen = [
        status,
        await runHandler(claimWhy, { claim: slotOf("cited"), full: true }, planned),
        await runHandler(caseStatus, { case: "cites" }, planned),
        await runHandler(briefRender, { claim: cited! }, planned),
      ].map((output) => JSON.stringify(output));

      const bareStatus = await runHandler(claimStatus, { claim: slotOf("bare") }, planned);
      expect([status.label, status.reason]).toEqual([bareStatus.label, bareStatus.reason]);
      for (const output of seen) {
        expect(output).not.toContain(CANARY);
        expect(output).not.toContain(run!);
      }
    }, 120_000);

    test("a closure seal over a claim hides its evidence run and what read it, until the seal is lifted", async () => {
      const world = await emptyWorld(key, scratch);
      const [run] = await world.store.putMany([{ kind: "run", value: fixtureRunRecord(CANARY) }]);
      const [cited] = await world.store.putMany([{ kind: "claim", value: claim("cited", {}, [receiptEdge(run!)]) }]);
      const [reader] = await world.store.putMany([
        { kind: "run", value: fixtureBrief("read the evidence", { reads: [run!] }) },
      ]);
      const ids = [cited!, run!, reader!];

      await seal(world, cited!, true);
      expect(await heldBy(world.station, ids)).toEqual([false, false, false]);
      expect(await heldBy(world.author, ids)).toEqual([true, true, true]);

      await runHandler(releaseRevoke, { id: cited!, from: WRITER, key: key.keyPath }, world.author);
      expect(await heldBy(world.station, ids)).toEqual([true, true, true]);

      await seal(world, cited!);
      expect(await heldBy(world.station, ids)).toEqual([false, true, true]);
    }, 120_000);

    async function heldBy(context: OperationContext, ids: readonly RecordId[]): Promise<boolean[]> {
      const opened = await openWorkspace(context);
      onTestFinished(() => opened.close());
      return ids.map((id) => opened.index.holds(id));
    }

    /** A claim sealed from the writer by closure: it, every run its settling minted and a run
     * reading its receipt are held by the author and by no station cleared to the writer. */
    async function sealedClaimHidden(
      settle: (author: OperationContext) => Promise<RecordId>,
      modules: readonly string[] = [],
    ): Promise<void> {
      const checkout = await makeCheckout("hello");
      onTestFinished(() => checkout.cleanup());
      const author: OperationContext = {
        workspace: checkout.dir,
        scope: SCOPE,
        now,
        via: "tty",
        principalName: PUBLISHER,
      };
      await runHandler(workspaceInit, { workspace: checkout.dir }, author);
      for (const dir of modules) {
        await runHandler(moduleBuild, { dir }, author);
      }
      const gitDir = join(checkout.dir, MUSAI_DIR);
      await writeTrustFile({ gitDir }, "allowed-signers", allowedSignersLine(key));
      await writeTrustFile({ gitDir }, "roles", `${key.principal} owner any\n`);
      await writeTrustFile({ gitDir }, "audiences", "writer\n");
      const store = new Store({ ctx: { gitDir }, scope: SCOPE, now });
      const runsBefore = new Set(await store.list("run"));
      const claim = await settle(author);
      const minted = (await store.list("run")).filter((id) => !runsBefore.has(id));
      const [receipt] = await receiptIds({ list: async () => minted, read: (id, kind) => store.read(id, kind) });
      const station = { ...author, clearance: WRITER };
      await runHandler(releaseSeal, { id: claim, from: WRITER, key: key.keyPath, closure: true }, author);
      expect(await heldBy(station, [claim, ...minted])).toEqual([claim, ...minted].map(() => false));
      const [reader] = await store.putMany([
        { kind: "run", value: fixtureBrief("read the canary's receipt", { reads: [receipt!] }) },
      ]);
      const ids = [claim, ...minted, reader!];
      expect(await heldBy(station, ids)).toEqual(ids.map(() => false));
      expect(await heldBy(author, ids)).toEqual(ids.map(() => true));
      const cleared = join(gitDir, "local", "scopes", SCOPE, "cleared", `${hexDigest(WRITER)}.sqlite`);
      const warm = rowsHeld(cleared);

      await rm(cleared);
      await heldBy(station, ids);

      expect(rowsHeld(cleared)).toEqual(warm);
      expect(JSON.stringify(warm)).not.toContain(CANARY);
    }

    const printsCanary = ["node", "-e", `console.log(${JSON.stringify(CANARY)})`];

    const byCheck = (check: CheckRunInput) => async (author: OperationContext) =>
      (await runHandler(checkRun, check, author)).claim as RecordId;

    test("a closure seal over a check claim hides its receipts and what read them, cold and warm alike", async () => {
      await sealedClaimHidden(byCheck({ statement: "the check prints the canary", command: printsCanary }));
    }, 240_000);

    test("a closure seal over a check a module's rule judges hides the rule's receipts, cold and warm alike", async () => {
      await sealedClaimHidden(
        byCheck({
          statement: "the rule's check prints the canary",
          rule: TREE_COMMAND_RULE,
          parameters: JSON.stringify(printsCanary),
        }),
        [TREE_COMMAND_MODULE_DIR],
      );
    }, 240_000);

    test("a closure seal over a claim the interpreter judges over two recipes hides both recipes' receipts, cold and warm alike", async () => {
      await sealedClaimHidden(
        async (author) => {
          const booked = await runHandler(caseBook, { slug: "paired", kind: TREE_COMMAND_PAIR_KIND }, author);
          expect((await runHandler(caseStatus, { case: "paired" }, author)).counts).toMatchObject({ holds: 1 });
          const opened = await openWorkspace(author);
          onTestFinished(() => opened.close());
          return (opened.read(booked.case) as CaseRecord).claims[0]!;
        },
        [TREE_COMMAND_MODULE_DIR],
      );
    }, 240_000);

    test("a claim citing an evidence run its scope does not hold is refused to its author by every reader, naming the run", async () => {
      const world = await emptyWorld(key, scratch);
      const missing = recordId(fixtureRunRecord("a run this scope never held"));
      const [cited] = await world.store.putMany([{ kind: "claim", value: claim("cited", {}, [receiptEdge(missing)]) }]);
      await world.store.putMany([{ kind: "case", value: fixtureCase("cites", [cited!]) }]);
      const author: OperationContext = { ...world.author, mode: "plan" };

      for (const [descriptor, input] of [
        [claimStatus, { claim: slotOf("cited") }],
        [claimWhy, { claim: slotOf("cited"), full: true }],
        [caseStatus, { case: "cites" }],
        [briefRender, { claim: cited! }],
      ] as const) {
        const refused = runHandler(descriptor as OperationDescriptor, input, author);
        await expect(refused).rejects.toMatchObject({ reason: "no-such-record" });
        await expect(refused).rejects.toThrow(missing);
      }
    }, 120_000);

    test("doctor under the clearance names no case the author has open, and the author's names its view", async () => {
      const world = await restingWorld(key, scratch);
      const slug = "canary-slug-4f1d9b";
      const [sealedCase] = await world.store.putMany([{ kind: "case", value: fixtureCase(slug, [world.restsOn]) }]);
      await seal(world, sealedCase!);
      await runHandler(caseOpen, { case: slug }, world.author);

      const seen = JSON.stringify(await runHandler(doctorRun, {}, world.station));
      const authors = await runHandler(doctorRun, {}, world.author);

      expect(seen).not.toContain(slug);
      expect(authors.local.filter((check) => check.name === "view-worktrees")).toEqual([
        { name: "view-worktrees", ok: true, detail: "no stale view worktree" },
      ]);
    }, 240_000);

    test("a station briefs a claim under the one case its fold holds, where a sealed case under another slug cites it too", async () => {
      const world = await restingWorld(key, scratch);
      const slug = "canary-slug-7c2e5a";
      const [sealedCase] = await world.store.putMany([{ kind: "case", value: fixtureCase(slug, [world.restsOn]) }]);
      await seal(world, sealedCase!);

      const station = { ...world.station, mode: "plan" as const };
      const stations = await runHandler(briefRender, { claim: world.restsOn }, station);
      const named = await runHandler(briefRender, { claim: world.restsOn, case: slug }, station).catch(
        (e: unknown) => e,
      );
      const authors = await runHandler(briefRender, { claim: world.restsOn }, { ...world.author, mode: "plan" }).catch(
        (e: unknown) => e,
      );

      expect(JSON.stringify(stations)).not.toContain(slug);
      expect(stations.output).toContain("(rests)");
      expect(named).toMatchObject({ reason: "no-such-record", detail: `no case found named ${slug}` });
      expect(authors).toMatchObject({ reason: "invalid-input", detail: expect.stringContaining(slug) });
    }, 240_000);

    test("doctor under the clearance counts none of the store's records or objects or the sessions' calls, and the author's does", async () => {
      const world = await restingWorld(key, scratch);

      const seen = await runHandler(doctorRun, {}, world.station);
      const authors = await runHandler(doctorRun, {}, world.author);

      const counted = ["record-layout", "loose-objects", "call-log"];
      expect(seen.local.filter((check) => counted.includes(check.name))).toEqual([]);
      expect(authors.local.filter((check) => counted.includes(check.name)).map((check) => check.name)).toEqual(counted);
    }, 240_000);

    /** A seal from `writer` over `subject` in `principal`'s name with no signature beside it, as a
     * fresh clone holds one whose sidecar was stripped. */
    async function strippedSeal(world: World, subject: RecordId, principal: string): Promise<RecordId> {
      const { id, record } = mintAttestation({
        subject,
        principal,
        principalClass: "person",
        via: "tty",
        purpose: "sealed",
        at: timestamp("2026-10-09T00:00:00.000Z"),
        seal: { audience: WRITER },
      });
      await world.store.putMany([{ kind: "attestation", value: record }]);
      return id;
    }

    /** A claim resting on a run carrying the canary, and what the station reads of the claim. */
    async function citedRun(world: World) {
      const [run] = await world.store.putMany([{ kind: "run", value: fixtureRunRecord(CANARY) }]);
      const [cited] = await world.store.putMany([{ kind: "claim", value: claim("cited", {}, [receiptEdge(run!)]) }]);
      await world.store.putMany([{ kind: "case", value: fixtureCase("cites", [cited!]) }]);
      const planned: OperationContext = { ...world.station, mode: "plan" };
      const seen = async () =>
        JSON.stringify([
          await runHandler(claimStatus, { claim: slotOf("cited") }, planned),
          await runHandler(claimWhy, { claim: slotOf("cited"), full: true }, planned),
          await runHandler(doctorRun, {}, world.station),
        ]);
      return { run: run!, seen };
    }

    test("a seal whose sidecar was stripped still withholds what it seals from a cleared fold, and only the author's doctor names it", async () => {
      const world = await emptyWorld(key, scratch);
      const { run, seen } = await citedRun(world);
      const stripped = await strippedSeal(world, run, key.principal);

      const station = await seen();
      const authors = await runHandler(doctorRun, {}, world.author);

      expect(station).not.toContain(CANARY);
      expect(station).not.toContain(run);
      expect(station).not.toContain(shortIdOf(stripped));
      expect(station).not.toContain("unverified-seals");
      const named = authors.local.filter((check) => check.name === "unverified-seals");
      expect(named.map((check) => check.ok)).toEqual([false]);
      expect(named[0]!.detail).toContain(shortIdOf(stripped));
      expect(named[0]!.detail).toContain(`over ${shortIdOf(run)}`);
      expect(named[0]!.detail).toContain(`musai lab attestation show ${shortIdOf(stripped)}`);
      expect(named[0]!.detail).toContain("musai lab seal");
      for (const unsafe of [run, key.principal, WRITER]) {
        expect(named[0]!.detail).not.toContain(unsafe);
      }
    }, 120_000);

    test("a seal forged in the name of a writer the trust does not grant publish withholds nothing from a cleared fold", async () => {
      const world = await emptyWorld(key, scratch);
      const { run, seen } = await citedRun(world);
      await strippedSeal(world, run, `key:SHA256:${"f".repeat(43)}`);

      const authors = await runHandler(doctorRun, {}, world.author);

      expect(await seen()).toContain(run);
      expect(authors.local.filter((check) => check.name === "unverified-seals")).toEqual([
        { name: "unverified-seals", ok: true, detail: expect.any(String) },
      ]);
    }, 120_000);

    test("a claim citing a run the fold refused is refused to a station as to its author, in status and brief", async () => {
      const world = await emptyWorld(key, scratch);
      const [good] = await world.store.putMany([{ kind: "run", value: fixtureRunRecord("a receipt that reads") }]);
      const unreadable = recordId({ marker: "a run whose bytes no fold reads" });
      await commitAroundTheStore(
        { ctx: { gitDir: join(world.workspace, MUSAI_DIR) }, scope: SCOPE, now },
        recordPath("run", unreadable),
        new TextEncoder().encode("not a record"),
      );
      const [citing] = await world.store.putMany([
        { kind: "claim", value: claim("cites-a-bad-run", {}, [receiptEdge(good!), receiptEdge(unreadable)]) },
      ]);

      await world.store.putMany([{ kind: "case", value: fixtureCase("bad-run", [citing!]) }]);

      for (const [descriptor, input] of [
        [claimStatus, { claim: slotOf("cites-a-bad-run") }],
        [briefRender, { claim: citing! }],
      ] as const) {
        const refusals = [];
        for (const context of [world.author, world.station]) {
          const asked = { ...context, mode: "plan" as const };
          refusals.push(await runHandler(descriptor as OperationDescriptor, input, asked).catch((e: unknown) => e));
        }

        expect(refusals[0], descriptor.id).toMatchObject({ reason: "record-corrupted", about: [unreadable] });
        expect(refusals[1], descriptor.id).toEqual(refusals[0]);
      }
    }, 120_000);

    /** A testimony run the reviewer asserted, with its attestation. */
    async function putTestimony(world: World) {
      const performed = fixtureRunRecord("the reviewer's recommendation");
      const testimony: RunRecord = {
        ...performed,
        runKind: "testimony",
        recipe: {
          ...performed.recipe,
          command: ["ask", "musai.core/judge"],
          substrates: [
            { mediaType: BRIEF_MEDIA_TYPE, digest: { sha256: "a".repeat(64) } },
            { mediaType: CREW_MEDIA_TYPE, digest: { sha256: "b".repeat(64) } },
            { mediaType: MODEL_MEDIA_TYPE, uri: "model://anthropic/claude" },
          ],
          isolation: "none",
        },
        observation: { ...performed.observation, isolationHeld: "none" },
      };
      const [run] = await world.store.putMany([{ kind: "run", value: testimony }]);
      const attestation = mintAttestation({
        subject: run!,
        principal: pseudonymOf("reviewer@example.com"),
        principalClass: "person",
        via: "signature",
        purpose: "asserted",
        at: timestamp("2026-10-09T00:00:00.000Z"),
      });
      await world.store.putMany([{ kind: "attestation", value: attestation.record }]);
      return { run: run!, attestation };
    }

    /** A claim resting on its own receipt, and an argument citing `evidence` against the claim, or
     * against that receipt where `onReceipt` is set. */
    async function attackedClaim(world: World, id: string, evidence: readonly RecordId[], onReceipt = false) {
      const [own] = await world.store.putMany([{ kind: "run", value: fixtureRunRecord("the claim's own receipt") }]);
      const [attacked] = await world.store.putMany([{ kind: "claim", value: claim(id, {}, [receiptEdge(own!)]) }]);
      const argument: ArgumentRecord = {
        kind: "argument",
        premises: [],
        supersedes: [],
        schemaVersion: CURRENT_SCHEMA_VERSIONS.argument,
        target: onReceipt ? own! : attacked!,
        reason: "it does not hold",
        evidence: evidence.map(receiptEdge),
      };
      const [argued] = await world.store.putMany([{ kind: "argument", value: argument }]);
      return { claim: attacked!, argument: argued!, receipt: own! };
    }

    /** Every output a reader of the claim `name` and its case is shown, as JSON and as text. */
    async function claimReadings(context: OperationContext, name: string, claimId: RecordId, slug: string) {
      const planned: OperationContext = { ...context, mode: "plan" };
      const slot = slotOf(name);
      const asked: readonly (readonly [OperationDescriptor, object])[] = [
        [claimStatus, { claim: slot }],
        [claimWhy, { claim: slot }],
        [claimWhy, { claim: slot, full: true }],
        [briefRender, { claim: claimId }],
        [caseStatus, { case: slug }],
        [caseSoundcheck, { case: slug }],
        [viewRun, {}],
      ];
      const shown: string[] = [];
      for (const [descriptor, input] of asked) {
        const output = await runHandler(descriptor, input, planned);
        shown.push(JSON.stringify(output), descriptor.renderText(output));
      }
      return shown;
    }

    test.each([
      ["wholly on a sealed run", false],
      ["on a sealed receipt and a held testimony", true],
    ])(
      "an argument resting %s leaves the station's claim open, contested on grounds it is not shown",
      async (_, withTestimony) => {
        const world = await emptyWorld(key, scratch);
        const [sealed] = await world.store.putMany([{ kind: "run", value: fixtureRunRecord(CANARY) }]);
        const held = withTestimony ? [(await putTestimony(world)).run] : [];
        const { claim: attacked } = await attackedClaim(world, "attacked", [sealed!, ...held]);
        await world.store.putMany([{ kind: "case", value: fixtureCase("cites", [attacked]) }]);
        await seal(world, sealed!);
        const planned: OperationContext = { ...world.station, mode: "plan" };

        const status = await runHandler(claimStatus, { claim: slotOf("attacked") }, planned);
        const why = await runHandler(claimWhy, { claim: slotOf("attacked"), full: true }, planned);
        const soundcheck = await runHandler(caseSoundcheck, { case: "cites" }, planned);

        expect([status.label, status.reason]).toEqual(["open", "contested-authority"]);
        expect(why.detail).toBe(`contested on grounds withheld under the clearance ${WRITER}`);
        expect(soundcheck.claims.map((claim) => claim.label)).toEqual(["open"]);
        for (const output of await claimReadings(world.station, "attacked", attacked, "cites")) {
          expect(output).not.toContain(CANARY);
          expect(output).not.toContain(sealed!);
        }
      },
      120_000,
    );

    test("a station's brief names an argument contesting on withheld grounds, and a ruling on it reads fresh", async () => {
      const world = await emptyWorld(key, scratch);
      const [sealed] = await world.store.putMany([{ kind: "run", value: fixtureRunRecord(CANARY) }]);
      const { claim: attacked, argument } = await attackedClaim(world, "attacked", [sealed!]);
      await world.store.putMany([{ kind: "case", value: fixtureCase("cites", [attacked]) }]);
      await seal(world, sealed!);

      const planned = await runHandler(briefRender, { claim: attacked }, { ...world.station, mode: "plan" });
      const rendered = await runHandler(briefRender, { claim: attacked }, world.station);
      const run = (await world.store.read(rendered.brief, "run")) as ComputedRunRecord;
      const { head, caseId } = parseBriefSubstrates(run.recipe);
      using station = await openWorkspace(world.station);
      const staleness = await fullReadIds(station, caseId, attacked, head, WRITER);
      const verdict = { claim: attacked, verdict: "holds", reason: "it holds", brief: rendered.brief } as const;
      await writeSignerConfig(join(world.workspace, MUSAI_DIR, LOCAL_DIR), { keyPath: key.keyPath });
      await runHandler(rulingMake, verdict, world.station);
      const authors = await runHandler(claimStatus, { claim: slotOf("attacked") }, { ...world.author, mode: "plan" });

      expect(rendered.output).toContain(
        `- argument ${argument} contests the claim on grounds withheld under the clearance ${WRITER}: it does not hold`,
      );
      expect(planned.brief).toBe(rendered.brief);
      expect(new Set(contentIdsOf(run.observation.reads))).toEqual(new Set(staleness));
      expect(staleness).toContain(argument);
      expect(authors).toMatchObject({ label: "holds", decidedBy: { kind: "ruling" } });
      expect(authors.decidedOnStaleEvidence).toBeUndefined();
      for (const hidden of [CANARY, sealed!]) {
        expect(JSON.stringify(run)).not.toContain(hidden);
      }
    }, 120_000);

    test("a station's brief names an argument against the claim's receipt on withheld grounds, and a ruling on it reads fresh", async () => {
      const world = await emptyWorld(key, scratch);
      const [sealed] = await world.store.putMany([{ kind: "run", value: fixtureRunRecord(CANARY) }]);
      const { claim: attacked, argument, receipt } = await attackedClaim(world, "attacked", [sealed!], true);
      await world.store.putMany([{ kind: "case", value: fixtureCase("cites", [attacked]) }]);
      await seal(world, sealed!);
      const planned: OperationContext = { ...world.station, mode: "plan" };

      const status = await runHandler(claimStatus, { claim: slotOf("attacked") }, planned);
      const rendered = await runHandler(briefRender, { claim: attacked }, world.station);
      const run = (await world.store.read(rendered.brief, "run")) as ComputedRunRecord;
      const { head, caseId } = parseBriefSubstrates(run.recipe);
      using station = await openWorkspace(world.station);
      const staleness = await fullReadIds(station, caseId, attacked, head, WRITER);
      const verdict = { claim: attacked, verdict: "holds", reason: "it holds", brief: rendered.brief } as const;
      await writeSignerConfig(join(world.workspace, MUSAI_DIR, LOCAL_DIR), { keyPath: key.keyPath });
      await runHandler(rulingMake, verdict, world.station);
      const authors = await runHandler(claimStatus, { claim: slotOf("attacked") }, { ...world.author, mode: "plan" });

      expect([status.label, status.reason]).toEqual(["open", "contested-authority"]);
      expect(rendered.output).toContain(
        `- argument ${argument} contests the run ${receipt} on grounds withheld under the clearance ${WRITER}: it does not hold`,
      );
      expect(new Set(contentIdsOf(run.observation.reads))).toEqual(new Set(staleness));
      expect(staleness).toContain(argument);
      expect(authors).toMatchObject({ label: "holds", decidedBy: { kind: "ruling" } });
      expect(authors.decidedOnStaleEvidence).toBeUndefined();
      for (const output of [
        JSON.stringify(run),
        ...(await claimReadings(world.station, "attacked", attacked, "cites")),
      ]) {
        expect(output).not.toContain(CANARY);
        expect(output).not.toContain(sealed!);
      }
    }, 120_000);

    /** A check the record-need rule judges over a held record, cited by a case. */
    async function checkedWorld() {
      const world = await restingWorld(key, scratch);
      const [record] = await world.store.putMany([
        { kind: "run", value: fixtureRunRecord("the record the rule asks for") },
      ]);
      const [checked] = await world.store.putMany([
        { kind: "claim", value: claim("checked", { [RECORD_NEED_RULE]: record! }) },
      ]);
      await world.store.putMany([{ kind: "case", value: fixtureCase("checks", [checked!]) }]);
      return { ...world, checked: checked!, checkedRecord: record! };
    }

    /** The receipts the check's latest evaluation under `context` rests on. */
    async function checkReceiptsUnder(context: OperationContext): Promise<readonly RecordId[]> {
      const opened = await openWorkspace(context);
      onTestFinished(() => opened.close());
      const checked = opened.index.claimAtSlot(slotOf("checked"))!.record as ClaimRecord;
      const chosen = checkEvaluation(opened.index, checked, () => true, opened.clearance);
      return recordedEvaluation(chosen!.evaluation).receipts;
    }

    async function argueAgainst(world: World, target: RecordId, evidence: readonly RecordId[], reason: string) {
      const argument: ArgumentRecord = {
        kind: "argument",
        premises: [],
        supersedes: [],
        schemaVersion: CURRENT_SCHEMA_VERSIONS.argument,
        target,
        reason,
        evidence: evidence.map(receiptEdge),
      };
      const [argued] = await world.store.putMany([{ kind: "argument", value: argument }]);
      return argued!;
    }

    /** A brief's run, and every id staleness checks it against at the head it was rendered at. */
    async function readsAtHead(world: World, context: OperationContext, claimId: RecordId, brief: RecordId) {
      const run = (await world.store.read(brief, "run")) as ComputedRunRecord;
      const { head, caseId } = parseBriefSubstrates(run.recipe);
      const opened = await openWorkspace(context);
      onTestFinished(() => opened.close());
      return { run, staleness: await fullReadIds(opened, caseId, claimId, head, opened.clearance) };
    }

    test("a check challenged at its receipt has a brief packing the receipt and the challenge, and a ruling on it reads fresh", async () => {
      const world = await checkedWorld();
      expect((await runHandler(claimStatus, { claim: slotOf("checked") }, world.author)).label).toBe("holds");
      const [receipt] = await checkReceiptsUnder(world.author);
      const [counter] = await world.store.putMany([
        { kind: "run", value: fixtureRunRecord("the challenge's own run") },
      ]);
      const argument = await argueAgainst(world, receipt!, [counter!], "it passes for the wrong reason");
      const planned: OperationContext = { ...world.author, mode: "plan" };

      const contested = await runHandler(claimStatus, { claim: slotOf("checked") }, planned);
      const rendered = await runHandler(briefRender, { claim: world.checked }, world.author);
      const { run, staleness } = await readsAtHead(world, world.author, world.checked, rendered.brief);
      const verdict = { claim: world.checked, verdict: "holds", reason: "it holds", brief: rendered.brief } as const;
      await writeSignerConfig(join(world.workspace, MUSAI_DIR, LOCAL_DIR), { keyPath: key.keyPath });
      await runHandler(rulingMake, verdict, world.author);
      const ruled = await runHandler(claimStatus, { claim: slotOf("checked") }, planned);

      expect(contested.label).toBe("open");
      expect(rendered.output).toContain(`## Direct evidence\n- receipt ${receipt} (rule ${RECORD_NEED_RULE})\n`);
      expect(rendered.output).toContain(
        `- receipt ${counter} (musai.core/exit-code@1:result) against the run ${receipt}: it passes for the wrong reason`,
      );
      expect(new Set(contentIdsOf(run.observation.reads))).toEqual(new Set(staleness));
      expect(staleness).toEqual(expect.arrayContaining([receipt, counter, argument]));
      expect(ruled).toMatchObject({ label: "holds", decidedBy: { kind: "ruling" } });
      expect(ruled.decidedOnStaleEvidence).toBeUndefined();
    }, 240_000);

    test("a station's brief on a failing check challenged at its receipt on withheld grounds packs the receipt as attacking and the pinned contest, naming nothing withheld", async () => {
      const world = await checkedWorld();
      const failed = await answerStationRun(world, "a failing run in the station's image", 1);
      const failing = await runHandler(claimStatus, { claim: slotOf("checked") }, world.station);
      expect(await checkReceiptsUnder(world.station)).toEqual([failed]);
      const [sealed] = await world.store.putMany([{ kind: "run", value: fixtureRunRecord(CANARY) }]);
      const argument = await argueAgainst(world, failed, [sealed!], "it fails for the wrong reason");
      await seal(world, sealed!);

      const status = await runHandler(claimStatus, { claim: slotOf("checked") }, { ...world.station, mode: "plan" });
      const rendered = await runHandler(briefRender, { claim: world.checked }, world.station);
      const { run, staleness } = await readsAtHead(world, world.station, world.checked, rendered.brief);

      expect(failing.label).toBe("fails");
      expect([status.label, status.reason]).toEqual(["open", "contested-authority"]);
      expect(rendered.output).toContain(
        `## Attacking evidence\n- receipt ${failed} (rule ${RECORD_NEED_RULE}, which fails)\n`,
      );
      expect(rendered.output).toContain(
        `- argument ${argument} contests the run ${failed} on grounds withheld under the clearance ${WRITER}: it fails for the wrong reason`,
      );
      expect(new Set(contentIdsOf(run.observation.reads))).toEqual(new Set(staleness));
      expect(staleness).toEqual(expect.arrayContaining([failed, argument]));
      for (const output of [JSON.stringify(run), JSON.stringify(status), rendered.output]) {
        expect(output).not.toContain(CANARY);
        expect(output).not.toContain(sealed!);
      }
    }, 240_000);

    test("a station's brief on a check challenged at its receipt on withheld grounds packs the receipt and the pinned contest, naming nothing withheld", async () => {
      const world = await checkedWorld();
      expect((await runHandler(claimStatus, { claim: slotOf("checked") }, world.station)).label).toBe("holds");
      expect(await checkReceiptsUnder(world.station)).toEqual([world.stationRun]);
      const [sealed] = await world.store.putMany([{ kind: "run", value: fixtureRunRecord(CANARY) }]);
      const argument = await argueAgainst(world, world.stationRun, [sealed!], "it does not hold");
      await seal(world, sealed!);

      const status = await runHandler(claimStatus, { claim: slotOf("checked") }, { ...world.station, mode: "plan" });
      const rendered = await runHandler(briefRender, { claim: world.checked }, world.station);
      const { run, staleness } = await readsAtHead(world, world.station, world.checked, rendered.brief);

      expect([status.label, status.reason]).toEqual(["open", "contested-authority"]);
      expect(rendered.output).toContain(
        `## Direct evidence\n- receipt ${world.stationRun} (rule ${RECORD_NEED_RULE})\n`,
      );
      expect(rendered.output).toContain(
        `- argument ${argument} contests the run ${world.stationRun} on grounds withheld under the clearance ${WRITER}: it does not hold`,
      );
      expect(new Set(contentIdsOf(run.observation.reads))).toEqual(new Set(staleness));
      expect(staleness).toContain(argument);
      expect(JSON.stringify(run)).not.toContain(CANARY);
      expect(JSON.stringify(run)).not.toContain(sealed!);
    }, 240_000);

    test("a station's brief trims an argument's held evidence whole, apart from its pinned contest on withheld grounds", async () => {
      const world = await emptyWorld(key, scratch);
      const [own, held, sealed] = await world.store.putMany([
        { kind: "run", value: fixtureRunRecord("the claim's own receipt") },
        { kind: "run", value: fixtureRunRecord("a receipt the station holds") },
        { kind: "run", value: fixtureRunRecord(CANARY) },
      ]);
      const [mixed] = await world.store.putMany([{ kind: "claim", value: claim("mixed", {}, [receiptEdge(own!)]) }]);
      // A reason long enough that omitting the held line saves more than the omission list costs.
      const reason = "it does not hold on any input the station has seen";
      const argument = await argueAgainst(world, mixed!, [held!, sealed!], reason);
      await world.store.putMany([{ kind: "case", value: fixtureCase("mixed", [mixed!]) }]);
      await seal(world, sealed!);
      const planned: OperationContext = { ...world.station, mode: "plan" };
      const itemLines = (output: string) => output.split("\n").filter((line) => line.startsWith("- "));
      const full = await runHandler(briefRender, { claim: mixed! }, planned);
      expect(full.output).toContain(`- argument ${argument} contests the claim on grounds withheld`);

      let mostOmitted = 0;
      for (let budget = Buffer.byteLength(full.output); ; budget -= 8) {
        const rendered = await runHandler(briefRender, { claim: mixed!, budget }, planned).catch(
          (error: unknown) => error,
        );
        if (isOperationError(rendered)) {
          break;
        }
        const { output } = rendered as { readonly output: string };
        const omitted = itemLines(output).filter((line) => line.endsWith("— omitted (over-budget)"));
        const printed = itemLines(output).filter((line) => line.startsWith(`- receipt ${held}`));
        expect(printed.length + omitted.length).toBe(1);
        expect(Buffer.byteLength(output)).toBeLessThanOrEqual(budget);
        expect(output).toContain(`- argument ${argument} contests the claim on grounds withheld`);
        expect(output).not.toContain(CANARY);
        expect(output).not.toContain(sealed!);
        mostOmitted = Math.max(mostOmitted, omitted.length);
      }
      expect(mostOmitted).toBe(1);
    }, 240_000);

    /** The check's claim read without performing, and its brief, both as the author. */
    async function readUnperformed(world: World, slot: string, claimId: RecordId) {
      const status = await runHandler(claimStatus, { claim: slot }, { ...world.author, mode: "plan" });
      const rendered = await runHandler(briefRender, { claim: claimId }, world.author);
      return { status, brief: rendered.output };
    }

    test("a check no evaluation has judged reads open without performing, and its brief packs no receipt", async () => {
      const world = await checkedWorld();
      expect((await runHandler(claimStatus, { claim: slotOf("checked") }, world.author)).label).toBe("holds");
      const [twin] = await world.store.putMany([
        { kind: "claim", value: claim("twin", { [RECORD_NEED_RULE]: world.checkedRecord }) },
      ]);
      await world.store.putMany([{ kind: "case", value: fixtureCase("twins", [twin!]) }]);

      const { status, brief } = await readUnperformed(world, slotOf("twin"), twin!);

      expect([status.label, status.detail]).toEqual([
        "open",
        "nothing has evaluated this check here yet; `status` evaluates it",
      ]);
      expect(brief).not.toContain(`(rule ${RECORD_NEED_RULE})`);
    }, 240_000);

    test("a check its rule's current build has not evaluated reads open without performing, and its brief packs no receipt", async () => {
      const world = await checkedWorld();
      expect((await runHandler(claimStatus, { claim: slotOf("checked") }, world.author)).label).toBe("holds");
      await rebuildRecordNeed(world, "2026-10-10T00:00:00.000Z");

      const unperformed = await readUnperformed(world, slotOf("checked"), world.checked);
      expect((await runHandler(claimStatus, { claim: slotOf("checked") }, world.author)).label).toBe("holds");
      const performed = await readUnperformed(world, slotOf("checked"), world.checked);

      expect(unperformed.status.label).toBe("open");
      expect(unperformed.brief).not.toContain(`(rule ${RECORD_NEED_RULE})`);
      expect(performed.status.label).toBe("holds");
      const [receipt] = await checkReceiptsUnder(world.author);
      expect(performed.brief).toContain(`- receipt ${receipt} (rule ${RECORD_NEED_RULE})`);
    }, 240_000);

    test("a brief over a check unrun since its rule's rebuild says so in a pinned line, and a ruling over it is refused once status runs it", async () => {
      const world = await checkedWorld();
      for (const context of [world.author, world.station]) {
        expect((await runHandler(claimStatus, { claim: slotOf("checked") }, context)).label).toBe("holds");
      }
      await rebuildRecordNeed(world, "2026-10-10T00:00:00.000Z");
      const status = `\`status ${shortIdOf(slotOf("checked"))}\``;
      const unrun = (advice: string) =>
        `- the claim's check has not run since its rule was rebuilt; ${advice} evaluates it`;

      const briefs = [
        await runHandler(briefRender, { claim: world.checked }, world.author),
        await runHandler(briefRender, { claim: world.checked }, world.station),
      ];
      await writeSignerConfig(join(world.workspace, MUSAI_DIR, LOCAL_DIR), { keyPath: key.keyPath });
      await runHandler(claimStatus, { claim: slotOf("checked") }, world.author);
      const [receipt] = await checkReceiptsUnder(world.author);
      const verdict = { claim: world.checked, verdict: "holds", reason: "it holds", brief: briefs[0]!.brief } as const;
      const refused = await runHandler(rulingMake, verdict, world.author).catch((e: unknown) => e);
      const evaluated = await runHandler(briefRender, { claim: world.checked }, world.author);

      for (const [{ output }, advice] of [
        [briefs[0]!, status],
        [briefs[1]!, `${status} under the clearance ${WRITER}`],
      ] as const) {
        expect(output.split("\n").filter((line) => line === unrun(advice))).toHaveLength(1);
        expect(output).not.toContain(`(rule ${RECORD_NEED_RULE})`);
      }
      expect(refused).toMatchObject({
        reason: "stale",
        detail: expect.stringContaining(`- ${receipt}: was unread, now read`),
      });
      expect(evaluated.output).not.toContain("has not run since its rule was rebuilt");
      expect(evaluated.output).toContain(`- receipt ${receipt} (rule ${RECORD_NEED_RULE})`);
    }, 240_000);

    test("a brief over a check unrun since its rule's rebuild keeps its pinned line under a budget that trims", async () => {
      const world = await checkedWorld();
      expect((await runHandler(claimStatus, { claim: slotOf("checked") }, world.author)).label).toBe("holds");
      await argueAgainst(world, world.checked, [world.checkedRecord], "a long argument ".repeat(20));
      await rebuildRecordNeed(world, "2026-10-10T00:00:00.000Z");
      const whole = await runHandler(briefRender, { claim: world.checked }, world.author);
      // Room for everything but the argument's long line, so the trim must take it.
      const budget = Buffer.byteLength(whole.output) - 1;

      const trimmed = await runHandler(briefRender, { claim: world.checked, budget }, world.author);

      expect(trimmed.output).toContain("## Omitted");
      expect(trimmed.output).toContain("has not run since its rule was rebuilt");
    }, 240_000);

    test("a ruling on a check reads fresh from the status that first evaluates it after a rebuild, on the same receipts", async () => {
      const world = await checkedWorld();
      expect((await runHandler(claimStatus, { claim: slotOf("checked") }, world.author)).label).toBe("holds");
      const rendered = await runHandler(briefRender, { claim: world.checked }, world.author);
      const verdict = { claim: world.checked, verdict: "holds", reason: "it holds", brief: rendered.brief } as const;
      await writeSignerConfig(join(world.workspace, MUSAI_DIR, LOCAL_DIR), { keyPath: key.keyPath });
      await runHandler(rulingMake, verdict, world.author);
      const [before] = await checkReceiptsUnder(world.author);
      await rebuildRecordNeed(world, "2026-10-10T00:00:00.000Z");

      const evaluating = await runHandler(claimStatus, { claim: slotOf("checked") }, world.author);
      const reread = await runHandler(claimStatus, { claim: slotOf("checked") }, { ...world.author, mode: "plan" });

      expect(await checkReceiptsUnder(world.author)).toEqual([before]);
      for (const status of [evaluating, reread]) {
        expect(status).toMatchObject({ label: "holds", decidedBy: { kind: "ruling" } });
        expect(status.decidedOnStaleEvidence).toBeUndefined();
      }
    }, 240_000);

    /** The interpreter's condition over a clean exit passing `tag`: one receipt per tag. */
    function exitsCleanly(tag: string): string {
      const recipe = {
        command: ["node", "-e", "process.exit(0)", tag],
        workingDirectory: "/",
        environment: {},
        declared: [],
        substrates: [],
        isolation: "hygiene",
      };
      return JSON.stringify({
        recipes: [{ name: "r", kind: "run", recipe }],
        expectations: [{ kind: "exitCodeIs", recipe: "r", value: 0 }],
      });
    }

    /** A menu of two checks, each ruled on over its sibling's brief, then the core rebuilt. */
    async function rebuiltMenu(): Promise<World> {
      const world = await restingWorld(key, scratch);
      const option = (id: string) => ({
        ...claim(id, { gateClass: "intent", disposition: id, [DECLARATIVE_RULE]: exitsCleanly(id) }),
        exclusiveGroup: "menu",
      });
      const [chosen, other] = await world.store.putMany([
        { kind: "claim", value: option("chosen") },
        { kind: "claim", value: option("other") },
      ]);
      await world.store.putMany([{ kind: "case", value: fixtureCase("menu", [chosen!, other!]) }]);
      // Performing runs both checks, and the menu awaits its answer however they read.
      expect((await runHandler(caseStatus, { case: "menu" }, world.author)).counts).toEqual({
        holds: 0,
        fails: 0,
        open: 1,
        notChosen: 0,
      });
      await writeSignerConfig(join(world.workspace, MUSAI_DIR, LOCAL_DIR), { keyPath: key.keyPath });
      // Each option is ruled on over its sibling's brief, as an answer choosing another option is.
      for (const [ruled, asked, verdict] of [
        [chosen!, other!, "holds"],
        [other!, chosen!, "fails"],
      ] as const) {
        const { brief } = await runHandler(briefRender, { claim: asked }, world.author);
        await runHandler(rulingMake, { claim: ruled, verdict, reason: verdict, brief }, world.author);
      }
      await rebuildCore(world, "2026-10-10T00:00:00.000Z");
      return world;
    }

    /** The runs the store holds whose recipe's command names `tag` or its slot. */
    async function runsNaming(world: World, tag: string): Promise<RecordId[]> {
      const named: RecordId[] = [];
      for (const id of await world.store.list("run")) {
        const { command } = ((await world.store.read(id, "run")) as RunRecord).recipe;
        if (command.includes(tag) || command.includes(slotOf(tag))) {
          named.push(id);
        }
      }
      return named;
    }

    test("a performing status on one menu option after a rebuild reads its ruling over the sibling's brief stale, naming the sibling, and runs nothing of it", async () => {
      const world = await rebuiltMenu();
      const before = await runsNaming(world, "other");
      const short = shortIdOf(slotOf("other"));

      const status = await runHandler(claimStatus, { claim: slotOf("chosen") }, world.author);
      const ran = await runsNaming(world, "other");
      await runHandler(claimStatus, { claim: slotOf("other") }, world.author);
      const reread = await runHandler(claimStatus, { claim: slotOf("chosen") }, { ...world.author, mode: "plan" });

      expect(status).toMatchObject({
        label: "holds",
        decidedOnStaleEvidence: true,
        detail: `decided on a brief over ${short}, whose check has not run since its rule was rebuilt; \`status ${short}\` evaluates it`,
      });
      expect(ran).toEqual(before);
      expect(reread.label).toBe("holds");
      expect(reread.decidedOnStaleEvidence).toBeUndefined();
      expect(reread.detail).toBeUndefined();
    }, 240_000);

    test("a ruling over a sibling's brief that packed no check of it reads stale for its own cause, naming no unrun check", async () => {
      const world = await restingWorld(key, scratch);
      const option = (id: string, rendering = id) => ({
        ...claim(id, { gateClass: "intent", disposition: id, [DECLARATIVE_RULE]: exitsCleanly(id) }, [], rendering),
        exclusiveGroup: "menu",
      });
      const [chosen, other] = await world.store.putMany([
        { kind: "claim", value: option("chosen") },
        { kind: "claim", value: option("other") },
      ]);
      await world.store.putMany([{ kind: "case", value: fixtureCase("menu", [chosen!, other!]) }]);
      await writeSignerConfig(join(world.workspace, MUSAI_DIR, LOCAL_DIR), { keyPath: key.keyPath });
      const { brief } = await runHandler(briefRender, { claim: other! }, world.author);
      await runHandler(rulingMake, { claim: chosen!, verdict: "holds", reason: "holds", brief }, world.author);
      await world.store.putMany([
        { kind: "claim", value: { ...option("other", "other, restated"), supersedes: [other!] } },
      ]);

      const status = await runHandler(claimStatus, { claim: slotOf("chosen") }, world.author);

      expect(status).toMatchObject({ label: "holds", decidedOnStaleEvidence: true });
      expect(status.detail).toBeUndefined();
    }, 240_000);

    test("a performing case status after a rebuild reads fresh the rulings on a menu of two checks, each over its sibling's brief", async () => {
      const world = await rebuiltMenu();

      const first = await runHandler(caseStatus, { case: "menu" }, world.author);
      const reread = await runHandler(caseStatus, { case: "menu" }, world.author);

      for (const status of [first, reread]) {
        expect(status).toMatchObject({ counts: { holds: 1, notChosen: 1 } });
        expect(status.flagged).toBeUndefined();
      }
    }, 240_000);

    test("no brief renders and no ruling is made over a check whose evaluation moved, until status evaluates it again", async () => {
      const world = await restingWorld(key, scratch);
      const [briefed, sharing] = await world.store.putMany([
        { kind: "claim", value: claim("briefed", { [DECLARATIVE_RULE]: exitsCleanly("shared") }) },
        { kind: "claim", value: claim("sharing", { [DECLARATIVE_RULE]: exitsCleanly("shared") }) },
      ]);
      await world.store.putMany([{ kind: "case", value: fixtureCase("shared", [briefed!, sharing!]) }]);
      expect((await runHandler(claimStatus, { claim: slotOf("briefed") }, world.author)).label).toBe("holds");
      const { brief } = await runHandler(briefRender, { claim: briefed! }, world.author);
      await writeSignerConfig(join(world.workspace, MUSAI_DIR, LOCAL_DIR), { keyPath: key.keyPath });
      // A moving clock, so the sibling spawns a newer receipt for the recipe the first one read.
      await runHandler(claimStatus, { claim: slotOf("sharing") }, { ...world.author, now: clockFromEnvironment() });
      const ruling = (rendered: RecordId) =>
        ({ claim: briefed!, verdict: "holds", reason: "it holds", brief: rendered }) as const;

      const refusals = [
        await runHandler(briefRender, { claim: briefed! }, { ...world.author, mode: "plan" }).catch((e: unknown) => e),
        await runHandler(rulingMake, ruling(brief), world.author).catch((e: unknown) => e),
      ];
      await runHandler(claimStatus, { claim: slotOf("briefed") }, world.author);
      const overTheOld = await runHandler(rulingMake, ruling(brief), world.author).catch((e: unknown) => e);
      const fresh = await runHandler(briefRender, { claim: briefed! }, world.author);
      await runHandler(rulingMake, ruling(fresh.brief), world.author);
      const ruled = await runHandler(claimStatus, { claim: slotOf("briefed") }, { ...world.author, mode: "plan" });

      for (const refusal of refusals) {
        expect(refusal).toMatchObject({
          reason: "stale",
          detail: expect.stringContaining("a newer receipt landed for a recipe this check's evaluation read"),
        });
        expect(refusal).toMatchObject({
          detail: expect.stringContaining(`\`status ${shortIdOf(slotOf("briefed"))}\``),
        });
      }
      expect(overTheOld).toMatchObject({
        reason: "stale",
        detail: expect.stringContaining(
          `refusing to rule over the brief ${brief}: evidence moved since it was rendered`,
        ),
      });
      expect(ruled).toMatchObject({ label: "holds", decidedBy: { kind: "ruling" } });
      expect(ruled.decidedOnStaleEvidence).toBeUndefined();
    }, 240_000);

    test("a gate answered over its brief once the check's evaluation it packs has moved is refused, naming the move", async () => {
      const world = await restingWorld(key, scratch);
      const [asked, sharing] = await world.store.putMany([
        { kind: "claim", value: claim("asked", { gateClass: "judgment", [DECLARATIVE_RULE]: exitsCleanly("gated") }) },
        { kind: "claim", value: claim("sharing", { [DECLARATIVE_RULE]: exitsCleanly("gated") }) },
      ]);
      await world.store.putMany([{ kind: "case", value: fixtureCase("gated", [asked!, sharing!]) }]);
      await runHandler(claimStatus, { claim: slotOf("asked") }, world.author);
      await writeSignerConfig(join(world.workspace, MUSAI_DIR, LOCAL_DIR), { keyPath: key.keyPath });
      const { brief } = await runHandler(gateAsk, { claim: asked! }, world.author);
      // A moving clock, so the sibling spawns a newer receipt for the recipe the gate's check read.
      await runHandler(claimStatus, { claim: slotOf("sharing") }, { ...world.author, now: clockFromEnvironment() });

      const answer = { pending: asked!, brief, choice: "holds", reason: "it holds" };
      const refused = await runHandler(gateAnswer, answer, world.author).catch((e: unknown) => e);

      expect(refused).toMatchObject({
        reason: "stale",
        detail: expect.stringContaining("a newer receipt landed for a recipe this check's evaluation read"),
      });
    }, 240_000);

    test("a ruling refused over a station's brief whose evaluation moved names the clearance its status runs under", async () => {
      const world = await restingWorld(key, scratch);
      await runHandler(claimStatus, { claim: slotOf("rests-on") }, world.station);
      const { brief } = await runHandler(briefRender, { claim: world.restsOn }, world.station);
      const restated = {
        ...claim("rests-on", { [RECORD_NEED_RULE]: SEALED_ID }, [], "restated"),
        supersedes: [world.restsOn],
      };
      const [successor] = await world.store.putMany([{ kind: "claim", value: restated }]);
      await writeSignerConfig(join(world.workspace, MUSAI_DIR, LOCAL_DIR), { keyPath: key.keyPath });

      const verdict = { claim: successor!, verdict: "holds", reason: "it holds", brief } as const;
      const refused = await runHandler(rulingMake, verdict, world.author).catch((e: unknown) => e);

      expect(refused).toMatchObject({
        reason: "stale",
        detail: expect.stringContaining(
          `this claim changed since its check was evaluated, so the receipts it packs no longer stand; run \`status ${shortIdOf(slotOf("rests-on"))}\` under the clearance ${WRITER}`,
        ),
      });
    }, 240_000);

    /** A check the station holds on and briefs, the author's receipt for its run landed first
     * through a twin claim, so the author's own status after the brief lands no newer receipt. */
    async function stationBriefed() {
      const world = await checkedWorld();
      await world.store.putMany([{ kind: "claim", value: claim("twin", { [RECORD_NEED_RULE]: world.checkedRecord }) }]);
      expect((await runHandler(claimStatus, { claim: slotOf("twin") }, world.author)).label).toBe("holds");
      expect((await runHandler(claimStatus, { claim: slotOf("checked") }, world.station)).label).toBe("holds");
      const { brief } = await runHandler(briefRender, { claim: world.checked }, world.station);
      await writeSignerConfig(join(world.workspace, MUSAI_DIR, LOCAL_DIR), { keyPath: key.keyPath });
      return { world, verdict: { claim: world.checked, verdict: "holds", reason: "it holds", brief } as const };
    }

    test("an author's ruling over a station's brief is held to the station's evaluation, not the author's own", async () => {
      const { world, verdict } = await stationBriefed();
      expect((await runHandler(claimStatus, { claim: slotOf("checked") }, world.author)).label).toBe("holds");

      const ruled = await runHandler(rulingMake, verdict, world.author);

      expect(ruled.minted.map(({ kind }) => kind)).toContain("ruling");
    }, 240_000);

    test("an author's ruling over a station's brief is refused once the station evaluates on other receipts", async () => {
      const { world, verdict } = await stationBriefed();
      await answerStationRun(world, "a later run in the station's image");
      await runHandler(claimStatus, { claim: slotOf("checked") }, world.station);

      const refused = await runHandler(rulingMake, verdict, world.author).catch((e: unknown) => e);

      expect(refused).toMatchObject({
        reason: "stale",
        detail: expect.stringContaining(
          `evidence moved since it was rendered:\n- ${world.stationRun}: was read, now unread`,
        ),
      });
    }, 240_000);

    test("an author's ruling over a station's brief is refused for an argument the station sees landing since, never for one sealed from it", async () => {
      const world = await restingWorld(key, scratch);
      const [run, grounds, seen] = await world.store.putMany([
        { kind: "run", value: fixtureRunRecord("the run the claim cites") },
        { kind: "run", value: fixtureRunRecord("the sealed argument's grounds") },
        { kind: "run", value: fixtureRunRecord("the seen argument's grounds") },
      ]);
      const [cites] = await world.store.putMany([{ kind: "claim", value: claim("cites", {}, [receiptEdge(run!)]) }]);
      await world.store.putMany([{ kind: "case", value: fixtureCase("cites", [cites!]) }]);
      const { brief } = await runHandler(briefRender, { claim: cites! }, world.station);
      await writeSignerConfig(join(world.workspace, MUSAI_DIR, LOCAL_DIR), { keyPath: key.keyPath });
      const sealedArgument = await argueAgainst(world, cites!, [grounds!], CANARY);
      await seal(world, sealedArgument);
      const verdict = { claim: cites!, verdict: "holds", reason: "it holds", brief } as const;

      const ruled = await runHandler(rulingMake, verdict, world.author);
      const seenArgument = await argueAgainst(world, cites!, [seen!], "the station sees this one");
      const refused = await runHandler(rulingMake, verdict, world.author).catch((e: unknown) => e);

      expect(ruled.minted.map(({ kind }) => kind)).toContain("ruling");
      expect(refused).toMatchObject({
        reason: "stale",
        detail: expect.stringContaining(`- ${seenArgument}: was unread, now read`),
      });
      expect(JSON.stringify(refused)).toContain(seenArgument);
      for (const hidden of [sealedArgument, grounds!, CANARY]) {
        expect(JSON.stringify(refused)).not.toContain(hidden);
      }
    }, 240_000);

    test("a station's ruling over a brief rendered without a clearance is refused, naming none of what lands sealed from the station since", async () => {
      const world = await emptyWorld(key, scratch);
      const [run, grounds] = await world.store.putMany([
        { kind: "run", value: fixtureRunRecord("the run the claim cites") },
        { kind: "run", value: fixtureRunRecord("the sealed argument's grounds") },
      ]);
      const [cites] = await world.store.putMany([{ kind: "claim", value: claim("cites", {}, [receiptEdge(run!)]) }]);
      await world.store.putMany([{ kind: "case", value: fixtureCase("cites", [cites!]) }]);
      const { brief } = await runHandler(briefRender, { claim: cites! }, world.author);
      await writeSignerConfig(join(world.workspace, MUSAI_DIR, LOCAL_DIR), { keyPath: key.keyPath });
      const sealedArgument = await argueAgainst(world, cites!, [grounds!], CANARY);
      await seal(world, sealedArgument);

      const verdict = { claim: cites!, verdict: "holds", reason: "it holds", brief } as const;
      const refused = await runHandler(rulingMake, verdict, world.station).catch((e: unknown) => e);

      expect(refused).toMatchObject({
        reason: "invalid-input",
        about: [brief],
        detail: `refusing to rule over the brief ${brief}: it was rendered without a clearance; render a brief under the clearance ${WRITER} and rule over that`,
      });
      for (const hidden of [sealedArgument, grounds!, CANARY]) {
        expect(JSON.stringify(refused)).not.toContain(hidden);
      }
    }, 120_000);

    test("a station's ruling over a brief rendered under another clearance is refused, naming that clearance", async () => {
      const world = await emptyWorld(key, scratch);
      await writeTrustFile({ gitDir: join(world.workspace, MUSAI_DIR) }, "audiences", "writer\nreader\n");
      const reader: OperationContext = { ...world.author, clearance: "reader" as Audience };
      const [run] = await world.store.putMany([{ kind: "run", value: fixtureRunRecord("the run the claim cites") }]);
      const [cites] = await world.store.putMany([{ kind: "claim", value: claim("cites", {}, [receiptEdge(run!)]) }]);
      await world.store.putMany([{ kind: "case", value: fixtureCase("cites", [cites!]) }]);
      const { brief } = await runHandler(briefRender, { claim: cites! }, reader);
      await writeSignerConfig(join(world.workspace, MUSAI_DIR, LOCAL_DIR), { keyPath: key.keyPath });

      const verdict = { claim: cites!, verdict: "holds", reason: "it holds", brief } as const;
      const refused = await runHandler(rulingMake, verdict, world.station).catch((e: unknown) => e);
      const own = await runHandler(briefRender, { claim: cites! }, world.station);
      const ruled = await runHandler(rulingMake, { ...verdict, brief: own.brief }, world.station);

      expect(refused).toMatchObject({
        reason: "invalid-input",
        detail: expect.stringContaining(
          `it was rendered under the clearance reader; render a brief under the clearance ${WRITER}`,
        ),
      });
      expect(ruled.minted.map(({ kind }) => kind)).toContain("ruling");
    }, 120_000);

    test("an author's ruling over a station's brief whose clearance the audiences file no longer declares is refused, naming the clearance and the remedy", async () => {
      const world = await restingWorld(key, scratch);
      const [run] = await world.store.putMany([{ kind: "run", value: fixtureRunRecord("the run the claim cites") }]);
      const [cites] = await world.store.putMany([{ kind: "claim", value: claim("cites", {}, [receiptEdge(run!)]) }]);
      await world.store.putMany([{ kind: "case", value: fixtureCase("cites", [cites!]) }]);
      const { brief } = await runHandler(briefRender, { claim: cites! }, world.station);
      await writeSignerConfig(join(world.workspace, MUSAI_DIR, LOCAL_DIR), { keyPath: key.keyPath });
      await world.store.putMany([{ kind: "run", value: fixtureRunRecord("a run moving the head") }]);
      await writeTrustFile({ gitDir: join(world.workspace, MUSAI_DIR) }, "audiences", "reader\n");

      const verdict = { claim: cites!, verdict: "holds", reason: "it holds", brief } as const;
      const refused = await runHandler(rulingMake, verdict, world.author).catch((e: unknown) => e);

      expect(refused).toMatchObject({
        reason: "invalid-input",
        about: [WRITER],
        detail: expect.stringContaining(
          `refusing to rule over a brief rendered under the clearance ${WRITER}: the audiences file no longer declares it`,
        ),
      });
      expect(refused).toMatchObject({ detail: expect.stringContaining(`declare ${WRITER} there again`) });
    }, 240_000);

    test("a successor sealed from the clearance moves no evaluation under it, so its brief renders naming none of it", async () => {
      const [sealedWorld, unsealedWorld] = [await restingWorld(key, scratch), await restingWorld(key, scratch)];
      const successors: RecordId[] = [];
      for (const world of [sealedWorld, unsealedWorld]) {
        await runHandler(claimStatus, { claim: slotOf("rests-on") }, world.station);
        const restated = {
          ...claim("rests-on", { [RECORD_NEED_RULE]: SEALED_ID }, [], CANARY),
          supersedes: [world.restsOn],
        };
        successors.push((await world.store.putMany([{ kind: "claim", value: restated }]))[0]!);
      }
      const sealId = await seal(sealedWorld, successors[0]!);
      const planned: OperationContext = { ...sealedWorld.station, mode: "plan" };

      const outputs = [
        await runHandler(briefRender, { claim: sealedWorld.restsOn }, sealedWorld.station),
        await runHandler(claimStatus, { claim: slotOf("rests-on") }, planned),
      ];
      const refused = await runHandler(briefRender, { claim: successors[1]! }, unsealedWorld.station).catch(
        (e: unknown) => e,
      );

      for (const hidden of [CANARY, successors[0]!, sealId]) {
        expect(JSON.stringify(outputs)).not.toContain(hidden);
      }
      expect(outputs[1]).not.toMatchObject({ reason: "stale" });
      expect(refused).toMatchObject({
        reason: "stale",
        detail: expect.stringContaining("this claim changed since its check was evaluated"),
      });
    }, 240_000);

    test("a later evaluation by an earlier build of the rule moves neither the status nor the brief off the current build's", async () => {
      const world = await checkedWorld();
      expect((await runHandler(claimStatus, { claim: slotOf("checked") }, world.author)).label).toBe("holds");
      const opened = await openWorkspace(world.author);
      onTestFinished(() => opened.close());
      const earlier = opened.index.contributionById(RECORD_NEED_RULE)!;
      const [byEarlier] = opened.index.receiptsByRecipe(
        recordId(evaluationRecipe(earlier, slotOf("checked"), undefined)),
      );
      await rebuildRecordNeed(world, "2026-10-10T00:00:00.000Z");
      expect((await runHandler(claimStatus, { claim: slotOf("checked") }, world.author)).label).toBe("holds");
      const [receipt] = await checkReceiptsUnder(world.author);
      const held = byEarlier!.record as ComputedRunRecord;
      await world.store.putMany([
        {
          kind: "run",
          value: {
            ...held,
            supersedes: [byEarlier!.recordId],
            observation: { ...held.observation, output: JSON.stringify({ label: "fails", reason: "it does not" }) },
          },
        },
      ]);

      const { status, brief } = await readUnperformed(world, slotOf("checked"), world.checked);

      expect(status).toMatchObject({ label: "holds", decidedBy: { kind: "run", id: receipt } });
      expect(brief).toContain(`- receipt ${receipt} (rule ${RECORD_NEED_RULE})`);
    }, 240_000);

    /** A ruling `ruler` makes on its own brief over the check, as `reader` then reads the claim. */
    async function ruledAcross(ruler: "author" | "station", reader: "author" | "station") {
      const world = await checkedWorld();
      for (const context of [world.author, world.station]) {
        expect((await runHandler(claimStatus, { claim: slotOf("checked") }, context)).label).toBe("holds");
      }
      const rendered = await runHandler(briefRender, { claim: world.checked }, world[ruler]);
      const verdict = { claim: world.checked, verdict: "holds", reason: "it holds", brief: rendered.brief } as const;
      await writeSignerConfig(join(world.workspace, MUSAI_DIR, LOCAL_DIR), { keyPath: key.keyPath });
      await runHandler(rulingMake, verdict, world[ruler]);
      const read = await runHandler(claimStatus, { claim: slotOf("checked") }, { ...world[reader], mode: "plan" });
      return { rendered, read, receipts: await checkReceiptsUnder(world[ruler]) };
    }

    test("a station's ruling on a check, over the station's own receipt, reads fresh to the author", async () => {
      const { rendered, read, receipts } = await ruledAcross("station", "author");

      expect(rendered.output).toContain(`- receipt ${receipts[0]} (rule ${RECORD_NEED_RULE})`);
      expect(read).toMatchObject({ label: "holds", decidedBy: { kind: "ruling" } });
      expect(read.decidedOnStaleEvidence).toBeUndefined();
    }, 240_000);

    test("an author's ruling on a check, over the author's own receipt, reads fresh to the station", async () => {
      const { rendered, read, receipts } = await ruledAcross("author", "station");

      expect(rendered.output).toContain(`- receipt ${receipts[0]} (rule ${RECORD_NEED_RULE})`);
      expect(read).toMatchObject({ label: "holds", decidedBy: { kind: "ruling" } });
      expect(read.decidedOnStaleEvidence).toBeUndefined();
    }, 240_000);

    /** Both rule on their own briefs, `later` last, the author's reading the station's receipt
     * through a challenge citing it; then the station evaluates on a receipt of its own. */
    async function stationMovesAfterBothRule(later: "author" | "station") {
      const world = await checkedWorld();
      for (const context of [world.author, world.station]) {
        expect((await runHandler(claimStatus, { claim: slotOf("checked") }, context)).label).toBe("holds");
      }
      const [authorReceipt] = await checkReceiptsUnder(world.author);
      await argueAgainst(world, authorReceipt!, [world.stationRun], "the station's run says otherwise");
      await writeSignerConfig(join(world.workspace, MUSAI_DIR, LOCAL_DIR), { keyPath: key.keyPath });
      const earlier = later === "author" ? "station" : "author";
      for (const [ruler, at] of [
        [earlier, "2026-10-09T01:00:00.000Z"],
        [later, "2026-10-09T02:00:00.000Z"],
      ] as const) {
        const rendered = await runHandler(briefRender, { claim: world.checked }, world[ruler]);
        const verdict = { claim: world.checked, verdict: "holds", reason: "it holds", brief: rendered.brief } as const;
        await runHandler(rulingMake, verdict, { ...world[ruler], now: fixedClock(at) });
      }
      const moved = await answerStationRun(world, "a later run in the station's image");
      await runHandler(claimStatus, { claim: slotOf("checked") }, world.station);
      expect(await checkReceiptsUnder(world.station)).toEqual([moved]);
      const readBy = (reader: "author" | "station") =>
        runHandler(claimStatus, { claim: slotOf("checked") }, { ...world[reader], mode: "plan" });
      return { author: await readBy("author"), station: await readBy("station") };
    }

    test("a station evaluating on other receipts leaves its own ruling stale for the author and for the station", async () => {
      const read = await stationMovesAfterBothRule("station");

      for (const status of [read.author, read.station]) {
        expect(status).toMatchObject({ label: "holds", decidedBy: { kind: "ruling" }, decidedOnStaleEvidence: true });
      }
    }, 240_000);

    test("a station evaluating on other receipts leaves the author's ruling fresh for the author and for the station", async () => {
      const read = await stationMovesAfterBothRule("author");

      for (const status of [read.author, read.station]) {
        expect(status).toMatchObject({ label: "holds", decidedBy: { kind: "ruling" } });
        expect(status.decidedOnStaleEvidence).toBeUndefined();
      }
    }, 240_000);

    /** The check evaluated under `reader`, then read without performing once `lands` has run. */
    async function readOnceLanded(reader: "author" | "station", lands: (world: World) => Promise<unknown>) {
      const world = await checkedWorld();
      await world.store.putMany([{ kind: "claim", value: claim("twin", { [RECORD_NEED_RULE]: world.checkedRecord }) }]);
      expect((await runHandler(claimStatus, { claim: slotOf("checked") }, world[reader])).label).toBe("holds");
      await lands(world);
      return runHandler(claimStatus, { claim: slotOf("checked") }, { ...world[reader], mode: "plan" });
    }

    const stationRunsAgain = (world: World) => answerStationRun(world, "a later run in the station's image");
    // A moving clock, so the twin spawns a newer host receipt for the recipe the check read.
    const authorRunsAgain = (world: World) =>
      runHandler(claimStatus, { claim: slotOf("twin") }, { ...world.author, now: clockFromEnvironment() });
    const movedRun = {
      label: "open",
      reason: "stale",
      detail: expect.stringContaining("a newer receipt landed for a recipe this check's evaluation read"),
    };

    test("a station's evaluation reads stale once a newer receipt of its run lands in the station's image", async () => {
      expect(await readOnceLanded("station", stationRunsAgain)).toMatchObject(movedRun);
    }, 240_000);

    test("a station's evaluation stays fresh when the author runs the same recipe on the host", async () => {
      expect(await readOnceLanded("station", authorRunsAgain)).toMatchObject({ label: "holds", reason: null });
    }, 240_000);

    test("an author's evaluation reads stale once a newer receipt of its run lands on the host", async () => {
      expect(await readOnceLanded("author", authorRunsAgain)).toMatchObject(movedRun);
    }, 240_000);

    test("an author's evaluation stays fresh when the station runs the same recipe in its image", async () => {
      expect(await readOnceLanded("author", stationRunsAgain)).toMatchObject({ label: "holds", reason: null });
    }, 240_000);

    test("a closure seal over a check a module's rule judges withholds from the station its own receipts of the run its evaluation read, earlier and later alike", async () => {
      const world = await checkedWorld();
      expect((await runHandler(claimStatus, { claim: slotOf("checked") }, world.station)).label).toBe("holds");
      await seal(world, world.checked, true);

      const later = await stationReceiptReadBeside(world, "a later run in the station's image", slotOf("twin"));

      expect(await heldBy(world.station, [world.stationRun, later])).toEqual([false, false]);
      expect(await heldBy(world.author, [world.stationRun, later])).toEqual([true, true]);
    }, 240_000);

    test("a station's receipt landing after a closure seal over a check a module's rule judges is shown where an evaluation in its commit reads it, and withheld landing alone", async () => {
      const world = await checkedWorld();
      await seal(world, world.checked, true);

      const read = await stationReceiptReadBeside(world, "read beside its evaluation", slotOf("twin"));
      const alone = await answerStationRun(world, "landed alone");

      expect(await heldBy(world.station, [read, alone])).toEqual([true, false]);
    }, 240_000);

    test("a station's check of the sentence a closure-sealed check claims, by the same rule, withholds none of the station's receipts", async () => {
      const world = await restingWorld(key, scratch, (await makeCheckout("hello")).dir);
      const [authorAsks, stationAsks] = await world.store.putMany([
        { kind: "run", value: fixtureRunRecord("the record the author's rule asks for") },
        { kind: "run", value: fixtureRunRecord("the record the station's rule asks for") },
      ]);
      const sentence = { statement: "the record is there", rule: RECORD_NEED_RULE };
      const sealed = await runHandler(checkRun, { ...sentence, parameters: authorAsks! }, world.author);
      await seal(world, sealed.claim as RecordId, true);

      const own = await runHandler(checkRun, { ...sentence, parameters: stationAsks! }, world.station);
      const later = await stationReceiptReadBeside(world, "a later run in the station's image", slotOf("twin"));

      expect([own.slot, own.claim === sealed.claim, own.label]).toEqual([sealed.slot, false, "holds"]);
      expect(await heldBy(world.station, [world.stationRun, later])).toEqual([true, true]);
    }, 240_000);

    /** The author's check of a sentence sealed from the station, and the station's check of it. */
    async function forkedBySentence(world: World) {
      const [authorAsks, stationAsks] = await world.store.putMany([
        { kind: "run", value: fixtureRunRecord("the record the author's rule asks for") },
        { kind: "run", value: fixtureRunRecord("the record the station's rule asks for") },
      ]);
      const sentence = { statement: "the record is there", rule: RECORD_NEED_RULE, parameters: authorAsks! };
      const sealed = await runHandler(checkRun, sentence, world.author);
      await seal(world, sealed.claim as RecordId, true);
      const own = await runHandler(checkRun, { ...sentence, parameters: stationAsks! }, world.station);
      return { sentence, slot: sealed.slot, sealed: sealed.claim as RecordId, own: own.claim as RecordId };
    }

    test("the author's replace closes a forked slot", async () => {
      const world = await restingWorld(key, scratch, (await makeCheckout("hello")).dir);
      const { sentence, slot, sealed, own } = await forkedBySentence(world);
      const planned: OperationContext = { ...world.author, mode: "plan" };

      const forked = await runHandler(claimStatus, { claim: slot }, planned);
      await expect(runHandler(checkRun, sentence, world.author)).rejects.toMatchObject({
        name: "SentenceClaimedError",
      });
      const replaced = await runHandler(checkRun, { ...sentence, replace: true }, world.author);
      const opened = await openWorkspace(world.author);
      const successor = opened.read(replaced.claim as RecordId) as ClaimRecord;
      opened.close();

      expect([forked.label, forked.reason]).toEqual(["open", "forked-slot"]);
      expect(forked.detail).toContain("`check --replace`");
      expect(forked.detail).not.toContain("lab keep");
      expect([...successor.supersedes].sort()).toEqual([sealed, own].sort());
      expect([replaced.slot, replaced.label]).toEqual([slot, "holds"]);
      expect(await runHandler(claimStatus, { claim: slot }, planned)).toMatchObject({ label: "holds" });
    }, 240_000);

    test("a station's cleared fold shows nothing of a fork it cannot see", async () => {
      const world = await restingWorld(key, scratch, (await makeCheckout("hello")).dir);
      const { slot, sealed } = await forkedBySentence(world);
      const planned: OperationContext = { ...world.station, mode: "plan" };

      const status = await runHandler(claimStatus, { claim: slot }, planned);
      const why = await runHandler(claimWhy, { claim: slot, full: true }, planned);
      const doctor = await runHandler(doctorRun, {}, world.station);
      const authors = await runHandler(doctorRun, {}, world.author);

      expect(status.label).toBe("holds");
      expect(authors.local).toContainEqual(expect.objectContaining({ name: "forked-slots", ok: false }));
      for (const output of [status, why, doctor].map((read) => JSON.stringify(read))) {
        expect(output).not.toContain("forked");
        expect(output).not.toContain(sealed.slice(7, 19));
      }
    }, 240_000);

    /** A claim of `type` at the slot its conditions compute, in `group`. */
    async function groupedClaim(
      context: OperationContext,
      type: string,
      conditions: Record<string, string>,
      canonical: Record<string, string>,
      group: string,
    ): Promise<RecordId> {
      const opened = await openWorkspace(context);
      onTestFinished(() => opened.close());
      const record: ClaimRecord = {
        kind: "claim",
        supersedes: [],
        schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
        type,
        about: [],
        slot: slotFor(opened.claimTypes.get(type)!, conditions),
        conditions,
        canonical,
        rendering: `chosen from ${group}`,
        evidence: [],
        exclusiveGroup: group,
      };
      const [id] = await opened.put([{ kind: "claim", value: record }]);
      return id as RecordId;
    }

    test("a station's draft naming another exclusive group at a slot sealed from it leaves the author's slot forked, not unreadable", async () => {
      const world = await emptyWorld(key, scratch);
      for (const dir of [CORE_MODULE_DIR, CASEBOOK_MODULE_DIR]) {
        await runHandler(moduleBuild, { dir }, world.author);
      }
      const slug = "a-report-filed-twice";
      const conditions = { case: slug, disposition: "file", gateClass: "intent" };
      const canonical = { case: slug, disposition: "file" };
      const sealed = await groupedClaim(world.author, CASEBOOK_DISPOSITION, conditions, canonical, "the-authors-menu");
      await seal(world, sealed);
      const booked = await runHandler(caseBook, { slug, about: [], kind: CASEBOOK_KIND }, world.station);
      const own = booked.minted.find(
        ({ kind, record }) => kind === "claim" && (record as ClaimRecord).conditions["disposition"] === "file",
      );
      const slot = (own!.record as ClaimRecord).slot;
      const named = [sealed, own!.id].map(shortIdOf).join(", ");

      const authors = await runHandler(claimStatus, { claim: slot }, { ...world.author, mode: "plan" });
      const doctor = await runHandler(doctorRun, {}, world.author);
      const stations = await runHandler(claimStatus, { claim: slot }, { ...world.station, mode: "plan" });

      expect(authors).toMatchObject({ label: "open", reason: "forked-slot" });
      expect(authors.detail).toContain(named);
      expect(doctor.local).toContainEqual(
        expect.objectContaining({ name: "forked-slots", ok: false, detail: expect.stringContaining(named) }),
      );
      expect(stations.reason).not.toBe("forked-slot");
      expect(JSON.stringify(stations)).not.toContain(shortIdOf(sealed));
    }, 240_000);

    test("a station booking a slug whose case is sealed from it forks the author's slug, and learns nothing", async () => {
      const world = await emptyWorld(key, scratch);
      await runHandler(moduleBuild, { dir: CORE_MODULE_DIR }, world.author);
      const slug = "a-slug-booked-unseen";
      const authors = await runHandler(caseBook, { slug, about: ["urn:the-authors-booking"] }, world.author);
      await seal(world, authors.case);
      const stations = await runHandler(caseBook, { slug, about: ["urn:the-stations-booking"] }, world.station);

      const refused = await runHandler(caseStatus, { case: slug }, { ...world.author, mode: "plan" }).catch(
        (error: unknown) => error,
      );
      const doctor = await runHandler(doctorRun, {}, world.author);
      const seen = await runHandler(caseStatus, { case: slug }, { ...world.station, mode: "plan" });
      const stationsDoctor = await runHandler(doctorRun, {}, world.station);

      expect(stations.case).not.toBe(authors.case);
      expect(refused).toMatchObject({ reason: "invalid-input" });
      for (const id of [authors.case, stations.case]) {
        expect((refused as Error).message).toContain(id);
      }
      const named = [authors.case, stations.case].map(shortIdOf).join(", ");
      expect(doctor.local).toContainEqual(
        expect.objectContaining({ name: "forked-slugs", ok: false, detail: expect.stringContaining(named) }),
      );
      expect(JSON.stringify(doctor)).not.toContain(slug);
      for (const output of [seen, stationsDoctor]) {
        expect(JSON.stringify(output)).not.toContain(shortIdOf(authors.case));
      }
      expect(JSON.stringify(stationsDoctor)).not.toContain("forked-slugs");
    }, 240_000);

    test("the author keeps a disposition a station's draft forked, and the slot holds the author's alone", async () => {
      const world = await emptyWorld(key, scratch);
      for (const dir of [CORE_MODULE_DIR, CASEBOOK_MODULE_DIR]) {
        await runHandler(moduleBuild, { dir }, world.author);
      }
      const slug = "a-report-kept-once";
      const conditions = { case: slug, disposition: "file", gateClass: "intent" };
      const canonical = { case: slug, disposition: "file" };
      const sealed = await groupedClaim(world.author, CASEBOOK_DISPOSITION, conditions, canonical, "the-authors-menu");
      await seal(world, sealed);
      const booked = await runHandler(caseBook, { slug, about: [], kind: CASEBOOK_KIND }, world.station);
      const own = booked.minted.find(
        ({ kind, record }) => kind === "claim" && (record as ClaimRecord).conditions["disposition"] === "file",
      );
      const slot = (own!.record as ClaimRecord).slot;

      const refused = await runHandler(forkKeep, { record: sealed }, world.station).catch((error: unknown) => error);
      const kept = await runHandler(forkKeep, { record: sealed }, world.author);
      const opened = await openWorkspace(world.author);
      const successor = opened.read(kept.successor as RecordId) as ClaimRecord;
      const live = opened.index.contributorsAtSlot(slot).map(({ id }) => id);
      opened.close();
      const authors = await runHandler(claimStatus, { claim: slot }, { ...world.author, mode: "plan" });
      const doctor = await runHandler(doctorRun, {}, world.author);

      expect(refused).toMatchObject({ reason: "invalid-input", about: [WRITER] });
      expect([...successor.supersedes].sort()).toEqual([sealed, own!.id].sort());
      expect([successor.slot, successor.exclusiveGroup]).toEqual([slot, "the-authors-menu"]);
      expect(live).toEqual([kept.successor]);
      expect(authors.reason).not.toBe("forked-slot");
      expect(doctor.local).toContainEqual(expect.objectContaining({ name: "forked-slots", ok: true }));
    }, 240_000);

    test("a forked exclusive group is closed by the author's replace", async () => {
      const world = await restingWorld(key, scratch, (await makeCheckout("hello")).dir);
      const [asks] = await world.store.putMany([
        { kind: "run", value: fixtureRunRecord("the record both menus' claims ask for") },
      ]);
      const sentence = { statement: "the record is on one menu", rule: RECORD_NEED_RULE, parameters: asks! };
      const { subject } = await repositoryOf(world.workspace);
      const conditions = { subject, statement: sentence.statement, [RECORD_NEED_RULE]: asks! };
      const canonical = { statement: sentence.statement };
      const sealed = await groupedClaim(world.author, CHECK_CLAIM_TYPE, conditions, canonical, "one-menu");
      await seal(world, sealed);
      const own = await groupedClaim(world.station, CHECK_CLAIM_TYPE, conditions, canonical, "another-menu");
      const planned: OperationContext = { ...world.author, mode: "plan" };
      const opened = await openWorkspace(world.author);
      const slot = (opened.read(own) as ClaimRecord).slot;
      opened.close();

      const forked = await runHandler(claimStatus, { claim: slot }, planned);
      const refused = await runHandler(checkRun, sentence, world.author).catch((error: unknown) => error);
      const replaced = await runHandler(checkRun, { ...sentence, replace: true }, world.author);
      const reopened = await openWorkspace(world.author);
      const successor = reopened.read(replaced.claim as RecordId) as ClaimRecord;
      reopened.close();
      const doctor = await runHandler(doctorRun, {}, world.author);

      expect([forked.label, forked.reason]).toEqual(["open", "forked-slot"]);
      expect(refused).toMatchObject({ name: "SentenceClaimedError" });
      const groups = [`${shortIdOf(sealed)} in one-menu`, `${shortIdOf(own)} in another-menu`];
      expect((refused as Error).message).toContain(
        `its live claims name different exclusive groups (${groups.join("; ")})`,
      );
      expect([...successor.supersedes].sort()).toEqual([sealed, own].sort());
      expect([replaced.slot, replaced.label, successor.exclusiveGroup]).toEqual([slot, "holds", null]);
      expect(await runHandler(claimStatus, { claim: slot }, planned)).toMatchObject({ label: "holds" });
      expect(doctor.local).toContainEqual(expect.objectContaining({ name: "forked-slots", ok: true }));
    }, 240_000);

    test("a ruling whose brief read a sealed run leaves the station's claim open, naming neither the run nor the brief", async () => {
      const world = await emptyWorld(key, scratch);
      const [sealed] = await world.store.putMany([{ kind: "run", value: fixtureRunRecord(CANARY) }]);
      const [held] = await world.store.putMany([
        { kind: "run", value: fixtureRunRecord("a receipt the station holds") },
      ]);
      const [ruled] = await world.store.putMany([
        { kind: "claim", value: claim("ruled", {}, [receiptEdge(sealed!), receiptEdge(held!)]) },
      ]);
      await world.store.putMany([{ kind: "case", value: fixtureCase("ruled", [ruled!]) }]);
      const { brief } = await runHandler(briefRender, { claim: ruled! }, world.author);
      const verdict = { claim: ruled!, verdict: "fails", reason: "it does not hold", brief, key: key.keyPath } as const;
      await runHandler(rulingMake, verdict, world.author);
      await seal(world, sealed!);
      const planned: OperationContext = { ...world.station, mode: "plan" };

      const authors = await runHandler(claimStatus, { claim: slotOf("ruled") }, { ...world.author, mode: "plan" });
      const status = await runHandler(claimStatus, { claim: slotOf("ruled") }, planned);
      const why = await runHandler(claimWhy, { claim: slotOf("ruled"), full: true }, planned);

      expect(authors.label).toBe("fails");
      expect([status.label, status.reason]).toEqual(["open", "contested-authority"]);
      expect(why.detail).toBe(`contested on grounds withheld under the clearance ${WRITER}`);
      for (const output of await claimReadings(world.station, "ruled", ruled!, "ruled")) {
        for (const hidden of [CANARY, sealed!, brief]) {
          expect(output).not.toContain(hidden);
        }
      }
    }, 120_000);

    test("a ruling on grounds withheld from the station reads there as deciding nothing, and nothing as deciding the claim", async () => {
      const world = await emptyWorld(key, scratch);
      const [sealed] = await world.store.putMany([{ kind: "run", value: fixtureRunRecord(CANARY) }]);
      const [held] = await world.store.putMany([
        { kind: "run", value: fixtureRunRecord("a receipt the station holds") },
      ]);
      const [ruled] = await world.store.putMany([
        { kind: "claim", value: claim("ruled", {}, [receiptEdge(sealed!), receiptEdge(held!)]) },
      ]);
      await world.store.putMany([{ kind: "case", value: fixtureCase("ruled", [ruled!]) }]);
      const { brief } = await runHandler(briefRender, { claim: ruled! }, world.author);
      const verdict = { claim: ruled!, verdict: "fails", reason: "it does not hold", brief, key: key.keyPath } as const;
      const ruling = (await runHandler(rulingMake, verdict, world.author)).minted[0]!.id;
      await seal(world, sealed!);
      const planned: OperationContext = { ...world.station, mode: "plan" };

      const status = await runHandler(claimStatus, { claim: slotOf("ruled") }, planned);
      const why = await runHandler(claimWhy, { claim: slotOf("ruled") }, planned);

      expect(status).toMatchObject({ label: "open", decidedBy: null });
      expect(claimStatus.renderText(status)).not.toContain(" · run ");
      expect(why.rulings).toEqual([expect.objectContaining({ id: ruling, uncounted: "grounds-withheld" })]);
      expect(claimWhy.renderText(why)).toContain(
        `  ruling ${ruling.slice(7, 19)} · fails, person ruling by ${PUBLISHER} (${key.principal}) · decided nothing: the claim is contested on grounds withheld here`,
      );
    }, 120_000);

    test("a station's own ruling on a claim contested on withheld grounds reads in why as deciding nothing", async () => {
      const world = await emptyWorld(key, scratch);
      const [sealed] = await world.store.putMany([{ kind: "run", value: fixtureRunRecord(CANARY) }]);
      const { claim: attacked } = await attackedClaim(world, "attacked", [sealed!]);
      await world.store.putMany([{ kind: "case", value: fixtureCase("cites", [attacked]) }]);
      await seal(world, sealed!);
      await writeSignerConfig(join(world.workspace, MUSAI_DIR, LOCAL_DIR), { keyPath: key.keyPath });
      const { brief } = await runHandler(briefRender, { claim: attacked }, world.station);
      const verdict = { claim: attacked, verdict: "holds", reason: "it holds", brief } as const;
      const ruling = (await runHandler(rulingMake, verdict, world.station)).minted[0]!.id;
      const planned: OperationContext = { ...world.station, mode: "plan" };

      const why = await runHandler(claimWhy, { claim: slotOf("attacked") }, planned);

      expect([why.label, why.reason]).toEqual(["open", "contested-authority"]);
      expect(why.rulings).toEqual([expect.objectContaining({ id: ruling, uncounted: "grounds-withheld" })]);
      expect(claimWhy.renderText(why)).toContain(
        `  ruling ${ruling.slice(7, 19)} · holds, person ruling by ${PUBLISHER} (${key.principal}) · decided nothing: the claim is contested on grounds withheld here`,
      );
      for (const output of await claimReadings(world.station, "attacked", attacked, "cites")) {
        expect(output).not.toContain(CANARY);
        expect(output).not.toContain(sealed!);
      }
    }, 120_000);

    test("a station's own ruling on an option of a menu whose holder rests on a withheld brief reads in why as deciding nothing", async () => {
      const world = await emptyWorld(key, scratch);
      const [sealed] = await world.store.putMany([{ kind: "run", value: fixtureRunRecord(CANARY) }]);
      const [chosen, other] = await world.store.putMany([
        { kind: "claim", value: { ...claim("chosen", {}, [receiptEdge(sealed!)]), exclusiveGroup: "menu" } },
        { kind: "claim", value: { ...claim("other", {}), exclusiveGroup: "menu" } },
      ]);
      await world.store.putMany([{ kind: "case", value: fixtureCase("menu", [chosen!, other!]) }]);
      const { brief } = await runHandler(briefRender, { claim: chosen! }, world.author);
      const chose = { claim: chosen!, verdict: "holds", reason: "this one", brief, key: key.keyPath } as const;
      await runHandler(rulingMake, chose, world.author);
      await seal(world, sealed!);
      await writeSignerConfig(join(world.workspace, MUSAI_DIR, LOCAL_DIR), { keyPath: key.keyPath });
      const asked = await runHandler(briefRender, { claim: other! }, world.station);
      const verdict = { claim: other!, verdict: "fails", reason: "not this one", brief: asked.brief } as const;
      const ruling = (await runHandler(rulingMake, verdict, world.station)).minted[0]!.id;
      const planned: OperationContext = { ...world.station, mode: "plan" };

      const why = await runHandler(claimWhy, { claim: slotOf("other") }, planned);

      expect([why.label, why.reason]).toEqual(["open", "contested-authority"]);
      expect(why.rulings).toEqual([expect.objectContaining({ id: ruling, uncounted: "grounds-withheld" })]);
      for (const output of await claimReadings(world.station, "other", other!, "menu")) {
        for (const hidden of [CANARY, sealed!, brief]) {
          expect(output).not.toContain(hidden);
        }
      }
    }, 120_000);

    test("a ruling on one option of a menu whose brief read a sealed run leaves every option open to the station", async () => {
      const world = await emptyWorld(key, scratch);
      const [sealed] = await world.store.putMany([{ kind: "run", value: fixtureRunRecord(CANARY) }]);
      const [chosen, other] = await world.store.putMany([
        { kind: "claim", value: { ...claim("chosen", {}, [receiptEdge(sealed!)]), exclusiveGroup: "menu" } },
        { kind: "claim", value: { ...claim("other", {}), exclusiveGroup: "menu" } },
      ]);
      await world.store.putMany([{ kind: "case", value: fixtureCase("menu", [chosen!, other!]) }]);
      const { brief } = await runHandler(briefRender, { claim: chosen! }, world.author);
      const verdict = { claim: chosen!, verdict: "holds", reason: "this one", brief, key: key.keyPath } as const;
      await runHandler(rulingMake, verdict, world.author);
      await seal(world, sealed!);
      const labels = async (context: OperationContext) =>
        (await runHandler(caseSoundcheck, { case: "menu" }, { ...context, mode: "plan" })).claims.map((entry) => [
          entry.label,
          entry.reason,
        ]);

      expect(await labels(world.author)).toEqual([
        ["holds", null],
        ["fails", null],
      ]);
      expect(await labels(world.station)).toEqual([
        ["open", "contested-authority"],
        ["open", "contested-authority"],
      ]);
      for (const output of await claimReadings(world.station, "other", other!, "menu")) {
        for (const hidden of [CANARY, sealed!, brief]) {
          expect(output).not.toContain(hidden);
        }
      }
    }, 120_000);

    test("a station cannot rule a second option into holding where the menu's holder rests on a withheld brief", async () => {
      const world = await emptyWorld(key, scratch);
      const [sealed] = await world.store.putMany([{ kind: "run", value: fixtureRunRecord(CANARY) }]);
      const option = (id: string, evidence: readonly RecordId[]) => ({
        ...claim(id, { gateClass: "intent", disposition: id }, evidence.map(receiptEdge)),
        exclusiveGroup: "menu",
      });
      const [chosen, other] = await world.store.putMany([
        { kind: "claim", value: option("chosen", [sealed!]) },
        { kind: "claim", value: option("other", []) },
      ]);
      await world.store.putMany([{ kind: "case", value: fixtureCase("menu", [chosen!, other!]) }]);
      const { brief } = await runHandler(briefRender, { claim: chosen! }, world.author);
      const verdict = { claim: chosen!, verdict: "holds", reason: "this one", brief, key: key.keyPath } as const;
      await runHandler(rulingMake, verdict, world.author);
      await seal(world, sealed!);
      await writeSignerConfig(join(world.workspace, MUSAI_DIR, LOCAL_DIR), { keyPath: key.keyPath });
      const hidden = [CANARY, sealed!, brief];

      const pending = await runHandler(gatePending, {}, { ...world.station, mode: "plan" });
      const asked = await runHandler(gateAsk, { claim: other! }, world.station);
      const answer = { pending: other!, brief: asked.brief, choice: "other", reason: "the other one" };
      const refused = await runHandler(gateAnswer, answer, world.station).catch((error: unknown) => error);

      expect(refused).toMatchObject({
        reason: "sibling-conflict",
        detail: expect.stringContaining(`on grounds withheld under the clearance ${WRITER}`),
      });
      expect(pending.gates).toEqual([]);
      const labels = await runHandler(caseSoundcheck, { case: "menu" }, { ...world.author, mode: "plan" });
      expect(labels.claims.map((entry) => entry.label)).toEqual(["holds", "fails"]);
      const shown = [pending, asked, refused].map((output) => JSON.stringify(output));
      for (const output of [...shown, gatePending.renderText(pending), (refused as Error).message]) {
        for (const withheld of hidden) {
          expect(output).not.toContain(withheld);
        }
      }
    }, 120_000);

    test("a station's progress names as next no menu whose holder rests on a withheld brief, as pending lists none", async () => {
      const world = await emptyWorld(key, scratch);
      const [sealed] = await world.store.putMany([{ kind: "run", value: fixtureRunRecord(CANARY) }]);
      const option = (id: string, evidence: readonly RecordId[]) => ({
        ...claim(id, { gateClass: "intent", disposition: id }, evidence.map(receiptEdge)),
        exclusiveGroup: "menu",
      });
      const [chosen, other] = await world.store.putMany([
        { kind: "claim", value: option("chosen", [sealed!]) },
        { kind: "claim", value: option("other", []) },
      ]);
      await world.store.putMany([{ kind: "case", value: fixtureCase("menu", [chosen!, other!]) }]);
      const { brief } = await runHandler(briefRender, { claim: chosen! }, world.author);
      const verdict = { claim: chosen!, verdict: "holds", reason: "this one", brief, key: key.keyPath } as const;
      await runHandler(rulingMake, verdict, world.author);
      await seal(world, sealed!);
      const planned: OperationContext = { ...world.station, mode: "plan" };

      const pending = await runHandler(gatePending, { case: "menu" }, planned);
      const progress = await runHandler(caseStatus, { case: "menu" }, planned);

      expect(pending.gates).toEqual([]);
      expect(progress).toMatchObject({ next: null, done: false, reason: "claim-open" });
      for (const hidden of [CANARY, sealed!, brief]) {
        expect(JSON.stringify(progress)).not.toContain(hidden);
      }
    }, 120_000);

    test("a run that lands withheld after corrupt bytes named its id leaves the station's refusal standing, cold and warm alike", async () => {
      const world = await emptyWorld(key, scratch);
      const gitDir = join(world.workspace, MUSAI_DIR);
      const [sealed] = await world.store.putMany([{ kind: "run", value: fixtureRunRecord(CANARY) }]);
      const performed = fixtureRunRecord("a receipt that read the sealed run");
      const reader: PerformedRunRecord = {
        ...performed,
        observation: { ...performed.observation, reads: [readEntryFor(sealed!)] },
      };
      const readerId = recordId(reader);
      await commitAroundTheStore(
        { ctx: { gitDir }, scope: SCOPE, now },
        recordPath("claim", readerId),
        new TextEncoder().encode("not a record"),
      );
      await seal(world, sealed!);
      const cleared = join(gitDir, "local", "scopes", SCOPE, "cleared", `${hexDigest(WRITER)}.sqlite`);
      const built = await openWorkspace(world.station);
      built.close();
      const refusalsBefore = rowsHeld(cleared)["refusals"];
      expect(JSON.stringify(refusalsBefore)).toContain(readerId);

      await world.store.putMany([{ kind: "run", value: reader }]);
      const [own] = await world.store.putMany([{ kind: "run", value: fixtureRunRecord("the claim's own receipt") }]);
      const [cites] = await world.store.putMany([
        { kind: "claim", value: claim("cites-the-reader", {}, [receiptEdge(own!), receiptEdge(readerId)]) },
      ]);
      await world.store.putMany([{ kind: "case", value: fixtureCase("reader", [cites!]) }]);

      await runHandler(claimStatus, { claim: slotOf("cites-the-reader") }, { ...world.author, mode: "plan" });
      await expect(
        runHandler(claimStatus, { claim: slotOf("cites-the-reader") }, { ...world.station, mode: "plan" }),
      ).rejects.toMatchObject({ reason: "record-corrupted", about: [readerId] });
      const warm = rowsHeld(cleared);
      expect(warm["refusals"]).toEqual(refusalsBefore);

      await rm(cleared);
      const rebuilt = await openWorkspace(world.station);
      rebuilt.close();

      expect(rowsHeld(cleared)).toEqual(warm);
    }, 120_000);

    test("the author's brief over a claim citing a run is not refused for corrupt bytes at another kind's path", async () => {
      const world = await emptyWorld(key, scratch);
      const [own] = await world.store.putMany([{ kind: "run", value: fixtureRunRecord("the claim's own receipt") }]);
      await commitAroundTheStore(
        { ctx: { gitDir: join(world.workspace, MUSAI_DIR) }, scope: SCOPE, now },
        recordPath("claim", own!),
        new TextEncoder().encode("not a record"),
      );
      const [cites] = await world.store.putMany([{ kind: "claim", value: claim("cites", {}, [receiptEdge(own!)]) }]);
      await world.store.putMany([{ kind: "case", value: fixtureCase("cites", [cites!]) }]);

      const brief = await runHandler(briefRender, { claim: cites! }, { ...world.author, mode: "plan" });

      expect(brief.output).toContain(own!);
    }, 120_000);

    test("a brief packing a testimony names the attestation its kind word reads among its reads", async () => {
      const world = await emptyWorld(key, scratch);
      const { run, attestation } = await putTestimony(world);
      const [testified] = await world.store.putMany([
        { kind: "claim", value: claim("testified", {}, [receiptEdge(run!)]) },
      ]);
      await world.store.putMany([{ kind: "case", value: fixtureCase("testified", [testified!]) }]);

      const planned = await runHandler(briefRender, { claim: testified! }, { ...world.author, mode: "plan" });
      const brief = planned.minted[0]!.record as RunRecord;

      expect(brief.observation.reads).toContainEqual(readEntryFor(attestation.id));
    }, 120_000);

    test("a brief packing a testimony is refused a corrupt attestation at its head to a station as to its author", async () => {
      const world = await emptyWorld(key, scratch);
      const { run, attestation } = await putTestimony(world);
      const corrupt = Array.from({ length: 64 }, (_, marker) => recordId({ marker })).find(
        (id) => id < attestation.id,
      )!;
      await commitAroundTheStore(
        { ctx: { gitDir: join(world.workspace, MUSAI_DIR) }, scope: SCOPE, now },
        recordPath("attestation", corrupt),
        new TextEncoder().encode("not a record"),
      );
      const [testified] = await world.store.putMany([
        { kind: "claim", value: claim("testified", {}, [receiptEdge(run!)]) },
      ]);
      await world.store.putMany([{ kind: "case", value: fixtureCase("testified", [testified!]) }]);

      const refusals = [];
      for (const context of [world.author, world.station]) {
        const asked = { ...context, mode: "plan" as const };
        refusals.push(await runHandler(briefRender, { claim: testified! }, asked).catch((e: unknown) => e));
      }

      expect(refusals[0]).toMatchObject({ reason: "record-corrupted", about: [corrupt] });
      expect(refusals[1]).toEqual(refusals[0]);
    }, 120_000);

    test("a station is refused the verbs that name the author's scopes and tips, naming its clearance", async () => {
      const world = await restingWorld(key, scratch);
      const scopes = (await runHandler(scopeList, {}, world.author)).scopes;

      for (const [descriptor, input] of [
        [scopeList, {}],
        [scopeFork, { name: "station-fork" }],
        [scopeMerge, { from: SCOPE }],
        [scopeDrop, { name: SCOPE, tip: "0".repeat(40) }],
        [storeRelayout, {}],
      ] as const) {
        const refused = runHandler(descriptor as OperationDescriptor, input, world.station);
        await expect(refused).rejects.toMatchObject({ reason: "invalid-input" });
        await expect(refused).rejects.toThrow(WRITER);
      }

      expect((await runHandler(scopeList, {}, world.author)).scopes).toEqual(scopes);
    }, 240_000);

    test("a station's open and save are refused, naming its clearance, and leave the author's worktree as it was", async () => {
      const world = await restingWorld(key, scratch);
      const opened = await runHandler(caseOpen, { case: "rests" }, world.author);
      const draft = join(opened.path, "draft-in-progress.md");
      await writeFile(draft, "the author's unsaved words\n");

      for (const descriptor of [caseOpen, caseSave] as readonly OperationDescriptor[]) {
        const refused = runHandler(descriptor, { case: "rests" }, world.station);
        await expect(refused).rejects.toMatchObject({ reason: "invalid-input" });
        await expect(refused).rejects.toThrow(WRITER);
      }

      expect(await readFile(draft, "utf8")).toBe("the author's unsaved words\n");
      expect(await runHandler(caseOpen, { case: "rests" }, world.author)).toEqual(opened);
      expect((await runHandler(caseSave, { case: "rests" }, world.author)).minted).toEqual([]);
    }, 240_000);
  },
);

/** The station image for the engine tests: one held locally that runs every program they name. */
async function stationImage(): Promise<string | undefined> {
  const image = await localImageRunning(["sh", "-c", "command -v node && command -v find && command -v cat"]);
  return image === undefined ? undefined : `${image.repository}@sha256:${image.digest}`;
}

const TRACKED_SAYS_HELLO = "process.exit(require('fs').readFileSync('tracked.txt','utf8')==='hello'?0:1)";

describe("a station's runs go through a container that cannot see the workspace's own directory", () => {
  async function stationWorkspace() {
    const checkout = await makeCheckout("hello");
    onTestFinished(() => checkout.cleanup());
    const context: OperationContext = { workspace: checkout.dir, scope: SCOPE, now, principalName: "operator" };
    await runHandler(workspaceInit, { workspace: checkout.dir }, context);
    const trust = { gitDir: join(checkout.dir, MUSAI_DIR) };
    await writeTrustFile(trust, "audiences", "writer\n");
    return { dir: checkout.dir, trust, author: context, station: { ...context, clearance: WRITER } };
  }

  async function runsIn(dir: string): Promise<PerformedRunRecord[]> {
    const store = new Store({ ctx: { gitDir: join(dir, MUSAI_DIR) }, scope: SCOPE, now });
    const ids = await receiptIds(store);
    return Promise.all(ids.map(async (id) => performedRun(id, (await store.read(id, "run")) as RunRecord)));
  }

  test("a check under a clearance whose trust branch names no station image is refused, naming the clearance, and writes nothing", async () => {
    const { dir, station } = await stationWorkspace();
    const refs = async () => (await execa("git", ["--git-dir", join(dir, MUSAI_DIR), "for-each-ref"])).stdout;
    const before = await refs();

    await expect(
      runHandler(checkRun, { statement: "the tracked file is there", command: ["find", "tracked.txt"] }, station),
    ).rejects.toMatchObject({ reason: "invalid-input", about: [WRITER] });
    expect(await refs()).toBe(before);
  }, 120_000);

  test("a station's check from a workspace below its repository's top is refused before its claim or tools are written", async () => {
    const checkout = await makeCheckout("hello");
    onTestFinished(() => checkout.cleanup());
    const dir = join(checkout.dir, "nested");
    await mkdir(dir);
    const author: OperationContext = { workspace: dir, scope: SCOPE, now, principalName: "operator" };
    await runHandler(workspaceInit, { workspace: dir }, author);
    const trust = { gitDir: join(dir, MUSAI_DIR) };
    await writeTrustFile(trust, "audiences", "writer\n");
    const { values } = (await readTrustBranch(trust)).config;
    const configured = { ...values, [STATION_IMAGE_CONFIG_KEY]: `registry.example/station@sha256:${"5".repeat(64)}` };
    await writeTrustFile(trust, "config.json", `${JSON.stringify(configured)}\n`);
    const refs = async () => (await execa("git", ["--git-dir", trust.gitDir, "for-each-ref"])).stdout;
    const before = await refs();

    await expect(
      runHandler(
        checkRun,
        { statement: "the tracked file is there", command: ["find", "tracked.txt"], tool: ["sh"] },
        { ...author, clearance: WRITER },
      ),
    ).rejects.toMatchObject({ reason: "invalid-input", about: [WRITER] });
    expect(await refs()).toBe(before);
  }, 120_000);

  test("a station's check naming a program the toolset lacks is refused, naming the clearance, and the trust branch does not move", async (context) => {
    if (!(await containerEngineAvailable(DEFAULT_CONTAINER_ENGINE))) {
      console.log("skip: no container engine answers on this machine");
      context.skip();
      return;
    }
    const { dir, trust, station } = await stationWorkspace();
    const { values } = (await readTrustBranch(trust)).config;
    const configured = { ...values, [STATION_IMAGE_CONFIG_KEY]: `registry.example/station@sha256:${"5".repeat(64)}` };
    await writeTrustFile(trust, "config.json", `${JSON.stringify(configured)}\n`);
    const refs = async () => (await execa("git", ["--git-dir", join(dir, MUSAI_DIR), "for-each-ref"])).stdout;
    const before = await refs();

    const refusal = await runHandler(
      checkRun,
      { statement: "the tracked file is listed", command: ["find", "tracked.txt"] },
      station,
    ).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ reason: "invalid-input", about: [WRITER] });
    expect((refusal as Error).message).toContain("toolset");
    expect(await refs()).toBe(before);
  }, 120_000);

  test("a station's check naming a program the toolset lacks is refused as the station's, whoever its principal is", async (context) => {
    if (!(await containerEngineAvailable(DEFAULT_CONTAINER_ENGINE))) {
      console.log("skip: no container engine answers on this machine");
      context.skip();
      return;
    }
    const { trust, station } = await stationWorkspace();
    const { values } = (await readTrustBranch(trust)).config;
    const configured = { ...values, [STATION_IMAGE_CONFIG_KEY]: `registry.example/station@sha256:${"5".repeat(64)}` };
    await writeTrustFile(trust, "config.json", `${JSON.stringify(configured)}\n`);
    await writeTrustFile(trust, "roles", "someone-else owner any\n");

    const refusal = await runHandler(
      checkRun,
      { statement: "the tracked file is listed", command: ["find", "tracked.txt"] },
      { ...station, principalName: "a-principal-holding-no-role" },
    ).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ reason: "invalid-input", about: [WRITER] });
    expect((refusal as Error).message).toContain("refusing to run under the clearance");
  }, 120_000);

  test("a claim's check performed under a clearance with no station image is refused, and mints no evaluation", async () => {
    const { dir, author, station } = await stationWorkspace();
    const checked = await runHandler(
      checkRun,
      { statement: "the tracked file is there", command: ["find", "tracked.txt"] },
      author,
    );
    const store = new Store({ ctx: { gitDir: join(dir, MUSAI_DIR) }, scope: SCOPE, now });
    const before = await store.list("run");

    await expect(runHandler(claimStatus, { claim: checked.slot }, station)).rejects.toMatchObject({
      reason: "invalid-input",
      about: [WRITER],
    });
    expect(await store.list("run")).toEqual(before);
  }, 120_000);

  test("a check under a clearance lists the workspace's own directory empty, where the author's lists what it holds", async (context) => {
    if (!(await containerEngineAvailable(DEFAULT_CONTAINER_ENGINE))) {
      console.log("skip: no container engine answers on this machine");
      context.skip();
      return;
    }
    const image = await stationImage();
    if (image === undefined) {
      console.log("skip: no locally held image runs node, find and cat");
      context.skip();
      return;
    }
    const { dir, trust, author, station } = await stationWorkspace();
    const { values } = (await readTrustBranch(trust)).config;
    await writeTrustFile(trust, "config.json", `${JSON.stringify({ ...values, [STATION_IMAGE_CONFIG_KEY]: image })}\n`);
    const lists = { statement: "the workspace's directory is listed", command: ["find", MUSAI_DIR, "-maxdepth", "1"] };

    expect((await runHandler(checkRun, lists, author)).label).toBe("holds");
    expect((await runHandler(checkRun, lists, station)).label).toBe("holds");

    const listings = (await runsIn(dir)).filter((run) => run.recipe.command[0] === "find");
    const [onHost] = listings.filter((run) => run.recipe.isolation === "hygiene");
    const [inContainer] = listings.filter((run) => run.recipe.isolation === "container");
    expect(textOf(inContainer!.observation.output, "the station's listing").trim()).toBe(MUSAI_DIR);
    expect(inContainer!.observation.isolationHeld).toBe("container");
    expect(inContainer!.recipe.substrates.at(-1)?.uri).toBe(image.slice(0, image.indexOf("@")));
    expect(textOf(onHost!.observation.output, "the author's listing")).toContain(`${MUSAI_DIR}/local`);
    expect(onHost!.recipe.substrates.some(isContainerImageSubstrate)).toBe(false);
  }, 240_000);

  test("a station with no image reads a check nothing has evaluated there as the refusal naming the image it lacks", async () => {
    const { author, station } = await stationWorkspace();
    const says = { statement: "the tracked file says hello", command: ["node", "-e", TRACKED_SAYS_HELLO] };
    const checked = await runHandler(checkRun, says, author);

    const status = await runHandler(claimStatus, { claim: checked.slot }, { ...station, mode: "plan" });

    expect([status.label, status.detail]).toEqual([
      "open",
      `refusing to run under the clearance ${WRITER}: a run there goes through a container, the recipe declares no image, and the trust branch's configuration names no ${STATION_IMAGE_CONFIG_KEY}`,
    ]);
  }, 120_000);

  test("a station with no image reads a check whose every recipe declares its own image as one `status` there evaluates", async () => {
    const { author, station } = await stationWorkspace();
    const says = { statement: "the tracked file says hello", command: ["node", "-e", TRACKED_SAYS_HELLO] };
    const checked = await runHandler(checkRun, says, author);
    const opened = await openWorkspace(author);
    onTestFinished(() => opened.close());
    const { store } = opened;
    const held = (await store.read(checked.claim as RecordId, "claim")) as ClaimRecord;
    const own = stationImageFromConfig({
      values: { [STATION_IMAGE_CONFIG_KEY]: `registry.example/own@sha256:${"6".repeat(64)}` },
    })!;
    const parameters = JSON.parse(held.conditions[DECLARATIVE_RULE] as string) as {
      recipes: { recipe: { substrates: unknown[]; isolation: string } }[];
    };
    for (const entry of parameters.recipes) {
      entry.recipe = { ...entry.recipe, substrates: [...entry.recipe.substrates, own], isolation: "container" };
    }
    const conditions = { ...held.conditions, [DECLARATIVE_RULE]: JSON.stringify(parameters) };
    await store.putMany([{ kind: "claim", value: { ...held, supersedes: [checked.claim as RecordId], conditions } }]);

    const status = await runHandler(claimStatus, { claim: checked.slot }, { ...station, mode: "plan" });

    expect([status.label, status.detail]).toEqual([
      "open",
      `nothing has evaluated this check here yet; \`status\` under the clearance ${WRITER} evaluates it`,
    ]);
  }, 120_000);

  test("a station's status and soundcheck without performing answer from its own evaluation in the station's image, never the author's", async () => {
    const { dir, trust, author, station } = await stationWorkspace();
    const says = { statement: "the tracked file says hello", command: ["node", "-e", TRACKED_SAYS_HELLO] };
    const checked = await runHandler(checkRun, says, author);
    expect(checked.label).toBe("holds");
    const store = new Store({ ctx: { gitDir: join(dir, MUSAI_DIR) }, scope: SCOPE, now });
    await store.putMany([{ kind: "case", value: fixtureCase("checks", [checked.claim as RecordId]) }]);
    const { values } = (await readTrustBranch(trust)).config;
    const configured = { ...values, [STATION_IMAGE_CONFIG_KEY]: `registry.example/station@sha256:${"5".repeat(64)}` };
    await writeTrustFile(trust, "config.json", `${JSON.stringify(configured)}\n`);
    const reading = { ...station, mode: "plan" as const };
    const labelled = async (context: OperationContext) => {
      const status = await runHandler(claimStatus, { claim: checked.slot }, context);
      const { claims } = await runHandler(caseSoundcheck, { case: "checks" }, context);
      expect(claims).toEqual([{ slot: checked.slot, label: status.label, reason: status.reason }]);
      return status;
    };

    const unrun = await labelled(reading);
    expect([unrun.label, unrun.detail]).toEqual(["open", expect.stringContaining("`status` under the clearance")]);

    const [onHost] = (await runsIn(dir)).filter(
      (run) => run.recipe.command[1] === "-e" && run.recipe.command[2] === TRACKED_SAYS_HELLO,
    );
    const image = stationImageFromConfig({ values: configured })!;
    const held = { clearance: WRITER, image, musaiDir: join(dir, MUSAI_DIR) };
    await store.putMany([
      {
        kind: "run",
        value: {
          ...onHost!,
          recipe: stationRecipe(onHost!.recipe, held),
          observation: {
            ...onHost!.observation,
            resolved: [...onHost!.observation.resolved, image],
            isolationHeld: "container",
            exitCode: 1,
          },
        },
      },
    ]);
    expect((await labelled(reading)).detail).toBe(unrun.detail);
    await runHandler(claimStatus, { claim: checked.slot }, station);
    expect((await labelled(reading)).label).toBe("fails");
    expect((await labelled({ ...author, mode: "plan" })).label).toBe("holds");
  }, 120_000);

  test("a station's check runs the image's own node and sh, with a home and a temp it can write", async (context) => {
    if (!(await containerEngineAvailable(DEFAULT_CONTAINER_ENGINE))) {
      console.log("skip: no container engine answers on this machine");
      context.skip();
      return;
    }
    const image = await stationImage();
    if (image === undefined) {
      console.log("skip: no locally held image runs node, find and cat");
      context.skip();
      return;
    }
    const { trust, station } = await stationWorkspace();
    const { values } = (await readTrustBranch(trust)).config;
    const admitted = { ...values, [STATION_IMAGE_CONFIG_KEY]: image, tools: ["cat", "sh"] };
    await writeTrustFile(trust, "config.json", `${JSON.stringify(admitted)}\n`);
    const writes =
      "const fs=require('fs');for(const d of [process.env.HOME,process.env.TMPDIR])fs.writeFileSync(d+'/w','')";
    const checks = [
      { statement: "the tracked file says hello", command: ["node", "-e", TRACKED_SAYS_HELLO] },
      { statement: "home and temp are writable", command: ["node", "-e", writes] },
      { statement: "the shell reads the tracked file", command: ["sh", "-c", "cat tracked.txt"], tool: ["cat"] },
    ];

    for (const check of checks) {
      expect([check.statement, (await runHandler(checkRun, check, station)).label]).toEqual([check.statement, "holds"]);
    }
  }, 240_000);
});

describe("a case citing a claim its scope does not hold", () => {
  test("is refused to its author, by every reader of the case, naming the missing claim", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "musai-clearance-corrupt-"));
    try {
      const { gitDir } = await initWorkspace(workspace, { now });
      const missing = recordId({ marker: "a claim this scope never held" });
      await new Store({ ctx: { gitDir }, scope: SCOPE, now }).putMany([
        { kind: "case", value: fixtureCase("corrupt", [missing]) },
      ]);
      const author: OperationContext = { workspace, scope: SCOPE, now, mode: "plan" };

      for (const [descriptor, input] of [
        [caseStatus, { case: "corrupt" }],
        [caseSoundcheck, { case: "corrupt" }],
        [gatePending, {}],
      ] as const) {
        await expect(runHandler(descriptor as OperationDescriptor, input, author)).rejects.toMatchObject({
          reason: "no-such-record",
          about: [missing],
        });
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("is refused to a station as to its author where the fold refused the claim", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "musai-clearance-refused-"));
    try {
      const { gitDir } = await initWorkspace(workspace, { now });
      await writeTrustFile({ gitDir }, "audiences", "writer\n");
      const unreadable = recordId({ marker: "a claim whose bytes no fold reads" });
      await commitAroundTheStore(
        { ctx: { gitDir }, scope: SCOPE, now },
        recordPath("claim", unreadable),
        new TextEncoder().encode("not a record"),
      );
      await new Store({ ctx: { gitDir }, scope: SCOPE, now }).putMany([
        { kind: "case", value: fixtureCase("refused", [unreadable]) },
      ]);
      const author: OperationContext = { workspace, scope: SCOPE, now, mode: "plan" };
      const station: OperationContext = { ...author, clearance: WRITER };

      const refusals = [];
      for (const context of [author, station]) {
        refusals.push(await runHandler(caseStatus, { case: "refused" }, context).catch((error: unknown) => error));
      }

      expect(refusals[0]).toMatchObject({ reason: "record-corrupted", about: [unreadable] });
      expect(refusals[1]).toEqual(refusals[0]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
