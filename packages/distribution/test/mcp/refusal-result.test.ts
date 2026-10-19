import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type OperationContext, type OperationDescriptor, openWorkspace, runHandler } from "@musai/api-core";
import { buildModule } from "@musai/devkit";
import { createMcpServer } from "@musai/mcp";
import {
  CURRENT_SCHEMA_VERSIONS,
  codeForReason,
  PACK_IRREVERSIBLE_SLOT_ID,
  type RecordId,
  slotFor,
  TRIPLE_DECLARATION,
} from "@musai/records";
import { initWorkspace } from "@musai/store";
import { blobStoreOf, fixedClock, fixtureBrief, writeTrustFile } from "@musai/test-support";
import { execa } from "execa";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { REGISTRY } from "../../src/index.js";
import { MUSAI_MCP } from "../../src/mcp/extension.js";

const STAMPER_FIXTURE_DIR = fileURLToPath(new URL("./fixtures/stamper", import.meta.url));
const CORE_MODULE_DIR = fileURLToPath(new URL("../../../core-module", import.meta.url));
const now = fixedClock("2026-09-22T00:00:00.000Z");
const scope = "default";

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

/** A plan drafting one claim and asserting it, as a pack's writing operation answers. */
function assertedClaimPlan(subject: string): Record<string, unknown> {
  return {
    put: [{ kind: "claim", value: claimDraft(subject) }],
    attest: [{ subject: { put: 0 }, purpose: "asserted" }],
    needs: [],
  };
}

interface Refusal {
  readonly reason: string;
  readonly about: readonly string[];
  readonly detail: string;
}

/** The refusal a result carries, read as a client reads it: its one text item. */
function refusalOf(result: CallToolResult): Refusal {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  expect(result.content).toHaveLength(1);
  const [item] = result.content;
  if (item?.type !== "text") {
    throw new Error(`a refusal answered with a ${item?.type} item rather than text`);
  }
  const parsed = JSON.parse(item.text) as Refusal;
  expect(Object.keys(parsed).sort()).toEqual(["about", "detail", "reason"]);
  expect(typeof parsed.detail).toBe("string");
  return parsed;
}

