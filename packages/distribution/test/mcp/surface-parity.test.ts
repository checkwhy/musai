import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { callTool } from "@musai/mcp";
import {
  type ClaimRecord,
  type ClaimTypeDeclaration,
  CURRENT_SCHEMA_VERSIONS,
  claimTypesFrom,
  type EvidenceEdge,
  type RecordId,
  type RunRecord,
  recordId,
  slotFor,
  timestamp,
  versionString,
} from "@musai/records";
import { RUNNER_PERFORMER } from "@musai/run";
import { type GitContext, initWorkspace, MUSAI_DIR, type PutItem, Store } from "@musai/store";
import { declareClaimTypes, fixedClock } from "@musai/test-support";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MUSAI } from "../../src/musai.js";

const CLI_PATH = fileURLToPath(new URL("../../dist/bin/cli.js", import.meta.url));
const SERVER_PATH = fileURLToPath(new URL("../../dist/bin/mcp.js", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const CORE_MODULE = join(REPO_ROOT, "packages", "core-module");
const CASEBOOK = fileURLToPath(new URL("../../../scenarios/casebook/modules/casebook", import.meta.url));
const CLAIM_TYPE = "musai.surface-parity-test/claim@1";
const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: CLAIM_TYPE, identityDimensions: ["id"] };
const CLAIM_TYPES = claimTypesFrom([CLAIM_DECLARATION]);
const FIXED_INSTANT = timestamp("2026-01-01T00:00:00.000Z");
const now = fixedClock(FIXED_INSTANT);
const SCOPE = "default";

interface FixtureWorkspace {
  readonly workspace: string;
  readonly scope: string;
  cleanup(): Promise<void>;
}

async function makeFixtureWorkspace(): Promise<FixtureWorkspace> {
  const workspace = await mkdtemp(join(tmpdir(), "musai-surface-parity-"));
  await initWorkspace(workspace, { now });
  return {
    workspace,
    scope: "default",
    async cleanup() {
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

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

describe("claim.status@3 answers a terminal and an MCP tool call with the same bytes", () => {
  let fixture: FixtureWorkspace;
  let slot: string;

  beforeAll(async () => {
    fixture = await makeFixtureWorkspace();
    const ctx: GitContext = { gitDir: join(fixture.workspace, ".musai") };
    const store = new Store({ ctx, scope: fixture.scope, now, claimTypes: CLAIM_TYPES });
    await declareClaimTypes(store, [CLAIM_DECLARATION]);

    const run = receiptRun("the receipt this fixture's claim rests on");
    const items: PutItem[] = [{ kind: "run", value: run }];
    const [runId] = await store.putMany(items);

    slot = slotFor(CLAIM_DECLARATION, { id: "surface-parity-claim" });
    const claim: ClaimRecord = {
      kind: "claim",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
      type: CLAIM_TYPE,
      about: [],
      slot,
      conditions: { id: "surface-parity-claim" },
      canonical: { statement: "surface-parity-claim" },
      rendering: "surface-parity-claim",
      evidence: [receiptEdge(runId!, "result")],
      exclusiveGroup: null,
    };
    await store.putMany([{ kind: "claim", value: claim }]);
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  test("the CLI's --json stdout and the MCP tool call's canonical text are byte-equal", async () => {
    const { stdout } = await execa("node", [
      CLI_PATH,
      "status",
      slot,
      "--workspace",
      fixture.workspace,
      "--scope",
      fixture.scope,
      "--json",
    ]);

    const result = await callTool(MUSAI, { workspace: fixture.workspace, scope: fixture.scope, now }, "claim_status", {
      claim: slot,
    });
    const mcpText = result.content[0]!.type === "text" ? result.content[0]!.text : "";

    expect(stdout).toBe(mcpText);
    expect(stdout).toContain("holds");
  });

  test("two CLI invocations at the same head produce byte-identical stdout", async () => {
    const first = await execa("node", [
      CLI_PATH,
      "status",
      slot,
      "--workspace",
      fixture.workspace,
      "--scope",
      fixture.scope,
      "--json",
    ]);
    const second = await execa("node", [
      CLI_PATH,
      "status",
      slot,
      "--workspace",
      fixture.workspace,
      "--scope",
      fixture.scope,
      "--json",
    ]);

    expect(first.stdout).toBe(second.stdout);
  });
});

describe("a case booked and soundchecked through the CLI and through the MCP server under one instant", () => {
  const SLUG = "surface-parity-clock-case";

  async function musai(args: readonly string[]): Promise<void> {
    await execa("node", [CLI_PATH, ...args], { env: { ...process.env, MUSAI_NOW: FIXED_INSTANT } });
  }

  async function freshWorkspace(): Promise<string> {
    const workspace = await mkdtemp(join(tmpdir(), "musai-surface-parity-clock-"));
    await musai(["init", workspace]);
    for (const module of [CORE_MODULE, CASEBOOK]) {
      await musai([
        "lab",
        "module",
        "build",
        module,
        "--source-git-dir",
        join(REPO_ROOT, ".git"),
        "--workspace",
        workspace,
      ]);
    }
    return workspace;
  }

  function storeAt(workspace: string): Store {
    return new Store({ ctx: { gitDir: join(workspace, MUSAI_DIR) }, scope: SCOPE, now });
  }

  /** The scope head from git: a case id alone rests on the trust commit `init` dated. */
  async function scopeHead(workspace: string): Promise<{ head: string; committedAt: string }> {
    const { stdout } = await execa("git", [
      "--git-dir",
      join(workspace, MUSAI_DIR),
      "log",
      "-1",
      "--format=%H %cI",
      `refs/heads/scope/${SCOPE}`,
    ]);
    const [head, committedAt] = stdout.trim().split(" ");
    return { head: head!, committedAt: committedAt! };
  }

  async function bookAndSoundcheckThroughCli(
    workspace: string,
  ): Promise<{ head: string; committedAt: string; receipts: readonly RecordId[] }> {
    await musai(["lab", "book", SLUG, "--kind", "fixture-casebook/report", "--workspace", workspace]);
    const { head, committedAt } = await scopeHead(workspace);
    const store = storeAt(workspace);
    const before = new Set(await store.list("run"));
    await musai(["lab", "soundcheck", SLUG, "--workspace", workspace]);
    const receipts = (await store.list("run")).filter((id) => !before.has(id)).sort();
    return { head, committedAt, receipts };
  }

  async function bookAndSoundcheckThroughMcp(
    workspace: string,
  ): Promise<{ head: string; committedAt: string; receipts: readonly RecordId[] }> {
    const client = new Client({ name: "musai-surface-parity-clock-test", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: "node",
        args: [SERVER_PATH, "--workspace", workspace, "--scope", SCOPE],
        env: { ...getDefaultEnvironment(), MUSAI_NOW: FIXED_INSTANT },
      }),
    );
    try {
      await client.callTool({ name: "case_book", arguments: { slug: SLUG, kind: "fixture-casebook/report" } });
      const { head, committedAt } = await scopeHead(workspace);
      const store = storeAt(workspace);
      const before = new Set(await store.list("run"));
      await client.callTool({ name: "case_soundcheck", arguments: { case: SLUG } });
      const receipts = (await store.list("run")).filter((id) => !before.has(id)).sort();
      return { head, committedAt, receipts };
    } finally {
      await client.close();
    }
  }

  test("the two surfaces book and soundcheck one case to the same scope head and the same receipts", async () => {
    const cliWorkspace = await freshWorkspace();
    const mcpWorkspace = await freshWorkspace();
    try {
      const fromCli = await bookAndSoundcheckThroughCli(cliWorkspace);
      const fromMcp = await bookAndSoundcheckThroughMcp(mcpWorkspace);

      // Git dates commits to the second, so only the date shows the pinned instant was used.
      expect(new Date(fromCli.committedAt).toISOString()).toBe(FIXED_INSTANT);
      expect(fromCli.committedAt).toBe(fromMcp.committedAt);
      expect(fromCli.head).toBe(fromMcp.head);

      expect(fromCli.receipts.length).toBeGreaterThan(0);
      expect(fromCli.receipts).toEqual(fromMcp.receipts);
    } finally {
      await rm(cliWorkspace, { recursive: true, force: true });
      await rm(mcpWorkspace, { recursive: true, force: true });
    }
  }, 120_000);
});
