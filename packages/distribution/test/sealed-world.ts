import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type OperationContext, openWorkspace, runHandler } from "@musai/api-core";
import { buildModule } from "@musai/devkit";
import {
  type Audience,
  type CaseRecord,
  type ClaimRecord,
  type ClaimTypeDeclaration,
  CURRENT_SCHEMA_VERSIONS,
  claimTypesFrom,
  type EvidenceEdge,
  type RecordId,
  type RunRecipe,
  recordId,
  slotFor,
  versionString,
} from "@musai/records";
import { STATION_IMAGE_CONFIG_KEY, stationImageFromConfig, stationRecipe } from "@musai/run";
import { initWorkspace, MUSAI_DIR, readTrustBranch, Store } from "@musai/store";
import {
  allowedSignersLine,
  blobStoreOf,
  declareClaimTypes,
  fixedClock,
  fixtureRunRecord,
  foldedIndex,
  type TestKey,
  writeTrustFile,
} from "@musai/test-support";
import { onTestFinished } from "vitest";
import { checkEvaluation } from "../src/evaluation.js";
import { claimStatus } from "../src/ops/claim.js";
import { releaseSeal } from "../src/ops/release.js";

const CORE_MODULE_DIR = fileURLToPath(new URL("../../core-module", import.meta.url));
/** A module whose rule asks for a record by id, read from its condition, and for a run. */
const RECORD_NEED_MODULE_DIR = fileURLToPath(new URL("./fixtures/record-need", import.meta.url));
export const RECORD_NEED_RULE = "record-need/cites-a-record";
/** The run the record-need rule asks for beside its record. */
const CLEAN_EXIT: RunRecipe = {
  command: ["node", "-e", "process.exit(0)"],
  workingDirectory: "/",
  environment: {},
  declared: [],
  substrates: [],
  isolation: "hygiene",
};
const STATION_IMAGE = `registry.example/station@sha256:${"5".repeat(64)}`;
const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: "musai.clearance-test/claim@1", identityDimensions: ["id"] };
const CLAIM_TYPES = claimTypesFrom([CLAIM_DECLARATION]);
export const PUBLISHER = "publisher@example.test";
export const WRITER = "writer" as Audience;
export const SCOPE = "default";
export const CANARY = "canary-4f1d9b: the sealed record's own words";
export const now = fixedClock("2026-10-09T00:00:00.000Z");

export const opensshAvailable =
  spawnSync("ssh-keygen", ["-Y", "check-novalidate"], { stdio: "ignore" }).error === undefined;

export const SEALED = fixtureRunRecord(CANARY);
export const SEALED_ID = recordId(SEALED);

export function slotOf(id: string): string {
  return slotFor(CLAIM_DECLARATION, { id });
}

export function claim(
  id: string,
  conditions: Record<string, string>,
  evidence: readonly EvidenceEdge[] = [],
  rendering = id,
): ClaimRecord {
  return {
    kind: "claim",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: CLAIM_DECLARATION.type,
    about: [],
    slot: slotOf(id),
    conditions: { id, ...conditions },
    canonical: { statement: id },
    rendering,
    evidence: [...evidence],
    exclusiveGroup: null,
  };
}

export function caseCiting(slug: string, claims: readonly RecordId[]): CaseRecord {
  return {
    kind: "case",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.case,
    type: null,
    slug,
    claims: [...claims],
    preset: { module: "musai.core", contribution: "musai.core/bare", moduleRecord: recordId({ marker: slug }) },
    projectCommit: "0".repeat(40),
    overrides: {},
    evaluatorVersion: versionString("1"),
  };
}

export function receiptEdge(run: RecordId): EvidenceEdge {
  return {
    run,
    selector: { module: "musai.core", parser: "exit-code", version: versionString("1"), key: "result" },
    item: recordId({ run, key: "result" }),
  };
}

/** One scope seen two ways: by its author, and by a station cleared to `writer`. */
export interface World {
  readonly workspace: string;
  readonly store: Store;
  readonly key: TestKey;
  readonly author: OperationContext;
  readonly station: OperationContext;
}

