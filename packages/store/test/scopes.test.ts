import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type ClaimRecord, type ClaimTypeDeclaration, CURRENT_SCHEMA_VERSIONS, slotFor } from "@musai/records";
import { type FixtureRepo, makeFixtureRepo } from "@musai/test-support";
import { execa } from "execa";
import { afterEach, describe, expect, test } from "vitest";
import { scopeIndexPath } from "../src/init.js";
import { createScope, dropScope, listScopes } from "../src/scopes.js";
import { Store } from "../src/store.js";

const CLAIM_TYPE = "musai.scopes-test/claim@1";
const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: CLAIM_TYPE, identityDimensions: ["id"] };

let repo: FixtureRepo | undefined;

afterEach(async () => {
  await repo?.cleanup();
  repo = undefined;
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

async function repoWithOneClaim(): Promise<{ repo: FixtureRepo; store: Store; tip: string }> {
  const made = await makeFixtureRepo("canon", [CLAIM_DECLARATION]);
  repo = made;
  const store = new Store({ ctx: made.ctx, scope: "canon", now: made.now, claimTypes: made.claimTypes });
  await store.put("claim", claimAt("first"));
  return { repo: made, store, tip: (await store.tip())! };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe("scopes listed, created and dropped", () => {
  test("the list names the scopes under refs/heads/scope and none under refs/one-level/scope", async () => {
    const { repo, tip } = await repoWithOneClaim();
    await execa("git", ["--git-dir", repo.ctx.gitDir, "update-ref", "refs/one-level/scope/legacy", tip]);
    await createScope(repo.ctx, "fork", tip);

    expect(await listScopes(repo.ctx)).toEqual([
      { scope: "canon", tip },
      { scope: "fork", tip },
    ]);
  });

  test("creating a scope over a name that holds a ref is refused, naming its tip", async () => {
    const { repo, tip } = await repoWithOneClaim();

    await expect(createScope(repo.ctx, "canon", tip)).rejects.toMatchObject({
      reason: "invalid-input",
      about: ["canon"],
      message: expect.stringContaining(tip),
    });
  });

  test("a drop against a moved tip is refused and removes nothing", async () => {
    const { repo, store, tip } = await repoWithOneClaim();
    const fold = scopeIndexPath(repo.ctx.gitDir, "canon");
    await mkdir(dirname(fold), { recursive: true });
    await writeFile(fold, "");
    await store.put("claim", claimAt("second"));
    const moved = await store.tip();

    await expect(dropScope(repo.ctx, "canon", tip)).rejects.toMatchObject({ reason: "head-moved" });
    expect(await store.tip()).toBe(moved);
    expect(await exists(fold)).toBe(true);
  });

  test("a drop removes the scope's fold directory and its ref", async () => {
    const { repo, store, tip } = await repoWithOneClaim();
    const fold = scopeIndexPath(repo.ctx.gitDir, "canon");
    await mkdir(dirname(fold), { recursive: true });
    await writeFile(fold, "");

    await dropScope(repo.ctx, "canon", tip);

    expect(await store.tip()).toBeNull();
    expect(await exists(dirname(fold))).toBe(false);
    expect(await listScopes(repo.ctx)).toEqual([]);
  });
});
