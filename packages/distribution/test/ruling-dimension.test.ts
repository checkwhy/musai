import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runHandler } from "@musai/api-core";
import { buildModule } from "@musai/devkit";
import { IndexDb } from "@musai/fold";
import { installModule } from "@musai/modules";
import {
  type CaseRecord,
  type ClaimRecord,
  type ClaimTypeDeclaration,
  type ContributionEntry,
  CURRENT_SCHEMA_VERSIONS,
  claimTypesFrom,
  type RecordId,
  recordId,
  slotFor,
  timestamp,
  versionString,
} from "@musai/records";
import { initWorkspace, Store } from "@musai/store";
import {
  blobStoreOf,
  declareClaimTypes,
  fixedClock,
  fixtureBrief,
  foldedIndex,
  manifestWithContributions,
  pseudonymOf,
} from "@musai/test-support";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { claimStatus } from "../src/ops/claim.js";
import { gatePending } from "../src/ops/gate.js";
import { viewRun } from "../src/ops/view.js";

const CORE_MODULE_DIR = fileURLToPath(new URL("../../core-module", import.meta.url));

const MODULE_NAME = "builds";
const now = fixedClock("2026-08-31T00:00:00.000Z");
const scope = "default";

const CLAIM_TYPE = "musai.ruling-dimension-test/claim@1";
const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: CLAIM_TYPE, identityDimensions: ["id"] };

/** A `build` dimension read as exact decimals, so "10" lies past "9", unlike in text order. */
const BUILD: ContributionEntry = {
  kind: "dimension",
  id: `${MODULE_NAME}/build`,
  version: versionString("1"),
  input: { name: "build", type: "ordered", data: { order: "numeric" } },
  output: true,
  documentation: "the build a claim was measured at, numbered from one",
};

function claimAtBuild(id: string, build: string, gateClass?: string): ClaimRecord {
  return {
    kind: "claim",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: CLAIM_TYPE,
    about: [],
    slot: slotFor(CLAIM_DECLARATION, { id }),
    conditions: gateClass === undefined ? { id, build } : { id, build, gateClass },
    canonical: { statement: id },
    rendering: id,
    evidence: [],
    exclusiveGroup: null,
  };
}

function caseCiting(slug: string, claims: readonly RecordId[]): CaseRecord {
  return {
    kind: "case",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.case,
    type: null,
    slug,
    claims: [...claims],
    preset: {
      module: "musai.core",
      contribution: "musai.core/bare",
      moduleRecord: recordId({ marker: "ruling-dimension-fixture" }),
    },
    projectCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    overrides: {},
    evaluatorVersion: versionString("1"),
  };
}

/** A policy from build 9 on, with its brief and a person's made attestation vouching for it. */
async function vouchedPolicyFromBuildNine(store: Store, at: string): Promise<RecordId> {
  const [brief] = await store.putMany([
    {
      kind: "run",
      value: fixtureBrief("the brief a policy was decided on"),
    },
  ]);
  const [policy] = await store.putMany([
    {
      kind: "ruling",
      value: {
        kind: "ruling",
        schemaVersion: CURRENT_SCHEMA_VERSIONS.ruling,
        over: { type: CLAIM_TYPE, scope: { build: { kind: "from", value: "9" } } },
        verdict: "fails",
        reason: "every build from 9 on is out of support",
        brief: brief!,
        supersedes: [],
      },
    },
  ]);
  await store.putMany([
    {
      kind: "attestation",
      value: {
        kind: "attestation",
        schemaVersion: CURRENT_SCHEMA_VERSIONS.attestation,
        subject: policy!,
        principal: pseudonymOf("person@example.com"),
        principalClass: "person",
        via: "signature",
        purpose: "made",
        at: timestamp(at),
        supersedes: [],
      },
    },
  ]);
  return policy!;
}

describe("a policy is applied under the dimensions the workspace's installed modules declare", () => {
  let workspace: string;
  let store: Store;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-ruling-dimension-"));
    await initWorkspace(workspace, { now });
    const gitDir = join(workspace, ".musai");
    store = new Store({ ctx: { gitDir }, scope, now, claimTypes: claimTypesFrom([CLAIM_DECLARATION]) });
    await declareClaimTypes(store, [CLAIM_DECLARATION]);
    const index = new IndexDb(":memory:");
    await index.fold(store);
    await installModule(
      MODULE_NAME,
      versionString("1.0.0"),
      manifestWithContributions([BUILD]),
      new TextEncoder().encode(`bundle for ${MODULE_NAME}`),
      recordId({ marker: `build-for-${MODULE_NAME}` }),
      store,
      blobStoreOf(workspace),
      index,
    );
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("a claim at build 10 sees a policy over every build from 9 on", async () => {
    await store.putMany([{ kind: "claim", value: claimAtBuild("tenth", "10") }]);
    await store.putMany([
      {
        kind: "ruling",
        value: {
          kind: "ruling",
          schemaVersion: CURRENT_SCHEMA_VERSIONS.ruling,
          over: { type: CLAIM_TYPE, scope: { build: { kind: "from", value: "9" } } },
          verdict: "fails",
          reason: "every build from 9 on is out of support",
          brief: recordId({ marker: "policy-brief" }),
          supersedes: [],
        },
      },
    ]);

    // An unvouched policy leaves claims it bears on contested; numeric order puts 10 past 9.
    const status = await claimStatus.handler(
      { claim: slotFor(CLAIM_DECLARATION, { id: "tenth" }) },
      { workspace, scope, now },
    );
    expect(status.label).toBe("open");
    expect(status.reason).toBe("contested-authority");
  });

  // Only the declared numeric order puts build 10 inside a policy from build 9 on.

  test("a gate claim at build 10 that a vouched policy over every build from 9 on rules is not awaiting an answer", async () => {
    const [tenth, eighth] = await store.putMany([
      { kind: "claim", value: claimAtBuild("tenth", "10", "judgment") },
      { kind: "claim", value: claimAtBuild("eighth", "8", "judgment") },
    ]);
    await store.putMany([{ kind: "case", value: caseCiting("builds-case", [tenth!, eighth!]) }]);
    await vouchedPolicyFromBuildNine(store, "2026-08-31T00:00:00.000Z");

    const pending = await runHandler(gatePending, {}, { workspace, scope, now });

    expect(pending.gates.map((gate) => gate.claim)).toEqual([eighth!]);
  });

  test("a case whose claim at build 10 a later policy over every build from 9 on reaches is as recent as that policy", async () => {
    await buildModule(CORE_MODULE_DIR, store, { blobs: blobStoreOf(workspace), index: await foldedIndex(store), now });
    const [tenth] = await store.putMany([{ kind: "claim", value: claimAtBuild("tenth", "10") }]);
    await store.putMany([{ kind: "case", value: caseCiting("recent-case", [tenth!]) }]);
    const dayLater = "2026-09-01T00:00:00.000Z";
    await vouchedPolicyFromBuildNine(
      new Store({
        ctx: { gitDir: join(workspace, ".musai") },
        scope,
        now: fixedClock(dayLater),
        claimTypes: claimTypesFrom([CLAIM_DECLARATION]),
      }),
      dayLater,
    );

    const listed = await runHandler(viewRun, {}, { workspace, scope, now: fixedClock(dayLater) });

    // Git records seconds and spells UTC as `Z` or `+00:00` by version, so the instant is compared.
    expect(listed.rows).toMatchObject([{ slug: "recent-case" }]);
    const [row] = listed.rows as Array<{ recency: string }>;
    expect(Date.parse(row!.recency)).toBe(Date.parse(dayLater));
  }, 120_000);
});