/** A workspace `key` may seal in, declaring `writer`; its directory is pushed onto `scratch`. */
export async function emptyWorld(key: TestKey, scratch: string[]): Promise<World> {
  const workspace = await mkdtemp(join(tmpdir(), "musai-clearance-"));
  scratch.push(workspace);
  const { gitDir } = await initWorkspace(workspace, { now });
  await writeTrustFile({ gitDir }, "allowed-signers", allowedSignersLine(key));
  await writeTrustFile({ gitDir }, "roles", `${key.principal} owner any\n`);
  await writeTrustFile({ gitDir }, "audiences", "writer\n");
  const store = new Store({ ctx: { gitDir }, scope: SCOPE, now, claimTypes: CLAIM_TYPES });
  await declareClaimTypes(store, [CLAIM_DECLARATION]);
  const author: OperationContext = { workspace, scope: SCOPE, now, via: "tty", principalName: PUBLISHER };
  return { workspace, store, key, author, station: { ...author, clearance: WRITER } };
}

export async function seal(world: World, subject: RecordId, closure?: boolean): Promise<RecordId> {
  const input = { id: subject, from: WRITER, key: world.key.keyPath, ...(closure === undefined ? {} : { closure }) };
  const sealed = await runHandler(releaseSeal, input, world.author);
  return sealed.minted[0]!.id as RecordId;
}

/** Both modules built, and a claim whose rule asks for the sealed record, cited by a case. */
export async function restingWorld(
  key: TestKey,
  scratch: string[],
): Promise<World & { readonly restsOn: RecordId; readonly stationRun: RecordId }> {
  const world = await emptyWorld(key, scratch);
  for (const dir of [CORE_MODULE_DIR, RECORD_NEED_MODULE_DIR]) {
    await buildModule(dir, world.store, {
      blobs: blobStoreOf(world.workspace),
      index: await foldedIndex(world.store),
      now,
    });
  }
  const [restsOn] = await world.store.putMany([
    { kind: "claim", value: claim("rests-on", { [RECORD_NEED_RULE]: SEALED_ID }) },
  ]);
  await world.store.putMany([{ kind: "case", value: caseCiting("rests", [restsOn!]) }]);
  return { ...world, restsOn: restsOn!, stationRun: await answerStationRun(world) };
}

/** The record-need module built again at `at`, so its build is a record of its own. */
export async function rebuildRecordNeed(world: World, at: string): Promise<void> {
  await buildModule(RECORD_NEED_MODULE_DIR, world.store, {
    blobs: blobStoreOf(world.workspace),
    index: await foldedIndex(world.store),
    now: fixedClock(at),
  });
}

/** A station image configured and the station's own receipt for the rule's run, so a station
 * performs the claim on a machine with no container engine. */
export async function answerStationRun(world: World, output = ""): Promise<RecordId> {
  const trust = { gitDir: join(world.workspace, MUSAI_DIR) };
  const { values } = (await readTrustBranch(trust)).config;
  const configured = { ...values, [STATION_IMAGE_CONFIG_KEY]: STATION_IMAGE };
  await writeTrustFile(trust, "config.json", `${JSON.stringify(configured)}\n`);
  const image = stationImageFromConfig({ values: configured })!;
  const clean = fixtureRunRecord(output);
  const [run] = await world.store.putMany([
    {
      kind: "run",
      value: {
        ...clean,
        recipe: stationRecipe(CLEAN_EXIT, { clearance: WRITER, image, musaiDir: trust.gitDir }),
        observation: {
          ...clean.observation,
          resolved: [image],
          isolationHeld: "container",
          startedAt: now(),
          finishedAt: now(),
        },
      },
    },
  ]);
  return run!;
}

/** The latest evaluation of the claim resting on the sealed record, as `context` reads it. */
export async function latestUnder(context: OperationContext): Promise<RecordId | undefined> {
  const opened = await openWorkspace(context);
  onTestFinished(() => opened.close());
  const restsOn = opened.index.claimAtSlot(slotOf("rests-on"))!.record as ClaimRecord;
  return checkEvaluation(opened.index, restsOn, () => true, opened.clearance)?.evaluation.id;
}

/** The sealed record landed and sealed, then the claim resting on it evaluated again; answers the
 * seal's id and the evaluation's. */
export async function sealAndEvaluate(world: World): Promise<readonly RecordId[]> {
  await world.store.putMany([{ kind: "run", value: SEALED }]);
  const sealId = await seal(world, SEALED_ID);
  await runHandler(claimStatus, { claim: slotOf("rests-on") }, world.author);
  return [sealId, (await latestUnder(world.author))!];
}

/** A claim whose rendering is the canary, landed and then sealed; answers its id and the seal's. */
export async function sealedClaim(world: World): Promise<readonly RecordId[]> {
  const [hidden] = await world.store.putMany([{ kind: "claim", value: claim("hidden", {}, [], CANARY) }]);
  return [hidden!, await seal(world, hidden!)];
}
