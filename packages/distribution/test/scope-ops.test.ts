import { fileURLToPath } from "node:url";
import { runHandler } from "@musai/api-core";
import { callTool } from "@musai/mcp";
import { type ClaimRecord, type ClaimTypeDeclaration, CURRENT_SCHEMA_VERSIONS, slotFor } from "@musai/records";
import { Store } from "@musai/store";
import { type FixtureRepo, makeFixtureRepo, SCENARIO_INSTANT } from "@musai/test-support";
import { execa } from "execa";
import { afterEach, describe, expect, test } from "vitest";
import { MUSAI } from "../src/musai.js";
import { scopeDrop, scopeFork, scopeList, scopeMerge } from "../src/ops/scope.js";

const CLI_PATH = fileURLToPath(new URL("../dist/bin/cli.js", import.meta.url));
const CLAIM_TYPE = "musai.scope-ops-test/claim@1";
const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: CLAIM_TYPE, identityDimensions: ["id"] };

const repos: FixtureRepo[] = [];

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()));
});

function claimAt(id: string): ClaimRecord {
  const conditions = { id };
  return {
    kind: "claim",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: CLAIM_TYPE,
    about: [],
    slot: slotFor(CLAIM_DECLARATION, conditions),
    conditions,
    canonical: { statement: `${id} holds` },
    rendering: `${id} holds.`,
    evidence: [],
    exclusiveGroup: null,
  };
}

async function canon(): Promise<FixtureRepo> {
  const repo = await makeFixtureRepo("canon", [CLAIM_DECLARATION]);
  repos.push(repo);
  const store = new Store({ ctx: repo.ctx, scope: "canon", now: repo.now, claimTypes: repo.claimTypes });
  await store.put("claim", claimAt("base"));
  return repo;
}

function storeIn(repo: FixtureRepo, scope: string): Store {
  return new Store({ ctx: repo.ctx, scope, now: repo.now, claimTypes: repo.claimTypes });
}

describe("the lab scope verbs", () => {
  test("drop is declared irreversible and needs the tip it expects, refusing a moved one", async () => {
    const repo = await canon();
    const context = { workspace: repo.workspace, scope: "canon", now: repo.now };
    const { tip } = await runHandler(scopeFork, { name: "fork" }, context);
    await storeIn(repo, "fork").put("claim", claimAt("moved on"));

    expect(scopeDrop.effect).toBe("irreversible");
    expect((scopeDrop.input as { required: string[] }).required).toContain("tip");
    await expect(runHandler(scopeDrop, { name: "fork", tip }, context)).rejects.toMatchObject({
      reason: "head-moved",
    });
  });

  test("merge in plan mode lists what would land and writes nothing", async () => {
    const repo = await canon();
    const context = { workspace: repo.workspace, scope: "canon", now: repo.now };
    await runHandler(scopeFork, { name: "fork" }, context);
    const [forked] = await storeIn(repo, "fork").putMany([{ kind: "claim", value: claimAt("forked") }]);
    const before = await storeIn(repo, "canon").tip();

    const preview = await runHandler(scopeMerge, { from: "fork" }, { ...context, mode: "plan" });

    expect(preview).toEqual({ commit: null, merged: [forked] });
    expect(await storeIn(repo, "canon").tip()).toBe(before);
  });

  test("fork and drop in plan mode answer as performing would and write nothing", async () => {
    const repo = await canon();
    const context = { workspace: repo.workspace, scope: "canon", now: repo.now };
    const planned = await runHandler(scopeFork, { name: "fork" }, { ...context, mode: "plan" });
    expect((await runHandler(scopeList, {}, context)).scopes.map((at) => at.scope)).toEqual(["canon"]);

    const forked = await runHandler(scopeFork, { name: "fork" }, context);
    await runHandler(scopeDrop, { name: forked.scope, tip: forked.tip }, { ...context, mode: "plan" });

    expect(planned).toEqual(forked);
    expect((await runHandler(scopeList, {}, context)).scopes.map((at) => at.scope)).toEqual(["canon", "fork"]);
    await expect(
      runHandler(scopeDrop, { name: "fork", tip: "0".repeat(40) }, { ...context, mode: "plan" }),
    ).rejects.toMatchObject({ reason: "head-moved" });
  });

  test("each verb answers the same over the CLI and over MCP", async () => {
    const [overCli, overMcp] = [await canon(), await canon()];
    const cli = async (args: readonly string[]) =>
      (
        await execa(
          "node",
          [CLI_PATH, "lab", "scope", ...args, "--workspace", overCli.workspace, "--scope", "canon", "--json"],
          { env: { MUSAI_NOW: SCENARIO_INSTANT } },
        )
      ).stdout;
    const mcp = async (tool: string, input: Record<string, unknown>) => {
      const result = await callTool(
        MUSAI,
        { workspace: overMcp.workspace, scope: "canon", now: overMcp.now },
        tool,
        input,
      );
      return result.content[0]!.type === "text" ? result.content[0]!.text : "";
    };

    expect(await cli(["fork", "fork"])).toBe(await mcp("scope_fork", { name: "fork" }));
    await storeIn(overCli, "fork").put("claim", claimAt("forked"));
    await storeIn(overMcp, "fork").put("claim", claimAt("forked"));
    expect(await cli(["list"])).toBe(await mcp("scope_list", {}));
    expect(await cli(["merge", "fork"])).toBe(await mcp("scope_merge", { from: "fork" }));
    const tip = (await storeIn(overCli, "fork").tip())!;
    expect(await cli(["drop", "fork", "--tip", tip])).toBe(await mcp("scope_drop", { name: "fork", tip }));
    expect(await runHandler(scopeList, {}, { workspace: overMcp.workspace, scope: "canon", now: overMcp.now })).toEqual(
      { scopes: [{ scope: "canon", tip: await storeIn(overMcp, "canon").tip() }] },
    );
  });
});
