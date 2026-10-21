import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workspace } from "@musai/api-core";
import { isOperationError, runHandler } from "@musai/api-core";
import {
  type ArgumentRecord,
  type Audience,
  type CaseRecord,
  type ClaimRecord,
  type ClaimTypeDeclaration,
  CURRENT_SCHEMA_VERSIONS,
  claimTypesFrom,
  EVALUATOR_VERSION,
  type EvidenceEdge,
  type RecordId,
  type RunRecord,
  readEntryFor,
  recordId,
  SEALED_KEY,
  SEALED_RENDERING_PLACEHOLDER,
  type SealableText,
  slotFor,
  timestamp,
  versionString,
} from "@musai/records";
import { RUNNER_PERFORMER } from "@musai/run";
import { type GitContext, initWorkspace, Store } from "@musai/store";
import { declareClaimTypes, fixedClock } from "@musai/test-support";
import { afterEach, describe, expect, test } from "vitest";
import { BRIEF_BUDGET_SLOT_ID, BRIEF_COMMAND, briefRecipe, parseBriefSubstrates } from "../src/brief/recipe.js";
import { type BriefRender, renderBrief } from "../src/brief/render.js";
import { byteLengthUtf8 } from "../src/brief/trim.js";
import { briefRender } from "../src/ops/brief.js";

const CLAIM_TYPE = "musai.brief-fixture-test/claim@1";
const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: CLAIM_TYPE, identityDimensions: ["id"] };
const CLAIM_TYPES = claimTypesFrom([CLAIM_DECLARATION]);
const FIXED_INSTANT = timestamp("2026-01-01T00:00:00.000Z");
const ASKED_AT = timestamp("2026-01-02T00:00:00.000Z");

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

interface Fixture {
  readonly workspace: string;
  readonly scope: string;
  readonly ctx: GitContext;
  readonly opened: Workspace;
  readonly store: Store;
  readonly caseId: RecordId;
  readonly claimId: RecordId;
  readonly directRunId: RecordId;
  readonly attackRunId: RecordId;
  readonly argumentId: RecordId;
  head(): Promise<string>;
  cleanup(): Promise<void>;
}

/** One case, claim, argument and evidence in a real workspace, all fixed, so two builds give the
 * same ids and the same brief. */
