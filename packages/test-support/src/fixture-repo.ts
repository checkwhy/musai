import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ClaimTypeDeclaration,
  type ClaimTypes,
  type Clock,
  claimTypesFrom,
  type RecordId,
  TRIPLE_DECLARATION,
} from "@musai/records";
import { type GitContext, initWorkspace, type PutItem, Store } from "@musai/store";
import { fixedClock, SCENARIO_INSTANT } from "./clock.js";
import { declareClaimTypes } from "./module-fixtures.js";

export interface FixtureRepo {
  workspace: string;
  ctx: GitContext;
  scope: string;
  /** The base triple plus whatever the fixture declared. */
  claimTypes: ClaimTypes;
  /** Dates every commit the fixture's helpers mint, and any store a test builds over it. */
  now: Clock;
  cleanup(): Promise<void>;
}

/** Built by the initialiser a user runs, with declarations seeded as modules so the fold reads
 * them as it would an installed pack's. */
export async function makeFixtureRepo(
  scope = "test",
  declarations: readonly ClaimTypeDeclaration[] = [],
): Promise<FixtureRepo> {
  const workspace = await mkdtemp(join(tmpdir(), "musai-fixture-"));
  const now = fixedClock(SCENARIO_INSTANT);
  const { gitDir } = await initWorkspace(workspace, { now });
  const ctx: GitContext = { gitDir };
  const claimTypes = claimTypesFrom([TRIPLE_DECLARATION, ...declarations]);

  if (declarations.length > 0) {
    const store = new Store({ ctx, scope, now, claimTypes });
    await declareClaimTypes(store, declarations);
  }

  return {
    workspace,
    ctx,
    scope,
    claimTypes,
    now,
    async cleanup() {
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

/** Through the `Store`, so no test helper computes a record id. */
export async function writeFixtureRecords(repo: FixtureRepo, items: PutItem[]): Promise<RecordId[]> {
  const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now, claimTypes: repo.claimTypes });
  return store.putMany(items);
}
