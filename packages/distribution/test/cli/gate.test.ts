import { fileURLToPath } from "node:url";
import {
  type ArgumentRecord,
  type CaseRecord,
  type ClaimRecord,
  type ClaimTypeDeclaration,
  CURRENT_SCHEMA_VERSIONS,
  type EvidenceEdge,
  type RecordId,
  type RunRecord,
  recordId,
  slotFor,
  timestamp,
  versionString,
} from "@musai/records";
import { RUNNER_PERFORMER } from "@musai/run";
import { type FixtureRepo, makeFixtureRepo, writeFixtureRecords } from "@musai/test-support";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const CLI_PATH = fileURLToPath(new URL("../../dist/bin/cli.js", import.meta.url));
const CLAIM_TYPE = "musai.cli-gate-fixture/claim@1";
const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: CLAIM_TYPE, identityDimensions: ["id"] };

interface ClaimSpec {
  readonly id: string;
  readonly rendering: string;
  readonly exclusiveGroup: string | null;
  readonly disposition?: string;
}

function slotOf(id: string): string {
  return slotFor(CLAIM_DECLARATION, { id });
}

async function seedCase(repo: FixtureRepo, slug: string, specs: readonly ClaimSpec[]): Promise<Map<string, RecordId>> {
  const idBySpecId = new Map<string, RecordId>();
  const claimIds: RecordId[] = [];
  for (const spec of specs) {
    const conditions: Record<string, string> = { id: spec.id };
    if (spec.disposition !== undefined) {
      conditions["disposition"] = spec.disposition;
    }
    const claim: ClaimRecord = {
      kind: "claim",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
      type: CLAIM_TYPE,
      about: [],
      slot: slotOf(spec.id),
      conditions,
      canonical: conditions,
      rendering: spec.rendering,
      evidence: [],
      exclusiveGroup: spec.exclusiveGroup,
    };
    const [id] = await writeFixtureRecords(repo, [{ kind: "claim", value: claim }]);
    claimIds.push(id!);
    idBySpecId.set(spec.id, id!);
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
      moduleRecord: recordId({ marker: "cli-gate-fixture" }),
    },
    projectCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    overrides: {},
    evaluatorVersion: versionString("1"),
  };
  await writeFixtureRecords(repo, [{ kind: "case", value: caseRecord }]);
  return idBySpecId;
}

const FIXED_INSTANT = timestamp("2026-01-01T00:00:00.000Z");

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

