import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { isOperationError, type OperationError, runHandler } from "@musai/api-core";
import { callTool, createMcpServer, toolsFromRegistry } from "@musai/mcp";
import {
  type CaseRecord,
  type ClaimRecord,
  type ClaimTypeDeclaration,
  CURRENT_SCHEMA_VERSIONS,
  claimTypesFrom,
  EVALUATOR_VERSION,
  type RecordId,
  recordId,
  slotFor,
  timestamp,
  versionString,
} from "@musai/records";
import { type GitContext, initWorkspace, Store } from "@musai/store";
import { declareClaimTypes, fixedClock, fixtureBrief, fixWorkspaceKey, pseudonymOf } from "@musai/test-support";
import { afterEach, describe, expect, test, vi } from "vitest";
import { briefRecipe, REGISTRY } from "../../src/index.js";
import { MUSAI_MCP } from "../../src/mcp/extension.js";
import { MUSAI } from "../../src/musai.js";

const CLAIM_TYPE = "musai.gate-parity-test/claim@1";
const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: CLAIM_TYPE, identityDimensions: ["id"] };
const CLAIM_TYPES = claimTypesFrom([CLAIM_DECLARATION]);
const FIXED_INSTANT = timestamp("2026-01-01T00:00:00.000Z");
const fixedNow = fixedClock(FIXED_INSTANT);

/** A workspace with one binary gate and one brief. Built once and copied: a brief pins its head's
 * sha, which differs between two separately initialised repositories. */
async function makeFixtureWorkspace(): Promise<{
  workspace: string;
  scope: string;
  claimId: RecordId;
  briefId: RecordId;
}> {
  const workspace = await mkdtemp(join(tmpdir(), "musai-gate-parity-"));
  await initWorkspace(workspace, { now: fixedNow });
  await fixWorkspaceKey(workspace);
  const scope = "default";
  const ctx: GitContext = { gitDir: join(workspace, ".musai") };
  const store = new Store({ ctx, scope, now: fixedNow, claimTypes: CLAIM_TYPES });
  await declareClaimTypes(store, [CLAIM_DECLARATION]);

  const conditions = { id: "parity-claim" };
  const claim: ClaimRecord = {
    kind: "claim",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: CLAIM_TYPE,
    about: [],
    slot: slotFor(CLAIM_DECLARATION, conditions),
    conditions,
    canonical: conditions,
    rendering: "the fixture's own gate holds",
    evidence: [],
    exclusiveGroup: null,
  };
  const [claimId] = await store.putMany([{ kind: "claim", value: claim }]);

  const caseRecord: CaseRecord = {
    kind: "case",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.case,
    type: null,
    slug: "gate-parity-case",
    claims: [claimId!],
    preset: {
      module: "musai.core",
      contribution: "musai.core/bare",
      moduleRecord: recordId({ marker: "gate-parity" }),
    },
    projectCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    overrides: {},
    evaluatorVersion: versionString("1"),
  };
  const [caseId] = await store.putMany([{ kind: "case", value: caseRecord }]);

  const head = (await store.tip())!;
  const recipe = briefRecipe(claimId!, { head, caseId: caseId!, budget: 20000, kernelVersion: EVALUATOR_VERSION });
  const brief = fixtureBrief("the fixture's own fixed brief", { recipe, reads: [caseId!, claimId!] });
  const [briefId] = await store.putMany([{ kind: "run", value: brief }]);

  return { workspace, scope, claimId: claimId!, briefId: briefId! };
}

interface MintedOutput {
  readonly minted: readonly {
    readonly id: RecordId;
    readonly kind: string;
    readonly record: { readonly via?: string };
  }[];
}

async function copyWorkspace(source: string): Promise<string> {
  const target = await mkdtemp(join(tmpdir(), "musai-gate-parity-copy-"));
  await cp(source, target, { recursive: true });
  return target;
}

describe("gate.answer mints the same ruling whichever surface asks, attested under the channel that surface establishes", () => {
  test("a terminal answer and a plain MCP answer under one clock and one principal mint the same ruling id and different attestation ids, the MCP one via model", async () => {
    const fixture = await makeFixtureWorkspace();
    const cliWorkspace = await copyWorkspace(fixture.workspace);
    const mcpWorkspace = await copyWorkspace(fixture.workspace);

    const principal = "reviewer";
    const answerInput = {
      pending: fixture.claimId,
      brief: fixture.briefId,
      choice: "holds",
      reason: "answered the same way from either surface",
    };

    try {
      // Terminal-shaped: the terminal's channel and principal, through the shared entry point.
      const gateAnswer = REGISTRY.get("gate.answer@2")!;
      const cliShaped = (await runHandler(gateAnswer, answerInput, {
        workspace: cliWorkspace,
        scope: fixture.scope,
        now: fixedNow,
        via: "tty",
        principalName: principal,
      })) as MintedOutput;

      // MCP-shaped: the same arguments as a raw tool call, under the model's channel.
      const mcpShaped = await callTool(
        MUSAI,
        { workspace: mcpWorkspace, scope: fixture.scope, now: fixedNow, via: "model", principalName: principal },
        "gate_answer",
        answerInput,
      );
      const mcpOutput = mcpShaped.structuredContent as unknown as MintedOutput;

      const idOf = (output: MintedOutput, kind: string): RecordId =>
        output.minted.find((item) => item.kind === kind)!.id;
      expect(cliShaped.minted).toHaveLength(2);
      expect(mcpOutput.minted).toHaveLength(2);
      expect(idOf(mcpOutput, "ruling")).toBe(idOf(cliShaped, "ruling"));
      expect(idOf(mcpOutput, "attestation")).not.toBe(idOf(cliShaped, "attestation"));
      const attestationVia = (output: MintedOutput): string | undefined =>
        output.minted.find((item) => item.kind === "attestation")!.record.via;
      expect(attestationVia(cliShaped)).toBe("tty");
      expect(attestationVia(mcpOutput)).toBe("model");
    } finally {
      await rm(fixture.workspace, { recursive: true, force: true });
      await rm(cliWorkspace, { recursive: true, force: true });
      await rm(mcpWorkspace, { recursive: true, force: true });
    }
  });

  test("gate_answer's elicitation-facing tool carries only what identifies the question, never choice, via or principal", async () => {
    const { GATE_ANSWER_ELICITATION_TOOL } = await import("../../src/mcp/gate-tool.js");
    const properties =
      (GATE_ANSWER_ELICITATION_TOOL.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(properties).sort()).toEqual(["brief", "pending", "reason"]);
  });

  test("ruling_make's advertised inputSchema carries supersedes as an array of strings", () => {
    const tool = toolsFromRegistry(REGISTRY).find((candidate) => candidate.name === "ruling_make")!;
    const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(properties["supersedes"]).toEqual({ type: "array", items: { type: "string" }, uniqueItems: true });
  });
});

