import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type DerivationJson, EVIDENCE_ORDER, formatFloorDecision, formatSetAsideDecision } from "@musai/evaluate";
import {
  ACTIONS,
  ANY_SCOPE,
  BRIEF_MEDIA_TYPE,
  type CaseRecord,
  type ClaimRecord,
  type ClaimTypeDeclaration,
  type ComputedRunRecord,
  CREW_MEDIA_TYPE,
  CURRENT_SCHEMA_VERSIONS,
  canonicalBytes,
  type EvidenceEdge,
  MODEL_MEDIA_TYPE,
  type PerformedRunRecord,
  type RecordId,
  type RulingRecord,
  type RunRecord,
  rawId,
  recordId,
  recordPath,
  renderSelector,
  slotFor,
  timestamp,
  versionString,
} from "@musai/records";
import { performRecipe, RUNNER_PERFORMER } from "@musai/run";
import { gitRevParse, readTrustBranch, Store } from "@musai/store";
import {
  allowedSignersLine,
  commitAroundTheStore,
  type FixtureRepo,
  fixtureBrief,
  fixWorkspaceKey,
  generateTestKey,
  makeFixtureRepo,
  pseudonymOf,
  removeTrustFile,
  type TestKey,
  writeFixtureRecords,
  writeTrustFile,
} from "@musai/test-support";
import { may, mintAttestation, parseAllowedSigners, parseRoles, roleMatrix, signAttestation } from "@musai/trust";
import { type ExecaError, execa } from "execa";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const CLI_PATH = fileURLToPath(new URL("../../dist/bin/cli.js", import.meta.url));

const FIXED_INSTANT = timestamp("2026-01-01T00:00:00.000Z");

const CLAIM_TYPE = "musai.demo/claim@1";
const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: CLAIM_TYPE, identityDimensions: ["id"] };

/** The three role descriptors a testimony run's recipe always carries. */
function testimonyRoleSubstrates(): RunRecord["recipe"]["substrates"] {
  return [
    { mediaType: BRIEF_MEDIA_TYPE, digest: { sha256: "a".repeat(64) } },
    { mediaType: CREW_MEDIA_TYPE, digest: { sha256: "b".repeat(64) } },
    { mediaType: MODEL_MEDIA_TYPE, uri: "model://anthropic/claude" },
  ];
}

