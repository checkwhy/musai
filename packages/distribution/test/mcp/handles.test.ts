import { mkdtemp, readdir, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type OperationContext, openWorkspace, runHandler } from "@musai/api-core";
import { createMcpServer } from "@musai/mcp";
import type { Audience } from "@musai/records";
import { initWorkspace, writeMainFiles } from "@musai/store";
import { fixedClock, fixtureBrief, writeTrustFile } from "@musai/test-support";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MUSAI_MCP } from "../../src/mcp/extension.js";
import { claimStatus } from "../../src/ops/claim.js";
import { scopeDrop, scopeFork } from "../../src/ops/scope.js";

const now = fixedClock("2026-10-13T00:00:00.000Z");

/** Linux lists a process's open files, which is how a held index shows. */
async function filesHeldUnder(dir: string): Promise<string[]> {
  const held = await Promise.all(
    (await readdir("/proc/self/fd")).map((fd) => readlink(join("/proc/self/fd", fd)).catch(() => "")),
  );
  return held.filter((target) => target.startsWith(dir));
}

describe("a cleared tool call leaves no index open behind it", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-mcp-handles-"));
    await initWorkspace(workspace, { now });
    await writeTrustFile({ gitDir: join(workspace, ".musai") }, "audiences", "writer\n");
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  async function callCleared(context: OperationContext, serving: () => Promise<void>): Promise<void> {
    const server = createMcpServer(MUSAI_MCP, context, { lab: true });
    const client = new Client({ name: "handles-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await client.listTools();
      await client.callTool({ name: "claim_status", arguments: { claim: "no-such-claim" } });
      await client.listPrompts();
      await serving();
    } finally {
      await client.close();
      await server.close();
    }
  }

  test.skipIf(process.platform !== "linux")(
    "holds no file of the scope's folds open while the server runs",
    async () => {
      const context = { workspace, scope: "default", now, clearance: "writer" as Audience };

      await callCleared(context, async () => {
        expect(await filesHeldUnder(workspace)).toEqual([]);
      });
    },
  );

  test.skipIf(process.platform !== "linux")("holds no file of the scope's folds open after an operation", async () => {
    const context = { workspace, scope: "default", now, clearance: "writer" as Audience };

    await runHandler(claimStatus, { claim: "no-such-claim" }, context).catch(() => undefined);

    expect(await filesHeldUnder(workspace)).toEqual([]);
  });

  test.skipIf(process.platform !== "linux")(
    "holds no file open after an open refused for a malformed floor",
    async () => {
      const config = `${JSON.stringify({ floor: { verdict: "hold" } })}\n`;
      await writeMainFiles({ gitDir: join(workspace, ".musai") }, { "config.json": config }, now);

      const refusal = await runHandler(
        claimStatus,
        { claim: "no-such-claim" },
        { workspace, scope: "default", now },
      ).catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(Error);
      expect(await filesHeldUnder(workspace)).toEqual([]);
    },
  );

  test.skipIf(process.platform !== "linux")(
    "holds no file open after a clearance the audiences do not declare",
    async () => {
      await writeTrustFile({ gitDir: join(workspace, ".musai") }, "audiences", "someone-else\n");
      const context = { workspace, scope: "default", now, clearance: "writer" as Audience };

      const refusal = await runHandler(claimStatus, { claim: "no-such-claim" }, context).catch(
        (error: unknown) => error,
      );

      expect(refusal).toMatchObject({ reason: "invalid-input", about: ["writer"] });
      expect(await filesHeldUnder(workspace)).toEqual([]);
    },
  );

  test("lets a scope the server read as cleared be dropped afterwards", async () => {
    const author = { workspace, scope: "default", now };
    const seeded = await openWorkspace(author);
    await seeded.put([{ kind: "run", value: fixtureBrief("a record to fork") }]);
    seeded.close();
    const forked = await runHandler(scopeFork, { name: "side" }, author);

    await callCleared({ ...author, scope: "side", clearance: "writer" as Audience }, async () => {
      await runHandler(scopeDrop, { name: forked.scope, tip: forked.tip }, author);
    });
  });
});
