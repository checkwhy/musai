import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openWorkspace, runHandler } from "@musai/api-core";
import {
  type ClaimRecord,
  type ClaimTypeDeclaration,
  CURRENT_SCHEMA_VERSIONS,
  claimTypesFrom,
  type EvidenceEdge,
  type PerformedRunRecord,
  type RecordId,
  recordId,
  slotFor,
  timestamp,
  versionString,
} from "@musai/records";
import { RUNNER_PERFORMER } from "@musai/run";
import { initWorkspace, Store } from "@musai/store";
import { declareClaimTypes, fixedClock } from "@musai/test-support";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { shortIdOf } from "../src/claim-ref.js";
import { claimStatus } from "../src/ops/claim.js";
import { doctorRun } from "../src/ops/doctor.js";
import { forkKeep } from "../src/ops/keep.js";
import { moduleBuild } from "../src/ops/module.js";
import { scopeFork, scopeMerge } from "../src/ops/scope.js";
import { claimWhy } from "../src/ops/why.js";

const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: "musai.forked-slot-test/claim@1", identityDimensions: ["id"] };
const CLAIM_TYPES = claimTypesFrom([CLAIM_DECLARATION]);
const FIXED_INSTANT = timestamp("2026-01-01T00:00:00.000Z");
const now = fixedClock(FIXED_INSTANT);
const scope = "default";
const CORE_MODULE_DIR = fileURLToPath(new URL("../../core-module", import.meta.url));

function slotOf(id: string): string {
  return slotFor(CLAIM_DECLARATION, { id });
}

