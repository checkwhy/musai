import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workspace } from "@musai/api-core";
import { isOperationError, openWorkspace, runHandler } from "@musai/api-core";
import {
  type CaseRecord,
  type ClaimRecord,
  type ClaimTypeDeclaration,
  CURRENT_SCHEMA_VERSIONS,
  claimTypesFrom,
  type RecordId,
  type RulingRecord,
  recordId,
  slotFor,
  versionString,
} from "@musai/records";
import { initWorkspace, Store } from "@musai/store";
import { declareClaimTypes, fixedClock } from "@musai/test-support";
import { afterEach, describe, expect, test } from "vitest";
import { labelledClaim } from "../src/claim.js";
import { askMenu, MenuRefusedError } from "../src/gate/menu.js";
import { gateAnswer, gateAsk, gatePending } from "../src/ops/gate.js";

const CLAIM_TYPE = "musai.gate-fixture-test/claim@1";
const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: CLAIM_TYPE, identityDimensions: ["id"] };
const CLAIM_TYPES = claimTypesFrom([CLAIM_DECLARATION]);
const now = fixedClock("2026-01-01T00:00:00.000Z");

interface ClaimSpec {
  readonly id: string;
  readonly rendering: string;
  readonly exclusiveGroup: string | null;
  readonly disposition?: string;
  readonly gateClass?: string;
}

async function buildWorkspace(slug: string, specs: readonly ClaimSpec[]) {
  const workspace = await mkdtemp(join(tmpdir(), "musai-gate-ask-test-"));
  await initWorkspace(workspace, { now });
  const scope = "default";
  const store = new Store({ ctx: { gitDir: join(workspace, ".musai") }, scope, now, claimTypes: CLAIM_TYPES });
  await declareClaimTypes(store, [CLAIM_DECLARATION]);

  const claimIds: RecordId[] = [];
  const idBySpecId = new Map<string, RecordId>();
  for (const spec of specs) {
    const conditions: Record<string, string> = { id: spec.id };
    if (spec.disposition !== undefined) {
      conditions["disposition"] = spec.disposition;
    }
    if (spec.gateClass !== undefined) {
      conditions["gateClass"] = spec.gateClass;
    }
    const claim: ClaimRecord = {
      kind: "claim",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
      type: CLAIM_TYPE,
      about: [],
      slot: slotFor(CLAIM_DECLARATION, conditions),
      conditions,
      canonical: conditions,
      rendering: spec.rendering,
      evidence: [],
      exclusiveGroup: spec.exclusiveGroup,
    };
    const [id] = await store.putMany([{ kind: "claim", value: claim }]);
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
      moduleRecord: recordId({ marker: "gate-fixture" }),
    },
    projectCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    overrides: {},
    evaluatorVersion: versionString("1"),
  };
  await store.putMany([{ kind: "case", value: caseRecord }]);

  return { workspace, scope, store, idBySpecId };
}

