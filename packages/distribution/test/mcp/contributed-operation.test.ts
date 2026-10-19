import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type OperationContext, openWorkspace } from "@musai/api-core";
import { buildModule } from "@musai/devkit";
import { callTool } from "@musai/mcp";
import {
  type Audience,
  CURRENT_SCHEMA_VERSIONS,
  PACK_IRREVERSIBLE_SLOT_ID,
  type PerformedRunRecord,
  type RecordId,
  recordId,
  slotFor,
  TRIPLE_DECLARATION,
} from "@musai/records";
import { RUNNER_PERFORMER } from "@musai/run";
import { initWorkspace, MUSAI_DIR } from "@musai/store";
import {
  blobStoreOf,
  fixedClock,
  fixtureBrief,
  fixWorkspaceKey,
  pseudonymOf,
  writeTrustFile,
} from "@musai/test-support";
import { mintAttestation } from "@musai/trust";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MUSAI } from "../../src/musai.js";

const STAMPER_FIXTURE_DIR = fileURLToPath(new URL("./fixtures/stamper", import.meta.url));
const CORE_MODULE_DIR = fileURLToPath(new URL("../../../core-module", import.meta.url));
const CASEBOOK_FIXTURE_DIR = fileURLToPath(new URL("../../../scenarios/casebook/modules/casebook", import.meta.url));
/** The one type in reach declaring a canonical schema, whose claims share an exclusive group. */
const DISPOSITION_TYPE = "fixture-casebook/disposition@1";
const now = fixedClock("2026-09-22T00:00:00.000Z");

/** A triple claim as a pack drafts one: a record value with no id. */
function claimDraft(subject: string): Record<string, unknown> {
  const conditions = { subject, predicate: "asserts", object: "a-fixture-object" };
  return {
    kind: "claim",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: "triple@1",
    about: [],
    slot: slotFor(TRIPLE_DECLARATION, conditions),
    conditions,
    canonical: conditions,
    rendering: `${subject} asserts a-fixture-object`,
    evidence: [],
    exclusiveGroup: null,
  };
}

/** A well-formed sealed value. No verb mints one, and no workspace key here could open it. */
const SEALED_TEXT = {
  $sealed: {
    alg: "aes-256-gcm",
    keyId: "a-key-this-workspace-never-held",
    ciphertext: "bm90LXRleHQtYW55Ym9keS1tZWFudC10by1yZWFk",
    digest: "b".repeat(64),
  },
};

/** A command run, which an argument rests on. */
function commandRun(): PerformedRunRecord {
  const instant = now();
  return {
    kind: "run",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
    runKind: "run",
    determinism: "nondeterministic",
    performer: RUNNER_PERFORMER,
    recipe: {
      command: [],
      workingDirectory: "/",
      environment: {},
      declared: [],
      substrates: [],
      isolation: "hygiene",
    },
    observation: {
      resolved: [],
      isolationHeld: "hygiene",
      binaries: [],
      bindings: [],
      output: "the receipt a fixture argument rests on",
      outputLossy: false,
      exitCode: 0,
      scrubbed: [],
      startedAt: instant,
      finishedAt: instant,
      reads: [],
      cost: {},
    },
  };
}

/** A plan drafting one claim and asserting it, as a pack's writing operation answers. */
function assertedClaimPlan(subject: string): Record<string, unknown> {
  return {
    put: [{ kind: "claim", value: claimDraft(subject) }],
    attest: [{ subject: { put: 0 }, purpose: "asserted" }],
    needs: [],
  };
}

interface Minted {
  readonly id: RecordId;
  readonly kind: string;
  readonly record: Record<string, unknown>;
}

