import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOperationError, openWorkspace, runHandler } from "@musai/api-core";
import { RULING_HOP_LABEL } from "@musai/evaluate";
import {
  type ArgumentRecord,
  type AttestationRecord,
  type CaseRecord,
  type ClaimRecord,
  type ClaimTypeDeclaration,
  CURRENT_SCHEMA_VERSIONS,
  claimTypesFrom,
  type EvidenceEdge,
  type RecordId,
  type RulingRecord,
  type RunRecord,
  recordId,
  slotFor,
  timestamp,
  versionString,
} from "@musai/records";
import { RUNNER_PERFORMER } from "@musai/run";
import { initWorkspace, Store } from "@musai/store";
import { declareClaimTypes, fixedClock, fixWorkspaceKey, namedCaller, writeTrustFile } from "@musai/test-support";
import { afterEach, describe, expect, test } from "vitest";
import { groupHolder } from "../src/claim.js";
import { briefRender } from "../src/ops/brief.js";
import { caseStatus } from "../src/ops/case-status.js";
import { claimStatus } from "../src/ops/claim.js";
import { gateAnswer, gateAsk, gatePending } from "../src/ops/gate.js";
import { rulingMake } from "../src/ops/ruling.js";
import { claimWhy } from "../src/ops/why.js";

const FIXED_INSTANT = timestamp("2026-01-01T00:00:00.000Z");
const now = fixedClock(FIXED_INSTANT);

function receiptRun(output: string): RunRecord {
  return {
    kind: "run",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
    runKind: "run",
    determinism: "nondeterministic",
    performer: RUNNER_PERFORMER,
    recipe: { command: [], workingDirectory: "/", environment: {}, declared: [], substrates: [], isolation: "hygiene" },
    observation: {
      resolved: [],
      isolationHeld: "hygiene",
      binaries: [],
      bindings: [],
      output,
      outputLossy: false,
      exitCode: 0,
      scrubbed: [],
      startedAt: FIXED_INSTANT,
      finishedAt: FIXED_INSTANT,
      reads: [],
      cost: {},
    },
  };
}

function receiptEdge(run: RecordId, key: string): EvidenceEdge {
  return {
    run,
    selector: { module: "musai.core", parser: "exit-code", version: versionString("1"), key },
    item: recordId({ run, key }),
  };
}

const CLAIM_TYPE = "musai.gate-answer-fixture-test/claim@1";
const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: CLAIM_TYPE, identityDimensions: ["id"] };
/** An undeclared claim type spelled so `memberId` sorts below every sibling. Slots are digests,
 * so the spelling is searched for; a reader skipping inapplicable members is then tested. */
function undeclaredTypeSortingFirst(memberId: string, siblingIds: readonly string[]): ClaimTypeDeclaration {
  const siblings = siblingIds.map((id) => slotFor(CLAIM_DECLARATION, { id }));
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const candidate: ClaimTypeDeclaration = {
      type: `musai.gate-answer-fixture-test/undeclared-${attempt}@1`,
      identityDimensions: ["id"],
    };
    const slot = slotFor(candidate, { id: memberId });
    if (siblings.every((sibling) => slot < sibling)) {
      return candidate;
    }
  }
  throw new Error(`no undeclared type spelling put ${memberId} below ${siblingIds.join(", ")}; widen the search`);
}
const UNDECLARED_DECLARATION = undeclaredTypeSortingFirst("a", ["b", "c"]);
/** A third type, so a re-pin dropping one is a module record the store does not hold yet. */
const SPARE_DECLARATION: ClaimTypeDeclaration = {
  type: "musai.gate-answer-fixture-test/spare@1",
  identityDimensions: ["id"],
};
const CLAIM_TYPES = claimTypesFrom([CLAIM_DECLARATION, UNDECLARED_DECLARATION]);

interface ClaimSpec {
  readonly id: string;
  readonly rendering: string;
  readonly exclusiveGroup: string | null;
  readonly disposition?: string;
  readonly gateClass?: string;
  /** Written under a type the workspace's fold does not declare. */
  readonly undeclared?: true;
  /** A receipt minted ahead of the claim and cited as its direct evidence. */
  readonly receipt?: string;
}

async function buildWorkspace(slug: string, specs: readonly ClaimSpec[]) {
  const workspace = await mkdtemp(join(tmpdir(), "musai-gate-answer-test-"));
  await initWorkspace(workspace, { now });
  await fixWorkspaceKey(workspace);
  const scope = "default";
  const store = new Store({ ctx: { gitDir: join(workspace, ".musai") }, scope, now, claimTypes: CLAIM_TYPES });
  await declareClaimTypes(store, [CLAIM_DECLARATION]);

  const claimIds: RecordId[] = [];
  const idBySpecId = new Map<string, RecordId>();
  const slotBySpecId = new Map<string, string>();
  for (const spec of specs) {
    const conditions: Record<string, string> = { id: spec.id };
    if (spec.disposition !== undefined) {
      conditions["disposition"] = spec.disposition;
    }
    if (spec.gateClass !== undefined) {
      conditions["gateClass"] = spec.gateClass;
    }
    const declaration = spec.undeclared ? UNDECLARED_DECLARATION : CLAIM_DECLARATION;
    const slot = slotFor(declaration, conditions);
    const claim: ClaimRecord = {
      kind: "claim",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
      type: declaration.type,
      about: [],
      slot,
      conditions,
      canonical: conditions,
      rendering: spec.rendering,
      evidence: [],
      exclusiveGroup: spec.exclusiveGroup,
    };
    if (spec.receipt !== undefined) {
      const [runId] = await store.putMany([{ kind: "run", value: receiptRun(spec.receipt) }]);
      claim.evidence.push(receiptEdge(runId!, "result"));
    }
    const [id] = await store.putMany([{ kind: "claim", value: claim }]);
    claimIds.push(id!);
    idBySpecId.set(spec.id, id!);
    slotBySpecId.set(spec.id, slot);
  }

  const caseRecord: CaseRecord = {
    kind: "case",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.case,
    type: null,
    slug,
    claims: claimIds,
    preset: {
      module: "musai.core",
      contribution: "musai.core/bare",
      moduleRecord: recordId({ marker: "gate-answer-fixture" }),
    },
    projectCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    overrides: {},
    evaluatorVersion: versionString("1"),
  };
  await store.putMany([{ kind: "case", value: caseRecord }]);

  return { workspace, scope, store, idBySpecId, slotBySpecId };
}

