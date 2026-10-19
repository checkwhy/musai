import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { installedManifests, type OperationContext, openWorkspace } from "@musai/api-core";
import { checkForListChanges } from "@musai/mcp";
import {
  type CaseRecord,
  type ClaimRecord,
  CURRENT_SCHEMA_VERSIONS,
  claimTypesFrom,
  recordId,
  slotFor,
  TRIPLE_CLAIM_TYPE,
  TRIPLE_DECLARATION,
  versionString,
} from "@musai/records";
import { initWorkspace, MUSAI_DIR, Store } from "@musai/store";
import { fixedClock, installEmptyModule } from "@musai/test-support";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const now = fixedClock("2026-01-01T00:00:00.000Z");

function stubServer() {
  return {
    sendToolListChanged: vi.fn().mockResolvedValue(undefined),
    sendResourceListChanged: vi.fn().mockResolvedValue(undefined),
    sendPromptListChanged: vi.fn().mockResolvedValue(undefined),
  };
}

/** A case and its one base triple claim in one batch: no module record among them. */
async function bookCaseOverAClaim(workspace: string, scope: string, slug: string): Promise<void> {
  const store = new Store({
    ctx: { gitDir: join(workspace, MUSAI_DIR) },
    scope,
    now,
    claimTypes: claimTypesFrom([TRIPLE_DECLARATION]),
  });
  const conditions = { subject: "https://example.com/issue/1", predicate: "concerns", object: slug };
  const claim: ClaimRecord = {
    kind: "claim",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: TRIPLE_CLAIM_TYPE,
    about: [conditions.subject],
    slot: slotFor(TRIPLE_DECLARATION, conditions),
    conditions,
    canonical: conditions,
    rendering: `${conditions.subject} concerns ${slug}`,
    evidence: [],
    exclusiveGroup: null,
  };
  const caseRecord: CaseRecord = {
    kind: "case",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.case,
    type: null,
    slug,
    claims: [recordId(claim)],
    preset: {
      module: "musai.core",
      contribution: "musai.core/bare",
      moduleRecord: recordId({ marker: "list-changed-test" }),
    },
    projectCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    overrides: {},
    evaluatorVersion: versionString("1"),
  };
  await store.putMany([
    { kind: "claim", value: claim },
    { kind: "case", value: caseRecord },
  ]);
}

describe("checkForListChanges", () => {
  let workspace: string;
  const scope = "default";
  let context: OperationContext;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-mcp-list-changed-"));
    await initWorkspace(workspace, { now });
    context = { workspace, scope, now };
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("with no modules installed and nothing changing, no notification is sent", async () => {
    const server = stubServer();
    const cursor = await checkForListChanges(server as unknown as Server, context, undefined, true);
    expect(server.sendToolListChanged).not.toHaveBeenCalled();
    expect(server.sendResourceListChanged).not.toHaveBeenCalled();
    expect(server.sendPromptListChanged).not.toHaveBeenCalled();

    const second = await checkForListChanges(server as unknown as Server, context, cursor, true);
    expect(second).toBe(cursor);
    expect(server.sendToolListChanged).not.toHaveBeenCalled();
  });

  test("an install fires every list-changed notification, and the manifests read afterwards include it", async () => {
    const server = stubServer();
    const before = await checkForListChanges(server as unknown as Server, context, undefined, true);

    await installEmptyModule(workspace, scope, "list-changed-fixture", now);

    const after = await checkForListChanges(server as unknown as Server, context, before, true);
    expect(server.sendToolListChanged).toHaveBeenCalledTimes(1);
    expect(server.sendResourceListChanged).toHaveBeenCalledTimes(1);
    expect(server.sendPromptListChanged).toHaveBeenCalledTimes(1);
    expect(after).not.toBe(before);

    const opened = await openWorkspace({ workspace, scope, now });
    const manifests = await installedManifests(opened);
    expect(manifests.some((named) => named.moduleName === "list-changed-fixture")).toBe(true);
  });

  test("checking again at the same, now-current cursor sends no further notification", async () => {
    const server = stubServer();
    const before = await checkForListChanges(server as unknown as Server, context, undefined, true);
    await installEmptyModule(workspace, scope, "list-changed-fixture-2", now);
    const after = await checkForListChanges(server as unknown as Server, context, before, true);
    expect(server.sendToolListChanged).toHaveBeenCalledTimes(1);

    const again = await checkForListChanges(server as unknown as Server, context, after, true);
    expect(again).toBe(after);
    expect(server.sendToolListChanged).toHaveBeenCalledTimes(1);
  });

  test("a claim put and a case booked fire no list-changed notification, since neither changes an installed manifest", async () => {
    const before = await checkForListChanges(stubServer() as unknown as Server, context, undefined, true);

    await bookCaseOverAClaim(workspace, scope, "no-manifest-changes");

    const server = stubServer();
    const after = await checkForListChanges(server as unknown as Server, context, before, true);
    expect(after).not.toBe(before);
    expect(server.sendToolListChanged).toHaveBeenCalledTimes(0);
    expect(server.sendResourceListChanged).toHaveBeenCalledTimes(0);
    expect(server.sendPromptListChanged).toHaveBeenCalledTimes(0);
  });
});
