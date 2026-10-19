import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type OperationContext, type OperationDescriptor, openWorkspace, runHandler } from "@musai/api-core";
import {
  type ArgumentRecord,
  BRIEF_MEDIA_TYPE,
  type CaseRecord,
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
import { initWorkspace, MUSAI_DIR, readTrustBranch, Store } from "@musai/store";
import {
  allowedSignersLine,
  commitAroundTheStore,
  fixtureBrief,
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
import { mintAttestation } from "@musai/trust";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, onTestFinished, test } from "vitest";
import { briefRender } from "../src/ops/brief.js";
import { caseBook, caseSoundcheck } from "../src/ops/case.js";
import { caseStatus } from "../src/ops/case-status.js";
import { type CheckRunInput, checkRun } from "../src/ops/check.js";
import { claimStatus } from "../src/ops/claim.js";
import { doctorRun } from "../src/ops/doctor.js";
import { eventsSinceOperation } from "../src/ops/events.js";
import { gatePending } from "../src/ops/gate.js";
import { moduleBuild } from "../src/ops/module.js";
import { caseOpen } from "../src/ops/open.js";
import { releaseRevoke, releaseSeal } from "../src/ops/release.js";
import { caseSave } from "../src/ops/save.js";
import { scopeDrop, scopeFork, scopeList, scopeMerge } from "../src/ops/scope.js";
import { storeRelayout } from "../src/ops/store.js";
import { viewRun } from "../src/ops/view.js";
import { claimWhy } from "../src/ops/why.js";
import { workspaceInit } from "../src/ops/workspace.js";
import {
  CANARY,
  caseCiting,
  claim,
  emptyWorld,
  latestUnder,
  now,
  opensshAvailable,
  PUBLISHER,
  RECORD_NEED_RULE,
  receiptEdge,
  restingWorld,
  SCOPE,
  seal,
  sealAndEvaluate,
  slotOf,
  type World,
  WRITER,
} from "./sealed-world.js";

/** A rule running the command its condition names in the project's working tree. */
const TREE_COMMAND_MODULE_DIR = fileURLToPath(new URL("./fixtures/tree-command", import.meta.url));
const TREE_COMMAND_RULE = "tree-command/exits-cleanly";
/** Its one claim the interpreter judges over two commands reading the tracked file. */
const TREE_COMMAND_PAIR_KIND = "tree-command/pair";

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
      await world.store.putMany([{ kind: "case", value: caseCiting("briefed", [briefed!]) }]);

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
      await world.store.putMany([{ kind: "case", value: caseCiting("briefed", [briefed!]) }]);
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
      await world.store.putMany([{ kind: "case", value: caseCiting("cites", [cited!, bare!]) }]);
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
      const heldUnder = async (context: OperationContext) => {
        const opened = await openWorkspace(context);
        onTestFinished(() => opened.close());
        return ids.map((id) => opened.index.holds(id));
      };

      await seal(world, cited!, true);
      expect(await heldUnder(world.station)).toEqual([false, false, false]);
      expect(await heldUnder(world.author)).toEqual([true, true, true]);

      await runHandler(releaseRevoke, { id: cited!, from: WRITER, key: key.keyPath }, world.author);
      expect(await heldUnder(world.station)).toEqual([true, true, true]);

      await seal(world, cited!);
      expect(await heldUnder(world.station)).toEqual([false, true, true]);
    }, 120_000);

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
      const heldUnder = async (context: OperationContext, ids: readonly RecordId[]) => {
        const opened = await openWorkspace(context);
        onTestFinished(() => opened.close());
        return ids.map((id) => opened.index.holds(id));
      };

      await runHandler(releaseSeal, { id: claim, from: WRITER, key: key.keyPath, closure: true }, author);
      expect(await heldUnder(station, [claim, ...minted])).toEqual([claim, ...minted].map(() => false));
      const [reader] = await store.putMany([
        { kind: "run", value: fixtureBrief("read the canary's receipt", { reads: [receipt!] }) },
      ]);
      const ids = [claim, ...minted, reader!];
      expect(await heldUnder(station, ids)).toEqual(ids.map(() => false));
      expect(await heldUnder(author, ids)).toEqual(ids.map(() => true));
      const cleared = join(gitDir, "local", "scopes", SCOPE, "cleared", `${hexDigest(WRITER)}.sqlite`);
      const warm = rowsHeld(cleared);

      await rm(cleared);
      await heldUnder(station, ids);

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
      await world.store.putMany([{ kind: "case", value: caseCiting("cites", [cited!]) }]);
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
      const [sealedCase] = await world.store.putMany([{ kind: "case", value: caseCiting(slug, [world.restsOn]) }]);
      await seal(world, sealedCase!);
      await runHandler(caseOpen, { case: slug }, world.author);

      const seen = JSON.stringify(await runHandler(doctorRun, {}, world.station));
      const authors = await runHandler(doctorRun, {}, world.author);

      expect(seen).not.toContain(slug);
      expect(authors.local.filter((check) => check.name === "view-worktrees")).toEqual([
        { name: "view-worktrees", ok: true, detail: "no stale view worktree" },
      ]);
    }, 240_000);

    test("doctor under the clearance counts none of the store's records or objects, and the author's does", async () => {
      const world = await restingWorld(key, scratch);

      const seen = await runHandler(doctorRun, {}, world.station);
      const authors = await runHandler(doctorRun, {}, world.author);

      const counted = ["record-layout", "loose-objects"];
      expect(seen.local.filter((check) => counted.includes(check.name))).toEqual([]);
      expect(authors.local.filter((check) => counted.includes(check.name)).map((check) => check.name)).toEqual(counted);
    }, 240_000);

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

      await world.store.putMany([{ kind: "case", value: caseCiting("bad-run", [citing!]) }]);

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

    /** A claim resting on its own receipt, and an argument against it citing `evidence`. */
    async function attackedClaim(world: World, id: string, evidence: readonly RecordId[]): Promise<RecordId> {
      const [own] = await world.store.putMany([{ kind: "run", value: fixtureRunRecord("the claim's own receipt") }]);
      const [attacked] = await world.store.putMany([{ kind: "claim", value: claim(id, {}, [receiptEdge(own!)]) }]);
      const argument: ArgumentRecord = {
        kind: "argument",
        premises: [],
        supersedes: [],
        schemaVersion: CURRENT_SCHEMA_VERSIONS.argument,
        target: attacked!,
        reason: "it does not hold",
        evidence: evidence.map(receiptEdge),
      };
      await world.store.putMany([{ kind: "argument", value: argument }]);
      return attacked!;
    }

    test.each([
      ["wholly on a sealed run", false],
      ["on a sealed receipt and a held testimony", true],
    ])(
      "an argument resting %s refuses the station, since the held part alone could read a contest as holding",
      async (_, withTestimony) => {
        const world = await emptyWorld(key, scratch);
        const [sealed] = await world.store.putMany([{ kind: "run", value: fixtureRunRecord(CANARY) }]);
        const held = withTestimony ? [(await putTestimony(world)).run] : [];
        const attacked = await attackedClaim(world, "attacked", [sealed!, ...held]);
        await world.store.putMany([{ kind: "case", value: caseCiting("cites", [attacked]) }]);
        await seal(world, sealed!);
        const planned: OperationContext = { ...world.station, mode: "plan" };

        await runHandler(claimStatus, { claim: slotOf("attacked") }, { ...world.author, mode: "plan" });
        for (const [descriptor, input] of [
          [claimStatus, { claim: slotOf("attacked") }],
          [claimWhy, { claim: slotOf("attacked"), full: true }],
          [briefRender, { claim: attacked }],
        ] as const) {
          await expect(
            runHandler(descriptor as OperationDescriptor, input, planned),
            descriptor.id,
          ).rejects.toMatchObject({
            reason: "no-such-record",
          });
        }
      },
      120_000,
    );

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
      await world.store.putMany([{ kind: "case", value: caseCiting("reader", [cites!]) }]);

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
      await world.store.putMany([{ kind: "case", value: caseCiting("cites", [cites!]) }]);

      const brief = await runHandler(briefRender, { claim: cites! }, { ...world.author, mode: "plan" });

      expect(brief.output).toContain(own!);
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
      await world.store.putMany([{ kind: "case", value: caseCiting("testified", [testified!]) }]);

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

  test("a station reading without performing reads its own receipts in the station's image, never the author's", async () => {
    const { dir, trust, author, station } = await stationWorkspace();
    const says = { statement: "the tracked file says hello", command: ["node", "-e", TRACKED_SAYS_HELLO] };
    const checked = await runHandler(checkRun, says, author);
    expect(checked.label).toBe("holds");
    const { values } = (await readTrustBranch(trust)).config;
    const configured = { ...values, [STATION_IMAGE_CONFIG_KEY]: `registry.example/station@sha256:${"5".repeat(64)}` };
    await writeTrustFile(trust, "config.json", `${JSON.stringify(configured)}\n`);
    const reading = { ...station, mode: "plan" as const };

    const unrun = await runHandler(claimStatus, { claim: checked.slot }, reading);
    expect([unrun.label, unrun.detail]).toEqual(["open", expect.stringContaining("`status` under the clearance")]);

    const [onHost] = (await runsIn(dir)).filter(
      (run) => run.recipe.command[1] === "-e" && run.recipe.command[2] === TRACKED_SAYS_HELLO,
    );
    const image = stationImageFromConfig({ values: configured })!;
    const held = { clearance: WRITER, image, musaiDir: join(dir, MUSAI_DIR) };
    await new Store({ ctx: { gitDir: join(dir, MUSAI_DIR) }, scope: SCOPE, now }).putMany([
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
    expect((await runHandler(claimStatus, { claim: checked.slot }, reading)).label).toBe("fails");
    expect((await runHandler(claimStatus, { claim: checked.slot }, { ...author, mode: "plan" })).label).toBe("holds");
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
        { kind: "case", value: caseCiting("corrupt", [missing]) },
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
        { kind: "case", value: caseCiting("refused", [unreadable]) },
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
