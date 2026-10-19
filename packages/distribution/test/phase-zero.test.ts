import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type OperationContext, openWorkspace, runHandler } from "@musai/api-core";
import { buildModule } from "@musai/devkit";
import {
  type ClaimRecord,
  type ClaimTypeDeclaration,
  type ComputedRunRecord,
  CURRENT_SCHEMA_VERSIONS,
  claimTypesFrom,
  hexOfRecordId,
  type RecordId,
  type RunRecord,
  slotFor,
} from "@musai/records";
import { initWorkspace, Store } from "@musai/store";
import { blobStoreOf, declareClaimTypes, fixedClock, foldedIndex } from "@musai/test-support";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { claimStatus } from "../src/ops/claim.js";

/** A stand-in for loom's phase 0: beats rest on atoms a holder holds, read through record needs. */
const ATOMS_MODULE_DIR = fileURLToPath(new URL("./fixtures/atoms", import.meta.url));
const CORE_MODULE_DIR = fileURLToPath(new URL("../../core-module", import.meta.url));
const RESTS_ON_ATOMS = "atoms/rests-on-atoms";
const ATOM: ClaimTypeDeclaration = { type: "musai.phase-zero/atom@1", identityDimensions: ["holder", "fact"] };
const BEAT: ClaimTypeDeclaration = { type: "musai.phase-zero/beat@1", identityDimensions: ["holder", "beat"] };

function claimOf(declaration: ClaimTypeDeclaration, conditions: Record<string, string>): ClaimRecord {
  return {
    kind: "claim",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: declaration.type,
    about: [],
    slot: slotFor(declaration, conditions),
    conditions,
    canonical: conditions,
    rendering: Object.values(conditions).join(" "),
    evidence: [],
    exclusiveGroup: null,
  };
}

function atom(holder: string, fact: string, value = "present"): ClaimRecord {
  return claimOf(ATOM, { holder, fact, value });
}

function beat(holder: string, name: string, atoms: readonly RecordId[]): ClaimRecord {
  return claimOf(BEAT, { holder, beat: name, [RESTS_ON_ATOMS]: atoms.join(",") });
}

describe("loom's phase 0 loop, on a fixture world musai owns", () => {
  let workspace: string;
  let store: Store;
  const scope = "default";
  const now = fixedClock("2026-10-08T00:00:00.000Z");
  const atoms = new Map<string, RecordId>();
  const beats = new Map<string, ClaimRecord>();

  function ctx(mode: OperationContext["mode"] = "perform"): OperationContext {
    return { workspace, scope, now, mode };
  }

  async function evaluationOf(holder: string): Promise<{ id: RecordId; run: ComputedRunRecord }> {
    const slot = beats.get(holder)!.slot;
    const runs = await Promise.all(
      (await store.list("run")).map(async (id) => ({ id, run: (await store.read(id, "run")) as RunRecord })),
    );
    return runs.find(({ run }) => run.runKind === "evaluation" && run.recipe.command[2] === slot) as {
      id: RecordId;
      run: ComputedRunRecord;
    };
  }

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-phase-zero-"));
    const { gitDir } = await initWorkspace(workspace, { now });
    store = new Store({ ctx: { gitDir }, scope, now, claimTypes: claimTypesFrom([ATOM, BEAT]) });
    await declareClaimTypes(store, [ATOM, BEAT]);
    for (const dir of [CORE_MODULE_DIR, ATOMS_MODULE_DIR]) {
      await buildModule(dir, store, { blobs: blobStoreOf(workspace), index: await foldedIndex(store), now });
    }
    for (const [key, record] of [
      ["ada-sword", atom("ada", "sword")],
      ["ada-map", atom("ada", "map")],
      ["bo-cloak", atom("bo", "cloak")],
    ] as const) {
      const [id] = await store.putMany([{ kind: "claim", value: record }]);
      atoms.set(key, id!);
    }
    beats.set("ada", beat("ada", "crosses-the-river", [atoms.get("ada-sword")!, atoms.get("ada-map")!]));
    beats.set("bo", beat("bo", "waits-at-the-inn", [atoms.get("bo-cloak")!]));
    await store.putMany([...beats.values()].map((value) => ({ kind: "claim" as const, value })));
  }, 120_000);

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("a check over a beat reads its atoms and mints an evaluation run naming them", async () => {
    for (const holder of ["ada", "bo"]) {
      expect(await runHandler(claimStatus, { claim: beats.get(holder)!.slot }, ctx())).toMatchObject({
        label: "holds",
      });
    }

    const { run } = await evaluationOf("ada");
    for (const fact of ["ada-sword", "ada-map"]) {
      const id = atoms.get(fact)!;
      const slot = (await store.read(id, "claim")) as ClaimRecord;
      expect(run.observation.reads).toContainEqual({
        key: `slot:${slot.slot}`,
        consumed: { sha256: hexOfRecordId(id) },
      });
    }
  }, 60_000);

  test("an atom a beat rested on, superseded, returns its evaluation from the fold by lookup and stales it", async () => {
    const swordId = atoms.get("ada-sword")!;
    const sword = (await store.read(swordId, "claim")) as ClaimRecord;
    await store.putMany([{ kind: "claim", value: { ...atom("ada", "sword", "lost"), supersedes: [swordId] } }]);

    const opened = await openWorkspace({ workspace, scope, now });
    const evaluation = await evaluationOf("ada");
    expect(opened.index.readersOf(`slot:${sword.slot}`).map((read) => read.reader)).toContain(evaluation.id);
    expect(opened.index.reachOf(`slot:${sword.slot}`).map((read) => read.reader)).toEqual([evaluation.id]);
    expect(await runHandler(claimStatus, { claim: beats.get("ada")!.slot }, ctx("plan"))).toMatchObject({
      label: "open",
      reason: "stale",
    });
    expect(await runHandler(claimStatus, { claim: beats.get("ada")!.slot }, ctx())).toMatchObject({
      label: "fails",
    });
    // Re-evaluated against the atom now at the slot, the beat reads current again.
    expect(await runHandler(claimStatus, { claim: beats.get("ada")!.slot }, ctx("plan"))).toMatchObject({
      label: "fails",
      reason: null,
    });
  }, 60_000);

  test("the other holder's beat, which read no moved atom, keeps its status", async () => {
    expect(await runHandler(claimStatus, { claim: beats.get("bo")!.slot }, ctx("plan"))).toMatchObject({
      label: "holds",
      reason: null,
    });
  }, 60_000);
});