async function makeFixture(
  slug = "brief-fixture-case",
  texts: { readonly rendering?: SealableText; readonly reason?: string } = {},
): Promise<Fixture> {
  const workspace = await mkdtemp(join(tmpdir(), "musai-brief-test-"));
  const now = fixedClock(ASKED_AT);
  await initWorkspace(workspace, { now });
  const scope = "default";
  const ctx: GitContext = { gitDir: join(workspace, ".musai") };
  const store = new Store({ ctx, scope, now, claimTypes: CLAIM_TYPES });
  await declareClaimTypes(store, [CLAIM_DECLARATION]);

  const directRun = receiptRun("direct evidence: the fixture's own hygiene run held clean");
  const attackRun = receiptRun("attacking evidence: a challenge's own run disagreeing");
  const [directRunId, attackRunId] = await store.putMany([
    { kind: "run", value: directRun },
    { kind: "run", value: attackRun },
  ]);

  const conditions = { id: "brief-fixture-claim" };
  const slot = slotFor(CLAIM_DECLARATION, conditions);
  const claim: ClaimRecord = {
    kind: "claim",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: CLAIM_TYPE,
    about: [],
    slot,
    conditions,
    canonical: conditions,
    rendering: texts.rendering ?? "the fixture's gate claim holds",
    evidence: [receiptEdge(directRunId!, "result")],
    exclusiveGroup: null,
  };
  const [claimId] = await store.putMany([{ kind: "claim", value: claim }]);

  const argument: ArgumentRecord = {
    kind: "argument",
    premises: [],
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.argument,
    target: claimId!,
    reason: texts.reason ?? "the fixture's own attacking argument",
    evidence: [receiptEdge(attackRunId!, "result")],
  };
  const [argumentId] = await store.putMany([{ kind: "argument", value: argument }]);

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
      moduleRecord: recordId({ marker: "brief-fixture" }),
    },
    projectCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    overrides: {},
    evaluatorVersion: versionString("1"),
  };
  const [caseId] = await store.putMany([{ kind: "case", value: caseRecord }]);

  const opened = { ctx, store } as unknown as Workspace;

  return {
    workspace,
    scope,
    ctx,
    opened,
    store,
    caseId: caseId!,
    claimId: claimId!,
    directRunId: directRunId!,
    attackRunId: attackRunId!,
    argumentId: argumentId!,
    async head() {
      return (await store.tip())!;
    },
    async cleanup() {
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

describe("briefRecipe", () => {
  test("names the brief command and exactly four substrates", () => {
    const recipe = briefRecipe("sha256:claim" as RecordId, {
      head: "deadbeef",
      caseId: "sha256:case" as RecordId,
      budget: 1000,
      kernelVersion: versionString("1"),
    });
    expect(recipe.command).toEqual([BRIEF_COMMAND, "sha256:claim"]);
    expect(recipe.substrates).toHaveLength(4);
    expect(recipe.substrates.filter((substrate) => substrate.digest?.gitCommit === "deadbeef")).toHaveLength(1);
    expect(recipe.substrates.filter((substrate) => substrate.digest?.sha256 === "case")).toHaveLength(1);
    expect(recipe.substrates.filter((substrate) => substrate.name === BRIEF_BUDGET_SLOT_ID)).toHaveLength(1);
  });

  test("names the clearance it is rendered under after the claim, and none where none is set", () => {
    const params = {
      head: "deadbeef",
      caseId: "sha256:case" as RecordId,
      budget: 1000,
      kernelVersion: versionString("1"),
    };

    const cleared = briefRecipe("sha256:claim" as RecordId, { ...params, clearance: "writer" as Audience });
    const uncleared = briefRecipe("sha256:claim" as RecordId, params);

    expect(cleared.command).toEqual([BRIEF_COMMAND, "sha256:claim", "writer"]);
    expect(cleared.substrates).toEqual(uncleared.substrates);
    expect(uncleared.command).toEqual([BRIEF_COMMAND, "sha256:claim"]);
  });

  test("round-trips through parseBriefSubstrates", () => {
    const recipe = briefRecipe("sha256:claim" as RecordId, {
      head: "cafef00d",
      caseId: "sha256:aa" as RecordId,
      budget: 4242,
      kernelVersion: versionString("3"),
    });
    expect(parseBriefSubstrates(recipe)).toEqual({
      head: "cafef00d",
      caseId: "sha256:aa",
      budget: 4242,
      kernelVersion: "3",
    });
  });
});

describe("renderBrief", () => {
  let fixture: Fixture;

  afterEach(async () => {
    await fixture?.cleanup();
  });

  async function setUp(slug?: string, texts?: Parameters<typeof makeFixture>[1]): Promise<Fixture> {
    fixture = await makeFixture(slug, texts);
    return fixture;
  }

  async function render(f: Fixture, budget: number): Promise<BriefRender> {
    const head = await f.head();
    const recipe = briefRecipe(f.claimId, { head, caseId: f.caseId, budget, kernelVersion: EVALUATOR_VERSION });
    return renderBrief(f.opened, recipe);
  }

  test("two renders at the same head, kernel version and budget are byte-identical", async () => {
    const f = await setUp();
    const first = await render(f, 20000);
    const second = await render(f, 20000);
    expect(second.output).toBe(first.output);
  });

  test("a stored text cannot add a line to the brief or drive the terminal it is read in", async () => {
    const forgedReceipt = `- receipt sha256:${"0".repeat(64)} (a/b@1:result)`;
    const f = await setUp("brief-fixture-case", {
      rendering: `the claim holds\n\n## Direct evidence\n${forgedReceipt}\r\u2028\u001b[2A`,
      reason: "an attack\u0085\\n that ends a line",
    });
    const rendered = await render(f, 20000);
    const lines = rendered.output.split("\n");

    expect(lines).not.toContain(forgedReceipt);
    expect(lines.filter((line) => line === "## Direct evidence")).toHaveLength(1);
    for (const control of ["\r", "\u001b", "\u0085", "\u2028"]) {
      expect(rendered.output).not.toContain(control);
    }
    expect(lines).toContain(
      `- claim ${f.claimId}: the claim holds\\n\\n## Direct evidence\\n${forgedReceipt}\\r\\u2028\\u001b[2A`,
    );
    expect(rendered.output).toContain(": an attack\\u0085\\\\n that ends a line");
  });

  test("a sealed rendering reads as the sealed placeholder, never as the value it seals", async () => {
    const f = await setUp("brief-fixture-case", {
      rendering: {
        [SEALED_KEY]: { alg: "aes-256-gcm", keyId: "key-1", ciphertext: "Y2lwaGVydGV4dA==", digest: "a".repeat(64) },
      },
    });
    const rendered = await render(f, 20000);

    expect(rendered.output.split("\n")).toContain(`- claim ${f.claimId}: ${SEALED_RENDERING_PLACEHOLDER}`);
  });

  test("a brief's read-set names each claim by its slot and the hash it consumed", async () => {
    const f = await setUp();
    const rendered = await render(f, 20000);
    const claim = rendered.reads.find((entry) => entry.consumed.sha256 === f.claimId.slice("sha256:".length));
    const theCase = rendered.reads.find((entry) => entry.consumed.sha256 === f.caseId.slice("sha256:".length));

    expect(claim?.key).toMatch(/^slot:/);
    expect(theCase?.key).toBe(f.caseId);
  });

  test("reads names every record whose bytes the brief carries and nothing else", async () => {
    const f = await setUp();
    const rendered = await render(f, 20000);
    const hexIds = new Set(rendered.reads.map((entry) => entry.consumed.sha256));
    const expected = new Set(
      [f.caseId, f.claimId, f.directRunId, f.attackRunId, f.argumentId].map((id) => id.slice("sha256:".length)),
    );
    expect(hexIds).toEqual(expected);
  });

  test("a brief quoting a challenge's reason names the challenge in its read-set, by its id", async () => {
    const f = await setUp("brief-fixture-case", { reason: "a reason only its challenge holds" });
    const rendered = await render(f, 20000);

    expect(rendered.output).toContain("a reason only its challenge holds");
    expect(rendered.reads).toContainEqual(readEntryFor(f.argumentId));
  });

  test("an argument against a run the claim cites is packed as attacking evidence naming that run", async () => {
    const f = await setUp();
    const [againstRunId] = await f.store.putMany([
      { kind: "run", value: receiptRun("attacking evidence: the direct run's exit code lies") },
    ]);
    const argument: ArgumentRecord = {
      kind: "argument",
      premises: [],
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.argument,
      target: f.directRunId,
      reason: "the direct run passed for the wrong reason",
      evidence: [receiptEdge(againstRunId!, "result")],
    };
    const [argumentId] = await f.store.putMany([{ kind: "argument", value: argument }]);
    const rendered = await render(f, 20000);

    expect(rendered.output.split("\n")).toContain(
      `- receipt ${againstRunId} (musai.core/exit-code@1:result) against the run ${f.directRunId}: the direct run passed for the wrong reason`,
    );
    expect(rendered.reads).toContainEqual(readEntryFor(argumentId!));
    expect(rendered.reads).toContainEqual(readEntryFor(againstRunId!));
  });

  test("the trim drops an argument whole and never prints a line it omits, even beside a kept line on its run", async () => {
    const f = await setUp();
    const against = (target: RecordId, reason: string, runs: readonly RecordId[]): ArgumentRecord => ({
      kind: "argument",
      premises: [],
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.argument,
      target,
      reason,
      evidence: runs.map((run) => receiptEdge(run, "result")),
    });
    const [selfCiting, twoRuns] = await f.store.putMany([
      { kind: "argument", value: against(f.directRunId, "the run attacks itself", [f.directRunId]) },
      { kind: "argument", value: against(f.claimId, "two runs tell against it", [f.directRunId, f.attackRunId]) },
    ]);
    const linesOf = new Map<string, number>([
      [f.argumentId, 1],
      [selfCiting, 1],
      [twoRuns, 2],
    ]);
    const attackLines = (rendered: BriefRender) =>
      rendered.output.split("## Attacking evidence\n")[1]!.split("\n\n")[0]!.split("\n");
    const itemLines = (rendered: BriefRender) => rendered.output.split("\n").filter((line) => line.startsWith("- "));
    const full = await render(f, 20000);
    expect(attackLines(full)).toHaveLength(4);

    const bytesOf = (lines: readonly string[]) => lines.reduce((total, line) => total + byteLengthUtf8(line), 0);
    let mostOmitted = 0;
    for (let budget = bytesOf(itemLines(full)); ; budget -= 8) {
      const rendered = await render(f, budget).catch((error: unknown) => error);
      if (isOperationError(rendered)) {
        break;
      }
      const { omissions } = rendered as BriefRender;
      const printed = attackLines(rendered as BriefRender).filter((line) => line !== "(none)");
      const omittedLines = omissions.reduce((total, omission) => total + linesOf.get(omission.id)!, 0);
      expect(printed.length + omittedLines).toBe(4);
      expect(new Set(omissions.map((omission) => omission.id)).size).toBe(omissions.length);
      expect(bytesOf(itemLines(rendered as BriefRender))).toBeLessThanOrEqual(budget);
      mostOmitted = Math.max(mostOmitted, omissions.length);
    }
    expect(mostOmitted).toBe(3);
  });

  test("an argument a later one supersedes is packed at a head before the succession and left out at one after it", async () => {
    const f = await setUp();
    const hexOf = (id: RecordId) => id.slice("sha256:".length);
    const readsOf = (rendered: BriefRender) => new Set(rendered.reads.map((entry) => entry.consumed.sha256));
    const headBefore = await f.head();
    const before = await render(f, 20000);
    expect(readsOf(before).has(hexOf(f.attackRunId))).toBe(true);

    const [predecessorId] = await f.store.list("argument");
    const predecessor = (await f.store.read(predecessorId!, "argument")) as ArgumentRecord;
    const [restatedRunId] = await f.store.putMany([
      { kind: "run", value: receiptRun("attacking evidence: the challenge restated on another run") },
    ]);
    await f.store.putMany([
      {
        kind: "argument",
        value: {
          ...predecessor,
          supersedes: [predecessorId!],
          reason: "the fixture's attacking argument, restated",
          evidence: [receiptEdge(restatedRunId!, "result")],
        },
      },
    ]);

    const after = await render(f, 20000);
    expect(readsOf(after).has(hexOf(restatedRunId!))).toBe(true);
    expect(readsOf(after).has(hexOf(f.attackRunId))).toBe(false);
    expect(after.output).not.toContain(f.attackRunId);

    const recipeBefore = briefRecipe(f.claimId, {
      head: headBefore,
      caseId: f.caseId,
      budget: 20000,
      kernelVersion: EVALUATOR_VERSION,
    });
    const reRendered = await renderBrief(f.opened, recipeBefore);
    expect(reRendered.output).toBe(before.output);
    expect(readsOf(reRendered)).toEqual(readsOf(before));
  });

  test("changing the budget changes the output; changing nothing changes nothing", async () => {
    const f = await setUp();
    const full = await render(f, 20000);
    const tiny = await render(f, 350);
    expect(tiny.output).not.toBe(full.output);
    expect(tiny.omissions.length).toBeGreaterThan(0);

    const sameAgain = await render(f, 20000);
    expect(sameAgain.output).toBe(full.output);
  });

  test("a head this render cannot open at all refuses with a reason from the closed vocabulary", async () => {
    const f = await setUp();
    const recipe = briefRecipe(f.claimId, {
      head: "0000000000000000000000000000000000000000",
      caseId: f.caseId,
      budget: 20000,
      kernelVersion: EVALUATOR_VERSION,
    });
    await expect(renderBrief(f.opened, recipe)).rejects.toSatisfy(
      (error: unknown) => isOperationError(error) && error.reason === "no-such-record",
    );
  });
});

describe("brief.render@1", () => {
  let fixture: Fixture;

  afterEach(async () => {
    await fixture?.cleanup();
  });

  async function setUp(slug?: string, texts?: Parameters<typeof makeFixture>[1]): Promise<Fixture> {
    fixture = await makeFixture(slug, texts);
    return fixture;
  }

  test("a slot handed where a brief wants a record answers with the record standing at it, since the two read alike on a command line", async () => {
    const f = await setUp("brief-op-slot-case");
    const claim = (await f.store.read(f.claimId, "claim")) as ClaimRecord;
    const error = await runHandler(
      briefRender,
      { claim: claim.slot },
      { workspace: f.workspace, scope: f.scope, now: fixedClock(ASKED_AT) },
    ).catch((caught: unknown) => caught);
    expect((error as { reason?: string }).reason).toBe("no-such-record");
    expect((error as { detail: string }).detail).toContain(`is a slot`);
    expect((error as { detail: string }).detail).toContain(f.claimId);
  });

  test("mints a brief run and returns it with its body, like any other write", async () => {
    const f = await setUp("brief-op-case-1");
    const output = await runHandler(
      briefRender,
      { claim: f.claimId },
      { workspace: f.workspace, scope: f.scope, now: fixedClock(ASKED_AT) },
    );
    expect(output.minted).toHaveLength(1);
    expect(output.minted[0]!.id).toBe(output.brief);
    const record = output.minted[0]!.record as RunRecord;
    expect(record.runKind).toBe("brief");
    expect(record.observation.output).toBe(output.output);
    expect(record.determinism).toBe("deterministic");
    expect(record.performer).toEqual(RUNNER_PERFORMER);
    expect(record.observation.cost).toEqual({});

    const stored = await f.store.read(output.brief, "run");
    expect((stored as RunRecord).observation.output).toBe(output.output);
  });

  test("plan mode returns the same brief id the following performing call mints, and writes nothing", async () => {
    const f = await setUp("brief-op-case-2");
    const now = fixedClock(ASKED_AT);
    const before = await f.store.tip();

    const planned = await runHandler(
      briefRender,
      { claim: f.claimId },
      {
        workspace: f.workspace,
        scope: f.scope,
        mode: "plan",
        now,
      },
    );
    const afterPlan = await f.store.tip();
    expect(afterPlan).toBe(before);

    const performed = await runHandler(
      briefRender,
      { claim: f.claimId },
      {
        workspace: f.workspace,
        scope: f.scope,
        mode: "perform",
        now,
      },
    );
    expect(performed.brief).toBe(planned.brief);
    expect(performed.minted.map((item) => item.id)).toEqual(planned.minted.map((item) => item.id));
  });

  test("two renders at one head mint one brief id, whatever the clock says", async () => {
    const f = await setUp("brief-op-clock");
    const at = (instant: string) => ({
      workspace: f.workspace,
      scope: f.scope,
      mode: "plan" as const,
      now: fixedClock(timestamp(instant)),
    });

    const early = await runHandler(briefRender, { claim: f.claimId }, at("2026-01-01T00:00:00.000Z"));
    const late = await runHandler(briefRender, { claim: f.claimId }, at("2027-06-30T12:00:00.000Z"));

    expect(late.brief).toBe(early.brief);
  });

  test("the brief's recipe carries the running kernel version; the case carries its own separate booking pin", async () => {
    const f = await setUp("brief-op-case-3");
    const output = await runHandler(
      briefRender,
      { claim: f.claimId },
      { workspace: f.workspace, scope: f.scope, now: fixedClock(ASKED_AT) },
    );
    const record = output.minted[0]!.record as RunRecord;
    const { kernelVersion } = parseBriefSubstrates(record.recipe);
    expect(kernelVersion).toBe(EVALUATOR_VERSION);

    const caseRecord = (await f.store.read(f.caseId, "case")) as CaseRecord;
    expect(caseRecord.evaluatorVersion).toBe(versionString("1"));
  });

  test("an explicit budget overrides the slot the workspace would otherwise resolve", async () => {
    const f = await setUp("brief-op-case-4");
    const output = await runHandler(
      briefRender,
      { claim: f.claimId, budget: 350 },
      { workspace: f.workspace, scope: f.scope, now: fixedClock(ASKED_AT) },
    );
    const record = output.minted[0]!.record as RunRecord;
    const { budget } = parseBriefSubstrates(record.recipe);
    expect(budget).toBe(350);
  });

  test("declares the reasons it can raise", () => {
    expect(briefRender.reasons).toContain("no-such-record");
    expect(briefRender.reasons).toContain("over-budget");
    expect(briefRender.reasons).toContain("head-moved");
  });
});