describe("gate.answer@2", () => {
  let workspace: string;

  afterEach(async () => {
    if (workspace) {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("mints exactly two records — one ruling and one attestation", async () => {
    const built = await buildWorkspace("two-record-case", [
      { id: "only", rendering: "it holds", exclusiveGroup: null },
    ]);
    workspace = built.workspace;
    const claimId = built.idBySpecId.get("only")!;
    const asked = await runHandler(gateAsk, { claim: claimId }, { workspace, scope: built.scope, now });

    const output = await runHandler(
      gateAnswer,
      {
        pending: claimId,
        brief: asked.brief,
        choice: "holds",
        reason: "the fixture says so",
      },
      { workspace, scope: built.scope, now, via: "tty", principalName: "person@example.com" },
    );

    expect(output.minted).toHaveLength(2);
    expect(output.minted.map((item) => item.kind).sort()).toEqual(["attestation", "ruling"]);
    const ruling = output.minted.find((item) => item.kind === "ruling")!.record as RulingRecord;
    expect(ruling.over).toEqual({ claim: claimId });
    expect(ruling.verdict).toBe("holds");
    expect(ruling.reason).toBe("the fixture says so");
  });

  test("an answer given with a salt mints a salted ruling, its attestation naming the salted id", async () => {
    const built = await buildWorkspace("salted-answer", [{ id: "only", rendering: "it holds", exclusiveGroup: null }]);
    workspace = built.workspace;
    const claimId = built.idBySpecId.get("only")!;
    const asked = await runHandler(gateAsk, { claim: claimId }, { workspace, scope: built.scope, now });

    const output = await runHandler(
      gateAnswer,
      { pending: claimId, brief: asked.brief, choice: "holds", reason: "answered salted", salt: true },
      { workspace, scope: built.scope, now, via: "tty", principalName: "person@example.com" },
    );

    const ruling = output.minted.find((item) => item.kind === "ruling")!;
    expect(ruling.record).toMatchObject({ over: { claim: claimId }, salt: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(output.minted.find((item) => item.kind === "attestation")!.record).toMatchObject({ subject: ruling.id });
  });

  test("two planned answers to the same question at one head, under one context, mint identical record ids", async () => {
    const built = await buildWorkspace("parity-source-case", [
      { id: "only", rendering: "it holds", exclusiveGroup: null },
    ]);
    workspace = built.workspace;
    const claimId = built.idBySpecId.get("only")!;
    const asked = await runHandler(gateAsk, { claim: claimId }, { workspace, scope: built.scope, now });
    const answerInput = {
      pending: claimId,
      brief: asked.brief,
      choice: "holds",
      reason: "answered from the terminal",
    };
    const answerContext = {
      workspace,
      scope: built.scope,
      mode: "plan" as const,
      now: fixedClock(FIXED_INSTANT),
      via: "tty" as const,
      principalName: "person@example.com",
    };

    const first = await runHandler(gateAnswer, answerInput, answerContext);
    const second = await runHandler(gateAnswer, answerInput, answerContext);

    expect(new Set(first.minted.map((item) => item.id))).toEqual(new Set(second.minted.map((item) => item.id)));
  });

  test("refuses an answer whose context establishes no channel, naming via, before anything is minted", async () => {
    const built = await buildWorkspace("no-channel-case", [
      { id: "only", rendering: "it holds", exclusiveGroup: null },
    ]);
    workspace = built.workspace;
    const claimId = built.idBySpecId.get("only")!;
    const asked = await runHandler(gateAsk, { claim: claimId }, { workspace, scope: built.scope, now });
    const headBefore = await built.store.tip();

    const error = await runHandler(
      gateAnswer,
      { pending: claimId, brief: asked.brief, choice: "holds", reason: "nobody established" },
      { workspace, scope: built.scope, now, principalName: "person@example.com" },
    ).catch((caught: unknown) => caught);

    expect(isOperationError(error)).toBe(true);
    expect(error).toMatchObject({ reason: "invalid-input", about: ["via"] });
    expect(await built.store.tip()).toBe(headBefore);
  });

  test("a model-channel answer mints a delegate, provisional attestation carrying the stated choice in the reason, never a person class", async () => {
    const built = await buildWorkspace("model-channel-case", [
      { id: "only", rendering: "it holds", exclusiveGroup: null },
    ]);
    workspace = built.workspace;
    const claimId = built.idBySpecId.get("only")!;
    const asked = await runHandler(gateAsk, { claim: claimId }, { workspace, scope: built.scope, now });

    const output = await runHandler(
      gateAnswer,
      {
        pending: claimId,
        brief: asked.brief,
        choice: "holds",
        reason: "the person at the keyboard said holds",
      },
      { workspace, scope: built.scope, now, via: "model", principalName: "an-agent@example.com" },
    );

    const attestation = output.minted.find((item) => item.kind === "attestation")!.record as AttestationRecord;
    expect(attestation.principalClass).toBe("agent");
    expect(attestation.via).toBe("model");
    const ruling = output.minted.find((item) => item.kind === "ruling")!.record as RulingRecord;
    expect(ruling.reason).toBe("the person at the keyboard said holds");

    const status = await runHandler(
      claimStatus,
      { claim: built.slotBySpecId.get("only")! },
      { workspace, scope: built.scope, now },
    );
    expect(status.label).toBe("holds");
    expect(status.comparison.via).toBe("ruling");
  });

  test("one ruling holding on one sibling makes every other sibling read fails, with exactly one ruling record in the store", async () => {
    const built = await buildWorkspace("menu-resolution-case", [
      { id: "a", rendering: "file a new issue", exclusiveGroup: "disposition", disposition: "file" },
      { id: "b", rendering: "post a comment", exclusiveGroup: "disposition", disposition: "comment" },
      { id: "c", rendering: "withdraw", exclusiveGroup: "disposition", disposition: "withdraw" },
    ]);
    workspace = built.workspace;
    const claimA = built.idBySpecId.get("a")!;
    const asked = await runHandler(gateAsk, { claim: claimA }, { workspace, scope: built.scope, now });

    await runHandler(
      gateAnswer,
      {
        pending: claimA,
        brief: asked.brief,
        choice: "file",
        reason: "the fixture picks file",
      },
      { workspace, scope: built.scope, now, via: "tty", principalName: "person@example.com" },
    );

    const statusA = await runHandler(
      claimStatus,
      { claim: built.slotBySpecId.get("a")! },
      { workspace, scope: built.scope, now },
    );
    const statusB = await runHandler(
      claimStatus,
      { claim: built.slotBySpecId.get("b")! },
      { workspace, scope: built.scope, now },
    );
    const statusC = await runHandler(
      claimStatus,
      { claim: built.slotBySpecId.get("c")! },
      { workspace, scope: built.scope, now },
    );
    expect(statusA.label).toBe("holds");
    expect(statusB.label).toBe("fails");
    expect(statusC.label).toBe("fails");

    const opened = await openWorkspace({ workspace, scope: built.scope, now });
    const rulingIds = await opened.store.list("ruling");
    expect(rulingIds).toHaveLength(1);
  });

  test("a menu asked over one member and answered choosing another reads its verdict, flagged decided on stale evidence once a member the brief read is superseded", async () => {
    const slug = "menu-answered-elsewhere";
    const built = await buildWorkspace(slug, [
      {
        id: "a",
        rendering: "file a new issue",
        exclusiveGroup: "disposition",
        disposition: "file",
        gateClass: "intent",
      },
      {
        id: "b",
        rendering: "post a comment",
        exclusiveGroup: "disposition",
        disposition: "comment",
        gateClass: "intent",
      },
      { id: "c", rendering: "withdraw", exclusiveGroup: "disposition", disposition: "withdraw", gateClass: "intent" },
    ]);
    workspace = built.workspace;
    const reader = { workspace, scope: built.scope, now };
    const statusOf = (specId: string) => runHandler(claimStatus, { claim: built.slotBySpecId.get(specId)! }, reader);
    const claimA = built.idBySpecId.get("a")!;
    expect((await runHandler(gatePending, { case: slug }, reader)).gates).toHaveLength(1);

    // The brief covers the whole menu; the person chooses another member.
    const asked = await runHandler(gateAsk, { claim: claimA }, reader);
    await runHandler(
      gateAnswer,
      { pending: claimA, brief: asked.brief, choice: "comment", reason: "the fixture picks comment" },
      { ...reader, via: "tty", principalName: "person@example.com" },
    );

    expect((await statusOf("b")).label).toBe("holds");
    expect((await statusOf("a")).label).toBe("fails");
    expect((await statusOf("c")).label).toBe("fails");
    expect((await runHandler(caseStatus, { case: slug }, reader)).counts).toEqual({
      holds: 1,
      fails: 0,
      open: 0,
      notChosen: 2,
    });
    expect((await runHandler(gatePending, { case: slug }, reader)).gates).toEqual([]);

    // A later record at the asked member's slot moves what the brief read.
    const askedRecord = (await built.store.read(claimA, "claim")) as ClaimRecord;
    await built.store.putMany([
      { kind: "claim", value: { ...askedRecord, supersedes: [claimA], rendering: "file a new issue, reworded" } },
    ]);
    expect(await statusOf("b")).toMatchObject({ label: "holds", decidedOnStaleEvidence: true });

    // Every reader agrees the menu is answered, and the two that list gates flag it.
    const claimB = built.idBySpecId.get("b")!;
    const pending = await runHandler(gatePending, { case: slug }, reader);
    const progress = await runHandler(caseStatus, { case: slug }, reader);
    const opened = await openWorkspace({ workspace, scope: built.scope, now });
    expect(pending.gates).toEqual([]);
    expect(pending.flagged).toEqual([{ case: slug, claim: claimB, gateClass: "intent" }]);
    expect(progress.next).toBeNull();
    expect(progress.counts).toEqual({ holds: 1, fails: 0, open: 0, notChosen: 2 });
    expect(progress.flagged).toEqual([claimB]);
    expect(await groupHolder(opened, "disposition")).toBe(built.slotBySpecId.get("b"));
    expect(gatePending.renderText(pending)).toContain("answered on stale evidence");
    expect(caseStatus.renderText(progress)).toContain("answered on stale evidence");
  });

  test("a binary gate two peers ruled opposite ways reads contested, and pending lists it as progress names it next", async () => {
    const slug = "binary-contested";
    const built = await buildWorkspace(slug, [
      { id: "only", rendering: "ship it", exclusiveGroup: null, gateClass: "intent" },
    ]);
    workspace = built.workspace;
    const reader = { workspace, scope: built.scope, now };
    const claim = built.idBySpecId.get("only")!;
    for (const [verdict, principal] of [
      ["holds", "one@example.com"],
      ["fails", "two@example.com"],
    ] as const) {
      const { brief } = await runHandler(briefRender, { claim }, reader);
      await runHandler(
        rulingMake,
        { claim, verdict, reason: `${principal} rules ${verdict}`, brief, supersedes: [] },
        { ...reader, via: "tty", principalName: principal },
      );
    }

    const status = await runHandler(claimStatus, { claim: built.slotBySpecId.get("only")! }, reader);
    const pending = await runHandler(gatePending, { case: slug }, reader);
    const progress = await runHandler(caseStatus, { case: slug }, reader);

    expect(status).toMatchObject({ label: "open", reason: "contested-authority" });
    expect(pending.gates).toEqual([{ case: slug, claim, gateClass: "intent" }]);
    expect(progress.next).toEqual({ gate: claim, class: "intent" });
  });

  test("a menu asked over a member carrying direct and attacking evidence and answered choosing another reads its verdict, flagged decided on stale evidence once an argument the brief read is replaced", async () => {
    const slug = "menu-answered-elsewhere-with-evidence";
    const built = await buildWorkspace(slug, [
      {
        id: "a",
        rendering: "file a new issue",
        exclusiveGroup: "disposition",
        disposition: "file",
        gateClass: "intent",
        receipt: "the receipt the asked member rests on",
      },
      {
        id: "b",
        rendering: "post a comment",
        exclusiveGroup: "disposition",
        disposition: "comment",
        gateClass: "intent",
      },
      { id: "c", rendering: "withdraw", exclusiveGroup: "disposition", disposition: "withdraw", gateClass: "intent" },
    ]);
    workspace = built.workspace;
    const reader = { workspace, scope: built.scope, now };
    const statusOf = (specId: string) => runHandler(claimStatus, { claim: built.slotBySpecId.get(specId)! }, reader);
    const claimA = built.idBySpecId.get("a")!;
    const [attackRunId] = await built.store.putMany([
      { kind: "run", value: receiptRun("the receipt an argument against the asked member rests on") },
    ]);
    const attack: ArgumentRecord = {
      kind: "argument",
      premises: [],
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.argument,
      target: claimA,
      reason: "a challenge to the asked member, standing when the brief is rendered",
      evidence: [receiptEdge(attackRunId!, "result")],
    };
    const [attackId] = await built.store.putMany([{ kind: "argument", value: attack }]);

    const asked = await runHandler(gateAsk, { claim: claimA }, reader);
    await runHandler(
      gateAnswer,
      { pending: claimA, brief: asked.brief, choice: "comment", reason: "the fixture picks comment" },
      { ...reader, via: "tty", principalName: "person@example.com" },
    );

    expect(await statusOf("b")).toMatchObject({ label: "holds" });

    // Replacing the packed argument with one on another receipt moves what the brief read.
    const [restatedRunId] = await built.store.putMany([
      { kind: "run", value: receiptRun("the receipt the restated argument rests on") },
    ]);
    await built.store.putMany([
      {
        kind: "argument",
        value: {
          ...attack,
          supersedes: [attackId!],
          reason: "the challenge, restated on another receipt",
          evidence: [receiptEdge(restatedRunId!, "result")],
        },
      },
    ]);
    expect(await statusOf("b")).toMatchObject({ label: "holds", decidedOnStaleEvidence: true });
  });

  test("a sibling answered twice with the same choice still holds, and every other sibling reads fails", async () => {
    const built = await buildWorkspace("answered-twice-case", [
      { id: "a", rendering: "file a new issue", exclusiveGroup: "disposition", disposition: "file" },
      { id: "b", rendering: "post a comment", exclusiveGroup: "disposition", disposition: "comment" },
    ]);
    workspace = built.workspace;
    const claimA = built.idBySpecId.get("a")!;
    const answerer = { workspace, scope: built.scope, now, via: "tty" as const, principalName: "person@example.com" };
    for (const reason of ["the fixture picks file", "the fixture picks file again"]) {
      const asked = await runHandler(gateAsk, { claim: claimA }, { workspace, scope: built.scope, now });
      await runHandler(gateAnswer, { pending: claimA, brief: asked.brief, choice: "file", reason }, answerer);
    }
    const opened = await openWorkspace({ workspace, scope: built.scope, now });
    expect(await opened.store.list("ruling")).toHaveLength(2);

    const statusA = await runHandler(
      claimStatus,
      { claim: built.slotBySpecId.get("a")! },
      { workspace, scope: built.scope, now },
    );
    const statusB = await runHandler(
      claimStatus,
      { claim: built.slotBySpecId.get("b")! },
      { workspace, scope: built.scope, now },
    );
    expect(statusA.label).toBe("holds");
    expect(statusB.label).toBe("fails");
  });

  test("a ruling that would make a second sibling hold is refused closed, naming the group and the sibling already holding", async () => {
    const built = await buildWorkspace("second-hold-case", [
      { id: "a", rendering: "file a new issue", exclusiveGroup: "disposition", disposition: "file" },
      { id: "b", rendering: "post a comment", exclusiveGroup: "disposition", disposition: "comment" },
    ]);
    workspace = built.workspace;
    const claimA = built.idBySpecId.get("a")!;
    const claimB = built.idBySpecId.get("b")!;
    const askedA = await runHandler(gateAsk, { claim: claimA }, { workspace, scope: built.scope, now });
    await runHandler(
      gateAnswer,
      {
        pending: claimA,
        brief: askedA.brief,
        choice: "file",
        reason: "the fixture picks file",
      },
      { workspace, scope: built.scope, now, via: "tty", principalName: "person@example.com" },
    );

    const askedB = await runHandler(gateAsk, { claim: claimB }, { workspace, scope: built.scope, now });
    const error = await runHandler(
      gateAnswer,
      {
        pending: claimB,
        brief: askedB.brief,
        choice: "comment",
        reason: "too late",
      },
      { workspace, scope: built.scope, now, via: "tty", principalName: "person@example.com" },
    ).catch((caught: unknown) => caught);

    expect(isOperationError(error)).toBe(true);
    expect((error as { reason: string }).reason).toBe("sibling-conflict");
    expect((error as { about: readonly string[] }).about).toContain("disposition");
  });

  test("a free-text answer against the other-option sibling records the text in the ruling's reason", async () => {
    const built = await buildWorkspace("free-text-case", [
      { id: "file", rendering: "file a new issue", exclusiveGroup: "disposition", disposition: "file" },
      { id: "other", rendering: "something else", exclusiveGroup: "disposition", disposition: "other" },
    ]);
    workspace = built.workspace;
    const claimOther = built.idBySpecId.get("other")!;
    const asked = await runHandler(gateAsk, { claim: claimOther }, { workspace, scope: built.scope, now });

    const output = await runHandler(
      gateAnswer,
      {
        pending: claimOther,
        brief: asked.brief,
        choice: "other",
        reason: "actually, close it as a duplicate",
      },
      { workspace, scope: built.scope, now, via: "tty", principalName: "person@example.com" },
    );

    const ruling = output.minted.find((item) => item.kind === "ruling")!.record as RulingRecord;
    expect(ruling.over).toEqual({ claim: claimOther });
    expect(ruling.reason).toBe("actually, close it as a duplicate");
  });

  test("refuses a choice the menu does not offer", async () => {
    const built = await buildWorkspace("bad-choice-case", [
      { id: "only", rendering: "it holds", exclusiveGroup: null },
    ]);
    workspace = built.workspace;
    const claimId = built.idBySpecId.get("only")!;
    const asked = await runHandler(gateAsk, { claim: claimId }, { workspace, scope: built.scope, now });

    const error = await runHandler(
      gateAnswer,
      {
        pending: claimId,
        brief: asked.brief,
        choice: "sideways",
        reason: "nonsense",
      },
      { workspace, scope: built.scope, now, via: "tty", principalName: "person@example.com" },
    ).catch((caught: unknown) => caught);

    expect(isOperationError(error)).toBe(true);
  });

  test("declares the reasons it can raise", () => {
    expect(gateAnswer.reasons).toContain("sibling-conflict");
    expect(gateAnswer.reasons).toContain("not-authorised");
    expect(gateAnswer.reasons).toContain("stale");
  });
});

describe("every ruling on a member of an exclusive group passes the menu's exclusivity", () => {
  let workspace: string;

  afterEach(async () => {
    if (workspace) {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  const MENU: readonly ClaimSpec[] = [
    { id: "a", rendering: "file a new issue", exclusiveGroup: "disposition", disposition: "file", gateClass: "intent" },
    {
      id: "b",
      rendering: "post a comment",
      exclusiveGroup: "disposition",
      disposition: "comment",
      gateClass: "intent",
    },
    { id: "c", rendering: "withdraw", exclusiveGroup: "disposition", disposition: "withdraw", gateClass: "intent" },
  ];
  const person = namedCaller("tty", "person@example.com");
  const delegate = namedCaller("model", "an-agent@example.com");

  async function aMenu(slug: string, specs: readonly ClaimSpec[] = MENU) {
    const built = await buildWorkspace(slug, specs);
    workspace = built.workspace;
    const reader = { workspace, scope: built.scope, now };
    async function briefFor(specId: string): Promise<RecordId> {
      return (await runHandler(gateAsk, { claim: built.idBySpecId.get(specId)! }, reader)).brief;
    }
    return {
      ...built,
      briefFor,
      async labels(): Promise<Record<string, string>> {
        const labels: Record<string, string> = {};
        for (const spec of specs) {
          labels[spec.id] = (await runHandler(claimStatus, { claim: built.slotBySpecId.get(spec.id)! }, reader)).label;
        }
        return labels;
      },
      async pending(): Promise<readonly RecordId[]> {
        return (await runHandler(gatePending, {}, reader)).gates.map((gate) => gate.claim);
      },
      async rule(specId: string, verdict: "holds" | "fails", by: typeof person | typeof delegate, brief?: RecordId) {
        return runHandler(
          rulingMake,
          {
            claim: built.idBySpecId.get(specId)!,
            verdict,
            reason: `ruled ${verdict}`,
            brief: brief ?? (await briefFor(specId)),
          },
          { ...reader, ...by },
        );
      },
      async answer(specId: string, choice: string, by: typeof person | typeof delegate) {
        const brief = await briefFor(specId);
        return runHandler(
          gateAnswer,
          { pending: built.idBySpecId.get(specId)!, brief, choice, reason: `answered ${choice}` },
          { ...reader, ...by },
        );
      },
    };
  }

  test("why names the ruling, and no receipt, as what decided a gate no evidence reaches", async () => {
    const menu = await aMenu("decided-by-ruling-alone", MENU);
    const reader = { workspace, scope: menu.scope, now };
    await menu.rule("a", "holds", person);

    const why = await runHandler(claimWhy, { claim: menu.slotBySpecId.get("a")!, full: true }, reader);

    expect(why).toMatchObject({ label: "holds", via: "ruling", runs: [] });
    expect(why.derivation?.decidedBy).toBe("ruling");
    expect(why.derivation?.children.map((child) => child.label)).toEqual([RULING_HOP_LABEL]);
  });

  test("a direct ruling that would make a second member hold is refused, and every member stays readable", async () => {
    for (const specs of [MENU.slice(0, 2), MENU]) {
      const menu = await aMenu(`second-direct-hold-of-${specs.length}`, specs);
      await menu.rule("a", "holds", person);
      const brief = await menu.briefFor("b");
      const headBefore = await menu.store.tip();

      const error = await menu.rule("b", "holds", person, brief).catch((caught: unknown) => caught);

      expect(error).toMatchObject({ reason: "sibling-conflict", about: ["disposition", menu.slotBySpecId.get("a")!] });
      expect(await menu.store.tip()).toBe(headBefore);
      const expected: Record<string, string> = { a: "holds", b: "fails", c: "fails" };
      expect(await menu.labels()).toEqual(Object.fromEntries(specs.map((spec) => [spec.id, expected[spec.id]])));
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("a ruling on a member that does not apply is refused, the member is offered nowhere, and another member's hold is minted", async () => {
    const menu = await aMenu("inapplicable-member", [{ ...MENU[0]!, undeclared: true }, MENU[1]!, MENU[2]!]);
    const reader = { workspace, scope: menu.scope, now };
    const brief = await menu.briefFor("a");
    const headBefore = await menu.store.tip();

    const refusal = await menu.rule("a", "holds", person, brief).catch((caught: unknown) => caught);

    expect(refusal).toMatchObject({ reason: "inapplicable", about: [menu.idBySpecId.get("a")!] });
    expect((refusal as { detail: string }).detail).toContain(UNDECLARED_DECLARATION.type);
    expect(await menu.store.tip()).toBe(headBefore);
    for (const specId of ["a", "b", "c"]) {
      const asked = await runHandler(gateAsk, { claim: menu.idBySpecId.get(specId)! }, reader);
      expect(asked.options.map((option) => option.value).sort()).toEqual(["comment", "withdraw"]);
    }
    // `a` sorts first, so it names the group unless the pending read skips an inapplicable member.
    const [lowest, ...rest] = ["a", "b", "c"].sort((left, right) =>
      menu.slotBySpecId.get(left)! < menu.slotBySpecId.get(right)! ? -1 : 1,
    );
    expect(lowest).toBe("a");
    expect(await menu.pending()).toEqual([menu.idBySpecId.get(rest[0]!)!]);
    expect(await menu.labels()).toEqual({ a: "open", b: "open", c: "open" });

    await menu.answer("b", "comment", person);

    expect(await menu.pending()).toEqual([]);
    expect(await menu.labels()).toEqual({ a: "open", b: "holds", c: "fails" });
    const inapplicable = await runHandler(claimStatus, { claim: menu.slotBySpecId.get("a")! }, reader);
    expect(inapplicable).toMatchObject({ label: "open", reason: "inapplicable" });
    expect(await runHandler(claimWhy, { claim: menu.slotBySpecId.get("a")! }, reader)).toMatchObject({
      reason: "inapplicable",
      via: inapplicable.comparison.via,
      detail: inapplicable.detail,
    });
  });

  test("a menu none of whose members applies is not pending, offers no menu and mints no ruling", async () => {
    const menu = await aMenu(
      "nothing-applies",
      MENU.map((spec) => ({ ...spec, undeclared: true as const })),
    );
    const reader = { workspace, scope: menu.scope, now };

    expect(await menu.pending()).toEqual([]);
    for (const [specId, choice] of [
      ["a", "file"],
      ["b", "comment"],
      ["c", "withdraw"],
    ] as const) {
      const claim = menu.idBySpecId.get(specId)!;
      const refusedAsk = await runHandler(gateAsk, { claim }, reader).catch((caught: unknown) => caught);
      expect(refusedAsk).toMatchObject({ reason: "no-such-record", about: ["disposition"] });

      const { brief } = await runHandler(briefRender, { claim }, reader);
      const headBefore = await menu.store.tip();
      const refusedRuling = await menu.rule(specId, "holds", person, brief).catch((caught: unknown) => caught);
      expect(refusedRuling).toMatchObject({ reason: "inapplicable", about: [claim] });
      const refusedAnswer = await runHandler(
        gateAnswer,
        { pending: claim, brief, choice, reason: `answered ${choice}` },
        { ...reader, ...person },
      ).catch((caught: unknown) => caught);
      expect(refusedAnswer).toMatchObject({ reason: "no-such-record" });
      expect(await menu.store.tip()).toBe(headBefore);
    }
    expect(await menu.labels()).toEqual({ a: "open", b: "open", c: "open" });
  });

  test("a holder that stops applying while a sibling is answered, then applies again, holds beside it: each of the two reads holds, and every read asking which member holds is refused", async () => {
    const menu = await aMenu("holder-applies-again", [{ ...MENU[0]!, undeclared: true }, MENU[1]!, MENU[2]!]);
    const reader = { workspace, scope: menu.scope, now };
    await declareClaimTypes(menu.store, [CLAIM_DECLARATION, UNDECLARED_DECLARATION]);
    await menu.answer("a", "file", person);
    expect(await menu.labels()).toEqual({ a: "holds", b: "fails", c: "fails" });

    await declareClaimTypes(menu.store, [CLAIM_DECLARATION, SPARE_DECLARATION]);
    expect(await menu.labels()).toEqual({ a: "open", b: "open", c: "open" });
    await menu.answer("b", "comment", person);
    expect(await menu.labels()).toEqual({ a: "open", b: "holds", c: "fails" });

    await declareClaimTypes(menu.store, [CLAIM_DECLARATION, SPARE_DECLARATION, UNDECLARED_DECLARATION]);

    const [lower] = [menu.slotBySpecId.get("a")!, menu.slotBySpecId.get("b")!].sort();
    const conflict = { reason: "sibling-conflict", about: ["disposition", lower] };
    for (const specId of ["a", "b"]) {
      expect((await runHandler(claimStatus, { claim: menu.slotBySpecId.get(specId)! }, reader)).label).toBe("holds");
    }
    await expect(runHandler(claimStatus, { claim: menu.slotBySpecId.get("c")! }, reader)).rejects.toMatchObject(
      conflict,
    );
    await expect(runHandler(gatePending, {}, reader)).rejects.toMatchObject(conflict);
    const brief = await menu.briefFor("c");
    await expect(menu.rule("c", "holds", person, brief)).rejects.toMatchObject(conflict);
  });

  test("a bare gate claim that does not apply is not pending, and the answer its binary menu still offers is refused", async () => {
    const menu = await aMenu("bare-inapplicable", [
      { id: "solo", rendering: "it holds", exclusiveGroup: null, gateClass: "intent", undeclared: true },
    ]);
    const reader = { workspace, scope: menu.scope, now };
    const claim = menu.idBySpecId.get("solo")!;

    expect(await menu.pending()).toEqual([]);
    const asked = await runHandler(gateAsk, { claim }, reader);
    expect(asked.options.map((option) => option.value)).toEqual(["holds", "fails"]);
    const headBefore = await menu.store.tip();
    const refused = await runHandler(
      gateAnswer,
      { pending: claim, brief: asked.brief, choice: "holds", reason: "answered holds" },
      { ...reader, ...person },
    ).catch((caught: unknown) => caught);
    expect(refused).toMatchObject({ reason: "inapplicable", about: [claim] });
    expect(await menu.store.tip()).toBe(headBefore);
    expect(await menu.labels()).toEqual({ solo: "open" });
  });

  test("a direct ruling that a member fails is minted whatever its siblings hold, and a second hold on the holding member is too", async () => {
    const menu = await aMenu("fails-and-reaffirm");
    await menu.rule("a", "holds", person);

    await menu.rule("b", "fails", person);
    await menu.rule("a", "holds", person);

    expect(await menu.labels()).toEqual({ a: "holds", b: "fails", c: "fails" });
  });

  test("a hold no attestation vouches for neither settles the menu nor blocks answering it, through a gate or directly", async () => {
    for (const route of ["answer", "rule"] as const) {
      const menu = await aMenu(`unvouched-hold-${route}`);
      const unvouched: RulingRecord = {
        kind: "ruling",
        supersedes: [],
        schemaVersion: CURRENT_SCHEMA_VERSIONS.ruling,
        over: { claim: menu.idBySpecId.get("a")! },
        verdict: "holds",
        reason: "committed by a peer, signed by nobody",
        brief: await menu.briefFor("a"),
      };
      await menu.store.putMany([{ kind: "ruling", value: unvouched }]);
      expect(await menu.pending()).toHaveLength(1);
      expect(await menu.labels()).toEqual({ a: "open", b: "open", c: "open" });

      await (route === "answer" ? menu.answer("b", "comment", person) : menu.rule("b", "holds", person));

      expect(await menu.pending()).toEqual([]);
      expect(await menu.labels()).toEqual({ a: "fails", b: "holds", c: "fails" });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("a vouched hold settles the menu and refuses every other member's answer", async () => {
    const menu = await aMenu("vouched-hold");
    await menu.answer("a", "file", person);

    expect(await menu.pending()).toEqual([]);
    for (const [specId, choice] of [
      ["b", "comment"],
      ["c", "withdraw"],
    ] as const) {
      const error = await menu.answer(specId, choice, person).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ reason: "sibling-conflict" });
    }
    expect(await menu.labels()).toEqual({ a: "holds", b: "fails", c: "fails" });
  });

  test("a person's fails over a delegate's answer reopens the menu: the group is pending again and another member can be answered", async () => {
    const menu = await aMenu("overruled-delegate");
    await menu.answer("a", "file", delegate);
    expect(await menu.pending()).toEqual([]);
    expect(await menu.labels()).toEqual({ a: "holds", b: "fails", c: "fails" });

    await menu.rule("a", "fails", person);

    expect(await menu.labels()).toEqual({ a: "fails", b: "open", c: "open" });
    expect(await menu.pending()).toHaveLength(1);
    await menu.answer("b", "comment", person);
    expect(await menu.pending()).toEqual([]);
    expect(await menu.labels()).toEqual({ a: "fails", b: "holds", c: "fails" });
  });

  test("under a holding floor a fails ruling on another member is refused, since the floor would make it hold, and the menu stays readable", async () => {
    const menu = await aMenu("floor-holds");
    await writeTrustFile(
      { gitDir: join(workspace, ".musai") },
      "config.json",
      JSON.stringify({ floor: { verdict: "holds" } }),
    );
    await menu.answer("a", "file", person);
    const brief = await menu.briefFor("b");
    const headBefore = await menu.store.tip();

    const error = await menu.rule("b", "fails", person, brief).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ reason: "sibling-conflict", about: ["disposition", menu.slotBySpecId.get("a")!] });
    expect(await menu.store.tip()).toBe(headBefore);
    expect(await menu.pending()).toEqual([]);
    expect(await menu.labels()).toEqual({ a: "holds", b: "fails", c: "fails" });
  });

  test("an ungrouped claim at a grouped member's slot answers a binary menu whose hold still passes the group's exclusivity", async () => {
    const menu = await aMenu("ungrouped-at-a-grouped-slot");
    const opened = await openWorkspace({ workspace, scope: menu.scope, now });
    const twin: ClaimRecord = {
      ...(opened.read(menu.idBySpecId.get("a")!) as ClaimRecord),
      rendering: "file a new issue, said again without the menu",
      exclusiveGroup: null,
    };
    const [twinId] = await menu.store.putMany([{ kind: "claim", value: twin }]);
    const citing = opened.index.cases()[0]!.record;
    await menu.store.putMany([{ kind: "case", value: { ...citing, slug: "the-twin-case", claims: [twinId!] } }]);
    await menu.answer("c", "withdraw", person);
    const asked = await runHandler(gateAsk, { claim: twinId! }, { workspace, scope: menu.scope, now });
    expect(asked.options.map((option) => option.value)).toEqual(["holds", "fails"]);
    const headBefore = await menu.store.tip();

    const error = await runHandler(
      gateAnswer,
      { pending: twinId!, brief: asked.brief, choice: "holds", reason: "the twin says file" },
      { workspace, scope: menu.scope, now, ...person },
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ reason: "sibling-conflict", about: ["disposition", menu.slotBySpecId.get("c")!] });
    expect(await menu.store.tip()).toBe(headBefore);
    expect(await menu.labels()).toEqual({ a: "fails", b: "fails", c: "holds" });
  });
});

describe("gate.answer@2 — an answer against evidence that moved", () => {
  let workspace: string;

  afterEach(async () => {
    if (workspace) {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  /** A workspace naming one binary gate with real direct evidence, for an argument to move. */
  async function buildEvidencedWorkspace(slug: string) {
    const workspace = await mkdtemp(join(tmpdir(), "musai-gate-stale-test-"));
    await initWorkspace(workspace, { now });
    const scope = "default";
    const store = new Store({ ctx: { gitDir: join(workspace, ".musai") }, scope, now, claimTypes: CLAIM_TYPES });
    await declareClaimTypes(store, [CLAIM_DECLARATION]);

    const [directRunId] = await store.putMany([
      { kind: "run", value: receiptRun("the direct receipt this claim rests on") },
    ]);

    const conditions = { id: "only" };
    const claim: ClaimRecord = {
      kind: "claim",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
      type: CLAIM_TYPE,
      about: [],
      slot: slotFor(CLAIM_DECLARATION, conditions),
      conditions,
      canonical: conditions,
      rendering: "the corpus is clean",
      evidence: [receiptEdge(directRunId!, "result")],
      exclusiveGroup: null,
    };
    const [claimId] = await store.putMany([{ kind: "claim", value: claim }]);

    const caseRecord: CaseRecord = {
      kind: "case",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.case,
      type: null,
      slug,
      claims: [claimId!],
      preset: {
        module: "musai.core",
        contribution: "musai.core/bare",
        moduleRecord: recordId({ marker: "gate-stale-fixture" }),
      },
      projectCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      overrides: {},
      evaluatorVersion: versionString("1"),
    };
    await store.putMany([{ kind: "case", value: caseRecord }]);

    return { workspace, scope, store, claimId: claimId! };
  }

  async function mintAttackingArgument(
    store: Store,
    claimId: RecordId,
  ): Promise<{ id: RecordId; argument: ArgumentRecord }> {
    const [attackRunId] = await store.putMany([
      { kind: "run", value: receiptRun("a new attacking receipt, minted after the brief") },
    ]);
    const argument: ArgumentRecord = {
      kind: "argument",
      premises: [],
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.argument,
      target: claimId,
      reason: "a challenge minted after the brief was rendered",
      evidence: [receiptEdge(attackRunId!, "result")],
    };
    const [id] = await store.putMany([{ kind: "argument", value: argument }]);
    return { id: id!, argument };
  }

  test("citing a brief whose evidence is all unmoved writes as usual", async () => {
    const built = await buildEvidencedWorkspace("unmoved-case");
    workspace = built.workspace;
    const asked = await runHandler(gateAsk, { claim: built.claimId }, { workspace, scope: built.scope, now });

    const output = await runHandler(
      gateAnswer,
      {
        pending: built.claimId,
        brief: asked.brief,
        choice: "holds",
        reason: "nothing moved",
      },
      { workspace, scope: built.scope, now, via: "tty", principalName: "person@example.com" },
    );

    expect(output.minted).toHaveLength(2);
  });

  test("citing a brief whose evidence has since moved refuses with the stale reason, naming exactly the moved reads and no unmoved one", async () => {
    const built = await buildEvidencedWorkspace("moved-case");
    workspace = built.workspace;
    const asked = await runHandler(gateAsk, { claim: built.claimId }, { workspace, scope: built.scope, now });

    const attack = await mintAttackingArgument(built.store, built.claimId);

    const error = await runHandler(
      gateAnswer,
      {
        pending: built.claimId,
        brief: asked.brief,
        choice: "holds",
        reason: "too late",
      },
      { workspace, scope: built.scope, now, via: "tty", principalName: "person@example.com" },
    ).catch((caught: unknown) => caught);

    expect(isOperationError(error)).toBe(true);
    expect((error as { reason: string }).reason).toBe("stale");
    expect((error as { about: readonly string[] }).about).toEqual([attack.id, attack.argument.evidence[0]!.run].sort());
  });

  test("a ruling over a brief that packed a standing argument against its own claim reads its verdict unflagged, and decided on stale evidence once that argument is replaced", async () => {
    const built = await buildEvidencedWorkspace("argued-before-the-brief");
    workspace = built.workspace;
    const reader = { workspace, scope: built.scope, now };
    const attack = await mintAttackingArgument(built.store, built.claimId);
    const slot = ((await built.store.read(built.claimId, "claim")) as ClaimRecord).slot;

    const asked = await runHandler(gateAsk, { claim: built.claimId }, reader);
    await runHandler(
      gateAnswer,
      { pending: built.claimId, brief: asked.brief, choice: "holds", reason: "the challenge does not persuade" },
      { ...reader, via: "tty", principalName: "person@example.com" },
    );

    const fresh = await runHandler(claimStatus, { claim: slot }, reader);
    expect(fresh).toMatchObject({ label: "holds" });
    expect(fresh).not.toMatchObject({ decidedOnStaleEvidence: true });

    // Replacing the packed argument with one on another receipt moves what the brief read.
    const [restatedRunId] = await built.store.putMany([
      { kind: "run", value: receiptRun("the receipt the restated argument rests on") },
    ]);
    await built.store.putMany([
      {
        kind: "argument",
        value: {
          ...attack.argument,
          supersedes: [attack.id],
          reason: "the challenge, restated on another receipt",
          evidence: [receiptEdge(restatedRunId!, "result")],
        },
      },
    ]);
    const stale = await runHandler(claimStatus, { claim: slot }, reader);
    expect(stale).toMatchObject({ label: "holds", decidedOnStaleEvidence: true });
    expect(claimStatus.exitCode(stale)).toBe(0);
    expect(claimStatus.renderText(stale)).toContain("decided on stale evidence");
  });

  test("a ruling over a brief rendered after an argument against its claim was replaced reads its verdict unflagged, and decided on stale evidence once the standing argument is replaced in turn", async () => {
    const built = await buildEvidencedWorkspace("argued-and-restated-before-the-brief");
    workspace = built.workspace;
    const reader = { workspace, scope: built.scope, now };
    const attack = await mintAttackingArgument(built.store, built.claimId);
    const [restatedRunId] = await built.store.putMany([
      { kind: "run", value: receiptRun("the receipt the restated argument rests on") },
    ]);
    const restated: ArgumentRecord = {
      ...attack.argument,
      supersedes: [attack.id],
      reason: "the challenge, restated on another receipt before any brief is asked",
      evidence: [receiptEdge(restatedRunId!, "result")],
    };
    const [restatedId] = await built.store.putMany([{ kind: "argument", value: restated }]);
    const slot = ((await built.store.read(built.claimId, "claim")) as ClaimRecord).slot;

    const asked = await runHandler(gateAsk, { claim: built.claimId }, reader);
    await runHandler(
      gateAnswer,
      {
        pending: built.claimId,
        brief: asked.brief,
        choice: "holds",
        reason: "the restated challenge does not persuade",
      },
      { ...reader, via: "tty", principalName: "person@example.com" },
    );

    const fresh = await runHandler(claimStatus, { claim: slot }, reader);
    expect(fresh).toMatchObject({ label: "holds" });
    expect(fresh).not.toMatchObject({ decidedOnStaleEvidence: true });

    // Replacing the standing argument moves what the brief read; one replaced earlier never did.
    const [againRunId] = await built.store.putMany([
      { kind: "run", value: receiptRun("the receipt the twice-restated argument rests on") },
    ]);
    await built.store.putMany([
      {
        kind: "argument",
        value: {
          ...restated,
          supersedes: [restatedId!],
          reason: "the challenge, restated once more",
          evidence: [receiptEdge(againRunId!, "result")],
        },
      },
    ]);
    const stale = await runHandler(claimStatus, { claim: slot }, reader);
    expect(stale).toMatchObject({ label: "holds", decidedOnStaleEvidence: true });
    expect(claimStatus.exitCode(stale)).toBe(0);
    expect(claimStatus.renderText(stale)).toContain("decided on stale evidence");
  });

  test("a small-budget brief and a large-budget brief over the same moved evidence produce the same stale verdict", async () => {
    const smallBuilt = await buildEvidencedWorkspace("small-budget-case");
    const largeBuilt = await buildEvidencedWorkspace("large-budget-case");
    expect(smallBuilt.claimId).toBe(largeBuilt.claimId);

    const smallAsked = await runHandler(
      gateAsk,
      { claim: smallBuilt.claimId, budget: 250 },
      { workspace: smallBuilt.workspace, scope: smallBuilt.scope, now },
    );
    const largeAsked = await runHandler(
      gateAsk,
      { claim: largeBuilt.claimId, budget: 1_000_000 },
      { workspace: largeBuilt.workspace, scope: largeBuilt.scope, now },
    );

    await mintAttackingArgument(smallBuilt.store, smallBuilt.claimId);
    await mintAttackingArgument(largeBuilt.store, largeBuilt.claimId);

    try {
      const smallError = await runHandler(
        gateAnswer,
        {
          pending: smallBuilt.claimId,
          brief: smallAsked.brief,
          choice: "holds",
          reason: "too late",
        },
        {
          workspace: smallBuilt.workspace,
          scope: smallBuilt.scope,
          now,
          via: "tty",
          principalName: "person@example.com",
        },
      ).catch((caught: unknown) => caught);
      const largeError = await runHandler(
        gateAnswer,
        {
          pending: largeBuilt.claimId,
          brief: largeAsked.brief,
          choice: "holds",
          reason: "too late",
        },
        {
          workspace: largeBuilt.workspace,
          scope: largeBuilt.scope,
          now,
          via: "tty",
          principalName: "person@example.com",
        },
      ).catch((caught: unknown) => caught);

      expect(isOperationError(smallError)).toBe(true);
      expect(isOperationError(largeError)).toBe(true);
      expect((smallError as { reason: string }).reason).toBe("stale");
      expect((largeError as { reason: string }).reason).toBe("stale");
      expect((smallError as { about: readonly string[] }).about).toEqual(
        (largeError as { about: readonly string[] }).about,
      );
    } finally {
      await rm(smallBuilt.workspace, { recursive: true, force: true });
      await rm(largeBuilt.workspace, { recursive: true, force: true });
    }
  });
});
