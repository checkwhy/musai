import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isOperationError,
  type OperationContext,
  type OperationDescriptor,
  openWorkspace,
  runHandler,
} from "@musai/api-core";
import {
  type ArgumentRecord,
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
import { checkEvaluation, evaluationRecipe, recordedEvaluation } from "../src/evaluation.js";
import { briefRender } from "../src/ops/brief.js";
import { caseBook, caseSoundcheck } from "../src/ops/case.js";
import { caseStatus } from "../src/ops/case-status.js";
import { type CheckRunInput, checkRun } from "../src/ops/check.js";
import { claimStatus } from "../src/ops/claim.js";
import { doctorRun } from "../src/ops/doctor.js";
import { eventsSinceOperation } from "../src/ops/events.js";
import { gateAnswer, gateAsk, gatePending } from "../src/ops/gate.js";
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
  caseCiting,
  claim,
  emptyWorld,
  latestUnder,
  now,
  opensshAvailable,
  PUBLISHER,
  RECORD_NEED_RULE,
  rebuildRecordNeed,
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
        await world.store.putMany([{ kind: "case", value: caseCiting("cites", [attacked]) }]);
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
      await world.store.putMany([{ kind: "case", value: caseCiting("cites", [attacked]) }]);
      await seal(world, sealed!);

      const planned = await runHandler(briefRender, { claim: attacked }, { ...world.station, mode: "plan" });
      const rendered = await runHandler(briefRender, { claim: attacked }, world.station);
      const run = (await world.store.read(rendered.brief, "run")) as ComputedRunRecord;
      const { head, caseId } = parseBriefSubstrates(run.recipe);
      const staleness = await fullReadIds(await openWorkspace(world.station), caseId, attacked, head);
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
      await world.store.putMany([{ kind: "case", value: caseCiting("cites", [attacked]) }]);
      await seal(world, sealed!);
      const planned: OperationContext = { ...world.station, mode: "plan" };

      const status = await runHandler(claimStatus, { claim: slotOf("attacked") }, planned);
      const rendered = await runHandler(briefRender, { claim: attacked }, world.station);
      const run = (await world.store.read(rendered.brief, "run")) as ComputedRunRecord;
      const { head, caseId } = parseBriefSubstrates(run.recipe);
      const staleness = await fullReadIds(await openWorkspace(world.station), caseId, attacked, head);
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
      await world.store.putMany([{ kind: "case", value: caseCiting("checks", [checked!]) }]);
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
      return { run, staleness: await fullReadIds(opened, caseId, claimId, head) };
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
      const argument = await argueAgainst(world, mixed!, [held!, sealed!], "it does not hold");
      await world.store.putMany([{ kind: "case", value: caseCiting("mixed", [mixed!]) }]);
      await seal(world, sealed!);
      const planned: OperationContext = { ...world.station, mode: "plan" };
      const itemLines = (output: string) => output.split("\n").filter((line) => line.startsWith("- "));
      const bytesOf = (lines: readonly string[]) => lines.reduce((total, line) => total + Buffer.byteLength(line), 0);
      const full = await runHandler(briefRender, { claim: mixed! }, planned);
      expect(full.output).toContain(`- argument ${argument} contests the claim on grounds withheld`);

      let mostOmitted = 0;
      for (let budget = bytesOf(itemLines(full.output)); ; budget -= 8) {
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
        expect(bytesOf(itemLines(output))).toBeLessThanOrEqual(budget);
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
      await world.store.putMany([{ kind: "case", value: caseCiting("twins", [twin!]) }]);

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

    test("a ruling whose brief read a sealed run leaves the station's claim open, naming neither the run nor the brief", async () => {
      const world = await emptyWorld(key, scratch);
      const [sealed] = await world.store.putMany([{ kind: "run", value: fixtureRunRecord(CANARY) }]);
      const [held] = await world.store.putMany([
        { kind: "run", value: fixtureRunRecord("a receipt the station holds") },
      ]);
      const [ruled] = await world.store.putMany([
        { kind: "claim", value: claim("ruled", {}, [receiptEdge(sealed!), receiptEdge(held!)]) },
      ]);
      await world.store.putMany([{ kind: "case", value: caseCiting("ruled", [ruled!]) }]);
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
      await world.store.putMany([{ kind: "case", value: caseCiting("ruled", [ruled!]) }]);
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
      await world.store.putMany([{ kind: "case", value: caseCiting("cites", [attacked]) }]);
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
      await world.store.putMany([{ kind: "case", value: caseCiting("menu", [chosen!, other!]) }]);
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
      await world.store.putMany([{ kind: "case", value: caseCiting("menu", [chosen!, other!]) }]);
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
      await world.store.putMany([{ kind: "case", value: caseCiting("menu", [chosen!, other!]) }]);
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
      await world.store.putMany([{ kind: "case", value: caseCiting("menu", [chosen!, other!]) }]);
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

    test("a brief packing a testimony names the attestation its kind word reads among its reads", async () => {
      const world = await emptyWorld(key, scratch);
      const { run, attestation } = await putTestimony(world);
      const [testified] = await world.store.putMany([
        { kind: "claim", value: claim("testified", {}, [receiptEdge(run!)]) },
      ]);
      await world.store.putMany([{ kind: "case", value: caseCiting("testified", [testified!]) }]);

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

  test("a station's status and soundcheck without performing answer from its own evaluation in the station's image, never the author's", async () => {
    const { dir, trust, author, station } = await stationWorkspace();
    const says = { statement: "the tracked file says hello", command: ["node", "-e", TRACKED_SAYS_HELLO] };
    const checked = await runHandler(checkRun, says, author);
    expect(checked.label).toBe("holds");
    const store = new Store({ ctx: { gitDir: join(dir, MUSAI_DIR) }, scope: SCOPE, now });
    await store.putMany([{ kind: "case", value: caseCiting("checks", [checked.claim as RecordId]) }]);
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