function receipt(output: string): PerformedRunRecord {
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

function edgeOn(run: RecordId): EvidenceEdge {
  return {
    run,
    selector: { module: "musai.core", parser: "exit-code", version: versionString("1"), key: "exitCode" },
    item: recordId(0),
  };
}

function claimJudgedBy(id: string, by: string | null, evidence: EvidenceEdge[]): ClaimRecord {
  return {
    kind: "claim",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: CLAIM_DECLARATION.type,
    about: [],
    slot: slotOf(id),
    conditions: by === null ? { id } : { id, by },
    canonical: { statement: id },
    rendering: id,
    evidence,
    exclusiveGroup: null,
  };
}

describe("a slot whose live claims are judged differently", () => {
  let workspace: string;
  let gitDir: string;
  let store: Store;
  const context = () => ({ workspace, scope, now });

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-forked-slot-"));
    ({ gitDir } = await initWorkspace(workspace, { now }));
    store = new Store({ ctx: { gitDir }, scope, now, claimTypes: CLAIM_TYPES });
    await declareClaimTypes(store, [CLAIM_DECLARATION]);
    await runHandler(moduleBuild, { dir: CORE_MODULE_DIR }, context());
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  async function landed(id: string, by: string | null): Promise<RecordId> {
    const [run] = await store.putMany([{ kind: "run", value: receipt(`${id} judged by ${by}`) }]);
    const [claim] = await store.putMany([{ kind: "claim", value: claimJudgedBy(id, by, [edgeOn(run!)]) }]);
    return claim!;
  }

  test("a slot two live claims judged differently read as forked, not by hash order", async () => {
    const pairs = [
      [await landed("forked-one", "one"), await landed("forked-one", "two")],
      [await landed("forked-two", "two"), await landed("forked-two", "one")],
    ];
    const doctor = await runHandler(doctorRun, {}, context());

    for (const [index, id] of ["forked-one", "forked-two"].entries()) {
      const status = await runHandler(claimStatus, { claim: slotOf(id) }, context());
      const why = await runHandler(claimWhy, { claim: slotOf(id), full: true }, context());
      const named = pairs[index]!.map(shortIdOf).sort().join(", ");

      expect(status).toMatchObject({ label: "open", reason: "forked-slot" });
      expect(status.detail).toContain(named);
      expect(claimWhy.renderText(why).split("\n")[0]).toContain("open (forked-slot) · ");
      expect(claimWhy.renderText(why)).toContain(named);
      expect(doctor.local).toContainEqual(
        expect.objectContaining({ name: "forked-slots", ok: false, detail: expect.stringContaining(named) }),
      );
    }
  });

  test("every contributor at a forked slot resolves by its own id", async () => {
    const contributors = [await landed("named-by-id", "one"), await landed("named-by-id", "two")];

    for (const id of contributors) {
      for (const named of [id, shortIdOf(id)]) {
        const status = await runHandler(claimStatus, { claim: named }, context());
        const why = await runHandler(claimWhy, { claim: named, full: true }, context());

        expect(status).toMatchObject({ label: "open", reason: "forked-slot" });
        expect(why).toMatchObject({ label: "open", reason: "forked-slot" });
      }
    }
  });

  test("claims at one slot judged alike merge, the slot holding on either's evidence", async () => {
    await landed("merged", null);
    await landed("merged", null);

    const status = await runHandler(claimStatus, { claim: slotOf("merged") }, context());
    const doctor = await runHandler(doctorRun, {}, context());

    expect(status.label).toBe("holds");
    expect(JSON.stringify(doctor.local)).not.toContain(shortIdOf(slotOf("merged")));
  });

  test("a scope merge bringing a claim judged otherwise to a slot leaves the slot forked", async () => {
    const before = await landed("merged-in", "here");
    await runHandler(scopeFork, { name: "elsewhere" }, context());
    const elsewhere = new Store({ ctx: { gitDir }, scope: "elsewhere", now, claimTypes: CLAIM_TYPES });
    const [run] = await elsewhere.putMany([{ kind: "run", value: receipt("judged elsewhere") }]);
    const [after] = await elsewhere.putMany([
      { kind: "claim", value: claimJudgedBy("merged-in", "elsewhere", [edgeOn(run!)]) },
    ]);

    await runHandler(scopeMerge, { from: "elsewhere" }, context());
    const status = await runHandler(claimStatus, { claim: slotOf("merged-in") }, context());

    expect(status).toMatchObject({ label: "open", reason: "forked-slot" });
    expect(status.detail).toContain([before, after!].map(shortIdOf).sort().join(", "));
  });

  test("the author closes a fork at a pack-kind slot, and the slot holds the successor alone", async () => {
    const kept = await landed("kept", "one");
    const other = await landed("kept", "two");

    const { successor: claim, supersedes } = await runHandler(forkKeep, { record: shortIdOf(kept) }, context());
    const opened = await openWorkspace(context());
    const successor = opened.read(claim as RecordId) as ClaimRecord;
    const { evidence } = opened.read(kept) as ClaimRecord;
    const live = opened.index.contributorsAtSlot(slotOf("kept")).map(({ id }) => id);
    opened.close();
    const status = await runHandler(claimStatus, { claim: slotOf("kept") }, context());
    const doctor = await runHandler(doctorRun, {}, context());

    expect([...successor.supersedes].sort()).toEqual([kept, other].sort());
    expect([...supersedes].sort()).toEqual([kept, other].sort());
    expect(successor).toMatchObject({ slot: slotOf("kept"), conditions: { id: "kept", by: "one" } });
    expect(successor.evidence).toEqual(evidence);
    expect(live).toEqual([claim]);
    expect(status.label).toBe("holds");
    expect(JSON.stringify(doctor.local)).not.toContain(shortIdOf(slotOf("kept")));
  });

  test("a fork at a pack-kind slot names the keep that closes it, never check --replace", async () => {
    await landed("remedied", "one");
    await landed("remedied", "two");
    const status = await runHandler(claimStatus, { claim: slotOf("remedied") }, context());
    const doctor = await runHandler(doctorRun, {}, context());
    const row = doctor.local.find(({ detail }) => detail.includes(shortIdOf(slotOf("remedied"))));

    for (const detail of [status.detail, row?.detail]) {
      expect(detail).toContain("`lab keep <claim>`");
      expect(detail).not.toContain("check --replace");
    }
  });

  test("keeping a claim at a slot no fork splits is refused, and mints nothing", async () => {
    const alone = await landed("alone", "one");

    await expect(runHandler(forkKeep, { record: alone }, context())).rejects.toMatchObject({
      reason: "invalid-input",
      message: expect.stringContaining("holds no fork"),
    });
    const opened = await openWorkspace(context());
    const live = opened.index.contributorsAtSlot(slotOf("alone")).map(({ id }) => id);
    opened.close();
    expect(live).toEqual([alone]);
  });

  test("keeping a name that is no record id is refused, naming the claim or case keep takes", async () => {
    await expect(runHandler(forkKeep, { record: "remedied" }, context())).rejects.toMatchObject({
      reason: "invalid-input",
      message: expect.stringContaining("names no claim or case to keep"),
    });
  });

  test("keeping a contributor a successor already retired is refused", async () => {
    const kept = await landed("retired", "one");
    const retired = await landed("retired", "two");
    await runHandler(forkKeep, { record: kept }, context());

    await expect(runHandler(forkKeep, { record: retired }, context())).rejects.toMatchObject({
      reason: "no-such-record",
    });
  });

  test("a successor kept from one group's member stands in for it, joining no group its opening commit closed", async () => {
    const grouped = (id: string, by: string, group: string): ClaimRecord => ({
      ...claimJudgedBy(id, by, []),
      exclusiveGroup: group,
    });
    const [kept, sibling] = await store.putMany([
      { kind: "claim", value: grouped("standing-in", "kept", "the-kept-menu") },
      { kind: "claim", value: grouped("standing-beside", "kept", "the-kept-menu") },
    ]);
    const [other] = await store.putMany([{ kind: "claim", value: grouped("standing-in", "other", "the-other-menu") }]);

    const { successor, supersedes } = await runHandler(forkKeep, { record: kept! }, context());
    const opened = await openWorkspace(context());
    const keptMenu = opened.index.claimsInGroup("the-kept-menu").map(({ id }) => id);
    const otherMenu = opened.index.claimsInGroup("the-other-menu").map(({ id }) => id);
    opened.close();

    expect([...supersedes].sort()).toEqual([kept!, other!].sort());
    expect(keptMenu.sort()).toEqual([successor, sibling!].sort());
    expect(otherMenu).toEqual([]);
  });
});