describe("a refused tool call answers as a tool result carrying its reason, about and detail", () => {
  let workspace: string;
  let context: OperationContext;

  beforeEach(() => {
    vi.stubEnv("MUSAI_PRINCIPAL", "a-client");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-mcp-refusal-result-"));
    await initWorkspace(workspace, { now });
    context = { workspace, scope, now };
    const { stdout } = await execa("git", ["rev-parse", "--absolute-git-dir"], { cwd: STAMPER_FIXTURE_DIR });
    const opened = await openWorkspace({ workspace, scope, now });
    for (const dir of [CORE_MODULE_DIR, STAMPER_FIXTURE_DIR]) {
      await buildModule(dir, opened.store, {
        blobs: blobStoreOf(workspace),
        index: opened.index,
        sourceGitDir: stdout.trim(),
        now,
      });
    }
  }, 60_000);

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  async function tip(): Promise<string | null> {
    return (await openWorkspace({ workspace, scope, now })).store.tip();
  }

  /** Calls one tool from a real client connected to a fresh server over this workspace. */
  async function callOverTheWire(
    name: string,
    args: Record<string, unknown>,
    registry: ReadonlyMap<string, OperationDescriptor> = REGISTRY,
  ): Promise<CallToolResult> {
    const server = createMcpServer({ ...MUSAI_MCP, registry }, context, { lab: true });
    const client = new Client({ name: "refusal-result-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      return (await client.callTool({ name, arguments: args })) as CallToolResult;
    } finally {
      await client.close();
      await server.close();
    }
  }

  async function aClaimAndABrief(subject: string): Promise<{ readonly claim: RecordId; readonly brief: RecordId }> {
    const opened = await openWorkspace({ workspace, scope, now });
    const [claim, brief] = await opened.put([
      { kind: "claim", value: claimDraft(subject) },
      { kind: "run", value: fixtureBrief("the brief a fixture ruling cites") },
    ]);
    return { claim: claim!, brief: brief! };
  }

  describe("invocation", () => {
    test("input the operation's schema refuses answers invalid-input, naming the operation", async () => {
      const refusal = refusalOf(await callOverTheWire("ruling_make", { verdict: "maybe" }));

      expect(refusal.reason).toBe("invalid-input");
      expect(codeForReason("invalid-input")).toBe("invocation");
      expect(refusal.about).toEqual(["ruling.make@2"]);
    });

    test("a tool name nothing projects answers unknown-operation, naming the name", async () => {
      const refusal = refusalOf(await callOverTheWire("no_such_tool", {}));

      expect(refusal.reason).toBe("unknown-operation");
      expect(codeForReason("unknown-operation")).toBe("invocation");
      expect(refusal.about).toEqual(["no_such_tool"]);
    });
  });

  describe("authority", () => {
    test("a pack's operation declaring an irreversible effect the project has not granted answers not-authorised, and nothing is written", async () => {
      const before = await tip();

      const refusal = refusalOf(
        await callOverTheWire("stamper_answers-irreversibly", { answer: assertedClaimPlan("irreversible") }),
      );

      expect(refusal.reason).toBe("not-authorised");
      expect(codeForReason("not-authorised")).toBe("authority");
      expect(refusal.about).toEqual(["stamper/answers-irreversibly@1", PACK_IRREVERSIBLE_SLOT_ID]);
      expect(await tip()).toBe(before);
    });

    test("a model channel retiring a person's ruling answers not-authorised, naming the ruling, and the scope's tip does not move", async () => {
      const { claim, brief } = await aClaimAndABrief("ruled-by-a-person");
      const person = (await runHandler(
        REGISTRY.get("ruling.make@2")!,
        { claim, verdict: "holds", reason: "ruled through the terminal", brief },
        { workspace, scope, now, via: "tty", principalName: "a-person", mode: "perform" },
      )) as { minted: readonly { kind: string; id: string }[] };
      const personRuling = person.minted.find((item) => item.kind === "ruling")!.id;
      const before = await tip();

      const refusal = refusalOf(
        await callOverTheWire("ruling_make", {
          claim,
          verdict: "fails",
          reason: "a model attempting to retire a person's ruling",
          brief,
          supersedes: [personRuling],
        }),
      );

      expect(refusal.reason).toBe("not-authorised");
      expect(codeForReason("not-authorised")).toBe("authority");
      expect(refusal.about).toContain(personRuling);
      expect(await tip()).toBe(before);
    });
  });

  test("refold: an expected head that moved answers head-moved, and nothing is written", async () => {
    const stale = await tip();
    expectNoRefusal(await callOverTheWire("stamper_answers", { answer: assertedClaimPlan("moving") }));
    const moved = await tip();

    const refusal = refusalOf(
      await callOverTheWire("stamper_answers", { answer: assertedClaimPlan("stale"), expectHead: stale }),
    );

    expect(refusal.reason).toBe("head-moved");
    expect(codeForReason("head-moved")).toBe("refold");
    expect(await tip()).toBe(moved);
  });

  test("workspace: a signer file that is not JSON answers workspace-incomplete when an attestation looks for its key, and nothing is written", async () => {
    const { claim, brief } = await aClaimAndABrief("signed-with-a-broken-signer-file");
    const signerFile = join(workspace, ".musai", "local", "signer.json");
    await writeFile(signerFile, "not json");
    await chmod(signerFile, 0o600);
    try {
      const before = await tip();

      const refusal = refusalOf(
        await callOverTheWire("ruling_make", { claim, verdict: "holds", reason: "a ruling to sign", brief }),
      );

      expect(refusal.reason).toBe("workspace-incomplete");
      expect(codeForReason("workspace-incomplete")).toBe("workspace");
      expect(refusal.detail).toContain("signer.json");
      expect(await tip()).toBe(before);
    } finally {
      await rm(signerFile, { force: true });
    }
  });

  test("requirement: a run need naming a binary no installed module declares answers undeclared-binary, and nothing is written", async () => {
    const undeclared = "definitely-not-a-real-binary-musai-test";
    const trust = { gitDir: join(workspace, ".musai") };
    const { stdout: configured } = await execa("git", ["--git-dir", trust.gitDir, "show", "main:config.json"]);
    await writeTrustFile(trust, "config.json", JSON.stringify({ slots: { [PACK_IRREVERSIBLE_SLOT_ID]: true } }));
    try {
      const before = await tip();

      const refusal = refusalOf(
        await callOverTheWire("stamper_answers-irreversibly", {
          answer: {
            ...assertedClaimPlan("needs-an-undeclared-binary"),
            needs: [
              {
                kind: "run",
                recipe: {
                  command: [undeclared],
                  workingDirectory: "/",
                  environment: {},
                  declared: [],
                  substrates: [],
                  isolation: "hygiene",
                },
              },
            ],
          },
        }),
      );

      expect(refusal.reason).toBe("undeclared-binary");
      expect(codeForReason("undeclared-binary")).toBe("requirement");
      expect(refusal.detail).toContain(undeclared);
      expect(await tip()).toBe(before);
    } finally {
      await writeTrustFile(trust, "config.json", configured);
    }
  });

  test("bug: a pack's operation declaring a read whose plan writes answers invalid-output, naming it", async () => {
    const refusal = refusalOf(
      await callOverTheWire("stamper_answers-as-read", { answer: assertedClaimPlan("read-that-writes") }),
    );

    expect(refusal.reason).toBe("invalid-output");
    expect(codeForReason("invalid-output")).toBe("bug");
    expect(refusal.about).toEqual(["stamper/answers-as-read@1"]);
  });

  test("a kernel refusal on the elicitation-shaped gate_answer answers as a tool result, naming the record, and nothing is elicited or written", async () => {
    const absent = `sha256:${"0".repeat(64)}`;
    const before = await tip();

    const refusal = refusalOf(await callOverTheWire("gate_answer", { pending: absent, brief: absent }));

    expect(refusal.reason).toBe("no-such-record");
    expect(refusal.about).toContain(absent);
    expect(await tip()).toBe(before);
  });

  test("a throw no reason names reaches the client as a JSON-RPC error, not a result", async () => {
    const keyList = REGISTRY.get("key.list@1")!;
    const faulty: OperationDescriptor = {
      ...keyList,
      handler: async () => {
        throw new Error("a defect no reason names");
      },
    };
    const registry = new Map(REGISTRY).set("key.list@1", faulty);

    await expect(callOverTheWire("key_list", {}, registry)).rejects.toThrow(/a defect no reason names/);
  });

  test("a refusal of the session's own list-change check is a JSON-RPC error, never the call's result", async () => {
    // History rewritten under a folded index refuses the open the check makes before the call.
    await aClaimAndABrief("a-commit-the-session-read-up-to");
    const gitDir = join(workspace, ".musai");
    const ref = `refs/heads/scope/${scope}`;
    const readUpTo = (await tip())!;
    const server = createMcpServer(MUSAI_MCP, context, { lab: true });
    const client = new Client({ name: "refusal-result-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      expectNoRefusal((await client.callTool({ name: "key_list", arguments: {} })) as CallToolResult);

      await execa("git", ["--git-dir", gitDir, "update-ref", ref, `${readUpTo}^`]);

      const attempt = client.callTool({ name: "key_list", arguments: {} });
      await expect(attempt).rejects.toThrow(/does not descend from the folded commit/);
      await expect(attempt).rejects.toHaveProperty("code", -32603);
    } finally {
      await execa("git", ["--git-dir", gitDir, "update-ref", ref, readUpTo]);
      await client.close();
      await server.close();
    }
  });
});

function expectNoRefusal(result: CallToolResult): void {
  expect(result.isError).not.toBe(true);
}
