import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { IndexDb } from "@musai/fold";
import {
  type ClaimRecord,
  type ClaimTypeDeclaration,
  CURRENT_SCHEMA_VERSIONS,
  idFromPath,
  kindFromPath,
  slotFor,
} from "@musai/records";
import { createScope, dropScope, listScopes, Store, scopeDifference, scopeIndexPath } from "@musai/store";
import { type FixtureRepo, makeFixtureRepo, rowsHeld } from "@musai/test-support";
import { afterEach, describe, expect, test } from "vitest";
import { openWorkspace } from "../src/open-workspace.js";
import type { Workspace } from "../src/workspace.js";

const CLAIM_TYPE = "musai.scope-fork-test/claim@1";
const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: CLAIM_TYPE, identityDimensions: ["id"] };

let repo: FixtureRepo | undefined;

afterEach(async () => {
  await repo?.cleanup();
  repo = undefined;
});

function claimAt(id: string, rendering = `${id} holds.`): ClaimRecord {
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
    rendering,
    evidence: [],
    exclusiveGroup: null,
  };
}

async function canonWith(...ids: string[]): Promise<{ repo: FixtureRepo; store: Store }> {
  const made = await makeFixtureRepo("canon", [CLAIM_DECLARATION]);
  repo = made;
  const store = new Store({ ctx: made.ctx, scope: "canon", now: made.now, claimTypes: made.claimTypes });
  await store.putMany(ids.map((id) => ({ kind: "claim" as const, value: claimAt(id) })));
  return { repo: made, store };
}

describe("a dropped scope, opened again", () => {
  test("after a drop, opening the name reads an empty scope with no rows", async () => {
    const { repo, store } = await canonWith("first");
    const slot = claimAt("first").slot;
    expect(
      (await openWorkspace({ workspace: repo.workspace, scope: "canon", now: repo.now })).index.claimAtSlot(slot),
    ).toBeDefined();

    await dropScope(repo.ctx, "canon", (await store.tip())!);

    const reopened = await openWorkspace({ workspace: repo.workspace, scope: "canon", now: repo.now });
    expect(reopened.index.claimAtSlot(slot)).toBeUndefined();
  });

  test("a crash after the fold is removed and before the ref is deleted leaves a scope that refolds on open", async () => {
    const { repo } = await canonWith("first");
    await openWorkspace({ workspace: repo.workspace, scope: "canon", now: repo.now });

    await rm(dirname(scopeIndexPath(repo.ctx.gitDir, "canon")), { recursive: true, force: true });

    const reopened = await openWorkspace({ workspace: repo.workspace, scope: "canon", now: repo.now });
    expect(reopened.index.claimAtSlot(claimAt("first").slot)).toBeDefined();
  });
});

/** A cold fold of `tip`, through a scope of its own opened as any reader opens one. */
async function coldRowsAt(repo: FixtureRepo, tip: string, scope: string): Promise<Record<string, string[]>> {
  await createScope(repo.ctx, scope, tip);
  await openWorkspace({ workspace: repo.workspace, scope, now: repo.now });
  return rowsHeld(scopeIndexPath(repo.ctx.gitDir, scope));
}

describe("a fork carries its fold", () => {
  test("the fork's fold holds the rows a cold fold of its ref holds, and opening it has nothing to walk", async () => {
    const { repo } = await canonWith("first", "second");
    const canon = await openWorkspace({ workspace: repo.workspace, scope: "canon", now: repo.now });

    const tip = await canon.fork("fork");

    const forkIndex = scopeIndexPath(repo.ctx.gitDir, "fork");
    expect(new IndexDb(forkIndex).watermark()).toBe(tip);
    expect(rowsHeld(forkIndex)).toEqual(await coldRowsAt(repo, tip, "cold"));
  });

  test("a write to the base after the fork is not in the fork", async () => {
    const { repo, store } = await canonWith("first");
    await (await openWorkspace({ workspace: repo.workspace, scope: "canon", now: repo.now })).fork("fork");

    await store.put("claim", claimAt("later"));

    const fork = await openWorkspace({ workspace: repo.workspace, scope: "fork", now: repo.now });
    expect(fork.index.claimAtSlot(claimAt("first").slot)).toBeDefined();
    expect(fork.index.claimAtSlot(claimAt("later").slot)).toBeUndefined();
  });

  test("a fork onto a name that holds a ref is refused, leaving that scope's fold in place", async () => {
    const { repo } = await canonWith("first");
    const canon = await openWorkspace({ workspace: repo.workspace, scope: "canon", now: repo.now });
    await canon.fork("fork");
    const before = rowsHeld(scopeIndexPath(repo.ctx.gitDir, "fork"));

    await expect(canon.fork("fork")).rejects.toMatchObject({ reason: "invalid-input", about: ["fork"] });
    expect(rowsHeld(scopeIndexPath(repo.ctx.gitDir, "fork"))).toEqual(before);
  });

  test("a fork of a scope with no records is refused", async () => {
    const { repo } = await canonWith("first");
    const empty = await openWorkspace({ workspace: repo.workspace, scope: "empty", now: repo.now });

    await expect(empty.fork("fork")).rejects.toMatchObject({ reason: "invalid-input", about: ["empty"] });
  });

  test("a fork taken while another handle folds the base matches a cold fold of the commit it took", async () => {
    const { repo, store } = await canonWith("first");
    const canon = await openWorkspace({ workspace: repo.workspace, scope: "canon", now: repo.now });
    for (const id of ["second", "third", "fourth"]) {
      await store.put("claim", claimAt(id));
    }
    const other = new IndexDb(scopeIndexPath(repo.ctx.gitDir, "canon"));

    const [, tip] = await Promise.all([other.fold(store), canon.fork("fork")]);

    expect(rowsHeld(scopeIndexPath(repo.ctx.gitDir, "fork"))).toEqual(await coldRowsAt(repo, tip, "cold"));
  });
});