describe("gate verbs against the built binary", () => {
  let repo: FixtureRepo;

  beforeEach(() => {
    vi.stubEnv("MUSAI_PRINCIPAL", "gate-cli");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await repo?.cleanup();
  });

  test("ask renders the brief and offers the menu, answer mints a ruling the terminal channel signed, status reads it back", async () => {
    repo = await makeFixtureRepo("gate-cli-binary", [CLAIM_DECLARATION]);
    const ids = await seedCase(repo, "cli-binary-case", [
      { id: "only", rendering: "the corpus is clean", exclusiveGroup: null },
    ]);
    const claimId = ids.get("only")!;

    const askOutput = await execa("node", [
      CLI_PATH,
      "lab",

      "ask",
      claimId,
      "--workspace",
      repo.workspace,
      "--scope",
      repo.scope,
      "--json",
    ]);
    const asked = JSON.parse(askOutput.stdout) as { brief: RecordId; options: readonly { value: string }[] };
    expect(asked.options.map((option) => option.value).sort()).toEqual(["fails", "holds"]);

    await execa("node", [
      CLI_PATH,
      "lab",

      "answer",
      claimId,
      "--brief",
      asked.brief,
      "--choice",
      "holds",
      "--reason",
      "the corpus really is clean",
      "--workspace",
      repo.workspace,
      "--scope",
      repo.scope,
    ]);

    const statusOutput = await execa("node", [
      CLI_PATH,
      "status",
      slotOf("only"),
      "--workspace",
      repo.workspace,
      "--scope",
      repo.scope,
    ]);
    expect(statusOutput.stdout.trim()).toMatch(/^✓ holds · /);
  });

  test("rule refuses a claim or a brief the scope does not hold, minting nothing — a record is immutable and a decision nobody could have made is permanent", async () => {
    repo = await makeFixtureRepo("gate-cli-rule-absent", [CLAIM_DECLARATION]);
    const ids = await seedCase(repo, "cli-rule-absent-case", [
      { id: "only", rendering: "the release is ready", exclusiveGroup: null },
    ]);
    const claimId = ids.get("only")!;
    const askOutput = await execa("node", [
      CLI_PATH,
      "lab",

      "ask",
      claimId,
      "--workspace",
      repo.workspace,
      "--scope",
      repo.scope,
      "--json",
    ]);
    const asked = JSON.parse(askOutput.stdout) as { brief: RecordId };
    const absent = `sha256:${"c".repeat(64)}`;

    async function pendingCount(): Promise<number> {
      const listed = await execa("node", [
        CLI_PATH,
        "lab",

        "pending",
        "--workspace",
        repo.workspace,
        "--scope",
        repo.scope,
        "--json",
      ]);
      return (JSON.parse(listed.stdout) as { gates: unknown[] }).gates.length;
    }
    const before = await pendingCount();

    for (const argv of [
      ["lab", "rule", absent, "--verdict", "holds", "--reason", "no such claim", "--brief", asked.brief],
      ["lab", "rule", claimId, "--verdict", "holds", "--reason", "no such brief", "--brief", absent],
    ]) {
      const refused = await execa("node", [CLI_PATH, ...argv, "--workspace", repo.workspace, "--scope", repo.scope], {
        reject: false,
      });
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stdout).toBe("");
    }

    expect(await pendingCount()).toBe(before);
  });

  test("pending lists a gate awaiting an answer and drops it once answered", async () => {
    repo = await makeFixtureRepo("gate-cli-pending", [CLAIM_DECLARATION]);
    await seedCase(repo, "cli-pending-case", [{ id: "only", rendering: "ship it", exclusiveGroup: null }]);

    const beforeAnswer = await execa("node", [
      CLI_PATH,
      "lab",

      "pending",
      "--workspace",
      repo.workspace,
      "--scope",
      repo.scope,
      "--json",
    ]);
    const before = JSON.parse(beforeAnswer.stdout) as { gates: readonly unknown[] };
    expect(before.gates).toEqual([]);
  });

  test("rule mints a ruling directly, the same commit answer would have made", async () => {
    repo = await makeFixtureRepo("gate-cli-rule", [CLAIM_DECLARATION]);
    const ids = await seedCase(repo, "cli-rule-case", [
      { id: "only", rendering: "the release is ready", exclusiveGroup: null },
    ]);
    const claimId = ids.get("only")!;

    const askOutput = await execa("node", [
      CLI_PATH,
      "lab",

      "ask",
      claimId,
      "--workspace",
      repo.workspace,
      "--scope",
      repo.scope,
      "--json",
    ]);
    const asked = JSON.parse(askOutput.stdout) as { brief: RecordId };

    await execa("node", [
      CLI_PATH,
      "lab",

      "rule",
      claimId,
      "--verdict",
      "holds",
      "--reason",
      "ruled directly, not through a gate",
      "--brief",
      asked.brief,
      "--workspace",
      repo.workspace,
      "--scope",
      repo.scope,
    ]);

    const statusOutput = await execa("node", [
      CLI_PATH,
      "status",
      slotOf("only"),
      "--workspace",
      repo.workspace,
      "--scope",
      repo.scope,
    ]);
    expect(statusOutput.stdout.trim()).toMatch(/^✓ holds · /);
  });

  test("rule --supersedes corrects a ruling: repeated flags collect and mint sorted, and an absent flag mints an empty list", async () => {
    repo = await makeFixtureRepo("gate-cli-supersede", [CLAIM_DECLARATION]);
    const ids = await seedCase(repo, "cli-supersede-case", [
      { id: "only", rendering: "the release is ready", exclusiveGroup: null },
    ]);
    const claimId = ids.get("only")!;

    const askOutput = await execa("node", [
      CLI_PATH,
      "lab",

      "ask",
      claimId,
      "--workspace",
      repo.workspace,
      "--scope",
      repo.scope,
      "--json",
    ]);
    const asked = JSON.parse(askOutput.stdout) as { brief: RecordId };

    interface RuleOutput {
      readonly minted: readonly {
        readonly id: RecordId;
        readonly kind: string;
        readonly record: { readonly supersedes: readonly RecordId[] };
      }[];
    }

    async function rule(
      verdict: "holds" | "fails",
      reason: string,
      supersedes: readonly RecordId[],
    ): Promise<RuleOutput> {
      const supersedesFlags = supersedes.flatMap((id) => ["--supersedes", id]);
      const result = await execa("node", [
        CLI_PATH,
        "lab",

        "rule",
        claimId,
        "--verdict",
        verdict,
        "--reason",
        reason,
        "--brief",
        asked.brief,
        ...supersedesFlags,
        "--workspace",
        repo.workspace,
        "--scope",
        repo.scope,
        "--json",
      ]);
      return JSON.parse(result.stdout) as RuleOutput;
    }

    // With no flag, a ruling retiring nothing carries "supersedes":[].
    const firstTake = await rule("holds", "a first take", []);
    const firstRuling = firstTake.minted.find((item) => item.kind === "ruling")!;
    expect(firstRuling.record.supersedes).toEqual([]);

    // A second, disagreeing ruling at the same tier leaves the claim contested.
    const secondTake = await rule("fails", "a second, disagreeing take", []);
    const secondRuling = secondTake.minted.find((item) => item.kind === "ruling")!;
    expect(secondRuling.record.supersedes).toEqual([]);

    const contestedStatus = await execa(
      "node",
      [CLI_PATH, "status", slotOf("only"), "--workspace", repo.workspace, "--scope", repo.scope],
      { reject: false },
    );
    expect(contestedStatus.exitCode).toBe(7);
    expect(contestedStatus.stdout.trim()).toMatch(/^◌ open · /);

    // Flags given out of order still mint a sorted list.
    const [first, second] = [firstRuling.id, secondRuling.id].sort();
    const correction = await rule("fails", "the correction, superseding both partial rulings", [second, first]);
    const correctingRuling = correction.minted.find((item) => item.kind === "ruling")!;
    expect(correctingRuling.record.supersedes).toEqual([first, second]);

    const correctedStatus = await execa(
      "node",
      [CLI_PATH, "status", slotOf("only"), "--workspace", repo.workspace, "--scope", repo.scope],
      { reject: false },
    );
    expect(correctedStatus.exitCode).toBe(7);
    expect(correctedStatus.stdout.trim()).toMatch(/^✗ fails · /);
  });

  test("answering against a brief whose evidence has since moved refuses, rendering each moved read's own before-and-after diff", async () => {
    repo = await makeFixtureRepo("gate-cli-stale", [CLAIM_DECLARATION]);
    const [directRunId] = await writeFixtureRecords(repo, [
      { kind: "run", value: receiptRun("the direct receipt this claim rests on") },
    ]);
    const conditions = { id: "only" };
    const claim: ClaimRecord = {
      kind: "claim",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
      type: CLAIM_TYPE,
      about: [],
      slot: slotOf("only"),
      conditions,
      canonical: conditions,
      rendering: "the corpus is clean",
      evidence: [receiptEdge(directRunId!, "result")],
      exclusiveGroup: null,
    };
    const [claimId] = await writeFixtureRecords(repo, [{ kind: "claim", value: claim }]);
    const caseRecord: CaseRecord = {
      kind: "case",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.case,
      type: null,
      slug: "cli-stale-case",
      claims: [claimId!],
      preset: {
        module: "musai.core",
        contribution: "musai.core/bare",
        moduleRecord: recordId({ marker: "cli-stale-fixture" }),
      },
      projectCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      overrides: {},
      evaluatorVersion: versionString("1"),
    };
    await writeFixtureRecords(repo, [{ kind: "case", value: caseRecord }]);

    const askOutput = await execa("node", [
      CLI_PATH,
      "lab",

      "ask",
      claimId!,
      "--workspace",
      repo.workspace,
      "--scope",
      repo.scope,
      "--json",
    ]);
    const asked = JSON.parse(askOutput.stdout) as { brief: RecordId };

    const [attackRunId] = await writeFixtureRecords(repo, [
      { kind: "run", value: receiptRun("a new attacking receipt, minted after the brief") },
    ]);
    const argument: ArgumentRecord = {
      kind: "argument",
      premises: [],
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.argument,
      target: claimId!,
      reason: "a challenge minted after the brief was rendered",
      evidence: [receiptEdge(attackRunId!, "result")],
    };
    const [argumentId] = await writeFixtureRecords(repo, [{ kind: "argument", value: argument }]);

    const failure = await execa(
      "node",
      [
        CLI_PATH,
        "lab",

        "answer",
        claimId!,
        "--brief",
        asked.brief,
        "--choice",
        "holds",
        "--reason",
        "too late",
        "--workspace",
        repo.workspace,
        "--scope",
        repo.scope,
      ],
      { reject: false },
    );

    expect(failure.exitCode).not.toBe(0);
    expect(failure.stderr).toMatch(/was unread, now read/);

    const jsonFailure = await execa(
      "node",
      [
        CLI_PATH,
        "lab",

        "answer",
        claimId!,
        "--brief",
        asked.brief,
        "--choice",
        "holds",
        "--reason",
        "too late",
        "--workspace",
        repo.workspace,
        "--scope",
        repo.scope,
        "--json",
      ],
      { reject: false, stripFinalNewline: false },
    );
    // No trailing newline, as `--json` gives a success; read unstripped so the byte is pinned.
    expect(jsonFailure.stderr.endsWith("\n")).toBe(false);
    const errorShape = JSON.parse(jsonFailure.stderr) as { code: string; reason: string; about: readonly string[] };
    expect(errorShape.reason).toBe("stale");
    expect(errorShape.about).toEqual([argumentId!, attackRunId!].sort());
  });
});