describe("ruling.make's supersession check reaches a plain MCP call, since mintRuling is the one function every surface plans a ruling through", () => {
  test("a model channel cannot retire a person's ruling: the refusal names the retired ruling's id, and the scope's tip does not move", async () => {
    const fixture = await makeFixtureWorkspace();
    const slot = slotFor(CLAIM_DECLARATION, { id: "parity-claim" });
    try {
      const principal = "reviewer";
      const terminalContext = {
        workspace: fixture.workspace,
        scope: fixture.scope,
        now: fixedNow,
        via: "tty" as const,
        principalName: principal,
        mode: "perform" as const,
      };

      const gateAnswer = REGISTRY.get("gate.answer@2")!;
      const personRuling = (await runHandler(
        gateAnswer,
        { pending: fixture.claimId, brief: fixture.briefId, choice: "holds", reason: "ruled through the terminal" },
        terminalContext,
      )) as MintedOutput;
      const rulingId = personRuling.minted.find((item) => item.kind === "ruling")!.id;

      const claimStatus = REGISTRY.get("claim.status@3")!;
      const before = (await runHandler(claimStatus, { claim: slot }, terminalContext)) as {
        comparison: { winner: string };
      };
      expect(before.comparison.winner).toBe(rulingId);

      const ctx: GitContext = { gitDir: join(fixture.workspace, ".musai") };
      const store = new Store({ ctx, scope: fixture.scope, now: fixedNow, claimTypes: CLAIM_TYPES });
      const tipBeforeRefusal = await store.tip();

      const refusal = await callTool(
        MUSAI,
        { workspace: fixture.workspace, scope: fixture.scope, now: fixedNow, via: "model", principalName: principal },
        "ruling_make",
        {
          claim: fixture.claimId,
          verdict: "fails",
          reason: "a model attempting to retire a person's ruling",
          brief: fixture.briefId,
          supersedes: [rulingId],
        },
      ).catch((caught: unknown) => caught);

      expect(isOperationError(refusal)).toBe(true);
      const error = refusal as OperationError;
      expect(error.reason).toBe("not-authorised");
      expect(error.about).toContain(rulingId);

      // Refused before planning, so the tip is unmoved and the person's ruling still decides.
      expect(await store.tip()).toBe(tipBeforeRefusal);
      const after = (await runHandler(claimStatus, { claim: slot }, terminalContext)) as {
        comparison: { winner: string };
      };
      expect(after.comparison.winner).toBe(rulingId);
    } finally {
      await rm(fixture.workspace, { recursive: true, force: true });
    }
  });
});

describe("a plain MCP tool call is attested under the principal its session established", () => {
  const CLIENT_NAME = "handshake-named-client";

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** What a planned `ruling_make` call from client `CLIENT_NAME` answers. */
  async function plainCall(): Promise<CallToolResult> {
    const fixture = await makeFixtureWorkspace();
    const server = createMcpServer(
      MUSAI_MCP,
      { workspace: fixture.workspace, scope: fixture.scope, now: fixedNow },
      { lab: true },
    );
    const client = new Client({ name: CLIENT_NAME, version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      return (await client.callTool({
        name: "ruling_make",
        arguments: {
          claim: fixture.claimId,
          verdict: "holds",
          reason: "ruled through a plain tool call",
          brief: fixture.briefId,
          plan: true,
        },
      })) as CallToolResult;
    } finally {
      await client.close();
      await server.close();
      await rm(fixture.workspace, { recursive: true, force: true });
    }
  }

  test("is refused, naming both remedies, when neither a key nor the environment names a principal, and never takes the client's handshake name", async () => {
    vi.stubEnv("MUSAI_PRINCIPAL", undefined);
    const result = await plainCall();
    const text = JSON.stringify(result.content);
    expect(result.isError).toBe(true);
    expect(text).toContain("MUSAI_PRINCIPAL");
    expect(text).toContain("musai init --key");
    expect(text).not.toContain(CLIENT_NAME);
  });

  test("names MUSAI_PRINCIPAL's pseudonym, via model, when the environment sets it", async () => {
    vi.stubEnv("MUSAI_PRINCIPAL", "pinned-reviewer");
    const output = (await plainCall()).structuredContent as unknown as {
      minted: readonly { kind: string; record: { principal?: string; via?: string } }[];
    };
    const attestation = output.minted.find((item) => item.kind === "attestation")!.record;
    expect(attestation.principal).toBe(pseudonymOf("pinned-reviewer"));
    expect(attestation.via).toBe("model");
  });
});
