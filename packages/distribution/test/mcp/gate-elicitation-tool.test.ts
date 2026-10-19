import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CaseRecord,
  type ClaimRecord,
  type ClaimTypeDeclaration,
  CURRENT_SCHEMA_VERSIONS,
  claimTypesFrom,
  EVALUATOR_VERSION,
  pseudonymFor,
  type RecordId,
  recordId,
  slotFor,
  timestamp,
  versionString,
} from "@musai/records";
import { type GitContext, initWorkspace, LOCAL_DIR, MUSAI_DIR, Store, workspaceKey } from "@musai/store";
import { declareClaimTypes, fixedClock, fixtureBrief, writeTrustFile } from "@musai/test-support";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { briefRecipe, REGISTRY } from "../../src/index.js";
import { answerGateThroughElicitation } from "../../src/mcp/gate-tool.js";

const CLAIM_TYPE = "musai.gate-elicitation-tool-test/claim@1";
const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: CLAIM_TYPE, identityDimensions: ["id"] };
const CLAIM_TYPES = claimTypesFrom([CLAIM_DECLARATION]);
const FIXED_INSTANT = timestamp("2026-01-01T00:00:00.000Z");
const now = fixedClock(FIXED_INSTANT);

interface Fixture {
  readonly workspace: string;
  readonly scope: string;
  readonly claimId: RecordId;
  readonly briefId: RecordId;
  cleanup(): Promise<void>;
}

async function makeFixture(): Promise<Fixture> {
  const workspace = await mkdtemp(join(tmpdir(), "musai-gate-elicitation-tool-"));
  await initWorkspace(workspace, { now });
  const scope = "default";
  const ctx: GitContext = { gitDir: join(workspace, ".musai") };
  const store = new Store({ ctx, scope, now, claimTypes: CLAIM_TYPES });
  await declareClaimTypes(store, [CLAIM_DECLARATION]);

  const conditions = { id: "elicitation-tool-claim" };
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
    slug: "elicitation-tool-case",
    claims: [claimId!],
    preset: {
      module: "musai.core",
      contribution: "musai.core/bare",
      moduleRecord: recordId({ marker: "elicitation-tool" }),
    },
    projectCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    overrides: {},
    evaluatorVersion: versionString("1"),
  };
  const [caseId] = await store.putMany([{ kind: "case", value: caseRecord }]);

  const head = (await store.tip())!;
  const recipe = briefRecipe(claimId!, { head, caseId: caseId!, budget: 20000, kernelVersion: EVALUATOR_VERSION });
  const brief = fixtureBrief("fixed", { recipe, reads: [caseId!, claimId!] });
  const [briefId] = await store.putMany([{ kind: "run", value: brief }]);

  return {
    workspace,
    scope,
    claimId: claimId!,
    briefId: briefId!,
    async cleanup() {
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

describe("answerGateThroughElicitation", () => {
  beforeEach(() => {
    vi.stubEnv("MUSAI_PRINCIPAL", "florin");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("an accepted elicitation mints a ruling via the elicitation channel, never letting the model assert the choice directly", async () => {
    const fixture = await makeFixture();
    try {
      const server = { elicitInput: vi.fn().mockResolvedValue({ action: "accept", content: { answer: "holds" } }) };
      const result = await answerGateThroughElicitation(
        REGISTRY,
        server,
        { workspace: fixture.workspace, scope: fixture.scope, now },
        { pending: fixture.claimId, brief: fixture.briefId },
      );
      const output = result.structuredContent as {
        minted: readonly { kind: string; record: { via?: string; principalClass?: string } }[];
      };
      expect(output.minted).toHaveLength(2);
      const attestation = output.minted.find((item) => item.kind === "attestation")!.record;
      expect(attestation.via).toBe("elicitation");
      expect(attestation.principalClass).toBe("person");
    } finally {
      await fixture.cleanup();
    }
  });

  test("a declined elicitation mints nothing and reports the gate is still open", async () => {
    const fixture = await makeFixture();
    try {
      const server = { elicitInput: vi.fn().mockResolvedValue({ action: "decline" }) };
      const result = await answerGateThroughElicitation(
        REGISTRY,
        server,
        { workspace: fixture.workspace, scope: fixture.scope, now },
        { pending: fixture.claimId, brief: fixture.briefId },
      );
      const output = result.structuredContent as { answered: boolean; action: string };
      expect(output.answered).toBe(false);
      expect(output.action).toBe("decline");

      const store = new Store({
        ctx: { gitDir: join(fixture.workspace, ".musai") },
        scope: fixture.scope,
        now,
        claimTypes: CLAIM_TYPES,
      });
      expect(await store.list("ruling")).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test("an expired elicitation mints nothing and is reported distinctly from a decline", async () => {
    const fixture = await makeFixture();
    try {
      const { McpError, ErrorCode } = await import("@modelcontextprotocol/sdk/types.js");
      const server = {
        elicitInput: vi.fn().mockRejectedValue(new McpError(ErrorCode.RequestTimeout, "Request timed out")),
      };
      const result = await answerGateThroughElicitation(
        REGISTRY,
        server,
        { workspace: fixture.workspace, scope: fixture.scope, now },
        { pending: fixture.claimId, brief: fixture.briefId },
      );
      const output = result.structuredContent as { answered: boolean; action: string };
      expect(output.answered).toBe(false);
      expect(output.action).toBe("expired");

      const store = new Store({
        ctx: { gitDir: join(fixture.workspace, ".musai") },
        scope: fixture.scope,
        now,
        claimTypes: CLAIM_TYPES,
      });
      expect(await store.list("ruling")).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test("a name only the workspace's configuration declares secret refuses a form field of that name before anything is elicited", async () => {
    const fixture = await makeFixture();
    try {
      await writeTrustFile(
        { gitDir: join(fixture.workspace, ".musai") },
        "config.json",
        JSON.stringify({ declaredNames: { answer: { secret: true } } }),
      );
      const server = { elicitInput: vi.fn().mockResolvedValue({ action: "accept", content: { answer: "holds" } }) };

      await expect(
        answerGateThroughElicitation(
          REGISTRY,
          server,
          { workspace: fixture.workspace, scope: fixture.scope, now },
          { pending: fixture.claimId, brief: fixture.briefId },
        ),
      ).rejects.toThrow(/secret/);
      expect(server.elicitInput).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  test("an elicited answer attests under the name the server was launched for, as its pseudonym", async () => {
    const fixture = await makeFixture();
    try {
      const server = { elicitInput: vi.fn().mockResolvedValue({ action: "accept", content: { answer: "holds" } }) };
      const result = await answerGateThroughElicitation(
        REGISTRY,
        server,
        { workspace: fixture.workspace, scope: fixture.scope, now },
        { pending: fixture.claimId, brief: fixture.briefId },
      );
      const output = result.structuredContent as {
        minted: readonly { kind: string; record: { principal?: string } }[];
      };
      const attestation = output.minted.find((item) => item.kind === "attestation")!.record;
      const localDir = join(fixture.workspace, MUSAI_DIR, LOCAL_DIR);
      expect(attestation.principal).toBe(pseudonymFor(await workspaceKey(localDir, { now }), "florin"));
    } finally {
      await fixture.cleanup();
    }
  });
});