describe("a pack's operation contribution called as a tool answers with a plan the kernel realises and applies", () => {
  let workspace: string;
  const scope = "default";
  let context: OperationContext;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-mcp-contributed-operation-"));
    await initWorkspace(workspace, { now });
    await fixWorkspaceKey(workspace);
    context = { workspace, scope, now, via: "model", principalName: "a-client" };
    const { stdout } = await execa("git", ["rev-parse", "--absolute-git-dir"], { cwd: STAMPER_FIXTURE_DIR });
    const opened = await openWorkspace({ workspace, scope, now });
    await buildModule(CORE_MODULE_DIR, opened.store, {
      blobs: blobStoreOf(workspace),
      index: opened.index,
      sourceGitDir: stdout.trim(),
      now,
    });
    await buildModule(CASEBOOK_FIXTURE_DIR, opened.store, {
      blobs: blobStoreOf(workspace),
      index: opened.index,
      sourceGitDir: stdout.trim(),
      now,
    });
    await buildModule(STAMPER_FIXTURE_DIR, opened.store, {
      blobs: blobStoreOf(workspace),
      index: opened.index,
      sourceGitDir: stdout.trim(),
      now,
    });
  }, 60_000);

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  async function tip(): Promise<string | null> {
    return (await openWorkspace({ workspace, scope, now })).store.tip();
  }

  /** A stored ruling over a stored claim, decided against a brief run. */
  async function aRuling(): Promise<{ readonly claim: RecordId; readonly ruling: RecordId }> {
    const opened = await openWorkspace({ workspace, scope, now });
    const [claimId, briefId] = await opened.put([
      { kind: "claim", value: claimDraft("ruled") },
      { kind: "run", value: fixtureBrief("the brief a fixture ruling cites") },
    ]);
    const ruled = await callTool(MUSAI, context, "ruling_make", {
      claim: claimId!,
      verdict: "holds",
      reason: "a ruling for a pack's plan to reach for",
      brief: briefId!,
    });
    const ruling = (ruled.structuredContent as { minted: Minted[] }).minted.find((item) => item.kind === "ruling");
    return { claim: claimId!, ruling: ruling!.id };
  }

  test("in plan mode it answers what it would mint, attested under the session's channel and principal, and writes nothing", async () => {
    const before = await tip();

    const result = await callTool(MUSAI, context, "stamper_answers", {
      answer: assertedClaimPlan("previewed"),
      plan: true,
    });

    const { minted, receipts } = result.structuredContent as { minted: Minted[]; receipts: RecordId[] };
    expect(receipts).toEqual([]);
    expect(minted.map((item) => item.kind)).toEqual(["claim", "attestation"]);
    expect(minted[1]).toMatchObject({
      kind: "attestation",
      record: {
        subject: minted[0]!.id,
        purpose: "asserted",
        principal: pseudonymOf("a-client"),
        principalClass: "agent",
        via: "model",
      },
    });
    expect(await tip()).toBe(before);
  });

  test("performing writes exactly what plan mode showed, in one commit", async () => {
    const answer = assertedClaimPlan("performed");
    const planned = await callTool(MUSAI, context, "stamper_answers", { answer, plan: true });
    const before = await tip();

    const performed = await callTool(MUSAI, context, "stamper_answers", { answer });

    expect(performed.structuredContent).toEqual(planned.structuredContent);
    const opened = await openWorkspace({ workspace, scope, now });
    expect(await opened.store.tip()).not.toBe(before);
    for (const item of (performed.structuredContent as { minted: Minted[] }).minted) {
      expect(await opened.store.read(item.id, item.kind as "claim" | "attestation")).toEqual(item.record);
    }
  });

  test("a stale expected head is refused before the pack is invoked, and nothing is written", async () => {
    const stale = await tip();
    await callTool(MUSAI, context, "stamper_answers", { answer: assertedClaimPlan("moving") });
    const moved = await tip();

    const refusal = await callTool(MUSAI, context, "stamper_answers", {
      answer: assertedClaimPlan("stale"),
      expectHead: stale,
    }).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ reason: "head-moved" });
    expect(await tip()).toBe(moved);
  });

  test("an operation declaring a read whose plan writes is refused invalid-output, naming it, even on a stale head, and nothing is written", async () => {
    const stale = await tip();
    await callTool(MUSAI, context, "stamper_answers", { answer: assertedClaimPlan("moving") });
    const moved = await tip();

    const refusal = await callTool(MUSAI, context, "stamper_answers-as-read", {
      answer: assertedClaimPlan("read-that-writes"),
      expectHead: stale,
    }).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ reason: "invalid-output", about: ["stamper/answers-as-read@1"] });
    expect(await tip()).toBe(moved);
  });

  describe("a pack's plan attests only what it drafts, and only as its maker or asserter", () => {
    test.each(["released", "revoked"])(
      "an attestation asking for %s is refused at the module boundary, and nothing is written",
      async (purpose) => {
        const before = await tip();
        const answer = {
          put: [{ kind: "claim", value: claimDraft(purpose) }],
          attest: [{ subject: { put: 0 }, purpose }],
          needs: [],
        };

        const refusal = await callTool(MUSAI, context, "stamper_answers", { answer }).catch((error: unknown) => error);

        expect(refusal).toMatchObject({ reason: "invalid-output", about: ["stamper_answers"] });
        expect(await tip()).toBe(before);
      },
    );

    test("an attestation naming an existing ruling as its subject is refused at the module boundary, and nothing is written", async () => {
      const { ruling: rulingId } = await aRuling();
      const before = await tip();

      const refusal = await callTool(MUSAI, context, "stamper_answers", {
        answer: { put: [], attest: [{ subject: rulingId, purpose: "asserted" }], needs: [] },
      }).catch((error: unknown) => error);

      expect(refusal).toMatchObject({ reason: "invalid-output", about: ["stamper_answers"] });
      expect(await tip()).toBe(before);
    });
  });

  describe("a pack's drafts pass the admission their kind's own verb runs", () => {
    /** Answers `answer` through the writing stamper, previewed and performed; both refusals. */
    async function refusedBothWays(answer: Record<string, unknown>): Promise<readonly unknown[]> {
      const previewed = await callTool(MUSAI, context, "stamper_answers", { answer, plan: true }).catch(
        (error: unknown) => error,
      );
      const performed = await callTool(MUSAI, context, "stamper_answers", { answer }).catch((error: unknown) => error);
      return [previewed, performed];
    }

    const refusedAtFirstPut = { reason: "invalid-output", about: ["stamper/answers@1", "put/0"] };

    /** The argument `challenge.file` would mint against a stored claim and receipt. */
    async function anAdmissibleArgument(): Promise<Record<string, unknown>> {
      const opened = await openWorkspace({ workspace, scope, now });
      const [claimId, runId] = await opened.put([
        { kind: "claim", value: claimDraft("challenged") },
        { kind: "run", value: commandRun() },
      ]);
      const previewed = await callTool(MUSAI, context, "challenge_file", {
        target: claimId!,
        reason: "the receipt says otherwise",
        run: runId!,
        selector: "musai.core/exit-code@1:exitCode",
        plan: true,
      });
      return (previewed.structuredContent as { minted: Minted[] }).minted[0]!.record;
    }

    /** What `case.book` would mint for one booking: the case, then its setlist's claims. */
    async function anAdmissibleBooking(
      slug: string,
      about: readonly string[],
      kind?: string,
    ): Promise<readonly Minted[]> {
      const previewed = await callTool(MUSAI, context, "case_book", {
        slug,
        about: [...about],
        plan: true,
        ...(kind === undefined ? {} : { kind }),
      });
      return (previewed.structuredContent as { minted: Minted[] }).minted;
    }

    /** A booking's records as plan entries, the case carrying its `about`. */
    function putsOf(minted: readonly Minted[], about: readonly string[]): readonly Record<string, unknown>[] {
      return minted.map((item) =>
        item.kind === "case"
          ? { kind: item.kind, value: item.record, about: [...about] }
          : { kind: item.kind, value: item.record },
      );
    }

    function artifactCiting(caseId: RecordId, cited: string): Record<string, unknown> {
      const label = cited.slice("sha256:".length, "sha256:".length + 12);
      return {
        kind: "artifact",
        schemaVersion: CURRENT_SCHEMA_VERSIONS.artifact,
        case: caseId,
        lifecycle: "drafted",
        content: `Prose resting on a receipt.[^${label}]\n\n## Receipts\n\n[^${label}]: ${cited}\n`,
        format: "markdown",
        supersedes: [],
      };
    }

    test("an argument whose evidence edge names an item its selector does not admit is refused in either mode, and nothing is written", async () => {
      const argument = await anAdmissibleArgument();
      const [edge] = argument["evidence"] as { run: RecordId; selector: unknown; item: RecordId }[];
      const forged = { ...argument, evidence: [{ ...edge!, item: recordId({ forged: true }) }] };
      const before = await tip();

      const refusals = await refusedBothWays({ put: [{ kind: "argument", value: forged }], attest: [], needs: [] });

      expect(refusals).toEqual([
        expect.objectContaining(refusedAtFirstPut),
        expect.objectContaining(refusedAtFirstPut),
      ]);
      expect(await tip()).toBe(before);
    });

    test("a pack's draft citing a run whose attestation carries no signature refuses workspace-incomplete, naming the attestation", async () => {
      const argument = await anAdmissibleArgument();
      const [edge] = argument["evidence"] as { run: RecordId }[];
      const opened = await openWorkspace({ workspace, scope, now });
      const [attestationId] = await opened.put([
        {
          kind: "attestation",
          value: mintAttestation({
            subject: edge!.run,
            principal: pseudonymOf("unsigned@example.test"),
            principalClass: "person",
            via: "tty",
            purpose: "asserted",
            at: now(),
          }).record,
        },
      ]);
      await writeTrustFile(
        { gitDir: join(workspace, MUSAI_DIR) },
        "config.json",
        JSON.stringify({ signing: "person" }),
      );
      const before = await tip();

      const refusals = await refusedBothWays({ put: [{ kind: "argument", value: argument }], attest: [], needs: [] });

      const unsigned = { reason: "workspace-incomplete", code: "workspace", about: [attestationId] };
      expect(refusals).toEqual([expect.objectContaining(unsigned), expect.objectContaining(unsigned)]);
      expect(await tip()).toBe(before);
    });

    test("a bare case citing a drafted claim its base triple derivation would not build is refused in either mode, and nothing is written", async () => {
      const about = ["https://example.test/concerned"];
      const [caseItem, claimItem] = await anAdmissibleBooking("forged-setlist", about);
      const claim = { ...claimItem!.record, rendering: "a claim the booking never named" };
      const bookedCase = { ...caseItem!.record, claims: [recordId(claim)] };
      const before = await tip();

      const refusals = await refusedBothWays({
        put: [
          { kind: "case", value: bookedCase, about },
          { kind: "claim", value: claim },
        ],
        attest: [],
        needs: [],
      });

      expect(refusals).toEqual([
        expect.objectContaining(refusedAtFirstPut),
        expect.objectContaining(refusedAtFirstPut),
      ]);
      expect(await tip()).toBe(before);
    });

    test("a case booked against a kind is derived from the about its plan carries, so one drafted for another about is refused in either mode", async () => {
      const booking = await anAdmissibleBooking(
        "kinded-elsewhere",
        ["https://example.test/reported"],
        "fixture-casebook/report",
      );
      const before = await tip();

      const refusals = await refusedBothWays({
        put: putsOf(booking, ["https://example.test/something-else"]),
        attest: [],
        needs: [],
      });

      expect(refusals).toEqual([
        expect.objectContaining(refusedAtFirstPut),
        expect.objectContaining(refusedAtFirstPut),
      ]);
      expect(await tip()).toBe(before);
    });

    test("an artifact whose anchor names a record neither the store nor its plan holds is refused in either mode, and nothing is written", async () => {
      const booked = await callTool(MUSAI, context, "case_book", { slug: "anchored", about: [] });
      const caseId = (booked.structuredContent as { case: RecordId }).case;
      const before = await tip();

      const refusals = await refusedBothWays({
        put: [{ kind: "artifact", value: artifactCiting(caseId, `sha256:${"f".repeat(64)}`) }],
        attest: [],
        needs: [],
      });

      expect(refusals).toEqual([
        expect.objectContaining(refusedAtFirstPut),
        expect.objectContaining(refusedAtFirstPut),
      ]);
      expect(await tip()).toBe(before);
    });

    test("a draft carrying a field its kind does not own is realised and written in the form its kind rebuilds", async () => {
      const performed = await callTool(MUSAI, context, "stamper_answers", {
        answer: {
          put: [{ kind: "claim", value: { ...claimDraft("injected"), injected: true } }],
          attest: [{ subject: { put: 0 }, purpose: "asserted" }],
          needs: [],
        },
      });

      const { minted } = performed.structuredContent as { minted: Minted[] };
      expect(minted[0]!.record).not.toHaveProperty("injected");
      expect(minted[0]!.id).toBe(recordId(claimDraft("injected")));
      expect(minted[1]!.record).toMatchObject({ subject: minted[0]!.id });
      const opened = await openWorkspace({ workspace, scope, now });
      expect(await opened.store.read(minted[0]!.id, "claim")).toEqual(minted[0]!.record);
    });

    test("a claim a pack drafts with no slot is minted with the id a booking gives the same claim", async () => {
      const [, booked] = await anAdmissibleBooking("unslotted", ["https://example.test/unslotted"]);
      const { slot: _slot, ...unslotted } = booked!.record;
      const answer = { put: [{ kind: "claim", value: unslotted }], attest: [], needs: [] };

      const previewed = await callTool(MUSAI, context, "stamper_answers", { answer, plan: true });
      const performed = await callTool(MUSAI, context, "stamper_answers", { answer });

      for (const result of [previewed, performed]) {
        const { minted } = result.structuredContent as { minted: Minted[] };
        expect(minted[0]!.id).toBe(booked!.id);
      }
      const opened = await openWorkspace({ workspace, scope, now });
      expect(await opened.store.read(booked!.id, "claim")).toEqual(booked!.record);
    });

    test("a claim drafted with no slot, of a type the workspace does not declare, is refused in either mode, naming the type, and nothing is written", async () => {
      const [, booked] = await anAdmissibleBooking("undeclared", ["https://example.test/undeclared"]);
      const { slot: _slot, ...unslotted } = booked!.record;
      const type = "fixture-nobody/declares@1";
      const before = await tip();

      const refusals = await refusedBothWays({
        put: [{ kind: "claim", value: { ...unslotted, type } }],
        attest: [],
        needs: [],
      });

      expect(refusals).toEqual([
        expect.objectContaining({ ...refusedAtFirstPut, detail: expect.stringContaining(type) }),
        expect.objectContaining({ ...refusedAtFirstPut, detail: expect.stringContaining(type) }),
      ]);
      expect(await tip()).toBe(before);
    });

    test("a claim drafted with a slot its type and conditions do not compute is refused in either mode, and nothing is written", async () => {
      const [, first, second] = await anAdmissibleBooking("misslotted", [
        "https://example.test/first",
        "https://example.test/second",
      ]);
      const before = await tip();

      const refusals = await refusedBothWays({
        put: [{ kind: "claim", value: { ...first!.record, slot: second!.record["slot"] } }],
        attest: [],
        needs: [],
      });

      expect(refusals).toEqual([
        expect.objectContaining(refusedAtFirstPut),
        expect.objectContaining(refusedAtFirstPut),
      ]);
      expect(await tip()).toBe(before);
    });

    test("an argument citing one admitted edge twice is written with the edge once, under the id that form hashes to", async () => {
      const argument = await anAdmissibleArgument();
      const [edge] = argument["evidence"] as unknown[];

      const performed = await callTool(MUSAI, context, "stamper_answers", {
        answer: {
          put: [{ kind: "argument", value: { ...argument, evidence: [edge, edge] } }],
          attest: [],
          needs: [],
        },
      });

      const { minted } = performed.structuredContent as { minted: Minted[] };
      expect(minted[0]!.record["evidence"]).toEqual([edge]);
      const opened = await openWorkspace({ workspace, scope, now });
      const stored = await opened.store.read(minted[0]!.id, "argument");
      expect(recordId(stored)).toBe(minted[0]!.id);
    });

    test("a draft whose own kind differs from the entry putting it is refused in either mode, and nothing is written", async () => {
      const { ruling } = await aRuling();
      const opened = await openWorkspace({ workspace, scope, now });
      const rulingRecord = await opened.store.read(ruling, "ruling");
      const before = await tip();

      const refusals = await refusedBothWays({
        put: [{ kind: "claim", value: rulingRecord }],
        attest: [],
        needs: [],
      });

      expect(refusals).toEqual([
        expect.objectContaining(refusedAtFirstPut),
        expect.objectContaining(refusedAtFirstPut),
      ]);
      expect(await tip()).toBe(before);
    });

    test("a claim superseding a ruled claim is refused in either mode, and that claim's status is unchanged", async () => {
      const { claim } = await aRuling();
      const slot = claimDraft("ruled")["slot"] as string;
      const ruledBefore = await callTool(MUSAI, context, "claim_status", { claim: slot });
      const before = await tip();

      const refusals = await refusedBothWays({
        put: [{ kind: "claim", value: { ...claimDraft("superseding"), supersedes: [claim] } }],
        attest: [],
        needs: [],
      });

      expect(refusals).toEqual([
        expect.objectContaining(refusedAtFirstPut),
        expect.objectContaining(refusedAtFirstPut),
      ]);
      expect(await tip()).toBe(before);
      const ruledAfter = await callTool(MUSAI, context, "claim_status", { claim: slot });
      expect(ruledAfter.structuredContent).toEqual(ruledBefore.structuredContent);
    });

    test("an argument naming premises no verb lets its maker name is refused in either mode, and nothing is written", async () => {
      const { claim } = await aRuling();
      const argument = await anAdmissibleArgument();
      const before = await tip();

      const refusals = await refusedBothWays({
        put: [{ kind: "argument", value: { ...argument, premises: [claim] } }],
        attest: [],
        needs: [],
      });

      expect(refusals).toEqual([
        expect.objectContaining(refusedAtFirstPut),
        expect.objectContaining(refusedAtFirstPut),
      ]);
      expect(await tip()).toBe(before);
    });

    test("a claim whose evidence edge names an item its selector does not admit is refused in either mode, and nothing is written", async () => {
      const argument = await anAdmissibleArgument();
      const [edge] = argument["evidence"] as { run: RecordId; selector: unknown; item: RecordId }[];
      const forged = { ...claimDraft("forged-evidence"), evidence: [{ ...edge!, item: recordId({ forged: true }) }] };
      const before = await tip();

      const refusals = await refusedBothWays({ put: [{ kind: "claim", value: forged }], attest: [], needs: [] });

      expect(refusals).toEqual([
        expect.objectContaining(refusedAtFirstPut),
        expect.objectContaining(refusedAtFirstPut),
      ]);
      expect(await tip()).toBe(before);
    });

    test("a claim resting on an admitted evidence edge is written as the pack drafted it", async () => {
      const argument = await anAdmissibleArgument();
      const [edge] = argument["evidence"] as unknown[];
      const claim = { ...claimDraft("evidenced"), evidence: [edge] };

      const performed = await callTool(MUSAI, context, "stamper_answers", {
        answer: { put: [{ kind: "claim", value: claim }], attest: [], needs: [] },
      });

      const { minted } = performed.structuredContent as { minted: Minted[] };
      const opened = await openWorkspace({ workspace, scope, now });
      expect(await opened.store.read(minted[0]!.id, "claim")).toEqual(claim);
    });

    test("an artifact standing in for an artifact of its own case is written as the pack drafted it", async () => {
      const booked = await callTool(MUSAI, context, "case_book", { slug: "superseded", about: [] });
      const caseId = (booked.structuredContent as { case: RecordId }).case;
      const opened = await openWorkspace({ workspace, scope, now });
      const [predecessor] = await opened.put([{ kind: "artifact", value: artifactCiting(caseId, caseId) }]);
      const successor = { ...artifactCiting(caseId, caseId), supersedes: [predecessor!] };

      const performed = await callTool(MUSAI, context, "stamper_answers", {
        answer: { put: [{ kind: "artifact", value: successor }], attest: [], needs: [] },
      });

      const { minted } = performed.structuredContent as { minted: Minted[] };
      const reopened = await openWorkspace({ workspace, scope, now });
      expect(await reopened.store.read(minted[0]!.id, "artifact")).toEqual(successor);
    });

    test("an artifact standing in for anything but one artifact of its own case is refused in either mode, and nothing is written", async () => {
      const booked = await callTool(MUSAI, context, "case_book", { slug: "superseding-elsewhere", about: [] });
      const caseId = (booked.structuredContent as { case: RecordId }).case;
      const opened = await openWorkspace({ workspace, scope, now });
      const [first, second] = await opened.put([
        { kind: "artifact", value: artifactCiting(caseId, caseId) },
        { kind: "artifact", value: { ...artifactCiting(caseId, caseId), format: "text" } },
      ]);
      const before = await tip();

      const overTheCase = await refusedBothWays({
        put: [{ kind: "artifact", value: { ...artifactCiting(caseId, caseId), supersedes: [caseId] } }],
        attest: [],
        needs: [],
      });
      const overTwo = await refusedBothWays({
        put: [{ kind: "artifact", value: { ...artifactCiting(caseId, caseId), supersedes: [first!, second!] } }],
        attest: [],
        needs: [],
      });

      for (const refusal of [...overTheCase, ...overTwo]) {
        expect(refusal).toMatchObject(refusedAtFirstPut);
      }
      expect(await tip()).toBe(before);
    });

    test("an artifact drafted in a lifecycle only a later verb reaches is refused in either mode, and nothing is written", async () => {
      const booked = await callTool(MUSAI, context, "case_book", { slug: "already-dropped", about: [] });
      const caseId = (booked.structuredContent as { case: RecordId }).case;
      const before = await tip();

      const refusals = await refusedBothWays({
        put: [{ kind: "artifact", value: { ...artifactCiting(caseId, caseId), lifecycle: "dropped" } }],
        attest: [],
        needs: [],
      });

      expect(refusals).toEqual([
        expect.objectContaining(refusedAtFirstPut),
        expect.objectContaining(refusedAtFirstPut),
      ]);
      expect(await tip()).toBe(before);
    });

    /** A disposition claim from a report's setlist: a schema-declaring type in a shared group. */
    async function aDispositionClaim(slug: string): Promise<Record<string, unknown>> {
      const booking = await anAdmissibleBooking(slug, [], "fixture-casebook/report");
      const disposition = booking.find((item) => item.record["type"] === DISPOSITION_TYPE);
      if (disposition === undefined) {
        throw new Error(`the report kind named no ${DISPOSITION_TYPE} claim for ${slug}`);
      }
      return disposition.record;
    }

    test("a claim whose conditions omit an identity dimension of its type is refused in either mode, and nothing is written", async () => {
      const conditions = { subject: "partly-identified", predicate: "asserts" };
      const partial = {
        ...claimDraft("partly-identified"),
        conditions,
        canonical: conditions,
        slot: slotFor(TRIPLE_DECLARATION, conditions),
      };
      const before = await tip();

      const refusals = await refusedBothWays({ put: [{ kind: "claim", value: partial }], attest: [], needs: [] });

      expect(refusals).toEqual([
        expect.objectContaining(refusedAtFirstPut),
        expect.objectContaining(refusedAtFirstPut),
      ]);
      expect(await tip()).toBe(before);
    });

    test("a claim whose canonical payload does not satisfy the schema its type declares is refused in either mode, and nothing is written", async () => {
      const slug = "payload-outside-its-schema";
      const forged = { ...(await aDispositionClaim(slug)), canonical: { case: slug, disposition: 4711 } };
      const before = await tip();

      const refusals = await refusedBothWays({ put: [{ kind: "claim", value: forged }], attest: [], needs: [] });

      expect(refusals).toEqual([
        expect.objectContaining(refusedAtFirstPut),
        expect.objectContaining(refusedAtFirstPut),
      ]);
      expect(await tip()).toBe(before);
    });

    test("a claim naming an exclusive group at a slot nothing has reached is written as the pack drafted it", async () => {
      const slug = "a-menu-of-its-own";
      const disposition = await aDispositionClaim(slug);

      const performed = await callTool(MUSAI, context, "stamper_answers", {
        answer: { put: [{ kind: "claim", value: disposition }], attest: [], needs: [] },
      });

      const { minted } = performed.structuredContent as { minted: Minted[] };
      expect(minted[0]!.record["exclusiveGroup"]).toBe(`${slug}/disposition`);
      const opened = await openWorkspace({ workspace, scope, now });
      expect(await opened.store.read(minted[0]!.id, "claim")).toEqual(disposition);
    });

    test("a claim naming an exclusive group at a slot a live contributor already holds is refused in either mode, and that slot still reads open", async () => {
      const group = "a-menu-the-pack-did-not-open";
      const opened = await openWorkspace({ workspace, scope, now });
      const [member, briefId] = await opened.put([
        { kind: "claim", value: { ...claimDraft("the-answered-member"), exclusiveGroup: group } },
        { kind: "run", value: fixtureBrief("the brief a fixture ruling cites") },
        { kind: "claim", value: claimDraft("the-persons-claim") },
      ]);
      await callTool(MUSAI, context, "ruling_make", {
        claim: member!,
        verdict: "holds",
        reason: "one member of this menu is answered",
        brief: briefId!,
      });
      const memberSlot = claimDraft("the-answered-member")["slot"] as string;
      const slot = claimDraft("the-persons-claim")["slot"] as string;
      // One member holds, so a slot joining the group derives `fails` from that ruling alone.
      const answered = await callTool(MUSAI, context, "claim_status", { claim: memberSlot });
      expect(answered.structuredContent).toMatchObject({ label: "holds" });
      const before = await tip();

      const refusals = await refusedBothWays({
        put: [{ kind: "claim", value: { ...claimDraft("the-persons-claim"), exclusiveGroup: group } }],
        attest: [],
        needs: [],
      });

      expect(refusals).toEqual([
        expect.objectContaining(refusedAtFirstPut),
        expect.objectContaining(refusedAtFirstPut),
      ]);
      expect(await tip()).toBe(before);
      const persons = await callTool(MUSAI, context, "claim_status", { claim: slot });
      expect(persons.structuredContent).toMatchObject({ label: "open" });
    });

    async function menuOf(claim: RecordId): Promise<unknown> {
      const asked = await callTool(MUSAI, context, "gate_ask", { claim, plan: true });
      return (asked.structuredContent as { options: unknown }).options;
    }

    /** Books `slug` against the report kind; the disposition claim its menu opens with. */
    async function aBookedMenu(slug: string): Promise<RecordId> {
      const booked = await callTool(MUSAI, context, "case_book", {
        slug,
        about: [],
        kind: "fixture-casebook/report",
      });
      const { minted } = booked.structuredContent as { minted: Minted[] };
      return minted.find((item) => item.record["type"] === DISPOSITION_TYPE)!.id;
    }

    test("two claims of one plan at one slot under different groups are refused in either mode, and a booking of that slot still offers its menu", async () => {
      const slug = "one-slot-two-menus";
      const disposition = await aDispositionClaim(slug);
      const before = await tip();

      const refusals = await refusedBothWays({
        put: [
          { kind: "claim", value: { ...disposition, exclusiveGroup: "one-menu" } },
          { kind: "claim", value: { ...disposition, exclusiveGroup: "another-menu" } },
        ],
        attest: [],
        needs: [],
      });

      expect(refusals).toEqual([
        expect.objectContaining({ ...refusedAtFirstPut, detail: expect.stringContaining("of the same plan") }),
        expect.objectContaining({ ...refusedAtFirstPut, detail: expect.stringContaining("of the same plan") }),
      ]);
      expect(await tip()).toBe(before);
      const values = ((await menuOf(await aBookedMenu(slug))) as { value: string }[]).map((option) => option.value);
      expect(values.sort()).toEqual(["file", "withdraw"]);
    });

    test("a plan drafting a booked case's grouped claims again, byte for byte, is admitted, and the group's menu is unchanged", async () => {
      const slug = "a-menu-drafted-again";
      const booking = await anAdmissibleBooking(slug, [], "fixture-casebook/report");
      const member = await aBookedMenu(slug);
      const menu = await menuOf(member);

      await callTool(MUSAI, context, "stamper_answers", {
        answer: { put: putsOf(booking, []), attest: [], needs: [] },
      });

      expect(await menuOf(member)).toEqual(menu);
    });

    test("a claim at a fresh slot naming the group a booked case opened is refused in either mode, and that case's menu is unchanged", async () => {
      const slug = "a-menu-already-open";
      const derived = await aDispositionClaim(slug);
      const member = await aBookedMenu(slug);
      const menu = await menuOf(member);
      const conditions = { case: slug, disposition: "comment", gateClass: "intent" };
      const joining = {
        ...derived,
        conditions,
        canonical: { case: slug, disposition: "comment" },
        rendering: `comment on ${slug} instead`,
        slot: slotFor({ type: DISPOSITION_TYPE, identityDimensions: ["case", "disposition"] }, conditions),
      };
      const before = await tip();

      const refusals = await refusedBothWays({ put: [{ kind: "claim", value: joining }], attest: [], needs: [] });

      expect(refusals).toEqual([
        expect.objectContaining({ ...refusedAtFirstPut, detail: expect.stringContaining("already has members") }),
        expect.objectContaining({ ...refusedAtFirstPut, detail: expect.stringContaining("already has members") }),
      ]);
      expect(await tip()).toBe(before);
      expect(await menuOf(member)).toEqual(menu);
    });

    test("two members of one group in one plan offering the same menu option are refused in either mode, and nothing is written", async () => {
      const group = "a-menu-offering-file-twice";
      const first = { ...(await aDispositionClaim("files-once")), exclusiveGroup: group };
      const second = { ...(await aDispositionClaim("files-twice")), exclusiveGroup: group };
      const before = await tip();

      const refusals = await refusedBothWays({
        put: [
          { kind: "claim", value: first },
          { kind: "claim", value: second },
        ],
        attest: [],
        needs: [],
      });

      expect(refusals).toEqual([
        expect.objectContaining({ ...refusedAtFirstPut, detail: expect.stringContaining("the same menu option file") }),
        expect.objectContaining({ ...refusedAtFirstPut, detail: expect.stringContaining("the same menu option file") }),
      ]);
      expect(await tip()).toBe(before);
    });

    describe("a booking's claims pass the same group admission as a pack's", () => {
      test("a booking whose kind puts a grouped claim at a slot a person's claim holds is refused in either mode, and the person's claim still reads open", async () => {
        const slug = "a-slot-a-person-spoke-for";
        const derived = await aDispositionClaim(slug);
        const opened = await openWorkspace({ workspace, scope, now });
        await opened.put([
          {
            kind: "claim",
            value: { ...derived, rendering: "a person's own word on filing it", exclusiveGroup: null },
          },
        ]);
        const before = await tip();
        const booking = { slug, about: [], kind: "fixture-casebook/report" };

        const previewed = await callTool(MUSAI, context, "case_book", { ...booking, plan: true }).catch(
          (error: unknown) => error,
        );
        const performed = await callTool(MUSAI, context, "case_book", booking).catch((error: unknown) => error);

        for (const refusal of [previewed, performed]) {
          expect(refusal).toMatchObject({
            reason: "invalid-input",
            detail: expect.stringContaining("already contributes"),
          });
        }
        expect(await tip()).toBe(before);
        const persons = await callTool(MUSAI, context, "claim_status", { claim: derived["slot"] as string });
        expect(persons.structuredContent).toMatchObject({ label: "open" });
      });

      test("a booking whose kind opens its own group writes every member, and the group's menu offers each", async () => {
        const member = await aBookedMenu("a-menu-the-kind-opens");

        const values = ((await menuOf(member)) as { value: string }[]).map((option) => option.value);

        expect(values.sort()).toEqual(["file", "withdraw"]);
      });
    });

    test("a pack's ungrouped claim at a booked menu member's slot cannot be answered holds once another member holds", async () => {
      const slug = "a-twin-without-the-menu";
      const booked = await callTool(MUSAI, context, "case_book", {
        slug,
        about: [],
        kind: "fixture-casebook/report",
      });
      const members = (booked.structuredContent as { minted: Minted[] }).minted.filter(
        (item) => item.record["type"] === DISPOSITION_TYPE,
      );
      const byValue = (value: string) =>
        members.find((item) => (item.record["conditions"] as Record<string, string>)["disposition"] === value)!;
      const withdraw = byValue("withdraw");
      const asked = await callTool(MUSAI, context, "gate_ask", { claim: withdraw.id });
      const { brief } = asked.structuredContent as { brief: RecordId };
      await callTool(MUSAI, context, "gate_answer", {
        pending: withdraw.id,
        brief,
        choice: "withdraw",
        reason: "the menu is answered",
      });
      const drafted = await callTool(MUSAI, context, "stamper_answers", {
        answer: {
          put: [
            {
              kind: "claim",
              value: { ...byValue("file").record, rendering: `file ${slug} after all`, exclusiveGroup: null },
            },
          ],
          attest: [],
          needs: [],
        },
      });
      const twin = (drafted.structuredContent as { minted: Minted[] }).minted[0]!.id;
      const before = await tip();

      const refused = await callTool(MUSAI, context, "gate_answer", {
        pending: twin,
        brief,
        choice: "holds",
        reason: "the twin says file",
      }).catch((error: unknown) => error);

      expect(refused).toMatchObject({
        reason: "sibling-conflict",
        about: [withdraw.record["exclusiveGroup"], withdraw.record["slot"]],
      });
      expect(await tip()).toBe(before);
      const answered = await callTool(MUSAI, context, "claim_status", { claim: withdraw.record["slot"] as string });
      expect(answered.structuredContent).toMatchObject({ label: "holds" });
    });

    test("a claim whose rendering is sealed is refused in either mode, and nothing is written", async () => {
      const sealed = { ...claimDraft("sealed-rendering"), rendering: SEALED_TEXT };
      const before = await tip();

      const refusals = await refusedBothWays({ put: [{ kind: "claim", value: sealed }], attest: [], needs: [] });

      expect(refusals).toEqual([
        expect.objectContaining(refusedAtFirstPut),
        expect.objectContaining(refusedAtFirstPut),
      ]);
      expect(await tip()).toBe(before);
    });

    test("an argument whose reason is sealed is refused in either mode, and nothing is written", async () => {
      const argument = await anAdmissibleArgument();
      const before = await tip();

      const refusals = await refusedBothWays({
        put: [{ kind: "argument", value: { ...argument, reason: SEALED_TEXT } }],
        attest: [],
        needs: [],
      });

      expect(refusals).toEqual([
        expect.objectContaining(refusedAtFirstPut),
        expect.objectContaining(refusedAtFirstPut),
      ]);
      expect(await tip()).toBe(before);
    });

    test("an admitted argument, case with the claims its kind derives, and artifact are each written as the pack drafted them", async () => {
      const argument = await anAdmissibleArgument();
      const about = ["https://example.test/reported"];
      const booking = await anAdmissibleBooking("drafted-by-a-pack", about, "fixture-casebook/report");
      const caseId = booking[0]!.id;
      const artifact = artifactCiting(caseId, caseId);

      const performed = await callTool(MUSAI, context, "stamper_answers", {
        answer: {
          put: [
            { kind: "argument", value: argument },
            ...putsOf(booking, about),
            { kind: "artifact", value: artifact },
          ],
          attest: [{ subject: { put: 0 }, purpose: "made" }],
          needs: [],
        },
      });

      const { minted } = performed.structuredContent as { minted: Minted[] };
      expect(minted.map((item) => item.kind)).toEqual([
        "argument",
        "case",
        ...booking.slice(1).map((item) => item.kind),
        "artifact",
        "attestation",
      ]);
      expect(minted[1]!.id).toBe(caseId);
      const opened = await openWorkspace({ workspace, scope, now });
      for (const item of minted) {
        expect(await opened.store.read(item.id, item.kind as "argument")).toEqual(item.record);
      }
    });
  });

  test("plan mode refuses where performing would: an irreversible operation the project has not allowed", async () => {
    const before = await tip();
    const answer = assertedClaimPlan("irreversible");

    const previewed = await callTool(MUSAI, context, "stamper_answers-irreversibly", { answer, plan: true }).catch(
      (error: unknown) => error,
    );
    const performed = await callTool(MUSAI, context, "stamper_answers-irreversibly", { answer }).catch(
      (error: unknown) => error,
    );

    const refusal = { reason: "not-authorised", about: ["stamper/answers-irreversibly@1", PACK_IRREVERSIBLE_SLOT_ID] };
    expect(previewed).toMatchObject(refusal);
    expect(performed).toMatchObject(refusal);
    expect(await tip()).toBe(before);
  });

  test("a plan puts a claim, carries a run need, and is applied under the session's own channel and principal rather than anything the pack named", async () => {
    const conditions = { subject: "a-fixture-subject", predicate: "asserts", object: "a-fixture-object" };
    const slot = slotFor(TRIPLE_DECLARATION, conditions);

    const performed = await callTool(MUSAI, context, "stamper_asserts-and-runs", {
      ...conditions,
      slot,
      schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    });

    const { minted, receipts } = performed.structuredContent as { minted: Minted[]; receipts: RecordId[] };
    const claim = minted.find((item) => item.kind === "claim");
    const attestation = minted.find((item) => item.kind === "attestation");
    if (claim === undefined || attestation === undefined) {
      throw new Error("asserts-and-runs minted neither a claim nor an attestation to check");
    }
    const opened = await openWorkspace({ workspace, scope, now });

    // The id realisePlan computed over the draft is the id the store persisted, by construction.
    const storedClaim = await opened.store.read(claim.id, "claim");
    expect(storedClaim).toEqual(claim.record);
    expect(recordId(storedClaim)).toBe(claim.id);

    expect(receipts).toHaveLength(1);
    await expect(opened.store.read(receipts[0]!, "run")).resolves.toMatchObject({ kind: "run" });

    // The principal and channel are the session's, never the pack's plan's.
    expect(attestation.record).toMatchObject({
      principal: pseudonymOf("a-client"),
      principalClass: "agent",
      via: "model",
    });
  });

  test("a plan's run need under a clearance whose trust branch names no station image is refused, naming the clearance, and lands nothing", async () => {
    await writeTrustFile({ gitDir: join(workspace, MUSAI_DIR) }, "audiences", "writer\n");
    const conditions = { subject: "a-station-subject", predicate: "asserts", object: "a-fixture-object" };
    const before = await tip();

    const refused = await callTool(MUSAI, { ...context, clearance: "writer" as Audience }, "stamper_asserts-and-runs", {
      ...conditions,
      slot: slotFor(TRIPLE_DECLARATION, conditions),
      schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    }).catch((error: unknown) => error);

    expect(refused).toMatchObject({ reason: "invalid-input", about: ["writer"] });
    expect(await tip()).toBe(before);
  });
});
