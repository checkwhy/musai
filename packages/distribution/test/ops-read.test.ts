import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHandler } from "@musai/api-core";
import {
  type CaseRecord,
  type ClaimRecord,
  type ClaimTypeDeclaration,
  CURRENT_SCHEMA_VERSIONS,
  claimTypesFrom,
  type EvidenceEdge,
  isKernelError,
  type RecordId,
  type RunRecord,
  recordId,
  slotFor,
  timestamp,
  versionString,
} from "@musai/records";
import { RUNNER_PERFORMER } from "@musai/run";
import { type GitContext, initWorkspace, type PutItem, Store } from "@musai/store";
import { declareClaimTypes, fixedClock } from "@musai/test-support";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { briefRender } from "../src/ops/brief.js";
import { caseSoundcheck } from "../src/ops/case.js";
import { claimStatus } from "../src/ops/claim.js";
import { claimWhy } from "../src/ops/why.js";

const CLAIM_TYPE = "musai.ops-read-test/claim@1";
const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: CLAIM_TYPE, identityDimensions: ["id"] };
const CLAIM_TYPES = claimTypesFrom([CLAIM_DECLARATION]);
const FIXED_INSTANT = timestamp("2026-01-01T00:00:00.000Z");
const now = fixedClock(FIXED_INSTANT);

function slotOf(id: string): string {
  return slotFor(CLAIM_DECLARATION, { id });
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

function claimRecord(id: string, evidence: ClaimRecord["evidence"]): ClaimRecord {
  return {
    kind: "claim",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: CLAIM_TYPE,
    about: [],
    slot: slotOf(id),
    conditions: { id },
    canonical: { statement: id },
    rendering: id,
    evidence,
    exclusiveGroup: null,
  };
}

describe("the read operations, called directly through their own handlers", () => {
  let workspace: string;
  let store: Store;
  const scope = "default";

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-ops-read-"));
    const { gitDir } = await initWorkspace(workspace, { now });
    const ctx: GitContext = { gitDir };
    store = new Store({ ctx, scope, now, claimTypes: CLAIM_TYPES });
    await declareClaimTypes(store, [CLAIM_DECLARATION]);
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("claim.status reports the receipt that decides a claim", async () => {
    const [runId] = await store.putMany([{ kind: "run", value: receiptRun("the receipt") }]);
    await store.putMany([{ kind: "claim", value: claimRecord("status-claim", [receiptEdge(runId!, "result")]) }]);

    const output = await claimStatus.handler({ claim: slotOf("status-claim") }, { workspace, scope, now });
    expect(output.label).toBe("holds");
    expect(output.reason).toBeNull();
    expect(output.comparison.winner).toContain(runId!);
  });

  test("a record id this scope does not hold is refused by name, never thrown as a fault of the kernel's own", async () => {
    const absent = recordId({ example: "a record nobody ever minted" });
    const error = await runHandler(briefRender, { claim: absent }, { workspace, scope, now }).catch(
      (caught: unknown) => caught,
    );
    expect(isKernelError(error)).toBe(true);
    expect((error as { reason: string }).reason).toBe("no-such-record");
    expect((error as { about: readonly string[] }).about).toEqual([absent]);
  });

  test("a claim named by the record id a correction replaced is refused by naming what replaced it and where it answers", async () => {
    const [runId] = await store.putMany([{ kind: "run", value: receiptRun("the corrected receipt") }]);
    const first = claimRecord("corrected-claim", []);
    const [firstId] = await store.putMany([{ kind: "claim", value: first }]);
    const corrected: ClaimRecord = { ...first, evidence: [receiptEdge(runId!, "result")], supersedes: [firstId!] };
    const [correctedId] = await store.putMany([{ kind: "claim", value: corrected }]);

    await expect(claimStatus.handler({ claim: firstId! }, { workspace, scope, now })).rejects.toThrow(
      `superseded by ${correctedId} at slot ${slotOf("corrected-claim")}`,
    );

    const output = await claimStatus.handler({ claim: slotOf("corrected-claim") }, { workspace, scope, now });
    expect(output.label).toBe("holds");
  });

  test("case.soundcheck reports one entry per claim the case cites, in the case's own order, named by slug or by id", async () => {
    const items: PutItem[] = [
      { kind: "run", value: receiptRun("first receipt") },
      { kind: "run", value: receiptRun("second receipt") },
    ];
    const [firstRunId, secondRunId] = await store.putMany(items);
    const [firstClaimId, secondClaimId] = await store.putMany([
      { kind: "claim", value: claimRecord("soundcheck-first", [receiptEdge(firstRunId!, "result")]) },
      { kind: "claim", value: claimRecord("soundcheck-second", [receiptEdge(secondRunId!, "result")]) },
    ]);
    const caseRecord: CaseRecord = {
      kind: "case",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.case,
      type: null,
      slug: "ops-read-case",
      claims: [firstClaimId!, secondClaimId!],
      preset: {
        module: "musai.core",
        contribution: "musai.core/default",
        moduleRecord: recordId({ marker: "preset-module" }),
      },
      projectCommit: "0".repeat(40),
      overrides: {},
      evaluatorVersion: versionString("1"),
    };
    const [caseId] = await store.putMany([{ kind: "case", value: caseRecord }]);

    const output = await caseSoundcheck.handler({ case: "ops-read-case" }, { workspace, scope, now });
    expect(output.claims).toEqual([
      { slot: slotOf("soundcheck-first"), label: "holds", reason: null },
      { slot: slotOf("soundcheck-second"), label: "holds", reason: null },
    ]);
    expect(await caseSoundcheck.handler({ case: caseId! }, { workspace, scope, now })).toEqual(output);
  });

  test("claim.why walks a single-receipt claim down to its run", async () => {
    const [runId] = await store.putMany([{ kind: "run", value: receiptRun("the why receipt") }]);
    await store.putMany([{ kind: "claim", value: claimRecord("why-claim", [receiptEdge(runId!, "result")]) }]);

    const { derivation } = await claimWhy.handler(
      { claim: slotOf("why-claim"), full: true },
      { workspace, scope, now },
    );
    if (derivation === undefined) {
      expect.unreachable("a claim backed by a receipt has a derivation to walk");
    }
    expect(derivation.label).toBe("claim");
    expect(derivation.children).toHaveLength(1);
    expect(derivation.children[0]!.children[0]!.id).toBe(runId!);
  });

  test("claim.why reports the open-with-no-derivation shape for a claim with no evidence at all", async () => {
    await store.putMany([{ kind: "claim", value: claimRecord("no-evidence-claim", []) }]);

    const output = await claimWhy.handler(
      { claim: slotOf("no-evidence-claim"), full: true },
      { workspace, scope, now },
    );
    expect(output.derivation).toBeUndefined();
    expect(output.reason).toBe("no-evidence");
  });
});
