import { performance } from "node:perf_hooks";
import type { OperationPlan } from "@musai/modules";
import { type ClaimRecord, type ClaimTypeDeclaration, CURRENT_SCHEMA_VERSIONS, slotFor } from "@musai/records";
import { Store } from "@musai/store";
import { type FixtureRepo, makeFixtureRepo } from "@musai/test-support";
import { execa } from "execa";
import { afterEach, expect, test } from "vitest";
import type { OperationContext } from "../src/context.js";
import { openWorkspace } from "../src/open-workspace.js";
import { perform, realisePlan } from "../src/plan.js";

const CLAIM_TYPE = "musai.batched-write-test/claim@1";
const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: CLAIM_TYPE, identityDimensions: ["id"] };
const BATCH = 10_000;
/** Catches only a superlinear regression; the author's machine records the time itself. */
const CEILING_MS = 120_000;

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

function claims(prefix: string): ClaimRecord[] {
  return Array.from({ length: BATCH }, (_, index) => claimAt(`${prefix}-${index}`));
}

async function commitCount(repo: FixtureRepo, scope: string): Promise<number> {
  const { stdout } = await execa("git", ["--git-dir", repo.ctx.gitDir, "rev-list", "--count", `scope/${scope}`]);
  return Number(stdout);
}

test(
  "a plan of ten thousand claims lands through perform in one commit, and the fold then holds every one",
  async () => {
    repo = await makeFixtureRepo("canon", [CLAIM_DECLARATION]);
    const view = await openWorkspace({ workspace: repo.workspace, scope: "canon", now: repo.now });
    const before = await commitCount(repo, "canon");
    const plan: OperationPlan = {
      put: claims("planned").map((value) => ({ kind: "claim", value })),
      attest: [],
      needs: [],
    };
    const context = { workspace: repo.workspace, scope: "canon", now: repo.now } as OperationContext;

    const started = performance.now();
    await perform(await realisePlan(plan, view, context, "fixture.batch@1", undefined), [], view);
    const elapsed = performance.now() - started;

    expect(await commitCount(repo, "canon")).toBe(before + 1);
    expect(view.index.claimSlotsOfType(CLAIM_TYPE)).toHaveLength(BATCH);
    expect(elapsed).toBeLessThan(CEILING_MS);
    console.info(`perform, ${BATCH} claims: ${Math.round(elapsed)} ms`);
  },
  CEILING_MS * 2,
);

test(
  "a whole merge of a fork holding ten thousand records lands in one commit",
  async () => {
    repo = await makeFixtureRepo("canon", [CLAIM_DECLARATION]);
    const storeOf = (scope: string) =>
      new Store({ ctx: repo!.ctx, scope, now: repo!.now, claimTypes: repo!.claimTypes });
    const canon = storeOf("canon");
    await canon.put("claim", claimAt("base"));
    await (await openWorkspace({ workspace: repo.workspace, scope: "canon", now: repo.now })).fork("fork");
    await storeOf("fork").putMany(claims("forked").map((value) => ({ kind: "claim" as const, value })));
    const before = await commitCount(repo, "canon");

    const started = performance.now();
    const merged = await canon.mergeFrom("fork");
    const elapsed = performance.now() - started;

    expect(await commitCount(repo, "canon")).toBe(before + 1);
    expect(merged.merged).toHaveLength(BATCH);
    expect(elapsed).toBeLessThan(CEILING_MS);
    console.info(`whole merge, ${BATCH} records: ${Math.round(elapsed)} ms`);
  },
  CEILING_MS * 2,
);