function runRecord(runKind: PerformedRunRecord["runKind"], output: string): PerformedRunRecord {
  const isTestimony = runKind === "testimony";
  return {
    kind: "run",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
    runKind,
    performer: RUNNER_PERFORMER,
    determinism: "nondeterministic",
    recipe: {
      command: isTestimony ? ["ask", "musai.core/judge"] : [],
      workingDirectory: isTestimony ? "" : "/",
      environment: {},
      declared: [],
      substrates: isTestimony ? testimonyRoleSubstrates() : [],
      isolation: isTestimony ? "none" : "hygiene",
    },
    observation: {
      resolved: [],
      isolationHeld: isTestimony ? "none" : "hygiene",
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

function slotOf(id: string): string {
  return slotFor(CLAIM_DECLARATION, { id });
}

/** An evidence edge from `run`; the key only tells fixtures apart. */
function edge(run: RecordId, key: string): EvidenceEdge {
  return {
    run,
    selector: { module: "musai.core", parser: "exit-code", version: versionString("1"), key },
    item: recordId({ run, key }),
  };
}

function rendered(key: string): string {
  return renderSelector({ module: "musai.core", parser: "exit-code", version: versionString("1"), key });
}

function claimRecord(id: string, evidence: ClaimRecord["evidence"], statement = id): ClaimRecord {
  return {
    kind: "claim",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: CLAIM_TYPE,
    about: [],
    slot: slotOf(id),
    conditions: { id },
    canonical: { statement },
    rendering: statement,
    evidence,
    exclusiveGroup: null,
  };
}

/** A brief whose `reads` name exactly `runIds`: the evidence snapshot of a ruling citing it. */
function briefRunCiting(...runIds: readonly RecordId[]): ComputedRunRecord {
  return fixtureBrief(`brief citing ${runIds.join(",")}`, { reads: runIds });
}

/** Stores a ruling over `claimId`, its brief, and the made attestation naming who ruled. */
async function writeRuling(
  repo: FixtureRepo,
  options: {
    readonly claimId: RecordId;
    readonly verdict: "holds" | "fails";
    readonly reason: string;
    readonly principal: string;
    readonly principalClass: "person" | "agent";
    readonly via?: "elicitation" | "tty" | "signature" | "model";
    readonly signWith?: TestKey;
    readonly citing?: readonly RecordId[];
  },
): Promise<RecordId> {
  const brief = options.citing ? briefRunCiting(...options.citing) : fixtureBrief(`brief for ${options.claimId}`);
  const [briefId] = await writeFixtureRecords(repo, [{ kind: "run", value: brief }]);
  const ruling: RulingRecord = {
    kind: "ruling",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.ruling,
    over: { claim: options.claimId },
    verdict: options.verdict,
    reason: options.reason,
    brief: briefId!,
  };
  const [rulingId] = await writeFixtureRecords(repo, [{ kind: "ruling", value: ruling }]);
  const attestation = mintAttestation({
    subject: rulingId!,
    principal: options.principal,
    principalClass: options.principalClass,
    via: options.via ?? "tty",
    purpose: "made",
    at: FIXED_INSTANT,
  });
  if (options.signWith) {
    const signature = await signAttestation({ attestation, keyPath: options.signWith.keyPath });
    await writeFixtureRecords(repo, [{ kind: "attestation", value: attestation.record, signature }]);
  } else {
    await writeFixtureRecords(repo, [{ kind: "attestation", value: attestation.record }]);
  }
  return rulingId!;
}

interface StatusLine {
  readonly label: string;
  readonly reason: string | null;
  readonly via: string;
  readonly winner: string;
  readonly rival: string | null;
  readonly agreeing: number;
  readonly decidedBy: { readonly kind: string; readonly id: string } | null;
  readonly decidedOnStaleEvidence: boolean;
}

/** `status --json`'s answer, read as the fields these tests compare. */
function parseStatusJson(stdout: string): StatusLine {
  const output = JSON.parse(stdout) as {
    label: string;
    reason: string | null;
    decidedBy: StatusLine["decidedBy"];
    decidedOnStaleEvidence?: true;
    comparison: { winner: string; rival: string | null; via: string; corroborated: string[] };
  };
  return {
    label: output.label,
    reason: output.reason,
    via: output.comparison.via,
    winner: output.comparison.winner,
    rival: output.comparison.rival,
    agreeing: output.comparison.corroborated.length,
    decidedBy: output.decidedBy,
    decidedOnStaleEvidence: output.decidedOnStaleEvidence === true,
  };
}

interface DerivationLine {
  readonly indent: number;
  readonly label: string;
  readonly id: string;
  readonly decidedBy: string;
  readonly beat: string | null;
}

function parseDerivationLine(line: string): DerivationLine {
  const indent = line.length - line.trimStart().length;
  const match = /^(\S+) (\S+) — decided by (.+?)(?:, beat (\S+))?$/.exec(line.trim());
  if (!match) {
    throw new Error(`unparseable derivation line: ${line}`);
  }
  const [, label, id, decidedBy, beat] = match;
  return { indent, label: label!, id: id!, decidedBy: decidedBy!, beat: beat ?? null };
}

function countJsonNodes(node: DerivationJson): number {
  return 1 + node.children.reduce((sum, child) => sum + countJsonNodes(child), 0);
}

function depthOfJsonNode(node: DerivationJson): number {
  return node.children.length === 0 ? 0 : 1 + Math.max(...node.children.map(depthOfJsonNode));
}

/** Exits 0 only for a claim that holds; any other label exits 7 with the status on stdout. */
async function runStatus(repo: FixtureRepo, slot: string): Promise<StatusLine> {
  const { stdout, exitCode } = await execa(
    "node",
    [CLI_PATH, "status", slot, "--workspace", repo.workspace, "--scope", repo.scope, "--json"],
    { reject: false },
  );
  const status = parseStatusJson(stdout);
  expect(exitCode).toBe(status.label === "holds" ? 0 : 7);
  return status;
}

/** The derivation's own lines from `why --full`, without the verdict or a run's details. */
async function runWhyText(repo: FixtureRepo, slot: string): Promise<DerivationLine[]> {
  const { stdout } = await execa("node", [
    CLI_PATH,
    "why",
    slot,
    "--full",
    "--workspace",
    repo.workspace,
    "--scope",
    repo.scope,
  ]);
  return stdout
    .trim()
    .split("\n")
    .filter((line) => line.includes(" — decided by "))
    .map(parseDerivationLine);
}

async function runWhyJson(repo: FixtureRepo, slot: string): Promise<DerivationJson> {
  const { stdout } = await execa("node", [
    CLI_PATH,
    "why",
    slot,
    "--full",
    "--workspace",
    repo.workspace,
    "--scope",
    repo.scope,
    "--json",
  ]);
  return (JSON.parse(stdout) as { derivation: DerivationJson }).derivation;
}

describe("the labelling every verb reaches: evidence kind decides, not array order", () => {
  let repo: FixtureRepo;
  let receiptRunId: RecordId;
  let agentJudgmentRunId: RecordId;

  beforeAll(async () => {
    repo = await makeFixtureRepo("cli-ordering", [CLAIM_DECLARATION]);

    const receiptRun = runRecord("run", "receipt output");
    const testimonyRun = runRecord("testimony", "a guess about the outcome");
    const [runId, testimonyId] = await writeFixtureRecords(repo, [
      { kind: "run", value: receiptRun },
      { kind: "run", value: testimonyRun },
    ]);
    receiptRunId = runId!;
    agentJudgmentRunId = testimonyId!;

    const attestation = mintAttestation({
      subject: agentJudgmentRunId,
      principal: pseudonymOf("reviewer-bot"),
      principalClass: "agent",
      via: "tty",
      purpose: "asserted",
      at: FIXED_INSTANT,
    });

    const weakFirst = claimRecord("order-weak-first", [
      edge(agentJudgmentRunId, "guess"),
      edge(receiptRunId, "result"),
    ]);
    const strongFirst = claimRecord("order-strong-first", [
      edge(receiptRunId, "result"),
      edge(agentJudgmentRunId, "guess"),
    ]);

    await writeFixtureRecords(repo, [
      { kind: "attestation", value: attestation.record },
      { kind: "claim", value: weakFirst },
      { kind: "claim", value: strongFirst },
    ]);
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  test("the receipt decides regardless of which edge the claim lists first", async () => {
    const weakFirstStatus = await runStatus(repo, slotOf("order-weak-first"));
    const strongFirstStatus = await runStatus(repo, slotOf("order-strong-first"));

    expect(weakFirstStatus.label).toBe("holds");
    expect(weakFirstStatus.via).toBe("receipt");
    expect(weakFirstStatus.winner).toBe(`${receiptRunId}#${rendered("result")}`);

    expect(strongFirstStatus).toEqual(weakFirstStatus);
  });

  test("the derivation names the rival the comparison recorded, in both text and structured form, with matching node count and depth", async () => {
    const textLines = await runWhyText(repo, slotOf("order-weak-first"));
    const json = await runWhyJson(repo, slotOf("order-weak-first"));

    expect(textLines).toHaveLength(3);
    expect(countJsonNodes(json)).toBe(textLines.length);
    expect(depthOfJsonNode(json)).toBe(textLines.length - 1);

    const [claimLine, evidenceLine] = textLines;
    expect(claimLine!.beat).toBe(`${agentJudgmentRunId}#${rendered("guess")}`);
    expect(evidenceLine!.beat).toBe(`${agentJudgmentRunId}#${rendered("guess")}`);
    expect(json.beat).toBe(`${agentJudgmentRunId}#${rendered("guess")}`);
    expect(json.children[0]!.beat).toBe(`${agentJudgmentRunId}#${rendered("guess")}`);
  });

  test("the rival why prints is the same rival status independently reports, so the derivation is read from the engine's own comparison rather than assembled again at the why call site", async () => {
    const status = await runStatus(repo, slotOf("order-weak-first"));
    const [claimLine] = await runWhyText(repo, slotOf("order-weak-first"));
    expect(claimLine!.beat).toBe(status.rival);
  });

  test("every evidence kind a verb prints is a member of the closed vocabulary", async () => {
    const json = await runWhyJson(repo, slotOf("order-weak-first"));
    expect(EVIDENCE_ORDER).toContain(json.children[0]!.decidedBy);
  });
});

describe("two receipts equal in kind, scope and weight corroborate a claim", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await makeFixtureRepo("cli-corroborated", [CLAIM_DECLARATION]);
    const runA = runRecord("run", "first receipt");
    const runB = runRecord("run", "second receipt");
    const [runAId, runBId] = await writeFixtureRecords(repo, [
      { kind: "run", value: runA },
      { kind: "run", value: runB },
    ]);
    const claim = claimRecord("corroborated-claim", [edge(runAId!, "result"), edge(runBId!, "result")]);
    await writeFixtureRecords(repo, [{ kind: "claim", value: claim }]);
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  test("the claim holds on either receipt, names no receipt it beat, and counts the other as agreeing", async () => {
    const status = await runStatus(repo, slotOf("corroborated-claim"));
    expect(status.label).toBe("holds");
    expect(status.winner).not.toBeNull();
    expect(status.rival).toBeNull();
    expect(status.agreeing).toBe(1);
    expect(status.decidedBy?.kind).toBe("run");
  });

  test("why lists the receipt that leads and the one that agrees with it", async () => {
    const { stdout } = await execa("node", [
      CLI_PATH,
      "why",
      slotOf("corroborated-claim"),
      "--workspace",
      repo.workspace,
      "--scope",
      repo.scope,
      "--json",
    ]);
    const runs = (JSON.parse(stdout) as { runs: { agrees: boolean }[] }).runs;

    expect(runs.map((run) => run.agrees)).toEqual([false, true]);
  });
});

describe("a claim backed by one receipt still holds, with the receipt named", () => {
  let repo: FixtureRepo;
  let runId: RecordId;

  beforeAll(async () => {
    repo = await makeFixtureRepo("cli-single-receipt", [CLAIM_DECLARATION]);
    const run = runRecord("run", "the one receipt");
    const [id] = await writeFixtureRecords(repo, [{ kind: "run", value: run }]);
    runId = id!;
    const claim = claimRecord("single-receipt-claim", [edge(runId, "result")]);
    await writeFixtureRecords(repo, [{ kind: "claim", value: claim }]);
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  test("holds, naming the receipt as what decided it", async () => {
    const status = await runStatus(repo, slotOf("single-receipt-claim"));
    expect(status.label).toBe("holds");
    expect(status.winner).toBe(`${runId}#${rendered("result")}`);
    expect(status.rival).toBeNull();
  });
});

describe("a testimony run's evidence kind follows the vouching principal's class", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await makeFixtureRepo("cli-testimony", [CLAIM_DECLARATION]);
    const personRun = runRecord("testimony", "a person's judgment");
    const agentRun = runRecord("testimony", "an agent's judgment");
    const [personRunId, agentRunId] = await writeFixtureRecords(repo, [
      { kind: "run", value: personRun },
      { kind: "run", value: agentRun },
    ]);
    const personAttestation = mintAttestation({
      subject: personRunId!,
      principal: pseudonymOf("reviewer@example.com"),
      principalClass: "person",
      via: "tty",
      purpose: "asserted",
      at: FIXED_INSTANT,
    });
    const agentAttestation = mintAttestation({
      subject: agentRunId!,
      principal: pseudonymOf("reviewer-bot"),
      principalClass: "agent",
      via: "tty",
      purpose: "asserted",
      at: FIXED_INSTANT,
    });
    const personClaim = claimRecord("person-judgment-claim", [edge(personRunId!, "judgment")]);
    const agentClaim = claimRecord("agent-judgment-claim", [edge(agentRunId!, "judgment")]);
    await writeFixtureRecords(repo, [
      { kind: "attestation", value: personAttestation.record },
      { kind: "attestation", value: agentAttestation.record },
      { kind: "claim", value: personClaim },
      { kind: "claim", value: agentClaim },
    ]);
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  test("an attestation naming a person reports a person's judgment as what decided it", async () => {
    const status = await runStatus(repo, slotOf("person-judgment-claim"));
    expect(status.via).toBe("person-judgment");
  });

  test("an attestation naming an agent reports an agent's judgment as what decided it", async () => {
    const status = await runStatus(repo, slotOf("agent-judgment-claim"));
    expect(status.via).toBe("agent-judgment");
  });

  test("a testimony run with no attestation over it fails with an error naming the run and the claim, not a stack trace", async () => {
    const unattestedRun = runRecord("testimony", "nobody vouched for this");
    const [unattestedRunId] = await writeFixtureRecords(repo, [{ kind: "run", value: unattestedRun }]);
    const claim = claimRecord("unattested-claim", [edge(unattestedRunId!, "judgment")]);
    await writeFixtureRecords(repo, [{ kind: "claim", value: claim }]);

    const unattestedSlot = slotOf("unattested-claim");
    let caught: ExecaError | undefined;
    try {
      await execa("node", [CLI_PATH, "status", unattestedSlot, "--workspace", repo.workspace, "--scope", repo.scope]);
    } catch (error) {
      caught = error as ExecaError;
    }
    expect(caught).toBeDefined();
    expect(caught!.exitCode).not.toBe(0);
    const combined = `${caught!.stdout ?? ""}${caught!.stderr ?? ""}`;
    expect(combined).toContain(unattestedSlot);
    expect(combined).toContain(unattestedRunId!);
  });
});

describe("a slot with two contributors is labelled from the union of their evidence", () => {
  let repo: FixtureRepo;
  let receiptRunId: RecordId;

  beforeAll(async () => {
    repo = await makeFixtureRepo("cli-union", [CLAIM_DECLARATION]);
    const agentRun = runRecord("testimony", "a guess before the receipt landed");
    const receiptRun = runRecord("run", "the receipt that landed later");
    const [agentRunId, runId] = await writeFixtureRecords(repo, [
      { kind: "run", value: agentRun },
      { kind: "run", value: receiptRun },
    ]);
    receiptRunId = runId!;
    const attestation = mintAttestation({
      subject: agentRunId!,
      principal: pseudonymOf("reviewer-bot"),
      principalClass: "agent",
      via: "tty",
      purpose: "asserted",
      at: FIXED_INSTANT,
    });

    const firstContributor = claimRecord("union-claim", [edge(agentRunId!, "guess")], "first contributor");
    const secondContributor = claimRecord("union-claim", [edge(receiptRunId, "result")], "second contributor");

    await writeFixtureRecords(repo, [
      { kind: "attestation", value: attestation.record },
      { kind: "claim", value: firstContributor },
      { kind: "claim", value: secondContributor },
    ]);
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  test("the claim is labelled from both contributors' evidence, and the receipt decides it", async () => {
    const status = await runStatus(repo, slotOf("union-claim"));
    expect(status.label).toBe("holds");
    expect(status.via).toBe("receipt");
    expect(status.winner).toBe(`${receiptRunId}#${rendered("result")}`);
  });
});

describe("a stored ruling decides the status the CLI prints and names itself in the derivation", () => {
  let repo: FixtureRepo;
  let receiptRunId: RecordId;
  let rulingId: RecordId;
  const RULING_PRINCIPAL = pseudonymOf("arbiter@example.com");

  beforeAll(async () => {
    repo = await makeFixtureRepo("cli-ruling", [CLAIM_DECLARATION]);
    const receiptRun = runRecord("run", "the receipt the ruling overrides");
    const [runId] = await writeFixtureRecords(repo, [{ kind: "run", value: receiptRun }]);
    receiptRunId = runId!;

    const claim = claimRecord("ruled-claim", [edge(receiptRunId, "result")]);
    const [claimId] = await writeFixtureRecords(repo, [{ kind: "claim", value: claim }]);

    rulingId = await writeRuling(repo, {
      claimId: claimId!,
      verdict: "fails",
      reason: "the receipt does not reflect what actually shipped",
      principal: RULING_PRINCIPAL,
      principalClass: "person",
      citing: [receiptRunId],
    });
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  test("status reports the ruling's verdict, naming the ruling as the winner and the evidence as the rival", async () => {
    const status = await runStatus(repo, slotOf("ruled-claim"));
    expect(status.label).toBe("fails");
    expect(status.winner).toBe(rulingId);
    expect(status.rival).toBe(`${receiptRunId}#${rendered("result")}`);
    expect(status.decidedBy).toEqual({ kind: "ruling", id: rulingId });
  });

  test("status's line names the ruling that decided by its short id", async () => {
    const { stdout } = await execa(
      "node",
      [CLI_PATH, "status", slotOf("ruled-claim"), "--workspace", repo.workspace, "--scope", repo.scope],
      { reject: false },
    );
    expect(stdout.trim()).toBe(`✗ fails · ${slotOf("ruled-claim").slice(7, 19)} · ruling ${rulingId.slice(7, 19)}`);
  });

  test("why renders the claim, the ruling naming its authority and principal, the brief it cites, and the overruled run as a set-aside", async () => {
    const textLines = await runWhyText(repo, slotOf("ruled-claim"));
    const json = await runWhyJson(repo, slotOf("ruled-claim"));

    expect(textLines).toHaveLength(4);
    expect(countJsonNodes(json)).toBe(textLines.length);

    const [claimLine, rulingLine, briefLine, setAsideLine] = textLines;
    expect(claimLine!.beat).toBe(`${receiptRunId}#${rendered("result")}`);
    expect(rulingLine!.label).toBe("ruling");
    expect(rulingLine!.id).toBe(rulingId);
    expect(rulingLine!.decidedBy).toContain("person");
    expect(rulingLine!.decidedBy).toContain(RULING_PRINCIPAL);
    expect(briefLine!.label).toBe("brief");
    expect(setAsideLine!.label).toBe("set-aside");
    expect(setAsideLine!.id).toBe(receiptRunId);
    expect(setAsideLine!.decidedBy).toBe(
      formatSetAsideDecision(RULING_PRINCIPAL, "the receipt does not reflect what actually shipped"),
    );

    const textIds = textLines.map((line) => line.id);
    const jsonIds: string[] = [];
    (function collect(node: DerivationJson): void {
      jsonIds.push(node.id);
      node.children.forEach(collect);
    })(json);
    expect(jsonIds).toEqual(textIds);
  });

  test("a ruling record carrying an empty reason is refused rather than rendering a reasonless set-aside", async () => {
    const receiptRun = runRecord("run", "another receipt a reasonless ruling would overrule");
    const [runId] = await writeFixtureRecords(repo, [{ kind: "run", value: receiptRun }]);
    const claim = claimRecord("reasonless-ruling-claim", [edge(runId!, "result")]);
    const [claimId] = await writeFixtureRecords(repo, [{ kind: "claim", value: claim }]);

    await writeRuling(repo, {
      claimId: claimId!,
      verdict: "fails",
      reason: "",
      principal: RULING_PRINCIPAL,
      principalClass: "person",
    });

    let caught: ExecaError | undefined;
    try {
      await execa("node", [
        CLI_PATH,
        "why",
        slotOf("reasonless-ruling-claim"),
        "--workspace",
        repo.workspace,
        "--scope",
        repo.scope,
      ]);
    } catch (error) {
      caught = error as ExecaError;
    }
    expect(caught).toBeDefined();
    expect(caught!.exitCode).not.toBe(0);
    const combined = `${caught!.stdout ?? ""}${caught!.stderr ?? ""}`;
    expect(combined).toContain("non-empty reason");
  });
});

describe("a ruling agreeing with the receipt it overlaps renders no set-aside hop", () => {
  let repo: FixtureRepo;
  let receiptRunId: RecordId;
  let rulingId: RecordId;
  const RULING_PRINCIPAL = pseudonymOf("arbiter@example.com");

  beforeAll(async () => {
    repo = await makeFixtureRepo("cli-ruling-agrees", [CLAIM_DECLARATION]);
    const receiptRun = runRecord("run", "the receipt the ruling confirms");
    const [runId] = await writeFixtureRecords(repo, [{ kind: "run", value: receiptRun }]);
    receiptRunId = runId!;

    const claim = claimRecord("agreeing-ruling-claim", [edge(receiptRunId, "result")]);
    const [claimId] = await writeFixtureRecords(repo, [{ kind: "claim", value: claim }]);

    rulingId = await writeRuling(repo, {
      claimId: claimId!,
      verdict: "holds",
      reason: "the receipt is correct and the ruling confirms it",
      principal: RULING_PRINCIPAL,
      principalClass: "person",
      citing: [receiptRunId],
    });
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  test("status reports the ruling's verdict, agreeing with the evidence it overlaps", async () => {
    const status = await runStatus(repo, slotOf("agreeing-ruling-claim"));
    expect(status.label).toBe("holds");
    expect(status.winner).toBe(rulingId);
  });

  test("why renders the claim, the ruling, the brief it cites and the receipt it read, with no set-aside label anywhere", async () => {
    const textLines = await runWhyText(repo, slotOf("agreeing-ruling-claim"));
    const json = await runWhyJson(repo, slotOf("agreeing-ruling-claim"));

    expect(textLines).toHaveLength(4);
    expect(countJsonNodes(json)).toBe(textLines.length);

    const [claimLine, rulingLine, briefLine, runLine] = textLines;
    expect(claimLine!.beat).toBe(`${receiptRunId}#${rendered("result")}`);
    expect(rulingLine!.label).toBe("ruling");
    expect(rulingLine!.id).toBe(rulingId);
    expect(briefLine!.label).toBe("brief");
    expect(runLine!.label).toBe("run");
    expect(runLine!.id).toBe(receiptRunId);

    expect(textLines.some((line) => line.label === "set-aside")).toBe(false);
    expect(JSON.stringify(json)).not.toContain("set-aside");

    const textIds = textLines.map((line) => line.id);
    const jsonIds: string[] = [];
    (function collect(node: DerivationJson): void {
      jsonIds.push(node.id);
      node.children.forEach(collect);
    })(json);
    expect(jsonIds).toEqual(textIds);
  });
});

describe("two principals agreeing over one ruling record produce one ruling, two attestations", () => {
  let repo: FixtureRepo;
  let rulingId: RecordId;
  const FIRST_PRINCIPAL = pseudonymOf("alice@example.com");
  const SECOND_PRINCIPAL = pseudonymOf("bob@example.com");

  beforeAll(async () => {
    repo = await makeFixtureRepo("cli-two-attestations", [CLAIM_DECLARATION]);
    const receiptRun = runRecord("run", "the receipt two principals agree the ruling overrides");
    const [runId] = await writeFixtureRecords(repo, [{ kind: "run", value: receiptRun }]);
    const claim = claimRecord("two-attestation-claim", [edge(runId!, "result")]);
    const [claimId] = await writeFixtureRecords(repo, [{ kind: "claim", value: claim }]);

    const [briefId] = await writeFixtureRecords(repo, [
      { kind: "run", value: fixtureBrief("brief both principals saw") },
    ]);
    const ruling: RulingRecord = {
      kind: "ruling",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.ruling,
      over: { claim: claimId! },
      verdict: "fails",
      reason: "both reviewers agree the receipt does not reflect what shipped",
      brief: briefId!,
    };
    const [id] = await writeFixtureRecords(repo, [{ kind: "ruling", value: ruling }]);
    rulingId = id!;

    const first = mintAttestation({
      subject: rulingId,
      principal: FIRST_PRINCIPAL,
      principalClass: "person",
      via: "tty",
      purpose: "made",
      at: FIXED_INSTANT,
    });
    const second = mintAttestation({
      subject: rulingId,
      principal: SECOND_PRINCIPAL,
      principalClass: "person",
      via: "tty",
      purpose: "made",
      at: FIXED_INSTANT,
    });
    await writeFixtureRecords(repo, [
      { kind: "attestation", value: first.record },
      { kind: "attestation", value: second.record },
    ]);
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  test("status still reports the one ruling's verdict, never duplicating it", async () => {
    const status = await runStatus(repo, slotOf("two-attestation-claim"));
    expect(status.label).toBe("fails");
    expect(status.winner).toBe(rulingId);
  });

  test("why names both principals in the ruling hop's decision, agreement visible rather than one record standing for the pair", async () => {
    const textLines = await runWhyText(repo, slotOf("two-attestation-claim"));
    const rulingLine = textLines.find((line) => line.label === "ruling");
    expect(rulingLine).toBeDefined();
    expect(rulingLine!.id).toBe(rulingId);
    expect(rulingLine!.decidedBy).toContain(FIRST_PRINCIPAL);
    expect(rulingLine!.decidedBy).toContain(SECOND_PRINCIPAL);
  });
});

describe("the role matrix and the trust branch's floor gate what a stored ruling decides", () => {
  let repo: FixtureRepo;
  let receiptRunId: RecordId;
  let rulingId: RecordId;
  const PRINCIPAL = pseudonymOf("arbiter@example.com");

  beforeAll(async () => {
    repo = await makeFixtureRepo("cli-matrix", [CLAIM_DECLARATION]);
    const receiptRun = runRecord("run", "the receipt the ruling overrides");
    const [runId] = await writeFixtureRecords(repo, [{ kind: "run", value: receiptRun }]);
    receiptRunId = runId!;

    const claim = claimRecord("matrix-claim", [edge(receiptRunId, "result")]);
    const [claimId] = await writeFixtureRecords(repo, [{ kind: "claim", value: claim }]);

    rulingId = await writeRuling(repo, {
      claimId: claimId!,
      verdict: "fails",
      reason: "the receipt does not reflect what actually shipped",
      principal: PRINCIPAL,
      principalClass: "person",
    });
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  test("with both trust files empty, the ruling decides at the tier it declares", async () => {
    const status = await runStatus(repo, slotOf("matrix-claim"));
    expect(status.label).toBe("fails");
    expect(status.winner).toBe(rulingId);
  });

  test("granting the principal only delegate evaluates the ruling as outside authority, reading the claim open with the contested-authority reason", async () => {
    await writeTrustFile(repo.ctx, "roles", `${PRINCIPAL} delegate any\n`);
    const status = await runStatus(repo, slotOf("matrix-claim"));
    expect(status.label).toBe("open");
    expect(status.reason).toBe("contested-authority");
  });

  test("granting the principal maintainer lets the ruling decide again", async () => {
    await writeTrustFile(repo.ctx, "roles", `${PRINCIPAL} maintainer any\n`);
    const status = await runStatus(repo, slotOf("matrix-claim"));
    expect(status.label).toBe("fails");
    expect(status.winner).toBe(rulingId);
  });

  test("a floor declared on the trust branch overrides the ruling's verdict", async () => {
    await writeTrustFile(repo.ctx, "config.json", JSON.stringify({ floor: { verdict: "holds" } }));
    const status = await runStatus(repo, slotOf("matrix-claim"));
    expect(status.label).toBe("holds");
  });

  test("a floor declared in a shape floorFrom does not recognise fails the invocation, naming the configuration key and the commit", async () => {
    await writeTrustFile(repo.ctx, "config.json", JSON.stringify({ floor: { verdict: "maybe" } }));
    const commit = await gitRevParse(repo.ctx, "refs/heads/main");
    let caught: ExecaError | undefined;
    try {
      await execa("node", [
        CLI_PATH,
        "status",
        slotOf("matrix-claim"),
        "--workspace",
        repo.workspace,
        "--scope",
        repo.scope,
      ]);
    } catch (error) {
      caught = error as ExecaError;
    }
    expect(caught).toBeDefined();
    const combined = `${caught!.stdout ?? ""}${caught!.stderr ?? ""}`;
    expect(combined).toContain("floor");
    expect(combined).toContain(commit!);
  });
});

describe("a ruling committed around the store never decides a claim", () => {
  let repo: FixtureRepo;
  let receiptRunId: RecordId;
  let refusedPath: string;

  beforeAll(async () => {
    repo = await makeFixtureRepo("cli-around-the-store", [CLAIM_DECLARATION]);
    const receiptRun = runRecord("run", "the receipt a hand-committed ruling tries to overrule");
    const [runId] = await writeFixtureRecords(repo, [{ kind: "run", value: receiptRun }]);
    receiptRunId = runId!;
    const claim = claimRecord("around-the-store-claim", [edge(receiptRunId, "result")]);
    const [claimId] = await writeFixtureRecords(repo, [{ kind: "claim", value: claim }]);

    const bytes = canonicalBytes({
      kind: "ruling",
      schemaVersion: CURRENT_SCHEMA_VERSIONS.ruling,
      over: { claim: claimId! },
      authority: "floor",
      verdict: "fails",
      reason: "a tier no ruling record may declare",
      brief: recordId({ example: "a brief this refused ruling would have cited" }),
    });
    refusedPath = recordPath("ruling", rawId(bytes));
    await commitAroundTheStore(repo, refusedPath, bytes);
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  test("a ruling declaring the floor's own tier is refused on read, reported by path and reason, and the receipt still decides", async () => {
    const { stdout, stderr } = await execa("node", [
      CLI_PATH,
      "status",
      slotOf("around-the-store-claim"),
      "--workspace",
      repo.workspace,
      "--scope",
      repo.scope,
      "--json",
    ]);
    const status = parseStatusJson(stdout);
    expect(status.label).toBe("holds");
    expect(status.via).toBe("receipt");
    expect(status.winner).toBe(`${receiptRunId}#${rendered("result")}`);
    expect(stderr).toContain(`refused ${refusedPath}`);
    expect(stderr).toContain(
      "ruling.authority no longer belongs on a ruling record: it moved to the attestation that signs it",
    );
  });
});

describe("at signing level person, a human attestation counts only once its signature verifies", () => {
  let repo: FixtureRepo;
  let key: TestKey;
  let testimonyId: RecordId;
  let unsignedAttestationId: RecordId;
  let tamperedAttestationId: RecordId;
  let testimonyAttestationId: RecordId;
  const UNSIGNED_PERSON = pseudonymOf("unsigned@example.com");
  const AGENT = pseudonymOf("reviewer-bot");
  const SET_SLUG = "signing-set";

  async function statusOrRefusal(slot: string): Promise<{ status?: StatusLine; refusal?: string }> {
    const result = await execa(
      "node",
      [CLI_PATH, "status", slot, "--workspace", repo.workspace, "--scope", repo.scope, "--json"],
      { reject: false },
    );
    return result.exitCode === 0 || result.exitCode === 7
      ? { status: parseStatusJson(result.stdout) }
      : { refusal: `${result.stdout}${result.stderr}` };
  }

  /** A verb's exit code, stdout and stderr refusal under `--json`. */
  async function refusalUnderJson(
    verb: readonly string[],
  ): Promise<{ exitCode: number | undefined; stdout: string; stderr: string }> {
    const { exitCode, stdout, stderr } = await execa(
      "node",
      [CLI_PATH, ...verb, "--workspace", repo.workspace, "--scope", repo.scope, "--json"],
      { reject: false },
    );
    return { exitCode, stdout: String(stdout), stderr: String(stderr) };
  }

  beforeAll(async () => {
    repo = await makeFixtureRepo("cli-signing", [CLAIM_DECLARATION]);
    key = await generateTestKey("signer@example.com");

    const receipt = runRecord("run", "the receipt every ruling below argues with");
    const testimony = runRecord("testimony", "a person's unsigned judgment");
    const [receiptId, testimonyRunId] = await writeFixtureRecords(repo, [
      { kind: "run", value: receipt },
      { kind: "run", value: testimony },
    ]);
    testimonyId = testimonyRunId!;

    const names = ["signed", "unsigned", "tampered", "delegate"] as const;
    const claimIds = await writeFixtureRecords(
      repo,
      names.map((name) => ({ kind: "claim", value: claimRecord(`signing-${name}`, [edge(receiptId!, "result")]) })),
    );
    await writeFixtureRecords(repo, [
      { kind: "claim", value: claimRecord("signing-testimony", [edge(testimonyId, "judgment")]) },
    ]);

    const rulingOver = async (claimId: RecordId): Promise<RecordId> => {
      const [briefId] = await writeFixtureRecords(repo, [{ kind: "run", value: fixtureBrief(`brief for ${claimId}`) }]);
      const ruling: RulingRecord = {
        kind: "ruling",
        supersedes: [],
        schemaVersion: CURRENT_SCHEMA_VERSIONS.ruling,
        over: { claim: claimId },
        verdict: "fails",
        reason: "the receipt measured a stale build",
        brief: briefId!,
      };
      const [id] = await writeFixtureRecords(repo, [{ kind: "ruling", value: ruling }]);
      return id!;
    };
    const signedRulingId = await rulingOver(claimIds[0]!);
    const unsignedRulingId = await rulingOver(claimIds[1]!);
    const tamperedRulingId = await rulingOver(claimIds[2]!);
    const delegateRulingId = await rulingOver(claimIds[3]!);

    const attest = (subject: RecordId, principal: string, principalClass: "person" | "agent") =>
      mintAttestation({ subject, principal, principalClass, via: "tty", purpose: "made", at: FIXED_INSTANT });
    const signedAttestation = attest(signedRulingId!, key.principal, "person");
    const tamperedAttestation = attest(tamperedRulingId!, key.principal, "person");
    const signature = await signAttestation({ attestation: signedAttestation, keyPath: key.keyPath });

    const [, unsignedAttested, tamperedAttested, , testimonyAttested] = await writeFixtureRecords(repo, [
      { kind: "attestation", value: signedAttestation.record, signature },
      { kind: "attestation", value: attest(unsignedRulingId!, UNSIGNED_PERSON, "person").record },
      // A real signature by the right key over a different attestation's bytes.
      { kind: "attestation", value: tamperedAttestation.record, signature },
      { kind: "attestation", value: attest(delegateRulingId!, AGENT, "agent").record },
      {
        kind: "attestation",
        value: mintAttestation({
          subject: testimonyId,
          principal: UNSIGNED_PERSON,
          principalClass: "person",
          via: "tty",
          purpose: "asserted",
          at: FIXED_INSTANT,
        }).record,
      },
    ]);
    unsignedAttestationId = unsignedAttested!;
    tamperedAttestationId = tamperedAttested!;
    testimonyAttestationId = testimonyAttested!;

    // A case whose first claim's ruling verifies and whose second's carries no signature.
    const setCase: CaseRecord = {
      kind: "case",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.case,
      type: null,
      slug: SET_SLUG,
      claims: [claimIds[0]!, claimIds[1]!],
      preset: {
        module: "musai.core",
        contribution: "musai.core/default",
        moduleRecord: recordId({ marker: "preset-module" }),
      },
      projectCommit: "0".repeat(40),
      overrides: {},
      evaluatorVersion: versionString("1"),
    };
    await writeFixtureRecords(repo, [{ kind: "case", value: setCase }]);

    await writeTrustFile(repo.ctx, "allowed-signers", allowedSignersLine(key));
    await writeTrustFile(
      repo.ctx,
      "roles",
      `${key.principal} owner any\n${UNSIGNED_PERSON} owner any\n${AGENT} delegate any\n`,
    );
    await writeTrustFile(repo.ctx, "config.json", JSON.stringify({ signing: "person" }));
  });

  afterAll(async () => {
    await repo.cleanup();
    await rm(key.dir, { recursive: true, force: true });
  });

  test("a person's ruling whose attestation carries a verified signature decides the claim", async () => {
    const { status, refusal } = await statusOrRefusal(slotOf("signing-signed"));
    expect(refusal).toBeUndefined();
    expect(status!.label).toBe("fails");
  });

  test("a person's ruling whose attestation carries no signature is refused by name, and nothing advances", async () => {
    const { status, refusal } = await statusOrRefusal(slotOf("signing-unsigned"));
    expect(status).toBeUndefined();
    expect(refusal).toContain(UNSIGNED_PERSON);
    expect(refusal).toContain("carries no signature");
    expect(refusal).toContain("signing level person");
  });

  test("a signature by the right key over other bytes is refused as invalid", async () => {
    const { status, refusal } = await statusOrRefusal(slotOf("signing-tampered"));
    expect(status).toBeUndefined();
    expect(refusal).toContain("does not verify (signature-invalid)");
  });

  test("an agent's unsigned attestation is enough for a delegate ruling at level person", async () => {
    const { status, refusal } = await statusOrRefusal(slotOf("signing-delegate"));
    expect(refusal).toBeUndefined();
    expect(status!.label).toBe("fails");
  });

  test("a person's unsigned testimony is refused on the evidence path too", async () => {
    const { status, refusal } = await statusOrRefusal(slotOf("signing-testimony"));
    expect(status).toBeUndefined();
    expect(refusal).toContain("carries no signature");
  });

  test("a person's ruling whose attestation carries no signature refuses workspace-incomplete, exit 3, naming the attestation", async () => {
    const { exitCode, stderr } = await refusalUnderJson(["status", slotOf("signing-unsigned")]);
    expect(exitCode).toBe(3);
    expect(JSON.parse(stderr)).toMatchObject({
      reason: "workspace-incomplete",
      code: "workspace",
      about: [unsignedAttestationId],
    });
  });

  test("a signature by the right key over other bytes refuses workspace-incomplete, exit 3", async () => {
    const { exitCode, stderr } = await refusalUnderJson(["status", slotOf("signing-tampered")]);
    expect(exitCode).toBe(3);
    expect(JSON.parse(stderr)).toMatchObject({
      reason: "workspace-incomplete",
      code: "workspace",
      about: [tamperedAttestationId],
    });
  });

  test("challenge.file citing a run whose attestation carries no signature refuses workspace-incomplete, exit 3, naming the attestation", async () => {
    const { exitCode, stderr } = await refusalUnderJson([
      "lab",
      "challenge",
      slotOf("signing-testimony"),
      "--run",
      testimonyId,
      "--selector",
      "musai.core/exit-code@1:judgment",
      "--reason",
      "the judgment was never signed",
    ]);
    expect(exitCode).toBe(3);
    expect(JSON.parse(stderr)).toMatchObject({
      reason: "workspace-incomplete",
      code: "workspace",
      about: [testimonyAttestationId],
    });
  });

  test("a reader over a set refuses whole, workspace-incomplete, exit 3, when one member's ruling carries no signature", async () => {
    const { exitCode, stdout, stderr } = await refusalUnderJson(["lab", "progress", SET_SLUG]);
    expect(exitCode).toBe(3);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toMatchObject({
      reason: "workspace-incomplete",
      code: "workspace",
      about: [unsignedAttestationId],
    });
  });

  test("at level all the agent's unsigned attestation is refused as well, and at level off nothing is checked", async () => {
    await writeTrustFile(repo.ctx, "config.json", JSON.stringify({ signing: "all" }));
    const atAll = await statusOrRefusal(slotOf("signing-delegate"));
    expect(atAll.status).toBeUndefined();
    expect(atAll.refusal).toContain(AGENT);
    expect(atAll.refusal).toContain("signing level all");

    await writeTrustFile(repo.ctx, "config.json", JSON.stringify({}));
    const atOff = await statusOrRefusal(slotOf("signing-unsigned"));
    expect(atOff.refusal).toBeUndefined();
    expect(atOff.status!.label).toBe("fails");
  });
});

describe("the roles file's four empty forms all open the workspace", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await makeFixtureRepo("cli-roles-empty-forms", [CLAIM_DECLARATION]);
    const run = runRecord("run", "a receipt with no ruling involved");
    const [runId] = await writeFixtureRecords(repo, [{ kind: "run", value: run }]);
    const claim = claimRecord("roles-empty-claim", [edge(runId!, "result")]);
    await writeFixtureRecords(repo, [{ kind: "claim", value: claim }]);
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  test("an absent roles file opens the workspace and prints a status", async () => {
    await removeTrustFile(repo.ctx, "roles");
    const status = await runStatus(repo, slotOf("roles-empty-claim"));
    expect(status.label).toBe("holds");
  });

  test("a zero-length roles file opens the workspace and prints a status", async () => {
    await writeTrustFile(repo.ctx, "roles", "");
    const status = await runStatus(repo, slotOf("roles-empty-claim"));
    expect(status.label).toBe("holds");
  });

  test("a whitespace-only roles file opens the workspace and prints a status", async () => {
    await writeTrustFile(repo.ctx, "roles", "   \n\t\n");
    const status = await runStatus(repo, slotOf("roles-empty-claim"));
    expect(status.label).toBe("holds");
  });

  test("a comment-only roles file opens the workspace and prints a status", async () => {
    await writeTrustFile(repo.ctx, "roles", "# nothing granted here\n");
    const status = await runStatus(repo, slotOf("roles-empty-claim"));
    expect(status.label).toBe("holds");
  });

  test("a roles file with an unparseable line fails the invocation by name", async () => {
    await writeTrustFile(repo.ctx, "roles", "not a roles line\n");
    let caught: ExecaError | undefined;
    try {
      await execa("node", [
        CLI_PATH,
        "status",
        slotOf("roles-empty-claim"),
        "--workspace",
        repo.workspace,
        "--scope",
        repo.scope,
      ]);
    } catch (error) {
      caught = error as ExecaError;
    }
    expect(caught).toBeDefined();
    expect(caught!.exitCode).not.toBe(0);
  });
});

describe("the role matrix's shape reads directly off the trust branch", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await makeFixtureRepo("cli-matrix-shape", [CLAIM_DECLARATION]);
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  test("two grants naming one principal at one scope merge into one entry holding the union of both roles' actions", async () => {
    await writeTrustFile(repo.ctx, "roles", "alice@example.com maintainer any\nalice@example.com arbiter any\n");
    const trust = await readTrustBranch(repo.ctx);
    const matrix = roleMatrix(parseAllowedSigners(trust.allowedSigners), parseRoles(trust.roles), trust.commit);
    const entriesForAlice = matrix.entries.filter((entry) => entry.principal === "alice@example.com");
    expect(entriesForAlice).toHaveLength(1);
    const union = new Set(["rule", "set-aside", "publish", "override-person"]);
    expect(new Set(entriesForAlice[0]!.actions)).toEqual(union);
  });

  test("two grants at scopes neither of which contains the other stay two entries", async () => {
    await writeTrustFile(repo.ctx, "roles", "bob@example.com maintainer alpha\nbob@example.com maintainer beta\n");
    const trust = await readTrustBranch(repo.ctx);
    const matrix = roleMatrix(parseAllowedSigners(trust.allowedSigners), parseRoles(trust.roles), trust.commit);
    const entriesForBob = matrix.entries.filter((entry) => entry.principal === "bob@example.com");
    expect(entriesForBob).toHaveLength(2);
  });

  test("two opens of an unchanged trust branch produce entries in the same principal-then-scope order", async () => {
    const first = await readTrustBranch(repo.ctx);
    const second = await readTrustBranch(repo.ctx);
    const matrixFirst = roleMatrix(parseAllowedSigners(first.allowedSigners), parseRoles(first.roles), first.commit);
    const matrixSecond = roleMatrix(
      parseAllowedSigners(second.allowedSigners),
      parseRoles(second.roles),
      second.commit,
    );
    expect(matrixSecond.entries).toEqual(matrixFirst.entries);
  });
});

describe("the trust branch's read is torn-free and the empty-files state is its own condition, not a fallback", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await makeFixtureRepo("cli-trust-conditions", [CLAIM_DECLARATION]);
    const run = runRecord("run", "a receipt with no ruling involved");
    const [runId] = await writeFixtureRecords(repo, [{ kind: "run", value: run }]);
    const claim = claimRecord("trust-conditions-claim", [edge(runId!, "result")]);
    await writeFixtureRecords(repo, [{ kind: "claim", value: claim }]);
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  test("with both trust files empty, the matrix reports the empty default and every action is granted", async () => {
    const trust = await readTrustBranch(repo.ctx);
    const matrix = roleMatrix(parseAllowedSigners(trust.allowedSigners), parseRoles(trust.roles), trust.commit);
    expect(matrix.emptyDefault).toBe(true);
    expect(matrix.asymmetric).toBe(false);
    for (const action of ACTIONS) {
      expect(may(matrix, "anyone@example.com", action, ANY_SCOPE)).toBe(true);
    }
  });

  test("the trust branch's commit is unchanged after several status and why invocations", async () => {
    const before = await gitRevParse(repo.ctx, "refs/heads/main");
    await runStatus(repo, slotOf("trust-conditions-claim"));
    await runWhyText(repo, slotOf("trust-conditions-claim"));
    await runStatus(repo, slotOf("trust-conditions-claim"));
    const after = await gitRevParse(repo.ctx, "refs/heads/main");
    expect(after).toBe(before);
  });

  test("an empty allowed-signers file beside a roles file holding grants is reported as its own condition, not the empty default", async () => {
    await writeTrustFile(repo.ctx, "roles", "carol@example.com maintainer any\n");
    const trust = await readTrustBranch(repo.ctx);
    expect(trust.allowedSigners).toBe("");
    const matrix = roleMatrix(parseAllowedSigners(trust.allowedSigners), parseRoles(trust.roles), trust.commit);
    expect(matrix.emptyDefault).toBe(false);
    expect(matrix.asymmetric).toBe(true);
    expect(may(matrix, "carol@example.com", "set-aside", ANY_SCOPE)).toBe(true);
  });

  test("the matrix's commit equals the commit the configuration was read at within one open", async () => {
    const trust = await readTrustBranch(repo.ctx);
    const matrix = roleMatrix(parseAllowedSigners(trust.allowedSigners), parseRoles(trust.roles), trust.commit);
    expect(matrix.commit).toBe(trust.config.commit);
  });

  test("a git-plumbing failure while reading the roles file refuses by name rather than reading as the empty default", async (context) => {
    context.skip(
      process.getuid?.() === 0,
      "root reads through mode bits, so an unreadable object directory cannot fail it",
    );
    await writeTrustFile(repo.ctx, "roles", "dedra@example.com maintainer any\n");
    const commit = await gitRevParse(repo.ctx, "refs/heads/main");
    const rolesBlob = await gitRevParse(repo.ctx, `${commit}:roles`);
    const objectDir = join(repo.ctx.gitDir, "objects", rolesBlob!.slice(0, 2));
    await chmod(objectDir, 0o000);
    try {
      await expect(readTrustBranch(repo.ctx)).rejects.toThrow(/roles/);
      await expect(readTrustBranch(repo.ctx)).rejects.toThrow(new RegExp(commit!));
    } finally {
      await chmod(objectDir, 0o755);
    }
  });
});

describe("one workspace carrying a pinned ruling, a set-aside and a floor, through both verbs", () => {
  let repo: FixtureRepo;
  let receiptRunId: RecordId;
  let claimId: RecordId;
  let rulingId: RecordId;
  const PRINCIPAL = pseudonymOf("arbiter@example.com");
  const REASON = "the receipt does not reflect what actually shipped";

  beforeAll(async () => {
    repo = await makeFixtureRepo("cli-graph", [CLAIM_DECLARATION]);
    const receiptRun = runRecord("run", "the receipt the ruling overrides");
    const [runId] = await writeFixtureRecords(repo, [{ kind: "run", value: receiptRun }]);
    receiptRunId = runId!;

    const claim = claimRecord("graph-claim", [edge(receiptRunId, "result")]);
    const [id] = await writeFixtureRecords(repo, [{ kind: "claim", value: claim }]);
    claimId = id!;

    rulingId = await writeRuling(repo, {
      claimId,
      verdict: "fails",
      reason: REASON,
      principal: PRINCIPAL,
      principalClass: "person",
      citing: [receiptRunId],
    });

    await writeTrustFile(repo.ctx, "roles", `${PRINCIPAL} maintainer any\n`);
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  test("with no floor declared, status reports the ruling's verdict over the evidence it displaced", async () => {
    const status = await runStatus(repo, slotOf("graph-claim"));
    expect(status.label).toBe("fails");
    expect(status.winner).toBe(rulingId);
    expect(status.rival).toBe(`${receiptRunId}#${rendered("result")}`);
  });

  test("with no floor declared, why renders the claim, the ruling naming its authority and principal, the brief it cites, and the overruled run as a set-aside naming that principal and the ruling's reason", async () => {
    const textLines = await runWhyText(repo, slotOf("graph-claim"));
    expect(textLines.map((line) => line.label)).toEqual(["claim", "ruling", "brief", "set-aside"]);

    const [claimLine, rulingLine, briefLine, setAsideLine] = textLines;
    expect(claimLine!.beat).toBe(`${receiptRunId}#${rendered("result")}`);
    expect(rulingLine!.id).toBe(rulingId);
    expect(rulingLine!.decidedBy).toContain("person");
    expect(rulingLine!.decidedBy).toContain(PRINCIPAL);
    expect(briefLine!.label).toBe("brief");
    expect(setAsideLine!.id).toBe(receiptRunId);
    expect(setAsideLine!.decidedBy).toBe(formatSetAsideDecision(PRINCIPAL, REASON));
  });

  test("with the floor declared and nothing else changed, status reports the floor's verdict instead", async () => {
    await writeTrustFile(repo.ctx, "config.json", JSON.stringify({ floor: { verdict: "holds" } }));
    const status = await runStatus(repo, slotOf("graph-claim"));
    expect(status.label).toBe("holds");
  });

  test("with the floor declared, why renders the claim, the floor naming the commit it was declared at, the evidence it stands over, and the run", async () => {
    const commit = await gitRevParse(repo.ctx, "refs/heads/main");
    const textLines = await runWhyText(repo, slotOf("graph-claim"));
    expect(textLines.map((line) => line.label)).toEqual(["claim", "floor", "evidence", "run"]);

    const [claimLine, floorLine, evidenceLine, runLine] = textLines;
    expect(claimLine!.beat).toBe(`${receiptRunId}#${rendered("result")}`);
    expect(floorLine!.decidedBy).toBe(formatFloorDecision(commit!));
    expect(evidenceLine!.id).toBe(`${receiptRunId}#${rendered("result")}`);
    expect(runLine!.id).toBe(receiptRunId);

    const json = await runWhyJson(repo, slotOf("graph-claim"));
    expect(countJsonNodes(json)).toBe(4);
  });

  test("with the claim's evidence moved away from what a ruling was pinned to, status reads the ruling's verdict flagged decided on stale evidence, and the derivation names the ruling", async () => {
    // Evidence only unions at a slot, so a ruling naming a run its snapshot never saw is authored.
    await writeTrustFile(repo.ctx, "config.json", "{}");

    const currentRun = runRecord("run", "the run currently backing this claim");
    const [currentRunId] = await writeFixtureRecords(repo, [{ kind: "run", value: currentRun }]);
    const movedClaim = claimRecord("moved-claim", [edge(currentRunId!, "result")]);
    const [movedClaimId] = await writeFixtureRecords(repo, [{ kind: "claim", value: movedClaim }]);

    const staleRun = runRecord("run", "the run a ruling once saw, no longer part of this claim's evidence");
    const [staleRunId] = await writeFixtureRecords(repo, [{ kind: "run", value: staleRun }]);
    const movedRulingId = await writeRuling(repo, {
      claimId: movedClaimId!,
      verdict: "fails",
      reason: REASON,
      principal: PRINCIPAL,
      principalClass: "person",
      citing: [staleRunId!],
    });

    const status = await runStatus(repo, slotOf("moved-claim"));
    expect(status.label).toBe("fails");
    expect(status.decidedOnStaleEvidence).toBe(true);

    const textLines = await runWhyText(repo, slotOf("moved-claim"));
    expect(textLines[1]!.label).toBe("ruling");
    expect(textLines[1]!.id).toBe(movedRulingId);
  });
});

describe("why walks a claim down to a receipt minted through the kernel's one hermetic spawn path", () => {
  let repo: FixtureRepo;
  let runId: RecordId;

  beforeAll(async () => {
    repo = await makeFixtureRepo("cli-hermetic-receipt", [CLAIM_DECLARATION]);
    const { recipe, observation } = await performRecipe({
      command: ["printf", "%s", "minted through the spawn path"],
      workingDirectory: "/",
      environment: {},
      declared: [],
      substrates: [],
      isolation: "hygiene",
    });
    const runValue: RunRecord = {
      kind: "run",
      schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
      runKind: "run",
      determinism: "nondeterministic",
      performer: RUNNER_PERFORMER,
      recipe,
      observation,
      supersedes: [],
    };
    const [id] = await writeFixtureRecords(repo, [{ kind: "run", value: runValue }]);
    runId = id!;
    const claim = claimRecord("hermetic-receipt-claim", [edge(runId, "result")]);
    await writeFixtureRecords(repo, [{ kind: "claim", value: claim }]);
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  test("why renders the run hop naming the minted receipt", async () => {
    const textLines = await runWhyText(repo, slotOf("hermetic-receipt-claim"));
    const runLine = textLines[textLines.length - 1]!;
    expect(runLine.label).toBe("run");
    expect(runLine.id).toBe(runId);
  });

  test("the minted receipt carries neither the fixture repository's own path nor the invoking process's home directory", async () => {
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now, claimTypes: repo.claimTypes });
    const stored = await store.read(runId, "run");
    const serialised = JSON.stringify(stored);
    expect(serialised).not.toContain(repo.workspace);
    const home = process.env["HOME"];
    if (home) {
      expect(serialised).not.toContain(home);
    }
  });
});

describe("why's --json bytes are the kernel's own canonical form of the derivation, not a pretty-printed copy", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await makeFixtureRepo("cli-why-canonical", [CLAIM_DECLARATION]);
    const run = runRecord("run", "the one receipt behind this claim");
    const [runId] = await writeFixtureRecords(repo, [{ kind: "run", value: run }]);
    const claim = claimRecord("why-canonical-claim", [edge(runId!, "result")]);
    await writeFixtureRecords(repo, [{ kind: "claim", value: claim }]);
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  test("re-canonicalising the parsed --json output reproduces the exact same bytes", async () => {
    const { stdout } = await execa("node", [
      CLI_PATH,
      "why",
      slotOf("why-canonical-claim"),
      "--workspace",
      repo.workspace,
      "--scope",
      repo.scope,
      "--json",
    ]);
    const reCanonicalised = new TextDecoder().decode(canonicalBytes(JSON.parse(stdout)));
    expect(stdout).toBe(reCanonicalised);
    expect(stdout).not.toContain("\n  ");
  });
});

describe("init, the module verbs, soundcheck and book, through the built binary", () => {
  test("init creates a workspace and prints its git directory, then how to register a signing key", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "musai-cli-init-"));
    try {
      const { stdout } = await execa("node", [CLI_PATH, "init", workspace]);
      const [gitDir, registration] = stdout.trim().split("\n");
      expect(gitDir).toBe(join(workspace, ".musai"));
      expect(registration).toContain("init --key");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("init with no directory creates the workspace in the directory it runs in", async () => {
    // A child's working directory is the resolved path, and macOS links the temp directory.
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "musai-cli-init-here-")));
    try {
      const { stdout } = await execa("node", [CLI_PATH, "init"], { cwd: workspace });
      expect(stdout.trim().split("\n")[0]).toBe(join(workspace, ".musai"));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  describe("a scaffolded module, built and tested through the module verbs", () => {
    let workspace: string;
    let moduleDir: string;

    beforeAll(async () => {
      workspace = await mkdtemp(join(tmpdir(), "musai-cli-module-workspace-"));
      moduleDir = await mkdtemp(join(tmpdir(), "musai-cli-module-source-"));
      await execa("node", [CLI_PATH, "init", workspace]);
    });

    afterAll(async () => {
      await rm(workspace, { recursive: true, force: true });
      await rm(moduleDir, { recursive: true, force: true });
    });

    test("module new scaffolds, builds and tests the default template in one call", async () => {
      const { stdout } = await execa("node", [CLI_PATH, "lab", "module", "new", moduleDir]);
      const lines = stdout.trim().split("\n");
      expect(lines[0]).toBe(moduleDir);
      expect(lines[1]).toBe("scaffolded, built and tested");
      expect(lines[2]).toBe(`install it in this workspace: musai lab module build ${moduleDir}`);
    });

    test("module build's help says it installs the module in this workspace", async () => {
      const { stdout } = await execa("node", [CLI_PATH, "lab", "module", "--help"]);
      expect(stdout.replace(/\s+/g, " ")).toContain(
        "build [options] <dir> build a module's source and install it in this workspace",
      );
    });

    test("module build records a manifest and a receipt against the workspace", async () => {
      const { stdout } = await execa("node", [CLI_PATH, "lab", "module", "build", moduleDir, "--workspace", workspace]);
      const lines = stdout.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(lines[1]).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    test("module build takes the module's directory relative to where it runs", async () => {
      const { stdout } = await execa(
        "node",
        [CLI_PATH, "lab", "module", "build", basename(moduleDir), "--workspace", workspace],
        { cwd: dirname(moduleDir) },
      );
      expect(stdout.trim().split("\n")[0]).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    test("test replays the module's own fixtures and exits clean", async () => {
      const { stdout, exitCode } = await execa("node", [CLI_PATH, "lab", "module", "test", moduleDir], {
        reject: false,
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain("pass");
    });

    test("test exits non-zero for a module with no fixtures to run, through the command and not only through the function", async () => {
      const emptyModuleDir = await mkdtemp(join(tmpdir(), "musai-cli-module-no-fixtures-"));
      try {
        await execa("node", [CLI_PATH, "lab", "module", "new", emptyModuleDir]);
        await rm(join(emptyModuleDir, "fixtures"), { recursive: true, force: true });

        const { exitCode } = await execa("node", [CLI_PATH, "lab", "module", "test", emptyModuleDir], {
          reject: false,
        });
        expect(exitCode).not.toBe(0);
      } finally {
        await rm(emptyModuleDir, { recursive: true, force: true });
      }
    });
  });

  describe("soundcheck prints one line per claim a case cites", () => {
    let repo: FixtureRepo;

    beforeAll(async () => {
      repo = await makeFixtureRepo("cli-soundcheck", [CLAIM_DECLARATION]);
      const run = runRecord("run", "the receipt behind the case's one claim");
      const [runId] = await writeFixtureRecords(repo, [{ kind: "run", value: run }]);
      const claim = claimRecord("soundcheck-claim", [edge(runId!, "result")]);
      const [claimId] = await writeFixtureRecords(repo, [{ kind: "claim", value: claim }]);
      const caseRecord: CaseRecord = {
        kind: "case",
        supersedes: [],
        schemaVersion: CURRENT_SCHEMA_VERSIONS.case,
        type: null,
        slug: "soundcheck-case",
        claims: [claimId!],
        preset: {
          module: "musai.core",
          contribution: "musai.core/default",
          moduleRecord: recordId({ marker: "preset-module" }),
        },
        projectCommit: "0".repeat(40),
        overrides: {},
        evaluatorVersion: versionString("1"),
      };
      await writeFixtureRecords(repo, [{ kind: "case", value: caseRecord }]);
    });

    afterAll(async () => {
      await repo.cleanup();
    });

    test("prints the slot and label for the case's one claim", async () => {
      const { stdout } = await execa("node", [
        CLI_PATH,
        "lab",

        "soundcheck",
        "soundcheck-case",
        "--workspace",
        repo.workspace,
        "--scope",
        repo.scope,
      ]);
      expect(stdout.trim()).toBe(`${slotOf("soundcheck-claim")}: holds`);
    });
  });

  describe("book mints a case a real soundcheck then reads back", () => {
    let workspace: string;

    beforeAll(async () => {
      workspace = await mkdtemp(join(tmpdir(), "musai-cli-book-"));
      await execa("node", [CLI_PATH, "init", workspace]);
    });

    afterAll(async () => {
      await rm(workspace, { recursive: true, force: true });
    });

    test("book then soundcheck shows the booked case's one claim by its computed status", async () => {
      const bookOutput = await execa("node", [
        CLI_PATH,
        "lab",

        "book",
        "booked-case",
        "--about",
        "urn:example:booked",
        "--workspace",
        workspace,
      ]);
      const caseId = bookOutput.stdout.trim();
      expect(caseId).toMatch(/^sha256:[0-9a-f]{64}$/);

      const soundcheckOutput = await execa("node", [
        CLI_PATH,
        "lab",

        "soundcheck",
        "booked-case",
        "--workspace",
        workspace,
      ]);
      expect(soundcheckOutput.stdout.trim()).toMatch(/^sha256:[0-9a-f]{64}: open \(no-evidence\)$/);
    });

    test("--plan previews the same case id without writing it", async () => {
      const planned = await execa("node", [
        CLI_PATH,
        "lab",

        "book",
        "plan-preview-case",
        "--about",
        "urn:example:preview",
        "--workspace",
        workspace,
        "--plan",
      ]);
      const planId = planned.stdout.trim();

      const soundcheckAttempt = await execa(
        "node",
        [CLI_PATH, "lab", "soundcheck", "plan-preview-case", "--workspace", workspace],
        {
          reject: false,
        },
      );
      expect(soundcheckAttempt.exitCode).not.toBe(0);

      const performed = await execa("node", [
        CLI_PATH,
        "lab",

        "book",
        "plan-preview-case",
        "--about",
        "urn:example:preview",
        "--workspace",
        workspace,
      ]);
      expect(performed.stdout.trim()).toBe(planId);
    });
  });
});

describe("the principal and channel a command line asserts: the environment names who, and only a terminal makes it a person", () => {
  let repo: FixtureRepo;
  let claimId: RecordId;
  let briefId: RecordId;

  beforeAll(async () => {
    repo = await makeFixtureRepo("cli-principal-environment", [CLAIM_DECLARATION]);
    await fixWorkspaceKey(repo.workspace);
    const run = runRecord("run", "the receipt behind the principal-environment claim");
    const [runId] = await writeFixtureRecords(repo, [{ kind: "run", value: run }]);
    const claim = claimRecord("principal-environment-claim", [edge(runId!, "result")]);
    const brief = fixtureBrief("brief for the principal-environment claim");
    const [mintedClaimId, mintedBriefId] = await writeFixtureRecords(repo, [
      { kind: "claim", value: claim },
      { kind: "run", value: brief },
    ]);
    claimId = mintedClaimId!;
    briefId = mintedBriefId!;
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  /** A planned `rule`, so nothing is written and a second call never collides with the first. */
  function ruleArgs(): string[] {
    return [
      CLI_PATH,
      "lab",

      "rule",
      claimId,
      "--verdict",
      "holds",
      "--reason",
      "the environment names who is ruling",
      "--brief",
      briefId,
      "--workspace",
      repo.workspace,
      "--scope",
      repo.scope,
      "--plan",
      "--json",
    ];
  }

  /** The attestation a planned `rule` mints, read out of its JSON answer. */
  function attestationIn(stdout: string): { principal?: string; via?: string; principalClass?: string } {
    const output = JSON.parse(stdout) as {
      minted: { kind: string; record: { principal?: string; via?: string; principalClass?: string } }[];
    };
    const attestation = output.minted.find((item) => item.kind === "attestation");
    if (attestation === undefined) {
      throw new Error("rule minted no attestation to read a principal from");
    }
    return attestation.record;
  }

  /** The attestation `rule` asserts with a pipe for standard input, as a script's or an agent's. */
  async function ruledAttestation(
    env: NodeJS.ProcessEnv,
  ): Promise<{ principal?: string; via?: string; principalClass?: string }> {
    const { stdout } = await execa("node", ruleArgs(), { env, extendEnv: false });
    return attestationIn(stdout);
  }

  test("names MUSAI_PRINCIPAL's pseudonym when the environment sets it, and with no terminal attached answers as an agent", async () => {
    const { MUSAI_PRINCIPAL: _pinned, ...unpinned } = process.env;
    const attestation = await ruledAttestation({ ...unpinned, MUSAI_PRINCIPAL: "pinned-reviewer" });
    expect(attestation.principal).toBe(pseudonymOf("pinned-reviewer"));
    expect(attestation.via).toBe("process");
    expect(attestation.principalClass).toBe("agent");
  });

  test("with no key and no name in the environment, refuses naming both remedies, and never the machine's user", async () => {
    const { MUSAI_PRINCIPAL: _pinned, ...unpinned } = process.env;
    const refused = await execa("node", ruleArgs(), { env: unpinned, extendEnv: false, reject: false });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("musai init --key");
    expect(refused.stderr).toContain("MUSAI_PRINCIPAL");
    expect(refused.stderr).not.toContain(`by ${userInfo().username}`);
  });

  test("answers as a person, via tty, when standard input is an interactive terminal", async (context) => {
    const util = await execa("script", ["--version"], { reject: false });
    context.skip(
      util.exitCode !== 0 || !util.stdout.includes("util-linux"),
      "allocating a terminal for the call takes util-linux's script",
    );
    const { MUSAI_PRINCIPAL: _pinned, ...unpinned } = process.env;
    const command = ["node", ...ruleArgs()].map((argument) => `'${argument.replaceAll("'", "'\\''")}'`).join(" ");
    const { stdout } = await execa("script", ["--quiet", "--return", "--command", command, "/dev/null"], {
      env: { ...unpinned, MUSAI_PRINCIPAL: "pinned-reviewer" },
      extendEnv: false,
    });
    const attestation = attestationIn(stdout.trim());
    expect(attestation.via).toBe("tty");
    expect(attestation.principalClass).toBe("person");
  });
});

describe("the cross-invocation form: a plan-mode call and the performing call that follows mint the same ids", () => {
  let repo: FixtureRepo;
  let claimId: RecordId;
  let briefId: RecordId;
  const PINNED_PRINCIPAL = "cross-invocation-ruler";

  beforeAll(async () => {
    repo = await makeFixtureRepo("cli-plan-then-perform", [CLAIM_DECLARATION]);
    const run = runRecord("run", "the receipt behind the cross-invocation claim");
    const [runId] = await writeFixtureRecords(repo, [{ kind: "run", value: run }]);
    const claim = claimRecord("cross-invocation-claim", [edge(runId!, "result")]);
    const brief = fixtureBrief("brief for the cross-invocation claim");
    const [mintedClaimId, mintedBriefId] = await writeFixtureRecords(repo, [
      { kind: "claim", value: claim },
      { kind: "run", value: brief },
    ]);
    claimId = mintedClaimId!;
    briefId = mintedBriefId!;
  });

  afterAll(async () => {
    await repo.cleanup();
  });

  /** Plan and perform are two processes each reading the clock, so `MUSAI_NOW` pins their instants
   * equal; the principal is pinned too. */
  async function rule(extraArgs: readonly string[]): Promise<{ minted: { id: string; kind: string }[] }> {
    const { stdout } = await execa(
      "node",
      [
        CLI_PATH,
        "lab",

        "rule",
        claimId,
        "--verdict",
        "holds",
        "--reason",
        "one pinned clock and one pinned principal decide this",
        "--brief",
        briefId,
        "--workspace",
        repo.workspace,
        "--scope",
        repo.scope,
        "--json",
        ...extraArgs,
      ],
      { env: { ...process.env, MUSAI_NOW: FIXED_INSTANT, MUSAI_PRINCIPAL: PINNED_PRINCIPAL } },
    );
    return JSON.parse(stdout) as { minted: { id: string; kind: string }[] };
  }

  test("mints the same record ids whether the call previews or performs", async () => {
    const planned = await rule(["--plan"]);
    const performed = await rule([]);

    expect(performed.minted.map((item) => item.id)).toEqual(planned.minted.map((item) => item.id));
  });
});