/** The live contributors at every slot either fold holds, by slot. */
function contributorsBySlot(...opened: readonly Workspace[]): Map<string, Map<number, string[]>> {
  const slots = new Set(opened.flatMap((each) => each.index.claimSlotsOfType(CLAIM_TYPE)));
  return new Map(
    [...slots].map((slot) => [
      slot,
      new Map(opened.map((each, at) => [at, each.index.contributorsAtSlot(slot).map((claim) => claim.id as string)])),
    ]),
  );
}

describe("a sandbox forked from the canon, merged back and dropped", () => {
  test("the slots of the difference's claims are exactly the slots whose live contributors differ between the folds", async () => {
    const { repo } = await canonWith("kept", "corrected");
    const canon = await openWorkspace({ workspace: repo.workspace, scope: "canon", now: repo.now });
    await canon.fork("fork");
    const forked = new Store({ ctx: repo.ctx, scope: "fork", now: repo.now, claimTypes: repo.claimTypes });
    const corrected = canon.index.claimAtSlot(claimAt("corrected").slot)!.id;
    await forked.putMany([
      { kind: "claim", value: { ...claimAt("corrected", "corrected, in the fork"), supersedes: [corrected] } },
      { kind: "claim", value: claimAt("new in the fork") },
    ]);
    const fork = await openWorkspace({ workspace: repo.workspace, scope: "fork", now: repo.now });

    const difference = await scopeDifference(repo.ctx, (await forked.tip())!, (await canon.store.tip())!);
    const differenceSlots = difference
      .filter((file) => kindFromPath(file.path) === "claim")
      .map((file) => (fork.read(idFromPath(file.path)) as ClaimRecord).slot)
      .sort();
    const differing = [...contributorsBySlot(canon, fork)]
      .filter(([, byFold]) => JSON.stringify(byFold.get(0)) !== JSON.stringify(byFold.get(1)))
      .map(([slot]) => slot)
      .sort();

    expect(differenceSlots).toEqual(differing);
    expect(differing).toHaveLength(2);
  });

  test("merged whole, the base reads the fork's claim", async () => {
    const { repo, store } = await canonWith("corrected");
    const canon = await openWorkspace({ workspace: repo.workspace, scope: "canon", now: repo.now });
    await canon.fork("fork");
    const forked = new Store({ ctx: repo.ctx, scope: "fork", now: repo.now, claimTypes: repo.claimTypes });
    const original = canon.index.claimAtSlot(claimAt("corrected").slot)!.id;
    const [correction] = await forked.putMany([
      { kind: "claim", value: { ...claimAt("corrected", "corrected, in the fork"), supersedes: [original] } },
    ]);

    await store.mergeFrom("fork");

    const merged = await openWorkspace({ workspace: repo.workspace, scope: "canon", now: repo.now });
    expect(merged.index.claimAtSlot(claimAt("corrected").slot)?.id).toBe(correction);
  });

  test("where canon and fork each correct one claim, the merged base holds both corrections as live contributors", async () => {
    const { repo, store } = await canonWith("disputed");
    const canon = await openWorkspace({ workspace: repo.workspace, scope: "canon", now: repo.now });
    await canon.fork("fork");
    const forked = new Store({ ctx: repo.ctx, scope: "fork", now: repo.now, claimTypes: repo.claimTypes });
    const original = canon.index.claimAtSlot(claimAt("disputed").slot)!.id;
    const [inCanon] = await store.putMany([
      { kind: "claim", value: { ...claimAt("disputed", "corrected in the canon"), supersedes: [original] } },
    ]);
    const [inFork] = await forked.putMany([
      { kind: "claim", value: { ...claimAt("disputed", "corrected in the fork"), supersedes: [original] } },
    ]);

    await store.mergeFrom("fork");

    const merged = await openWorkspace({ workspace: repo.workspace, scope: "canon", now: repo.now });
    const live = merged.index.contributorsAtSlot(claimAt("disputed").slot).map((claim) => claim.id);
    expect([...live].sort()).toEqual([inCanon!, inFork!].sort());
  });

  test("dropped, the fork's directory and ref are gone and the base is untouched", async () => {
    const { repo, store } = await canonWith("kept");
    const canon = await openWorkspace({ workspace: repo.workspace, scope: "canon", now: repo.now });
    const tip = await canon.fork("fork");
    const before = rowsHeld(scopeIndexPath(repo.ctx.gitDir, "canon"));

    await dropScope(repo.ctx, "fork", tip);

    expect(await listScopes(repo.ctx)).toEqual([{ scope: "canon", tip: await store.tip() }]);
    expect(rowsHeld(scopeIndexPath(repo.ctx.gitDir, "canon"))).toEqual(before);
    await expect(rm(dirname(scopeIndexPath(repo.ctx.gitDir, "fork")))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