describe("gate.ask@1", () => {
  let workspace: string;

  afterEach(async () => {
    if (workspace) {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("a binary gate (no exclusive group) offers holds and fails against its one claim", async () => {
    const built = await buildWorkspace("binary-case", [
      { id: "only", rendering: "the tests all pass", exclusiveGroup: null },
    ]);
    workspace = built.workspace;
    const claimId = built.idBySpecId.get("only")!;

    const output = await runHandler(gateAsk, { claim: claimId }, { workspace, scope: built.scope, now });

    expect(output.options).toEqual([
      { claim: claimId, value: "holds", description: "the tests all pass" },
      { claim: claimId, value: "fails", description: "not: the tests all pass" },
    ]);
    expect(output.minted).toHaveLength(1);
    expect(output.pending).toEqual({
      asking: `disposition for ${claimId}`,
      answeredBy: "gate.answer@2",
      input: { pending: claimId, brief: output.brief },
    });
  });

  test("a multi-sibling exclusive group offers one option per sibling, carrying its own disposition and rendering", async () => {
    const built = await buildWorkspace("menu-case", [
      { id: "a", rendering: "file a new issue", exclusiveGroup: "disposition", disposition: "file" },
      { id: "b", rendering: "post a comment", exclusiveGroup: "disposition", disposition: "comment" },
      { id: "c", rendering: "withdraw", exclusiveGroup: "disposition", disposition: "withdraw" },
    ]);
    workspace = built.workspace;
    const claimId = built.idBySpecId.get("a")!;

    const output = await runHandler(gateAsk, { claim: claimId }, { workspace, scope: built.scope, now });

    expect(output.options.map((option) => option.value).sort()).toEqual(["comment", "file", "withdraw"]);
    expect(output.options.find((option) => option.value === "file")!.description).toBe("file a new issue");
  });

  test("refuses a group whose options carry a duplicate value, with a reason from the closed vocabulary", async () => {
    const built = await buildWorkspace("duplicate-case", [
      { id: "a", rendering: "file a new issue", exclusiveGroup: "disposition", disposition: "file" },
      { id: "b", rendering: "file it again, differently worded", exclusiveGroup: "disposition", disposition: "file" },
    ]);
    workspace = built.workspace;
    const claimId = built.idBySpecId.get("a")!;

    const error = await runHandler(gateAsk, { claim: claimId }, { workspace, scope: built.scope, now }).catch(
      (caught: unknown) => caught,
    );

    expect(isOperationError(error)).toBe(true);
    expect((error as { reason: string }).reason).toBeTruthy();
  });

  test("askMenu refuses an exclusive group folded down to no members", async () => {
    const built = await buildWorkspace("empty-group-case", [
      { id: "only", rendering: "orphaned", exclusiveGroup: "ghost-group" },
    ]);
    workspace = built.workspace;
    const claimId = built.idBySpecId.get("only")!;
    const opened = await openWorkspace({ workspace, scope: built.scope, now });
    // Only the kernel builds a workspace, so the stub derives from a real one, one query replaced.
    const stub = Object.create(opened, {
      index: { value: Object.create(opened.index, { claimsInGroup: { value: () => [] } }) as Workspace["index"] },
    }) as Workspace;

    expect(() => askMenu(stub, claimId)).toThrow(MenuRefusedError);
  });
});

describe("gate.pending@1", () => {
  let workspace: string;

  afterEach(async () => {
    if (workspace) {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("lists a binary gate claim awaiting an answer, naming its case and its gate class", async () => {
    const built = await buildWorkspace("pending-case", [
      { id: "only", rendering: "the corpus is clean", exclusiveGroup: null, gateClass: "evidence" },
    ]);
    workspace = built.workspace;
    const claimId = built.idBySpecId.get("only")!;

    const output = await runHandler(gatePending, {}, { workspace, scope: built.scope, now });

    expect(output.gates).toEqual([{ case: "pending-case", claim: claimId, gateClass: "evidence" }]);
  });

  test("a ruling no attestation vouches for settles nothing, so the gate it names is still offered", async () => {
    const built = await buildWorkspace("unvouched-case", [
      { id: "only", rendering: "the corpus is clean", exclusiveGroup: null, gateClass: "evidence" },
    ]);
    workspace = built.workspace;
    const claimId = built.idBySpecId.get("only")!;
    const claim = (await built.store.read(claimId, "claim")) as ClaimRecord;

    const offeredBefore = await runHandler(gatePending, {}, { workspace, scope: built.scope, now });
    expect(offeredBefore.gates).toHaveLength(1);

    // A ruling with no attestation behind it, as a peer's bad commit or a hand edit leaves one.
    const unvouched: RulingRecord = {
      kind: "ruling",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.ruling,
      over: { claim: claimId },
      verdict: "holds",
      reason: "nobody signed this",
      brief: recordId({ marker: "a brief that vouches for nothing" }),
    };
    await built.store.putMany([{ kind: "ruling", value: unvouched }]);

    const offeredAfter = await runHandler(gatePending, {}, { workspace, scope: built.scope, now });
    expect(offeredAfter.gates).toEqual(offeredBefore.gates);

    const { status } = await labelledClaim(
      await openWorkspace({ workspace, scope: built.scope, now }),
      claim.slot,
      "perform",
    );
    expect(status.label).toBe("open");
  });

  test("a case filter naming no booked case says so, rather than reading like a case with every gate answered", async () => {
    const built = await buildWorkspace("filtered-case", [
      { id: "only", rendering: "the corpus is clean", exclusiveGroup: null, gateClass: "evidence" },
    ]);
    workspace = built.workspace;

    const byName = await runHandler(gatePending, { case: "filtered-case" }, { workspace, scope: built.scope, now });
    expect(byName.gates).toHaveLength(1);
    expect(byName.unlisted).toBeUndefined();

    const mistyped = await runHandler(gatePending, { case: "filtered-cse" }, { workspace, scope: built.scope, now });
    expect(mistyped.gates).toEqual([]);
    expect(mistyped.unlisted).toContain("filtered-cse");
    expect(gatePending.renderText!(mistyped)).not.toBe("no gates await an answer");
  });

  test("a claim naming no gate class is never listed", async () => {
    const built = await buildWorkspace("no-gate-case", [
      { id: "only", rendering: "an ordinary claim", exclusiveGroup: null },
    ]);
    workspace = built.workspace;

    const output = await runHandler(gatePending, {}, { workspace, scope: built.scope, now });

    expect(output.gates).toEqual([]);
  });

  test("a group drops out once one of its members holds, and returns the same order across two calls at one head", async () => {
    const built = await buildWorkspace("group-pending-case", [
      { id: "a", rendering: "file", exclusiveGroup: "disposition", disposition: "file", gateClass: "judgment" },
      { id: "b", rendering: "comment", exclusiveGroup: "disposition", disposition: "comment", gateClass: "judgment" },
    ]);
    workspace = built.workspace;
    const claimA = built.idBySpecId.get("a")!;

    const firstCall = await runHandler(gatePending, {}, { workspace, scope: built.scope, now });
    const secondCall = await runHandler(gatePending, {}, { workspace, scope: built.scope, now });
    expect(firstCall).toEqual(secondCall);
    expect(firstCall.gates).toHaveLength(1);

    const askOutput = await runHandler(gateAsk, { claim: claimA }, { workspace, scope: built.scope, now });
    await runHandler(
      gateAnswer,
      {
        pending: claimA,
        brief: askOutput.brief,
        choice: "file",
        reason: "the fixture chose file",
      },
      { workspace, scope: built.scope, now, via: "tty", principalName: "person@example.com" },
    );

    const afterAnswer = await runHandler(gatePending, {}, { workspace, scope: built.scope, now });
    expect(afterAnswer.gates).toEqual([]);
  });
});
