import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FoldContributions, FoldExtension } from "@musai/fold";
import { AmbiguousExclusiveGroupError, IndexDb, openIndexProvider, RuleRecordConflictError } from "@musai/fold";
import type {
  CaseRecord,
  ClaimRecord,
  ComputedRunRecord,
  ContributionEntry,
  DimensionRegistry,
  ModuleRecord,
  PerformedRunRecord,
} from "@musai/records";
import {
  type ClaimTypeDeclaration,
  CURRENT_SCHEMA_VERSIONS,
  claimTypesFrom,
  exactDecimal,
  type MusaiRecord,
  RECORD_KINDS,
  type RecordId,
  type RecordKind,
  recordId,
  recordPath,
  slotFor,
  timestamp,
  validateRecord,
  versionString,
} from "@musai/records";
import { RUNNER_PERFORMER } from "@musai/run";
import { type CommitChanges, gitCatFile, gitRevParse, Store, scopeRefName } from "@musai/store";
import {
  commitAroundTheStore,
  commitFilesAroundTheStore,
  type FixtureRepo,
  fixtureBrief,
  fixtureRunRecord,
  makeFixtureRepo,
  ownGit,
  rowsHeld,
  writeFixtureRecords,
} from "@musai/test-support";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { readFoldDeclarations } from "../src/module/fold-registry.js";

const CLAIM_TYPE = "musai.demo.claims/claim@1";
const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: CLAIM_TYPE, identityDimensions: ["id"] };
const CLAIM_TYPES = claimTypesFrom([CLAIM_DECLARATION]);

/** A fixture repository knowing this file's claim type, so every fixture claim validates. */
function makeRepo(scope?: string): Promise<FixtureRepo> {
  return makeFixtureRepo(scope, [CLAIM_DECLARATION]);
}

let repos: FixtureRepo[] = [];
let dbDirs: string[] = [];

afterEach(async () => {
  await Promise.all(repos.map((repo) => repo.cleanup()));
  await Promise.all(dbDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  repos = [];
  dbDirs = [];
});

async function makeDbPath(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "musai-index-fold-"));
  dbDirs.push(dir);
  return join(dir, name);
}

/** The slot a claim identified by `id` computes. */
function slotOf(id: string): string {
  return slotFor(CLAIM_DECLARATION, { id });
}

function claimAtSlot(id: string): ClaimRecord {
  const conditions = { id };
  const slot = slotOf(id);
  const run = recordId({ slot, purpose: "evidence source" });
  return {
    kind: "claim",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: CLAIM_TYPE,
    about: [`urn:example:${id}`],
    slot,
    conditions,
    canonical: { statement: `${id} holds` },
    rendering: `${id} holds.`,
    evidence: [
      {
        run: run as `sha256:${string}`,
        selector: { module: "musai.core", parser: "exit-code", version: versionString("1"), key: "exit-code" },
        item: recordId({ slot, item: "exit-code" }),
      },
    ],
    exclusiveGroup: null,
  };
}

function contributorAt(id: string, tag: string): ClaimRecord {
  const conditions = { id, tag };
  const slot = slotOf(id);
  const run = recordId({ slot, tag, purpose: "evidence source" });
  return {
    kind: "claim",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: CLAIM_TYPE,
    about: [`urn:example:${id}`],
    slot,
    conditions,
    canonical: { statement: `${id} holds via ${tag}` },
    rendering: `${id} holds via ${tag}.`,
    evidence: [
      {
        run: run as `sha256:${string}`,
        selector: {
          module: "musai.core",
          parser: "exit-code",
          version: versionString("1"),
          key: `exit-code-${tag}`,
        },
        item: recordId({ slot, tag, item: "exit-code" }),
      },
    ],
    exclusiveGroup: null,
  };
}

/** `contributorAt` with its `exclusiveGroup` a parameter, for contributors that disagree on it. */
function contributorWithGroup(id: string, tag: string, exclusiveGroup: string | null): ClaimRecord {
  return { ...contributorAt(id, tag), exclusiveGroup };
}

/** A case under `slug` citing `claims`, booked bare under the placeholder preset. */
function caseCiting(slug: string, claims: readonly RecordId[]): CaseRecord {
  return {
    kind: "case",
    schemaVersion: CURRENT_SCHEMA_VERSIONS.case,
    type: null,
    slug,
    claims: [...claims],
    preset: {
      module: "musai.core",
      contribution: "musai.core/default",
      moduleRecord: recordId({ marker: "preset" }),
    },
    projectCommit: "0".repeat(40),
    overrides: {},
    evaluatorVersion: versionString("1"),
    supersedes: [],
  };
}

/** The id a record would mint, computed without writing, so a test can search ids before git. */
function contentId(record: MusaiRecord): RecordId {
  const validation = validateRecord(record, { unregisteredClaimTypes: "refuse", claimTypes: CLAIM_TYPES });
  if (!validation.ok) {
    throw new Error(`test fixture built an invalid ${record.kind} record: ${validation.error}`);
  }
  return recordId(validation.record);
}

/** A tag whose contributor record mints an id on `side` of `silentId`, searched for rather than
 * hardcoded, so both orderings are exercised on real ids. */
function tagWithIdRelativeTo(id: string, exclusiveGroup: string, silentId: RecordId, side: "above" | "below"): string {
  const candidates = [
    "alpha",
    "bravo",
    "charlie",
    "delta",
    "echo",
    "foxtrot",
    "golf",
    "hotel",
    "india",
    "juliet",
    "kilo",
    "lima",
  ];
  for (const tag of candidates) {
    const candidateId = contentId(contributorWithGroup(id, tag, exclusiveGroup));
    if (side === "above" ? candidateId > silentId : candidateId < silentId) {
      return tag;
    }
  }
  throw new Error(`no candidate tag minted an id ${side} ${silentId} for slot ${id}; widen the candidate list`);
}

/** Writes three claims as three separate commits, returning each commit's sha in order. */
async function writeThreeCommits(repo: FixtureRepo): Promise<string[]> {
  const commits: string[] = [];
  for (let index = 0; index < 3; index++) {
    await writeFixtureRecords(repo, [{ kind: "claim", value: claimAtSlot(`slot-${index}`) }]);
    const tip = await gitRevParse(repo.ctx, scopeRefName(repo.scope));
    commits.push(tip!);
  }
  return commits;
}

async function digestOf(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

const MODULE_NAME = "musai.demo";

/** A module record naming a bundle never written, so folding it proves the fold resolves none. */
function moduleWithContributions(): ModuleRecord {
  return {
    kind: "module",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.module,
    name: MODULE_NAME,
    version: versionString("1"),
    manifest: {
      protocolVersion: 1,
      contributions: [
        {
          kind: "parser",
          id: `${MODULE_NAME}/exit-code`,
          version: versionString("1"),
          input: { type: "object" },
          output: { type: "object" },
          documentation: "Reads a run's exit code from its observation.",
        },
      ],
      sourceTree: { digest: { gitTree: "a".repeat(40) } },
      toolchain: [{ name: "node", version: versionString("24.0.0") }],
      packages: [],
    },
    bundle: recordId({ marker: "bundle-never-written" }),
    build: recordId({ marker: "build-never-written" }),
  };
}

/** A rule contribution under `moduleName`, by the bare name the module namespaces. */
function ruleContribution(name: string, moduleName = MODULE_NAME): ContributionEntry {
  return {
    kind: "rule",
    id: `${moduleName}/${name}`,
    version: versionString("1"),
    input: true,
    output: true,
    documentation: `The ${name} rule.`,
  };
}

/** A module record declaring `contribution` under the module its id namespaces, varied by `marker`
 * so two records of one name can declare one id, as a module rebuilt at a new path does. */
function moduleDeclaring(contribution: ContributionEntry, marker: string): ModuleRecord {
  return {
    ...moduleWithContributions(),
    name: contribution.id.slice(0, contribution.id.indexOf("/")),
    manifest: { ...moduleWithContributions().manifest, contributions: [contribution] },
    bundle: recordId({ marker }),
  };
}

/** A module declaring `contribution` whose id sorts below `above`, searched for among markers. */
function moduleDeclaringBelow(contribution: ContributionEntry, above: RecordId): ModuleRecord {
  for (const marker of ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"]) {
    const candidate = moduleDeclaring(contribution, marker);
    if (contentId(candidate) < above) {
      return candidate;
    }
  }
  throw new Error(`no bundle marker minted a module id below ${above}; widen the candidate list`);
}

/** Two module records declaring `contribution`, the later commit's with the lower id, so log
 * order and id order disagree. Answers both ids, earlier commit first. */
async function writeTieAcrossCommits(
  repo: FixtureRepo,
  contribution: ContributionEntry,
): Promise<[RecordId, RecordId]> {
  const earlier = moduleDeclaring(contribution, "tied-across-commits-earlier");
  const [earlierId] = await writeFixtureRecords(repo, [{ kind: "module", value: earlier }]);
  const [laterId] = await writeFixtureRecords(repo, [
    { kind: "module", value: moduleDeclaringBelow(contribution, earlierId!) },
  ]);
  return [earlierId!, laterId!];
}

/** Two module records declaring `contribution` in one commit; answers the ids in minting order. */
async function writeTieWithinCommit(repo: FixtureRepo, contribution: ContributionEntry): Promise<[RecordId, RecordId]> {
  const [first, second] = await writeFixtureRecords(repo, [
    { kind: "module", value: moduleDeclaring(contribution, "tied-within-commit-first") },
    { kind: "module", value: moduleDeclaring(contribution, "tied-within-commit-second") },
  ]);
  return [first!, second!];
}

/** The id the refusal fixture claims, holding bytes no record contract admits. */
const REFUSED_ID = `sha256:${"f".repeat(64)}` as RecordId;

describe("IndexDb.fold, applying commits and advancing the watermark together", () => {
  test("a fold over three commits applies all three and leaves the watermark at the tip", async () => {
    const repo = await makeRepo("fold-basic");
    repos.push(repo);
    const commits = await writeThreeCommits(repo);

    const dbPath = await makeDbPath("index.sqlite");
    const index = new IndexDb(dbPath);
    await index.fold(storeOf(repo));

    expect(index.watermark()).toBe(commits[2]);
    for (let i = 0; i < 3; i++) {
      expect(index.claimAtSlot(slotOf(`slot-${i}`))?.type).toBe(CLAIM_TYPE);
      expect(index.evidenceEdgesOf(slotOf(`slot-${i}`))).toHaveLength(1);
    }
  });

  test("a second fold with no new commits performs no writes", async () => {
    const repo = await makeRepo("fold-idempotent");
    repos.push(repo);
    await writeThreeCommits(repo);

    const dbPath = await makeDbPath("index.sqlite");
    const index = new IndexDb(dbPath);
    await index.fold(storeOf(repo));

    const before = await digestOf(dbPath);
    await index.fold(storeOf(repo));
    const after = await digestOf(dbPath);

    expect(after).toBe(before);
  });

  test("an interruption between commits leaves the watermark at the prior commit, and resuming completes the walk", async () => {
    const repo = await makeRepo("fold-interrupt-between");
    repos.push(repo);
    const commits = await writeThreeCommits(repo);

    const dbPath = await makeDbPath("index.sqlite");
    const index = new IndexDb(dbPath);

    await expect(
      index.fold(storeOf(repo), (event) => {
        if (event.commit === commits[2] && event.phase === "before-commit") {
          throw new Error("simulated crash between commits");
        }
      }),
    ).rejects.toThrow("simulated crash between commits");

    expect(index.watermark()).toBe(commits[1]);
    expect(index.claimAtSlot(slotOf("slot-2"))).toBeUndefined();

    await index.fold(storeOf(repo));

    expect(index.watermark()).toBe(commits[2]);
    expect(index.claimAtSlot(slotOf("slot-2"))?.type).toBe(CLAIM_TYPE);
  });

  test("an interruption inside a commit's transaction leaves neither its rows nor the watermark advanced", async () => {
    const repo = await makeRepo("fold-interrupt-mid");
    repos.push(repo);
    const commits = await writeThreeCommits(repo);

    const dbPath = await makeDbPath("index.sqlite");
    const index = new IndexDb(dbPath);

    await expect(
      index.fold(storeOf(repo), (event) => {
        if (event.commit === commits[2] && event.phase === "mid-transaction") {
          throw new Error("simulated crash mid-transaction");
        }
      }),
    ).rejects.toThrow("simulated crash mid-transaction");

    expect(index.watermark()).toBe(commits[1]);
    expect(index.claimAtSlot(slotOf("slot-2"))).toBeUndefined();
  });
});

describe("IndexDb.fold, a scope whose ref moved off the folded history", () => {
  /** Rewinds the scope to `commit` and writes one record past it, as a force-push would. */
  async function forceMoveTo(repo: FixtureRepo, commit: string): Promise<string> {
    await ownGit(repo.ctx.gitDir, ["update-ref", scopeRefName(repo.scope), commit]);
    await writeFixtureRecords(repo, [{ kind: "claim", value: claimAtSlot("rewritten") }]);
    return (await gitRevParse(repo.ctx, scopeRefName(repo.scope)))!;
  }

  test("a fold refuses a watermark the scope's tip no longer descends from", async () => {
    const repo = await makeRepo("fold-force-moved");
    repos.push(repo);
    const commits = await writeThreeCommits(repo);
    const dbPath = await makeDbPath("index.sqlite");
    const index = new IndexDb(dbPath);
    await index.fold(storeOf(repo));
    const tip = await forceMoveTo(repo, commits[0]!);

    const refusal = await index.fold(storeOf(repo)).then(
      () => null,
      (error: unknown) => error,
    );

    expect(refusal).toMatchObject({ reason: "record-corrupted" });
    const detail = (refusal as Error).message;
    expect(detail).toContain(commits[2]!);
    expect(detail).toContain(tip);
    expect(detail).toContain(dirname(dbPath));
    expect(index.watermark()).toBe(commits[2]);
  });

  test("a fold refuses a watermark the repository no longer holds at all, once the old history was pruned", async () => {
    const repo = await makeRepo("fold-pruned");
    repos.push(repo);
    const commits = await writeThreeCommits(repo);
    const dbPath = await makeDbPath("index.sqlite");
    const index = new IndexDb(dbPath);
    await index.fold(storeOf(repo));
    await forceMoveTo(repo, commits[0]!);
    await ownGit(repo.ctx.gitDir, ["reflog", "expire", "--expire=now", "--all"]);
    await ownGit(repo.ctx.gitDir, ["gc", "--quiet", "--prune=now"]);

    await expect(index.fold(storeOf(repo))).rejects.toMatchObject({ reason: "record-corrupted" });
  });

  test("a fold rebuilt after a force-move holds only the new history", async () => {
    const repo = await makeRepo("fold-force-rebuilt");
    repos.push(repo);
    const commits = await writeThreeCommits(repo);
    const dbPath = await makeDbPath("index.sqlite");
    await new IndexDb(dbPath).fold(storeOf(repo));
    const tip = await forceMoveTo(repo, commits[0]!);

    await rm(dirname(dbPath), { recursive: true, force: true });
    await mkdir(dirname(dbPath), { recursive: true });
    const rebuilt = new IndexDb(dbPath);
    await rebuilt.fold(storeOf(repo));

    expect(rebuilt.watermark()).toBe(tip);
    expect(rebuilt.claimAtSlot(slotOf("rewritten"))?.type).toBe(CLAIM_TYPE);
    expect(rebuilt.claimAtSlot(slotOf("slot-1"))).toBeUndefined();
    expect(rebuilt.claimAtSlot(slotOf("slot-2"))).toBeUndefined();
  });
});

/** The watermark a second connection reads: only what a transaction landed. */
function watermarkLanded(path: string): string | null {
  const raw = openIndexProvider().openReadOnly(path);
  try {
    const row = raw.prepare("SELECT commit_sha FROM watermark WHERE id = 0").get() as { commit_sha: string | null };
    return row.commit_sha;
  } finally {
    raw.close();
  }
}

describe("IndexDb.fold, a history longer than one transaction's group of commits", () => {
  const LONG_HISTORY = 300;
  let repo: FixtureRepo;
  const commits: string[] = [];

  beforeAll(async () => {
    repo = await makeRepo("fold-long-history");
    const store = storeOf(repo);
    for (let index = 0; index < LONG_HISTORY; index++) {
      await store.put("claim", claimAtSlot(`long-${index}`));
      commits.push((await store.tip())!);
    }
  }, 300_000);

  afterAll(async () => {
    await repo.cleanup();
  });

  test("a walk across a group boundary folds to the same index as walks that each fit in one", async () => {
    const whole = await makeDbPath("whole.sqlite");
    await new IndexDb(whole).fold(storeOf(repo));

    const pieces = await makeDbPath("pieces.sqlite");
    const index = new IndexDb(pieces);
    for (let stop = 50; stop < LONG_HISTORY; stop += 50) {
      await expect(
        index.fold(storeOf(repo), (event) => {
          if (event.commit === commits[stop] && event.phase === "before-commit") {
            throw new Error(`a stop before commit ${stop}`);
          }
        }),
      ).rejects.toThrow(`a stop before commit ${stop}`);
      expect(watermarkLanded(pieces)).toBe(commits[stop - 1]);
    }
    await index.fold(storeOf(repo));

    expect(index.watermark()).toBe(commits[LONG_HISTORY - 1]);
    expect(rowsHeld(pieces)).toEqual(rowsHeld(whole));
  });

  test("an interruption in a later group leaves the watermark at the commit before it", async () => {
    const path = await makeDbPath("index.sqlite");
    const index = new IndexDb(path);

    await expect(
      index.fold(storeOf(repo), (event) => {
        if (event.commit === commits[280] && event.phase === "before-commit") {
          throw new Error("simulated crash in the second group");
        }
      }),
    ).rejects.toThrow("simulated crash in the second group");

    expect(watermarkLanded(path)).toBe(commits[279]);
    expect(index.claimAtSlot(slotOf("long-279"))?.type).toBe(CLAIM_TYPE);
    expect(index.claimAtSlot(slotOf("long-280"))).toBeUndefined();
  });
});

/** The claims one case cites, as the `case_claims` table at `path` holds them. */
function citationsHeld(path: string, caseId: RecordId): RecordId[] {
  const raw = openIndexProvider().open(path);
  try {
    const rows = raw
      .prepare("SELECT claim_id FROM case_claims WHERE case_id = ? ORDER BY claim_id ASC")
      .all(caseId) as Array<{ claim_id: string }>;
    return rows.map((row) => row.claim_id as RecordId);
  } finally {
    raw.close();
  }
}

describe("IndexDb.fold, a case naming one claim more than once", () => {
  test("applies the commit, holds the citation once, and answers the claim's case identically after a rebuild", async () => {
    const repo = await makeRepo("fold-repeated-citation");
    repos.push(repo);

    const [claimId] = await writeFixtureRecords(repo, [{ kind: "claim", value: contributorAt("cited-twice", "only") }]);
    const [caseId] = await writeFixtureRecords(repo, [
      { kind: "case", value: caseCiting("cites-one-claim-twice", [claimId!, claimId!]) },
    ]);

    const incrementalPath = await makeDbPath("incremental.sqlite");
    const incremental = new IndexDb(incrementalPath);
    await incremental.fold(storeOf(repo));

    // The watermark at the tip shows the case's commit applied rather than rolled back.
    expect(incremental.watermark()).toBe(await gitRevParse(repo.ctx, scopeRefName(repo.scope)));
    expect(incremental.caseForClaim(claimId!)?.id).toBe(caseId);
    expect(citationsHeld(incrementalPath, caseId!)).toEqual([claimId]);

    const rebuiltPath = await makeDbPath("rebuilt.sqlite");
    const rebuilt = new IndexDb(rebuiltPath);
    await rebuilt.fold(storeOf(repo));

    expect(rebuilt.caseForClaim(claimId!)).toEqual(incremental.caseForClaim(claimId!));
    expect(citationsHeld(rebuiltPath, caseId!)).toEqual(citationsHeld(incrementalPath, caseId!));
  });
});

/** The contribution ids the rebuild fixture's two deliberate ties are declared under; the first
 * has a module of its own, since only the record a name resolves to answers for an id. */
const TIED_ACROSS_MODULE_NAME = "musai.demo.tied-across";
const TIED_ACROSS_COMMITS = ruleContribution("tied-across-commits", TIED_ACROSS_MODULE_NAME);
const TIED_WITHIN_COMMIT = ruleContribution("tied-within-commit");

/** The module contributing the fold table, under its own name so rule re-pins never move it. */
const FOLD_MODULE_NAME = "musai.demo.fold";
const FOLD_CONTRIBUTION_ID = `${FOLD_MODULE_NAME}/claims`;
/** That contribution id's SQL name, spelled out as a reader would find the table. */
const FOLD_TABLE = "musai_demo_fold_claims";

function foldContribution(): ContributionEntry {
  return {
    kind: "fold",
    id: FOLD_CONTRIBUTION_ID,
    version: versionString("1"),
    input: true,
    output: {
      type: "object",
      additionalProperties: false,
      required: ["rows"],
      properties: {
        rows: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "position"],
            properties: { id: { type: "string" }, position: { type: "integer" } },
          },
        },
      },
      indexes: [["id"]],
    },
    documentation: "One row per claim, carrying its id and where in its own commit it landed.",
  };
}

/** The module record declaring that table, naming a bundle never written: no host runs here. */
function foldModule(): ModuleRecord {
  const base = moduleWithContributions();
  return {
    ...base,
    name: FOLD_MODULE_NAME,
    manifest: { ...base.manifest, contributions: [foldContribution()] },
    bundle: recordId({ marker: "fold-bundle-never-written" }),
  };
}

/** One row per claim, as a plain function: handing the fold its row functions proves it never
 * reaches for a host itself. */
const claimRows: FoldExtension["rows"] = async (record) =>
  record.kind === "claim" ? [{ id: record.id, position: record.position }] : [];

/** The index's own declarations, with the row function above for every table. */
function foldContributions(index: IndexDb): FoldContributions {
  return {
    declarations: () => readFoldDeclarations(index, index.engine()).tables,
    extensions: async (tables) => ({
      extensions: tables.map((table) => ({ table, rows: claimRows })),
      close: async () => {},
    }),
  };
}

/** Every row of the contributed table at `path`, in key order. */
function contributedRowsHeld(path: string): Array<Record<string, unknown>> {
  const raw = openIndexProvider().open(path);
  try {
    return raw
      .prepare(`SELECT record_id, ordinal, id, position FROM ${FOLD_TABLE} ORDER BY record_id ASC, ordinal ASC`)
      .all() as Array<Record<string, unknown>>;
  } finally {
    raw.close();
  }
}

/** A scope holding every shape the index derives a row from and one record of each of the nine
 * kinds, so a rebuild's agreement covers the whole fold. */
async function writeRichScope(repo: FixtureRepo): Promise<{
  readonly slots: readonly string[];
  readonly group: string;
  readonly predecessor: RecordId;
  readonly artifact: RecordId;
  readonly attacked: RecordId;
  readonly recipeId: RecordId;
  /** The rule record replacing the fixture's first, the live record naming its contribution. */
  readonly ruleSuccessor: RecordId;
  /** The fixture case's slug, so the lookup by slug asks about a case that exists. */
  readonly caseSlug: string;
  /** A claim the fixture case cites, so the lookup by cited claim is asked non-vacuously. */
  readonly citedClaim: RecordId;
  /** One of two principals attesting a record, so the filtered lookup answers fewer than both. */
  readonly attestingPrincipal: string;
  /** One folded record of each kind, for the lookup by id to be asked about every kind. */
  readonly byKind: Readonly<Record<RecordKind, RecordId>>;
}> {
  const [predecessor] = await writeFixtureRecords(repo, [
    { kind: "claim", value: contributorAt("corrected", "first") },
  ]);
  await writeFixtureRecords(repo, [
    { kind: "claim", value: { ...contributorAt("corrected", "second"), supersedes: [predecessor!] } },
  ]);

  const group = "a menu of two";
  const [menuA, menuB] = await writeFixtureRecords(repo, [
    { kind: "claim", value: contributorWithGroup("menu-a", "only", group) },
    { kind: "claim", value: contributorWithGroup("menu-b", "only", group) },
  ]);

  const [caseId] = await writeFixtureRecords(repo, [
    { kind: "case", value: caseCiting("rebuild-case", [menuA!, menuB!]) },
  ]);

  const plain = { ...claimAtSlot("ruled"), conditions: { id: "ruled", chapter: "04" } };
  const [ruledId] = await writeFixtureRecords(repo, [{ kind: "claim", value: { ...plain, slot: slotOf("ruled") } }]);
  const [rulingId] = await writeFixtureRecords(repo, [
    {
      kind: "ruling",
      value: {
        kind: "ruling",
        schemaVersion: CURRENT_SCHEMA_VERSIONS.ruling,
        over: { claim: ruledId! },
        verdict: "holds",
        reason: "the rebuild fixture's own ruling over one claim",
        brief: recordId({ marker: "rebuild-brief" }),
        supersedes: [],
      },
    },
    {
      kind: "ruling",
      value: {
        kind: "ruling",
        schemaVersion: CURRENT_SCHEMA_VERSIONS.ruling,
        over: { type: CLAIM_TYPE, scope: { chapter: { kind: "range", from: "01", to: "09" } } },
        verdict: "fails",
        reason: "the rebuild fixture's own policy over a type at a scope",
        brief: recordId({ marker: "rebuild-policy-brief" }),
        supersedes: [],
      },
    },
  ]);

  const recipe = {
    command: ["true"],
    workingDirectory: "/",
    environment: {},
    declared: [],
    substrates: [],
    isolation: "hygiene" as const,
  };
  const observationAt = (startedAt: string) => ({
    resolved: [],
    isolationHeld: "hygiene" as const,
    binaries: [],
    bindings: [],
    output: "the rebuild fixture's own receipt",
    outputLossy: false,
    exitCode: 0,
    scrubbed: [],
    startedAt: timestamp(startedAt),
    finishedAt: timestamp(startedAt),
    reads: [],
    cost: {},
  });
  let runId: RecordId | undefined;
  for (const startedAt of ["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"]) {
    [runId] = await writeFixtureRecords(repo, [
      {
        kind: "run",
        value: {
          kind: "run",
          schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
          runKind: "run",
          performer: RUNNER_PERFORMER,
          determinism: "nondeterministic",
          recipe,
          observation: observationAt(startedAt),
          supersedes: [],
        },
      },
    ]);
  }

  const [moduleId] = await writeFixtureRecords(repo, [{ kind: "module", value: moduleWithContributions() }]);
  await writeTieAcrossCommits(repo, TIED_ACROSS_COMMITS);
  await writeTieWithinCommit(repo, TIED_WITHIN_COMMIT);
  await writeFixtureRecords(repo, [{ kind: "module", value: foldModule() }]);

  const [ruleId] = await writeFixtureRecords(repo, [
    {
      kind: "rule",
      value: {
        kind: "rule",
        schemaVersion: CURRENT_SCHEMA_VERSIONS.rule,
        name: "rebuild-rule",
        scope: { chapter: "04" },
        weight: exactDecimal("1"),
        supersedes: [],
        contribution: TIED_WITHIN_COMMIT.id,
      },
    },
  ]);
  const [ruleSuccessor] = await writeFixtureRecords(repo, [
    {
      kind: "rule",
      value: {
        kind: "rule",
        schemaVersion: CURRENT_SCHEMA_VERSIONS.rule,
        name: "rebuild-rule",
        scope: { chapter: { kind: "range", from: "01", to: "09" } },
        weight: exactDecimal("1"),
        supersedes: [ruleId!],
        contribution: TIED_WITHIN_COMMIT.id,
      },
    },
    {
      kind: "rule",
      value: {
        kind: "rule",
        schemaVersion: CURRENT_SCHEMA_VERSIONS.rule,
        name: "rebuild-lesson",
        scope: { chapter: "04" },
        weight: exactDecimal("1"),
        supersedes: [],
        contribution: null,
      },
    },
  ]);

  const attestationBy = (principal: string) => ({
    kind: "attestation" as const,
    schemaVersion: CURRENT_SCHEMA_VERSIONS.attestation,
    subject: ruledId!,
    principal,
    principalClass: "person" as const,
    via: "signature" as const,
    purpose: "made" as const,
    at: timestamp("2026-01-03T00:00:00.000Z"),
    supersedes: [],
  });
  const [attestationId] = await writeFixtureRecords(repo, [
    { kind: "attestation", value: attestationBy(`key:SHA256:${"a".repeat(43)}`) },
    { kind: "attestation", value: attestationBy(`key:SHA256:${"b".repeat(43)}`) },
  ]);

  const cited = recordId({ marker: "rebuild-cited" });
  const label = cited.slice("sha256:".length, "sha256:".length + 12);
  const [artifact] = await writeFixtureRecords(repo, [
    {
      kind: "artifact",
      value: {
        kind: "artifact",
        schemaVersion: CURRENT_SCHEMA_VERSIONS.artifact,
        case: caseId!,
        lifecycle: "drafted",
        content: [`Cited.[^${label}]`, "", "## Receipts", "", `[^${label}]: ${cited}`, ""].join("\n"),
        format: "text/markdown",
        supersedes: [],
      },
    },
  ]);

  const [argumentId] = await writeFixtureRecords(repo, [
    {
      kind: "argument",
      value: {
        kind: "argument",
        schemaVersion: CURRENT_SCHEMA_VERSIONS.argument,
        target: ruledId!,
        reason: "the rebuild fixture's own argument against one claim",
        evidence: [],
        premises: [],
        supersedes: [],
      },
    },
  ]);

  // Bytes no record contract admits, committed around the store, so a refusal is compared too.
  await commitAroundTheStore(repo, recordPath("claim", REFUSED_ID), new TextEncoder().encode("not a record"));

  return {
    slots: ["corrected", "menu-a", "menu-b", "ruled"].map(slotOf),
    group,
    predecessor: predecessor!,
    artifact: artifact!,
    attacked: ruledId!,
    recipeId: recordId(recipe),
    ruleSuccessor: ruleSuccessor!,
    caseSlug: "rebuild-case",
    citedClaim: menuA!,
    attestingPrincipal: `key:SHA256:${"a".repeat(43)}`,
    byKind: {
      claim: ruledId!,
      argument: argumentId!,
      run: runId!,
      ruling: rulingId!,
      rule: ruleSuccessor!,
      case: caseId!,
      artifact: artifact!,
      attestation: attestationId!,
      module: moduleId!,
    },
  };
}

/** An index and its file, so a check can read the file's tables beside asking the index. */
interface OpenedIndex {
  readonly index: IndexDb;
  readonly path: string;
}

/** The ids the `records` table at `path` holds for one kind, sorted. */
function recordIdsHeld(path: string, kind: RecordKind): RecordId[] {
  const raw = openIndexProvider().open(path);
  try {
    const rows = raw.prepare("SELECT id FROM records WHERE kind = ? ORDER BY id ASC").all(kind) as Array<{
      id: string;
    }>;
    return rows.map((row) => row.id as RecordId);
  } finally {
    raw.close();
  }
}

/** The ids a case's recency reads: the case, a claim it cites and the artifact citing it. */
function caseRelated(scope: Awaited<ReturnType<typeof writeRichScope>>): RecordId[] {
  return [scope.byKind.case, scope.citedClaim, scope.artifact];
}

/** Every question the index answers, asked of two indexes, each answer first asserted non-empty.
 * Per kind, the store's ids are exactly the folded ids plus the refused ones. */
async function expectSameAnswers(
  rebuilt: OpenedIndex,
  incremental: OpenedIndex,
  scope: Awaited<ReturnType<typeof writeRichScope>>,
  store: Store,
): Promise<void> {
  expect(incremental.index.claimsInGroup(scope.group)).toHaveLength(2);
  expect(incremental.index.successorsOf(scope.predecessor)).toHaveLength(1);
  expect(incremental.index.receiptByRecipe(scope.recipeId)).toBeDefined();
  expect(incremental.index.contributionsOf("rule")).toHaveLength(2);
  expect(incremental.index.contributionById(TIED_ACROSS_COMMITS.id)).toBeDefined();
  expect(incremental.index.contributionById(TIED_WITHIN_COMMIT.id)).toBeDefined();
  expect(incremental.index.ruleFor(TIED_WITHIN_COMMIT.id)?.id).toBe(scope.ruleSuccessor);
  expect(incremental.index.anchorsOf(scope.artifact)).toHaveLength(1);
  expect(incremental.index.refusals()).toHaveLength(1);
  expect(incremental.index.refusalFor(REFUSED_ID)).toBeDefined();
  expect(incremental.index.argumentsAgainst(scope.attacked)).toHaveLength(1);
  expect(incremental.index.caseBySlug(scope.caseSlug)).toBeDefined();
  expect(incremental.index.caseForClaim(scope.citedClaim)).toBeDefined();
  expect(incremental.index.cases()).toHaveLength(1);
  expect(incremental.index.caseSlugs()).toEqual([scope.caseSlug]);
  expect(incremental.index.artifactsOfCase(scope.byKind.case)).toHaveLength(1);
  expect(incremental.index.attestationsBySubject(scope.attacked)).toHaveLength(2);
  expect(incremental.index.attestationsBySubject(scope.attacked, scope.attestingPrincipal)).toHaveLength(1);
  expect(incremental.index.latestCommitTimeOf(caseRelated(scope))).not.toBeNull();
  // The within-commit rule records share one name, so each other module resolves beside them.
  const installed = incremental.index.installedModuleRecords();
  expect(installed.map((each) => each.name)).toEqual([
    MODULE_NAME,
    "musai.demo.claims",
    FOLD_MODULE_NAME,
    TIED_ACROSS_MODULE_NAME,
  ]);
  const ruleModule = installed.find((each) => each.name === MODULE_NAME);
  expect(ruleModule?.id).toBe(incremental.index.contributionById(TIED_WITHIN_COMMIT.id)?.moduleRecord);
  expect(incremental.index.contributionsOf("rule").map((row) => row.entry.id)).toEqual([
    TIED_ACROSS_COMMITS.id,
    TIED_WITHIN_COMMIT.id,
  ]);
  expect(incremental.index.contributionsOf("fold")[0]?.entry.id).toBe(FOLD_CONTRIBUTION_ID);
  // A contributed table is compared like any fold, or it could drift with the proof passing.
  expect(contributedRowsHeld(incremental.path)).not.toHaveLength(0);
  expect(contributedRowsHeld(rebuilt.path)).toEqual(contributedRowsHeld(incremental.path));
  expect(scope.slots.flatMap((slot) => incremental.index.rulingsFor(slot, new Map()))).not.toHaveLength(0);
  expect(scope.slots.flatMap((slot) => incremental.index.evidenceEdgesOf(slot))).not.toHaveLength(0);
  for (const kind of RECORD_KINDS) {
    expect(incremental.index.recordById(scope.byKind[kind])?.record.kind).toBe(kind);
  }
  // Every event from the beginning, one per record of a kind that raises one, in log order.
  const events = incremental.index.eventsAfter();
  expect(events).not.toHaveLength(0);
  expect(events?.map((event) => event.kind)).toEqual([
    "module.installed",
    "claim.put",
    "claim.put",
    "claim.put",
    "claim.put",
    "case.booked",
    "claim.put",
    "ruling.made",
    "ruling.made",
    "run.recorded",
    "run.recorded",
    "module.installed",
    "module.installed",
    "pin.changed",
    "pin.changed",
    "pin.changed",
    "module.installed",
    "attestation.made",
    "attestation.made",
  ]);
  for (const event of events ?? []) {
    const raised = incremental.index.recordById(event.recordId);
    expect(raised).toBeDefined();
    expect(event.about).toBe(raised?.record.kind === "module" ? raised.record.name : event.recordId);
  }

  for (const slot of scope.slots) {
    expect(rebuilt.index.claimAtSlot(slot)).toEqual(incremental.index.claimAtSlot(slot));
    expect(rebuilt.index.contributorsAtSlot(slot)).toEqual(incremental.index.contributorsAtSlot(slot));
    expect(rebuilt.index.evidenceEdgesOf(slot)).toEqual(incremental.index.evidenceEdgesOf(slot));
    expect(rebuilt.index.rulingsFor(slot, new Map())).toEqual(incremental.index.rulingsFor(slot, new Map()));
  }
  expect(rebuilt.index.claimsInGroup(scope.group)).toEqual(incremental.index.claimsInGroup(scope.group));
  expect(rebuilt.index.successorsOf(scope.predecessor)).toEqual(incremental.index.successorsOf(scope.predecessor));
  expect(rebuilt.index.receiptByRecipe(scope.recipeId)).toEqual(incremental.index.receiptByRecipe(scope.recipeId));
  expect(rebuilt.index.contributionsOf("rule")).toEqual(incremental.index.contributionsOf("rule"));
  for (const tied of [TIED_ACROSS_COMMITS, TIED_WITHIN_COMMIT]) {
    expect(rebuilt.index.contributionById(tied.id)).toEqual(incremental.index.contributionById(tied.id));
  }
  expect(rebuilt.index.ruleFor(TIED_WITHIN_COMMIT.id)).toEqual(incremental.index.ruleFor(TIED_WITHIN_COMMIT.id));
  expect(rebuilt.index.anchorsOf(scope.artifact)).toEqual(incremental.index.anchorsOf(scope.artifact));
  expect(rebuilt.index.refusals()).toEqual(incremental.index.refusals());
  expect(rebuilt.index.refusalFor(REFUSED_ID)).toEqual(incremental.index.refusalFor(REFUSED_ID));
  expect(rebuilt.index.argumentsAgainst(scope.attacked)).toEqual(incremental.index.argumentsAgainst(scope.attacked));
  expect(rebuilt.index.caseBySlug(scope.caseSlug)).toEqual(incremental.index.caseBySlug(scope.caseSlug));
  expect(rebuilt.index.caseForClaim(scope.citedClaim)).toEqual(incremental.index.caseForClaim(scope.citedClaim));
  expect(rebuilt.index.cases()).toEqual(incremental.index.cases());
  expect(rebuilt.index.caseSlugs()).toEqual(incremental.index.caseSlugs());
  expect(rebuilt.index.artifactsOfCase(scope.byKind.case)).toEqual(
    incremental.index.artifactsOfCase(scope.byKind.case),
  );
  expect(rebuilt.index.attestationsBySubject(scope.attacked)).toEqual(
    incremental.index.attestationsBySubject(scope.attacked),
  );
  expect(rebuilt.index.attestationsBySubject(scope.attacked, scope.attestingPrincipal)).toEqual(
    incremental.index.attestationsBySubject(scope.attacked, scope.attestingPrincipal),
  );
  expect(rebuilt.index.latestCommitTimeOf(caseRelated(scope))).toEqual(
    incremental.index.latestCommitTimeOf(caseRelated(scope)),
  );
  expect(rebuilt.index.installedModuleRecords()).toEqual(incremental.index.installedModuleRecords());
  expect(rebuilt.index.eventsAfter()).toEqual(incremental.index.eventsAfter());
  for (const kind of RECORD_KINDS) {
    expect(rebuilt.index.recordById(scope.byKind[kind])).toEqual(incremental.index.recordById(scope.byKind[kind]));
  }
  expect(rebuilt.index.watermark()).toBe(incremental.index.watermark());

  for (const kind of RECORD_KINDS) {
    const listed = (await store.list(kind)).sort();
    for (const opened of [incremental, rebuilt]) {
      const held = recordIdsHeld(opened.path, kind);
      expect(held).not.toHaveLength(0);
      const refused = opened.index
        .refusals()
        .filter((refusal) => refusal.path.startsWith(`records/${kind}/`))
        .map((refusal) => refusal.id);
      expect([...held, ...refused].sort()).toEqual(listed);
    }
  }
}

/** The store the fixture's records were written through. */
function storeOf(repo: FixtureRepo): Store {
  return new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now, claimTypes: repo.claimTypes });
}

describe("IndexDb schema-version rebuild", () => {
  test("an index whose recorded schema version differs from the kernel's is dropped and rebuilt, answering identically to an incrementally folded index", async () => {
    const repo = await makeRepo("fold-rebuild");
    repos.push(repo);

    const incrementalPath = await makeDbPath("incremental.sqlite");
    const incremental = new IndexDb(incrementalPath);
    const scope = await writeRichScope(repo);
    await incremental.fold(storeOf(repo), undefined, foldContributions(incremental));

    const rebuiltPath = await makeDbPath("rebuilt.sqlite");
    const rebuilt = new IndexDb(rebuiltPath);
    await rebuilt.fold(storeOf(repo), undefined, foldContributions(rebuilt));

    const raw = openIndexProvider().open(rebuiltPath);
    raw.exec("UPDATE schema_meta SET version = 9999 WHERE id = 0");
    raw.close();

    const reopened = new IndexDb(rebuiltPath);
    expect(reopened.watermark()).toBeNull();
    await reopened.fold(storeOf(repo), undefined, foldContributions(reopened));

    await expectSameAnswers(
      { index: reopened, path: rebuiltPath },
      { index: incremental, path: incrementalPath },
      scope,
      storeOf(repo),
    );
  });

  test("deleting the index file and folding from nothing answers identically to an incrementally folded index", async () => {
    const repo = await makeRepo("fold-from-scratch");
    repos.push(repo);

    const incrementalPath = await makeDbPath("incremental.sqlite");
    const incremental = new IndexDb(incrementalPath);
    const scope = await writeRichScope(repo);
    await incremental.fold(storeOf(repo), undefined, foldContributions(incremental));

    const freshPath = await makeDbPath("fresh.sqlite");
    await rm(freshPath, { force: true });
    const fresh = new IndexDb(freshPath);
    await fresh.fold(storeOf(repo), undefined, foldContributions(fresh));

    await expectSameAnswers(
      { index: fresh, path: freshPath },
      { index: incremental, path: incrementalPath },
      scope,
      storeOf(repo),
    );
  });
});

/** Every table at `path`, rows as sorted JSON, so two dumps compare by content. */
function tablesHeld(path: string): Record<string, string[]> {
  const raw = openIndexProvider().open(path);
  try {
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC")
      .all() as Array<{ name: string }>;
    const held: Record<string, string[]> = {};
    for (const { name } of tables) {
      const rows = raw.prepare(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>;
      held[name] = rows.map((row) => JSON.stringify(row)).sort();
    }
    return held;
  } finally {
    raw.close();
  }
}

/** The commit shas the `commits` table at `path` holds, in the fold's own order. */
function commitShasHeld(path: string): string[] {
  const raw = openIndexProvider().open(path);
  try {
    const rows = raw.prepare("SELECT sha FROM commits ORDER BY seq ASC").all() as Array<{ sha: string }>;
    return rows.map((row) => row.sha);
  } finally {
    raw.close();
  }
}

/** Moves the watermark at `path` to `sha` around the fold, so the next fold walks held commits. */
function moveWatermark(path: string, sha: string | null): void {
  const raw = openIndexProvider().open(path);
  try {
    raw.prepare("UPDATE watermark SET commit_sha = ? WHERE id = 0").run(sha);
    raw.prepare("UPDATE walked SET commit_sha = ? WHERE id = 0").run(sha);
  } finally {
    raw.close();
  }
}

describe("IndexDb.fold, a commit the index already holds", () => {
  test("applies it again without failing and leaves every table exactly as the first fold left it", async () => {
    const repo = await makeRepo("fold-reapplied");
    repos.push(repo);
    await writeRichScope(repo);

    const path = await makeDbPath("index.sqlite");
    const index = new IndexDb(path);
    await index.fold(storeOf(repo));
    const tip = index.watermark();
    const folded = tablesHeld(path);
    const shas = commitShasHeld(path);
    expect(shas.length).toBeGreaterThan(1);

    // The commit before the tip is where two racing folds overlap; `null` replays every insert.
    for (const resumeFrom of [shas[shas.length - 2]!, null]) {
      moveWatermark(path, resumeFrom);
      await index.fold(storeOf(repo));
      expect(index.watermark()).toBe(tip);
      expect(tablesHeld(path)).toEqual(folded);
    }
  });
});

describe("IndexDb, a lookup resolving two rows to one", () => {
  test("answers by the log's order and not by insertion order: the later commit wins across commits, the higher position within one, and a rebuilt fold agrees", async () => {
    const repo = await makeRepo("fold-tie-break");
    repos.push(repo);

    // The first fold stops between the tie's two commits, so the later one is numbered on resume.
    const incremental = new IndexDb(await makeDbPath("incremental.sqlite"));
    const [earlierAcross] = await writeFixtureRecords(repo, [
      { kind: "module", value: moduleDeclaring(TIED_ACROSS_COMMITS, "tied-across-commits-earlier") },
    ]);
    await incremental.fold(storeOf(repo));
    const [laterAcross] = await writeFixtureRecords(repo, [
      { kind: "module", value: moduleDeclaringBelow(TIED_ACROSS_COMMITS, earlierAcross!) },
    ]);
    const [firstWithin, secondWithin] = await writeTieWithinCommit(repo, TIED_WITHIN_COMMIT);
    await incremental.fold(storeOf(repo));

    // The later commit's record has the lower id, so only an answer by the log is right.
    expect(laterAcross! < earlierAcross!).toBe(true);
    expect(incremental.contributionById(TIED_ACROSS_COMMITS.id)?.moduleRecord).toBe(laterAcross);

    // Within one commit, paths shard by id, so the higher id sits at the higher position.
    const higherWithin = firstWithin > secondWithin ? firstWithin : secondWithin;
    expect(incremental.contributionById(TIED_WITHIN_COMMIT.id)?.moduleRecord).toBe(higherWithin);

    const rebuilt = new IndexDb(await makeDbPath("rebuilt.sqlite"));
    await rebuilt.fold(storeOf(repo));
    expect(rebuilt.contributionById(TIED_ACROSS_COMMITS.id)).toEqual(
      incremental.contributionById(TIED_ACROSS_COMMITS.id),
    );
    expect(rebuilt.contributionById(TIED_WITHIN_COMMIT.id)).toEqual(
      incremental.contributionById(TIED_WITHIN_COMMIT.id),
    );
  });

  test("two installed names declaring one id are answered by the later record in the log, never by id order, and a rebuilt fold agrees", async () => {
    const repo = await makeRepo("fold-tie-break-across-names");
    repos.push(repo);
    const nested = ruleContribution("tie", `${MODULE_NAME}/nested`);
    const earlierName = `${MODULE_NAME}/nested`;

    const incremental = new IndexDb(await makeDbPath("incremental.sqlite"));
    const [earlier] = await writeFixtureRecords(repo, [
      { kind: "module", value: { ...moduleDeclaring(nested, "nested-first"), name: earlierName } },
    ]);
    await incremental.fold(storeOf(repo));
    const later = moduleDeclaringBelow(nested, earlier!);
    const [laterId] = await writeFixtureRecords(repo, [{ kind: "module", value: { ...later, name: MODULE_NAME } }]);
    await incremental.fold(storeOf(repo));

    expect(laterId! < earlier!).toBe(true);
    expect(incremental.contributionById(nested.id)?.moduleRecord).toBe(laterId);
    expect(incremental.contributionById(nested.id)?.moduleName).toBe(MODULE_NAME);

    const rebuilt = new IndexDb(await makeDbPath("rebuilt.sqlite"));
    await rebuilt.fold(storeOf(repo));
    expect(rebuilt.contributionById(nested.id)).toEqual(incremental.contributionById(nested.id));
  });
});

describe("IndexDb, two contributors sharing one slot", () => {
  test("both remain reachable as contributors, and folding the two commits in either order answers identically", async () => {
    const forward = await makeRepo("fold-contributors-forward");
    repos.push(forward);
    const backward = await makeRepo("fold-contributors-backward");
    repos.push(backward);

    const first = contributorAt("shared-slot", "first");
    const second = contributorAt("shared-slot", "second");

    const [firstId] = await writeFixtureRecords(forward, [{ kind: "claim", value: first }]);
    const [secondId] = await writeFixtureRecords(forward, [{ kind: "claim", value: second }]);

    await writeFixtureRecords(backward, [{ kind: "claim", value: second }]);
    await writeFixtureRecords(backward, [{ kind: "claim", value: first }]);

    const forwardPath = await makeDbPath("forward.sqlite");
    const forwardIndex = new IndexDb(forwardPath);
    await forwardIndex.fold(storeOf(forward));

    const backwardPath = await makeDbPath("backward.sqlite");
    const backwardIndex = new IndexDb(backwardPath);
    await backwardIndex.fold(storeOf(backward));

    const forwardContributors = forwardIndex.contributorsAtSlot(slotOf("shared-slot"));
    const backwardContributors = backwardIndex.contributorsAtSlot(slotOf("shared-slot"));

    expect(forwardContributors.map((contributor) => contributor.id).sort()).toEqual([firstId, secondId].sort());
    expect(forwardContributors).toEqual(backwardContributors);

    const forwardEdges = forwardIndex.evidenceEdgesOf(slotOf("shared-slot"));
    const backwardEdges = backwardIndex.evidenceEdgesOf(slotOf("shared-slot"));
    expect(forwardEdges.map((edge) => edge.selector.key).sort()).toEqual(["exit-code-first", "exit-code-second"]);
    expect(forwardEdges).toEqual(backwardEdges);

    expect(forwardIndex.claimAtSlot(slotOf("shared-slot"))).toEqual(backwardIndex.claimAtSlot(slotOf("shared-slot")));
  });
});

describe("IndexDb.claimAtSlot, two contributors contending for one slot's exclusive group", () => {
  test("the contributor declaring a group governs over one declaring none, regardless of which one's id sorts first and regardless of fold order", async () => {
    const silentId = contentId(contributorWithGroup("contended-slot", "silent", null));

    // Both id orderings: an ascending-id pick is right by coincidence below and wrong above.
    const belowTag = tagWithIdRelativeTo("contended-slot", "menu-x", silentId, "below");
    const aboveTag = tagWithIdRelativeTo("contended-slot", "menu-x", silentId, "above");

    for (const groupTag of [belowTag, aboveTag]) {
      const silent = contributorWithGroup("contended-slot", "silent", null);
      const declared = contributorWithGroup("contended-slot", groupTag, "menu-x");
      const declaredId = contentId(declared);

      if (groupTag === belowTag) {
        expect(declaredId < silentId).toBe(true);
      } else {
        expect(declaredId > silentId).toBe(true);
      }

      const forward = await makeRepo(`fold-contended-forward-${groupTag}`);
      repos.push(forward);
      const backward = await makeRepo(`fold-contended-backward-${groupTag}`);
      repos.push(backward);

      await writeFixtureRecords(forward, [{ kind: "claim", value: silent }]);
      await writeFixtureRecords(forward, [{ kind: "claim", value: declared }]);

      await writeFixtureRecords(backward, [{ kind: "claim", value: declared }]);
      await writeFixtureRecords(backward, [{ kind: "claim", value: silent }]);

      const forwardPath = await makeDbPath(`forward-${groupTag}.sqlite`);
      const forwardIndex = new IndexDb(forwardPath);
      await forwardIndex.fold(storeOf(forward));

      const backwardPath = await makeDbPath(`backward-${groupTag}.sqlite`);
      const backwardIndex = new IndexDb(backwardPath);
      await backwardIndex.fold(storeOf(backward));

      for (const index of [forwardIndex, backwardIndex]) {
        const winner = index.claimAtSlot(slotOf("contended-slot"));
        expect(winner?.id).toBe(declaredId);
        expect((winner!.record as ClaimRecord).exclusiveGroup).toBe("menu-x");
      }
    }
  });

  test("two contributors declaring different groups is refused rather than one silently governing", async () => {
    const repo = await makeRepo("fold-contended-conflict");
    repos.push(repo);

    const first = contributorWithGroup("conflicted-slot", "first", "menu-a");
    const second = contributorWithGroup("conflicted-slot", "second", "menu-b");
    await writeFixtureRecords(repo, [{ kind: "claim", value: first }]);
    await writeFixtureRecords(repo, [{ kind: "claim", value: second }]);

    const dbPath = await makeDbPath("conflict.sqlite");
    const index = new IndexDb(dbPath);
    await index.fold(storeOf(repo));

    expect(() => index.claimAtSlot(slotOf("conflicted-slot"))).toThrow(AmbiguousExclusiveGroupError);
    expect(() => index.claimAtSlot(slotOf("conflicted-slot"))).toThrow("menu-a, menu-b");
  });

  test("claimsInGroup answers with the contributor that actually declared the group, never an unrelated representative", async () => {
    const repo = await makeRepo("fold-claims-in-group");
    repos.push(repo);

    const declared = contributorWithGroup("grouped-slot", "declared", "menu-x");
    const silent = contributorWithGroup("grouped-slot", "silent", null);
    await writeFixtureRecords(repo, [{ kind: "claim", value: declared }]);
    await writeFixtureRecords(repo, [{ kind: "claim", value: silent }]);

    const dbPath = await makeDbPath("claims-in-group.sqlite");
    const index = new IndexDb(dbPath);
    await index.fold(storeOf(repo));

    const members = index.claimsInGroup("menu-x");
    expect(members).toHaveLength(1);
    expect(members[0]?.slot).toBe(slotOf("grouped-slot"));
    expect((members[0]!.record as ClaimRecord).exclusiveGroup).toBe("menu-x");
  });
});

describe("a folded evidence edge answers by its selector's own parts, in a stable order", () => {
  test("an edge's structured selector and item survive the fold, and two folds of one scope agree on order", async () => {
    const repo = await makeRepo("fold-selector-parts");
    repos.push(repo);
    const claim = claimAtSlot("selector-parts");

    await writeFixtureRecords(repo, [{ kind: "claim", value: claim }]);

    const firstPath = await makeDbPath("first.sqlite");
    const first = new IndexDb(firstPath);
    await first.fold(storeOf(repo));

    const secondPath = await makeDbPath("second.sqlite");
    const second = new IndexDb(secondPath);
    await second.fold(storeOf(repo));

    const edges = first.evidenceEdgesOf(slotOf("selector-parts"));
    expect(edges).toEqual([
      {
        run: claim.evidence[0]!.run,
        selector: claim.evidence[0]!.selector,
        item: claim.evidence[0]!.item,
      },
    ]);
    expect(second.evidenceEdgesOf(slotOf("selector-parts"))).toEqual(edges);
  });
});

describe("IndexDb folds a module's manifest without touching its bundle", () => {
  test("a module's contributions are listed from the fold, with its bundle blob never written", async () => {
    const repo = await makeRepo("fold-module");
    repos.push(repo);
    const module = moduleWithContributions();
    const [moduleId] = await writeFixtureRecords(repo, [{ kind: "module", value: module }]);

    const dbPath = await makeDbPath("index.sqlite");
    const index = new IndexDb(dbPath);
    await index.fold(storeOf(repo));

    const contributions = index.contributionsOf("parser");
    expect(contributions).toHaveLength(1);
    expect(contributions[0]).toEqual({
      moduleRecord: moduleId,
      moduleName: MODULE_NAME,
      moduleVersion: "1",
      entry: module.manifest.contributions[0],
    });

    expect(index.contributionById(`${MODULE_NAME}/exit-code`)).toEqual(contributions[0]);
    expect(index.contributionsOf("rule")).toHaveLength(0);
  });

  test("a contribution answering at a module-namespaced point folds and is listed under that point's name", async () => {
    const repo = await makeRepo("fold-module-namespaced-point");
    repos.push(repo);
    const point = `${MODULE_NAME}/verdict-shape`;
    const contribution: ContributionEntry = { ...ruleContribution("shaped"), kind: point };
    const [moduleId] = await writeFixtureRecords(repo, [
      { kind: "module", value: moduleDeclaring(contribution, "module-namespaced-point") },
    ]);

    const index = new IndexDb(await makeDbPath("index.sqlite"));
    await index.fold(storeOf(repo));

    expect(index.contributionsOf(point)).toEqual([
      { moduleRecord: moduleId, moduleName: MODULE_NAME, moduleVersion: "1", entry: contribution },
    ]);
    expect(index.contributionsOf("rule")).toHaveLength(0);
  });
});

/** A module record declaring nothing under `name`; a name alone separates two of them. */
function moduleNamed(name: string): ModuleRecord {
  const base = moduleWithContributions();
  return { ...base, name, manifest: { ...base.manifest, contributions: [] } };
}

describe("IndexDb.installedModuleRecords, a scope holding two module names", () => {
  test("answers them by name ascending rather than in the order the log wrote them", async () => {
    const repo = await makeRepo("fold-two-module-names");
    repos.push(repo);

    // Written against their names' order, so the log's order cannot pass for a sorted one.
    await writeFixtureRecords(repo, [{ kind: "module", value: moduleNamed("zulu.demo") }]);
    await writeFixtureRecords(repo, [{ kind: "module", value: moduleNamed("alpha.demo") }]);

    const index = new IndexDb(await makeDbPath("index.sqlite"));
    await index.fold(storeOf(repo));

    expect(index.installedModuleRecords().map((install) => install.name)).toEqual([
      "alpha.demo",
      "musai.demo.claims",
      "zulu.demo",
    ]);
  });
});

/** The position and record id of every row one commit left in `table` at `path`. */
function positionsHeld(
  path: string,
  table: "records" | "events",
  commit: string,
): Array<{ position: number; id: RecordId }> {
  const idColumn = table === "records" ? "id" : "record_id";
  const raw = openIndexProvider().open(path);
  try {
    const rows = raw
      .prepare(`SELECT position, ${idColumn} AS id FROM ${table} WHERE commit_sha = ? ORDER BY position ASC`)
      .all(commit) as Array<{ position: number; id: string }>;
    return rows.map((row) => ({ position: row.position, id: row.id as RecordId }));
  } finally {
    raw.close();
  }
}

describe("IndexDb.fold, the position a record takes within its commit", () => {
  test("is the index of its record in the order the commit's writer wrote them, in the records table and the events table alike", async () => {
    const repo = await makeRepo("fold-positions");
    repos.push(repo);

    // Written in an order their paths do not sort in, so path order's positions fail.
    const items = [
      { kind: "module" as const, value: moduleWithContributions() },
      { kind: "claim" as const, value: contributorAt("positioned", "one") },
      { kind: "claim" as const, value: contributorAt("positioned", "two") },
      { kind: "case" as const, value: caseCiting("positioned-case", []) },
    ];
    const ids = await writeFixtureRecords(repo, items);
    const commit = (await gitRevParse(repo.ctx, scopeRefName(repo.scope)))!;
    const path = await makeDbPath("index.sqlite");
    await new IndexDb(path).fold(storeOf(repo));

    const paths = items.map((item, index) => recordPath(item.kind, ids[index]!));
    const sorted = [...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    expect(sorted).not.toEqual(paths);
    const expected = ids.map((id, position) => ({ position, id }));
    expect(positionsHeld(path, "records", commit)).toEqual(expected);
    expect(positionsHeld(path, "events", commit)).toEqual(expected);
  });
});

describe("IndexDb.eventsAfter, reading the fold's events past a cursor", () => {
  test("a cursor naming a position inside a commit answers the same rows in the same order from a fold rebuilt from nothing", async () => {
    const repo = await makeRepo("events-cursor-rebuild");
    repos.push(repo);
    await writeRichScope(repo);
    const path = await makeDbPath("index.sqlite");
    const folded = new IndexDb(path);
    await folded.fold(storeOf(repo));

    // A cursor at this commit's first record stands inside it, before the second.
    const all = folded.eventsAfter()!;
    const withinCommit = all.filter((event) => event.kind === "pin.changed").at(-1)!.commit;
    expect(all.filter((event) => event.commit === withinCommit)).toHaveLength(2);
    const cursor = { commit: withinCommit, position: positionsHeld(path, "events", withinCommit)[0]!.position };
    const answered = folded.eventsAfter(cursor);
    expect(answered).toEqual(all.slice(all.findIndex((event) => event.commit === withinCommit) + 1));
    expect(answered?.[0]?.commit).toBe(withinCommit);

    await rm(path, { force: true });
    const rebuilt = new IndexDb(path);
    expect(rebuilt.watermark()).toBeNull();
    await rebuilt.fold(storeOf(repo));
    expect(rebuilt.eventsAfter(cursor)).toEqual(answered);
  });

  test("a bare commit reads from that commit's end, and a commit the fold does not hold answers nothing rather than restarting", async () => {
    const repo = await makeRepo("events-bare-commit");
    repos.push(repo);
    await writeRichScope(repo);
    const index = new IndexDb(await makeDbPath("index.sqlite"));
    await index.fold(storeOf(repo));

    const all = index.eventsAfter()!;
    const withinCommit = all.filter((event) => event.kind === "pin.changed").at(-1)!.commit;
    const pastIt = all.slice(all.findLastIndex((event) => event.commit === withinCommit) + 1);
    expect(pastIt).not.toHaveLength(0);
    expect(index.eventsAfter({ commit: withinCommit })).toEqual(pastIt);
    expect(index.eventsAfter({ commit: index.watermark()! })).toEqual([]);
    expect(index.eventsAfter({ commit: "0".repeat(40) })).toBeUndefined();
  });
});

describe("IndexDb.fold, a module record the store contract refuses", () => {
  test("is listed as a refusal, resolves no name and raises no event, while the valid module record beside it in one commit raises its own", async () => {
    const repo = await makeRepo("events-refused-module");
    repos.push(repo);

    // The valid record's bytes are read back from another scope, so nothing here mints an id.
    const donorScope = "donor";
    const donor = new Store({ ctx: repo.ctx, scope: donorScope, now: repo.now, claimTypes: repo.claimTypes });
    const [validId] = await donor.putMany([{ kind: "module", value: moduleNamed("musai.valid") }]);
    const validPath = recordPath("module", validId!);
    const validBytes = await gitCatFile(repo.ctx, `${scopeRefName(donorScope)}:${validPath}`);
    // Bytes no module contract admits; a reader skipping the contract would take them as installed.
    const refusedId = `sha256:${"e".repeat(64)}` as RecordId;
    const refusedPath = recordPath("module", refusedId);
    const commit = await commitFilesAroundTheStore(repo, [
      { path: validPath, bytes: validBytes },
      {
        path: refusedPath,
        bytes: new TextEncoder().encode(JSON.stringify({ kind: "module", name: "musai.refused" })),
      },
    ]);

    const index = new IndexDb(await makeDbPath("index.sqlite"));
    await index.fold(storeOf(repo));

    expect(index.refusals().map((refusal) => ({ id: refusal.id, commit: refusal.commit, path: refusal.path }))).toEqual(
      [{ id: refusedId, commit, path: refusedPath }],
    );
    // The seeded module resolves first; it is read from the fold, since only this commit is pinned.
    const seededModule = index.installedModuleRecords().find((install) => install.name === "musai.demo.claims")!;
    expect(
      index
        .installedModuleRecords()
        .map((install) => install.id)
        .sort(),
    ).toEqual([seededModule.id, validId].sort());
    const events = index.eventsAfter()!;
    const moduleEvents = events.filter((event) => event.kind === "module.installed" || event.kind === "pin.changed");
    const seededEvent = moduleEvents.find((event) => event.about === "musai.demo.claims")!;
    const validEvent = moduleEvents.find((event) => event.about === "musai.valid")!;
    expect(moduleEvents).toEqual([seededEvent, validEvent]);
    expect(validEvent).toMatchObject({
      kind: "module.installed",
      about: "musai.valid",
      recordId: validId,
      commit,
      seq: 1,
    });
    expect(events.filter((event) => event.recordId === refusedId)).toEqual([]);
  });
});

describe("IndexDb.latestCommitTimeOf, records landing in commits of different dates", () => {
  test("answers the committer date of the latest commit among the records named, never the earliest", async () => {
    const repo = await makeRepo("fold-latest-commit-time");
    repos.push(repo);

    // The clock moves a day between writes, so a maximum cannot read the same as a minimum.
    let instant = "2026-03-01T00:00:00.000Z";
    const store = new Store({
      ctx: repo.ctx,
      scope: repo.scope,
      claimTypes: repo.claimTypes,
      now: () => timestamp(instant),
    });
    const [claimId] = await store.putMany([{ kind: "claim", value: contributorAt("dated", "only") }]);
    instant = "2026-03-02T00:00:00.000Z";
    const [caseId] = await store.putMany([{ kind: "case", value: caseCiting("dated-case", [claimId!]) }]);
    instant = "2026-03-03T00:00:00.000Z";
    const [artifactId] = await store.putMany([
      {
        kind: "artifact",
        value: {
          kind: "artifact",
          schemaVersion: CURRENT_SCHEMA_VERSIONS.artifact,
          case: caseId!,
          lifecycle: "drafted",
          content: "The artifact lands after the case it belongs to.",
          format: "text/markdown",
          supersedes: [],
        },
      },
    ]);

    const index = new IndexDb(await makeDbPath("index.sqlite"));
    await index.fold(storeOf(repo));

    const walked: CommitChanges[] = [];
    for await (const commit of storeOf(repo).changesSince(null)) {
      walked.push(commit);
    }
    const times = walked.map((commit) => commit.committedAt);
    expect(new Set(times).size).toBe(4);
    expect(index.latestCommitTimeOf([claimId!, caseId!, artifactId!])).toBe(times[3]);
    // The maximum is over the records named, not the scope.
    expect(index.latestCommitTimeOf([claimId!, caseId!])).toBe(times[2]);
  });
});

describe("IndexDb.anchorsOf: an artifact's own receipts section, derived at fold", () => {
  test("the label-to-full-id map comes from parsing an artifact's content, never from a field on the record", async () => {
    const repo = await makeRepo("fold-artifact-anchors");
    repos.push(repo);

    const citedId = recordId({ marker: "cited-record" });
    const label = citedId.slice("sha256:".length, "sha256:".length + 12);
    const content = [`A claim resting on a run.[^${label}]`, "", "## Receipts", "", `[^${label}]: ${citedId}`, ""].join(
      "\n",
    );

    const artifact = {
      kind: "artifact" as const,
      schemaVersion: CURRENT_SCHEMA_VERSIONS.artifact,
      case: recordId({ marker: "some-case" }),
      lifecycle: "drafted" as const,
      content,
      format: "markdown",
      supersedes: [],
    };
    const [artifactId] = await writeFixtureRecords(repo, [{ kind: "artifact", value: artifact }]);

    const dbPath = await makeDbPath("index.sqlite");
    const index = new IndexDb(dbPath);
    await index.fold(storeOf(repo));

    expect(index.anchorsOf(artifactId!)).toEqual([{ label, fullId: citedId }]);
    expect(Object.keys(artifact)).not.toContain("anchors");
  });

  test("re-folding an artifact whose content changed (a new record, since a record is never edited) replaces its own anchors rather than accumulating them", async () => {
    const repo = await makeRepo("fold-artifact-anchors-again");
    repos.push(repo);

    const firstCited = recordId({ marker: "first-cited" });
    const firstLabel = firstCited.slice("sha256:".length, "sha256:".length + 12);
    const first = {
      kind: "artifact" as const,
      schemaVersion: CURRENT_SCHEMA_VERSIONS.artifact,
      case: recordId({ marker: "some-case" }),
      lifecycle: "drafted" as const,
      content: [`First.[^${firstLabel}]`, "", "## Receipts", "", `[^${firstLabel}]: ${firstCited}`, ""].join("\n"),
      format: "markdown",
      supersedes: [],
    };
    const [firstId] = await writeFixtureRecords(repo, [{ kind: "artifact", value: first }]);

    const dbPath = await makeDbPath("index.sqlite");
    const index = new IndexDb(dbPath);
    await index.fold(storeOf(repo));
    expect(index.anchorsOf(firstId!)).toHaveLength(1);

    // A second draft is a new record naming the first, with its own receipts.
    const secondCited = recordId({ marker: "second-cited" });
    const secondLabel = secondCited.slice("sha256:".length, "sha256:".length + 12);
    const second = {
      kind: "artifact" as const,
      schemaVersion: CURRENT_SCHEMA_VERSIONS.artifact,
      case: first.case,
      lifecycle: "drafted" as const,
      content: [`Second.[^${secondLabel}]`, "", "## Receipts", "", `[^${secondLabel}]: ${secondCited}`, ""].join("\n"),
      format: "markdown",
      supersedes: [firstId!],
    };
    await writeFixtureRecords(repo, [{ kind: "artifact", value: second }]);
    await index.fold(storeOf(repo));

    // The first artifact's anchors are governed only by its own unchanged record.
    expect(index.anchorsOf(firstId!)).toEqual([{ label: firstLabel, fullId: firstCited }]);
  });
});

describe("succession: what a record replacing another does to the fold", () => {
  /** A ruling over a claim, in the shape the store writes one. */
  function rulingOver(claimId: RecordId, verdict: "holds" | "fails"): Record<string, unknown> {
    return {
      kind: "ruling",
      schemaVersion: CURRENT_SCHEMA_VERSIONS.ruling,
      over: { claim: claimId },
      verdict,
      reason: `the fixture's own ruling that the claim ${verdict}`,
      brief: recordId({ marker: `brief-${verdict}` }),
      supersedes: [],
    };
  }

  test("a contributor superseded by a later record no longer represents its slot, and the successor does", async () => {
    const repo = await makeRepo("succession-contributor");
    repos.push(repo);

    const [firstId] = await writeFixtureRecords(repo, [{ kind: "claim", value: contributorAt("shared", "first") }]);
    const corrected = { ...contributorAt("shared", "second"), supersedes: [firstId!] };
    const [secondId] = await writeFixtureRecords(repo, [{ kind: "claim", value: corrected }]);

    const index = new IndexDb(await makeDbPath("index.sqlite"));
    await index.fold(storeOf(repo));

    const slot = slotOf("shared");
    expect(index.contributorsAtSlot(slot).map((claim) => claim.id)).toEqual([secondId!]);
    expect(index.claimAtSlot(slot)?.id).toBe(secondId!);
    expect(index.successorsOf(firstId!)).toEqual([{ successor: secondId!, kind: "claim" }]);
    expect(index.successorsOf(secondId!)).toEqual([]);
  });

  test("a superseded contributor's evidence no longer supports its slot", async () => {
    const repo = await makeRepo("succession-edges");
    repos.push(repo);

    const first = contributorAt("shared", "first");
    const [firstId] = await writeFixtureRecords(repo, [{ kind: "claim", value: first }]);

    const index = new IndexDb(await makeDbPath("index.sqlite"));
    await index.fold(storeOf(repo));
    const slot = slotOf("shared");
    expect(index.evidenceEdgesOf(slot).map((edge) => edge.run)).toEqual([first.evidence[0]!.run]);

    const corrected = { ...contributorAt("shared", "second"), supersedes: [firstId!] };
    await writeFixtureRecords(repo, [{ kind: "claim", value: corrected }]);
    await index.fold(storeOf(repo));

    expect(index.evidenceEdgesOf(slot).map((edge) => edge.run)).toEqual([corrected.evidence[0]!.run]);
  });

  test("a ruling a later ruling names still comes back on its slot, carrying that successor", async () => {
    const repo = await makeRepo("succession-on-slot");
    repos.push(repo);

    const [claimId] = await writeFixtureRecords(repo, [{ kind: "claim", value: claimAtSlot("ruled") }]);
    const [firstRulingId] = await writeFixtureRecords(repo, [{ kind: "ruling", value: rulingOver(claimId!, "holds") }]);
    const [secondRulingId] = await writeFixtureRecords(repo, [
      { kind: "ruling", value: { ...rulingOver(claimId!, "fails"), supersedes: [firstRulingId!] } },
    ]);

    const index = new IndexDb(await makeDbPath("index.sqlite"));
    await index.fold(storeOf(repo));

    const found = index.rulingsFor(slotOf("ruled"), new Map());
    expect(new Map(found.map((ruling) => [ruling.id, ruling.successors]))).toEqual(
      new Map([
        [firstRulingId!, [{ successor: secondRulingId!, kind: "ruling" }]],
        [secondRulingId!, []],
      ]),
    );
  });

  test("successors come back in the order they landed, whatever order their ids sort in, cold or warm", async () => {
    const repo = await makeRepo("succession-landing-order");
    repos.push(repo);

    const [claimId] = await writeFixtureRecords(repo, [{ kind: "claim", value: claimAtSlot("forked") }]);
    const [nameId] = await writeFixtureRecords(repo, [{ kind: "ruling", value: rulingOver(claimId!, "holds") }]);
    const successorWith = (reason: string) => ({
      ...rulingOver(claimId!, "fails"),
      reason,
      supersedes: [nameId!],
    });
    const [early, late] = [successorWith("the first correction"), successorWith("the second correction")].sort(
      (a, b) => (recordId(a) > recordId(b) ? -1 : 1),
    );

    const warm = new IndexDb(await makeDbPath("warm.sqlite"));
    const [earlyId] = await writeFixtureRecords(repo, [{ kind: "ruling", value: early! }]);
    await warm.fold(storeOf(repo));
    const [lateId] = await writeFixtureRecords(repo, [{ kind: "ruling", value: late! }]);
    await warm.fold(storeOf(repo));
    const cold = new IndexDb(await makeDbPath("cold.sqlite"));
    await cold.fold(storeOf(repo));

    const landed = [
      { successor: earlyId!, kind: "ruling" },
      { successor: lateId!, kind: "ruling" },
    ];
    expect(lateId! < earlyId!).toBe(true);
    expect(warm.successorsOf(nameId!)).toEqual(landed);
    expect(cold.successorsOf(nameId!)).toEqual(landed);
    const onSlot = (index: IndexDb) => index.rulingsFor(slotOf("forked"), new Map()).find((r) => r.id === nameId);
    expect(onSlot(warm)?.successors).toEqual(landed);
    expect(onSlot(cold)?.successors).toEqual(landed);
  });

  test("a ruling over a superseded claim does not come back on the slot", async () => {
    const repo = await makeRepo("succession-claim-superseded");
    repos.push(repo);

    const [claimId] = await writeFixtureRecords(repo, [{ kind: "claim", value: claimAtSlot("corrected") }]);
    await writeFixtureRecords(repo, [{ kind: "ruling", value: rulingOver(claimId!, "holds") }]);
    await writeFixtureRecords(repo, [
      { kind: "claim", value: { ...claimAtSlot("corrected"), rendering: "the correction", supersedes: [claimId!] } },
    ]);

    const index = new IndexDb(await makeDbPath("index.sqlite"));
    await index.fold(storeOf(repo));

    expect(index.rulingsFor(slotOf("corrected"), new Map())).toEqual([]);
  });

  test("folding a predecessor and its successor in either commit order answers identically", async () => {
    const ordered = await makeRepo("succession-forward");
    const reversed = await makeRepo("succession-backward");
    repos.push(ordered, reversed);

    const first = contributorAt("ordering", "first");
    const [firstId] = await writeFixtureRecords(ordered, [{ kind: "claim", value: first }]);
    const second = { ...contributorAt("ordering", "second"), supersedes: [firstId!] };
    await writeFixtureRecords(ordered, [{ kind: "claim", value: second }]);

    await writeFixtureRecords(reversed, [{ kind: "claim", value: second }]);
    await writeFixtureRecords(reversed, [{ kind: "claim", value: first }]);

    const forward = new IndexDb(await makeDbPath("forward.sqlite"));
    await forward.fold(storeOf(ordered));
    const backward = new IndexDb(await makeDbPath("backward.sqlite"));
    await backward.fold(storeOf(reversed));

    const slot = slotOf("ordering");
    expect(backward.contributorsAtSlot(slot).map((claim) => claim.id)).toEqual(
      forward.contributorsAtSlot(slot).map((claim) => claim.id),
    );
    expect(backward.claimAtSlot(slot)?.id).toBe(forward.claimAtSlot(slot)?.id);
    expect(backward.successorsOf(firstId!)).toEqual(forward.successorsOf(firstId!));
    expect(backward.evidenceEdgesOf(slot)).toEqual(forward.evidenceEdgesOf(slot));
  });
});

describe("a ruling's extent: one claim, or a type at a scope", () => {
  /** A policy: a ruling over every claim of one type whose conditions its scope contains. */
  function policyOver(type: string, scope: Record<string, unknown>): Record<string, unknown> {
    return {
      kind: "ruling",
      schemaVersion: CURRENT_SCHEMA_VERSIONS.ruling,
      over: { type, scope },
      verdict: "fails",
      reason: "the fixture's own policy over a type at a scope",
      brief: recordId({ marker: "policy-brief" }),
      supersedes: [],
    };
  }

  test("a policy bears on every live contributor of its type whose conditions its scope contains, and on none outside it", async () => {
    const repo = await makeRepo("extent-type-scoped");
    repos.push(repo);

    const inside = { ...claimAtSlot("inside"), conditions: { id: "inside", chapter: "05" } };
    const outside = { ...claimAtSlot("outside"), conditions: { id: "outside", chapter: "11" } };
    await writeFixtureRecords(repo, [
      { kind: "claim", value: { ...inside, slot: slotOf("inside") } },
      { kind: "claim", value: { ...outside, slot: slotOf("outside") } },
    ]);
    const [policyId] = await writeFixtureRecords(repo, [
      { kind: "ruling", value: policyOver(CLAIM_TYPE, { chapter: { kind: "range", from: "01", to: "09" } }) },
    ]);

    const index = new IndexDb(await makeDbPath("index.sqlite"));
    await index.fold(storeOf(repo));

    expect(index.rulingsFor(slotOf("inside"), new Map()).map((ruling) => ruling.id)).toEqual([policyId!]);
    expect(index.rulingsFor(slotOf("outside"), new Map())).toEqual([]);
  });

  test("a policy's scope is compared under the dimension declared for it, and under the algebra's own order where none is", async () => {
    const repo = await makeRepo("extent-declared-dimension");
    repos.push(repo);

    const spanning = { ...claimAtSlot("spanning"), conditions: { id: "spanning", chapter: "9" } };
    await writeFixtureRecords(repo, [{ kind: "claim", value: { ...spanning, slot: slotOf("spanning") } }]);
    const [policyId] = await writeFixtureRecords(repo, [
      { kind: "ruling", value: policyOver(CLAIM_TYPE, { chapter: { kind: "range", from: "2", to: "10" } }) },
    ]);

    const index = new IndexDb(await makeDbPath("index.sqlite"));
    await index.fold(storeOf(repo));

    // "9" sorts past "10" as text and inside it as a number, so the registry decides the answer.
    const numeric: DimensionRegistry = new Map([
      ["chapter", { name: "chapter", type: "ordered", data: { order: "numeric" } }],
    ]);
    expect(index.rulingsFor(slotOf("spanning"), new Map())).toEqual([]);
    expect(index.rulingsFor(slotOf("spanning"), numeric).map((ruling) => ruling.id)).toEqual([policyId!]);
  });

  test("a policy carved out from a bound the declared dimension cannot place bears on nothing", async () => {
    const repo = await makeRepo("extent-carved-out");
    repos.push(repo);

    const carved = { ...claimAtSlot("carved"), conditions: { id: "carved", chapter: "5" } };
    await writeFixtureRecords(repo, [{ kind: "claim", value: { ...carved, slot: slotOf("carved") } }]);
    const [policyId] = await writeFixtureRecords(repo, [
      {
        kind: "ruling",
        value: policyOver(CLAIM_TYPE, {
          chapter: { kind: "except", base: { kind: "any" }, excluded: { kind: "from", value: "alpha" } },
        }),
      },
    ]);

    const index = new IndexDb(await makeDbPath("index.sqlite"));
    await index.fold(storeOf(repo));

    // A numeric order cannot place a word, so the exclusion reads it as carved out; text order can.
    const numeric: DimensionRegistry = new Map([
      ["chapter", { name: "chapter", type: "ordered", data: { order: "numeric" } }],
    ]);
    expect(index.rulingsFor(slotOf("carved"), new Map()).map((ruling) => ruling.id)).toEqual([policyId!]);
    expect(index.rulingsFor(slotOf("carved"), numeric)).toEqual([]);
  });

  test("a policy carved out at one value bears on every other under an identity dimension", async () => {
    const repo = await makeRepo("extent-carved-out-identity");
    repos.push(repo);

    const good = { ...claimAtSlot("good"), conditions: { id: "good", run: "good" } };
    const bad = { ...claimAtSlot("bad"), conditions: { id: "bad", run: "bad" } };
    await writeFixtureRecords(repo, [
      { kind: "claim", value: { ...good, slot: slotOf("good") } },
      { kind: "claim", value: { ...bad, slot: slotOf("bad") } },
    ]);
    const [policyId] = await writeFixtureRecords(repo, [
      {
        kind: "ruling",
        value: policyOver(CLAIM_TYPE, {
          run: { kind: "except", base: { kind: "any" }, excluded: { kind: "set", values: ["bad"] } },
        }),
      },
    ]);

    const index = new IndexDb(await makeDbPath("index.sqlite"));
    await index.fold(storeOf(repo));

    // Identity orders no two distinct values: "good" is not "bad", so the carve-out misses.
    const identity: DimensionRegistry = new Map([["run", { name: "run", type: "identity", data: {} }]]);
    expect(index.rulingsFor(slotOf("good"), identity).map((ruling) => ruling.id)).toEqual([policyId!]);
    expect(index.rulingsFor(slotOf("bad"), identity)).toEqual([]);
  });

  test("a policy naming a dimension a claim does not carry does not bear on it", async () => {
    const repo = await makeRepo("extent-missing-dimension");
    repos.push(repo);

    await writeFixtureRecords(repo, [{ kind: "claim", value: claimAtSlot("plain") }]);
    await writeFixtureRecords(repo, [{ kind: "ruling", value: policyOver(CLAIM_TYPE, { chapter: { kind: "any" } }) }]);

    const index = new IndexDb(await makeDbPath("index.sqlite"));
    await index.fold(storeOf(repo));

    expect(index.rulingsFor(slotOf("plain"), new Map())).toEqual([]);
  });

  test("a policy over another type bears on nothing at this one's slots", async () => {
    const repo = await makeRepo("extent-other-type");
    repos.push(repo);

    await writeFixtureRecords(repo, [{ kind: "claim", value: claimAtSlot("elsewhere") }]);
    await writeFixtureRecords(repo, [{ kind: "ruling", value: policyOver("musai.other@1", { id: { kind: "any" } }) }]);

    const index = new IndexDb(await makeDbPath("index.sqlite"));
    await index.fold(storeOf(repo));

    expect(index.rulingsFor(slotOf("elsewhere"), new Map())).toEqual([]);
  });

  test("a claim-bound ruling and a policy both bearing on one slot answer together, deduped and ordered", async () => {
    const repo = await makeRepo("extent-both");
    repos.push(repo);

    const claim = { ...claimAtSlot("both"), conditions: { id: "both", chapter: "03" } };
    const [claimId] = await writeFixtureRecords(repo, [{ kind: "claim", value: { ...claim, slot: slotOf("both") } }]);
    const [boundId] = await writeFixtureRecords(repo, [
      {
        kind: "ruling",
        value: {
          kind: "ruling",
          schemaVersion: CURRENT_SCHEMA_VERSIONS.ruling,
          over: { claim: claimId! },
          verdict: "holds",
          reason: "the fixture's own ruling over this one claim",
          brief: recordId({ marker: "bound-brief" }),
          supersedes: [],
        },
      },
    ]);
    const [policyId] = await writeFixtureRecords(repo, [
      { kind: "ruling", value: policyOver(CLAIM_TYPE, { chapter: { kind: "range", from: "01", to: "09" } }) },
    ]);

    const index = new IndexDb(await makeDbPath("index.sqlite"));
    await index.fold(storeOf(repo));

    expect(index.rulingsFor(slotOf("both"), new Map()).map((ruling) => ruling.id)).toEqual(
      [boundId!, policyId!].sort((a, b) => (a < b ? -1 : 1)),
    );
  });
});

describe("IndexDb.ruleFor, the live rule record naming a contribution", () => {
  const NAMED = `${MODULE_NAME}/named`;
  const OTHER = `${MODULE_NAME}/other`;

  /** A rule record stating `contribution`'s policy at `chapter`, or a lesson where it is null. */
  function ruleNaming(
    name: string,
    contribution: string | null,
    chapter: string,
    supersedes: RecordId[] = [],
  ): Record<string, unknown> {
    return {
      kind: "rule",
      schemaVersion: CURRENT_SCHEMA_VERSIONS.rule,
      name,
      scope: { chapter },
      weight: exactDecimal("1"),
      supersedes,
      contribution,
    };
  }

  test("a superseded rule record is not answered, and the record replacing it is", async () => {
    const repo = await makeRepo("rule-for-succession");
    repos.push(repo);

    const [firstId] = await writeFixtureRecords(repo, [{ kind: "rule", value: ruleNaming("first", NAMED, "01") }]);
    const [secondId] = await writeFixtureRecords(repo, [
      { kind: "rule", value: ruleNaming("second", NAMED, "02", [firstId!]) },
    ]);

    const index = new IndexDb(await makeDbPath("index.sqlite"));
    await index.fold(storeOf(repo));

    const found = index.ruleFor(NAMED);
    expect(found?.id).toBe(secondId!);
    expect(found?.record.scope).toEqual({ chapter: "02" });
  });

  test("a rule record naming another contribution is not answered, and a lesson is never answered, whatever its name", async () => {
    const repo = await makeRepo("rule-for-other");
    repos.push(repo);

    const [otherId] = await writeFixtureRecords(repo, [
      { kind: "rule", value: ruleNaming("other", OTHER, "01") },
      { kind: "rule", value: ruleNaming(NAMED, null, "02") },
    ]);

    const index = new IndexDb(await makeDbPath("index.sqlite"));
    await index.fold(storeOf(repo));

    expect(index.ruleFor(NAMED)).toBeUndefined();
    expect(index.ruleFor(OTHER)?.id).toBe(otherId!);
  });

  test("two live rule records naming one contribution are refused by name, and once one is superseded the other is answered", async () => {
    const repo = await makeRepo("rule-for-conflict");
    repos.push(repo);

    const [firstId, secondId] = await writeFixtureRecords(repo, [
      { kind: "rule", value: ruleNaming("first", NAMED, "01") },
      { kind: "rule", value: ruleNaming("second", NAMED, "02") },
    ]);

    const index = new IndexDb(await makeDbPath("index.sqlite"));
    await index.fold(storeOf(repo));

    let refusal: unknown;
    try {
      index.ruleFor(NAMED);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(RuleRecordConflictError);
    expect((refusal as RuleRecordConflictError).reason).toBe("declaration-conflict");
    expect((refusal as RuleRecordConflictError).about).toEqual([NAMED, ...[firstId!, secondId!].sort()]);

    // The successor names no contribution, so it withdraws the first's policy, not contends.
    await writeFixtureRecords(repo, [{ kind: "rule", value: ruleNaming("first", null, "01", [firstId!]) }]);
    await index.fold(storeOf(repo));

    expect(index.ruleFor(NAMED)?.id).toBe(secondId!);
  });

  test("a contribution no rule record names answers undefined", async () => {
    const repo = await makeRepo("rule-for-none");
    repos.push(repo);

    await writeFixtureRecords(repo, [{ kind: "rule", value: ruleNaming("other", OTHER, "01") }]);

    const index = new IndexDb(await makeDbPath("index.sqlite"));
    await index.fold(storeOf(repo));

    expect(index.ruleFor(NAMED)).toBeUndefined();
  });
});

describe("what the fold makes of a sealed value", () => {
  const SEALED = {
    $sealed: { alg: "aes-256-gcm", keyId: "key-1", ciphertext: "Y2lwaGVydGV4dA==", digest: "a".repeat(64) },
  };

  test("a claim whose rendering is sealed indexes under a placeholder and still answers by slot", async () => {
    const repo = await makeRepo("sealed-claim");
    repos.push(repo);

    const claim = { ...claimAtSlot("sealed"), rendering: SEALED };
    const [claimId] = await writeFixtureRecords(repo, [{ kind: "claim", value: claim }]);

    const index = new IndexDb(await makeDbPath("index.sqlite"));
    await index.fold(storeOf(repo));

    const found = index.claimAtSlot(slotOf("sealed"));
    expect(found?.id).toBe(claimId!);
    expect(found?.rendering).toBe("[sealed]");
    expect(index.refusals()).toEqual([]);
  });

  test("a sealed artifact folds no anchors, since its receipts section is inside the ciphertext", async () => {
    const repo = await makeRepo("sealed-artifact");
    repos.push(repo);

    const [artifactId] = await writeFixtureRecords(repo, [
      {
        kind: "artifact",
        value: {
          kind: "artifact",
          schemaVersion: CURRENT_SCHEMA_VERSIONS.artifact,
          case: recordId({ marker: "sealed-artifact-case" }),
          lifecycle: "drafted",
          content: SEALED,
          format: "text/markdown",
          supersedes: [],
        },
      },
    ]);

    const index = new IndexDb(await makeDbPath("index.sqlite"));
    await index.fold(storeOf(repo));

    expect(index.anchorsOf(artifactId!)).toEqual([]);
    expect(index.refusals()).toEqual([]);
  });
});

describe("IndexDb, the reverse index over every run's read-set", () => {
  const read = (marker: string) => recordId({ marker });
  const entry = (id: RecordId, key: string = id) => ({ key, consumed: { sha256: id.slice("sha256:".length) } });
  const shared = read("a record two runs read");
  const slotKey = `slot:${slotOf("read-claim")}`;

  function performedReader(reads: ReturnType<typeof entry>[]): PerformedRunRecord {
    const run = fixtureRunRecord("a performed run that read records");
    return { ...run, observation: { ...run.observation, reads } };
  }

  function evaluation(reads: ReturnType<typeof entry>[]): ComputedRunRecord {
    return {
      ...fixtureBrief("holds"),
      runKind: "evaluation",
      recipe: { command: ["evaluate", "a/rule", slotOf("read-claim")], substrates: [] },
      observation: { output: "holds", reads, cost: {} },
    };
  }

  async function readScope(repo: FixtureRepo): Promise<Record<string, RecordId>> {
    const [brief, testified, evaluated, command] = await writeFixtureRecords(repo, [
      { kind: "run", value: fixtureBrief("a brief", { reads: [shared, read("only the brief read this")] }) },
      { kind: "run", value: performedReader([entry(shared)]) },
      { kind: "run", value: evaluation([entry(read("the evaluated claim"), slotKey), entry(shared)]) },
      { kind: "run", value: fixtureRunRecord("a command reads nothing beyond its recipe") },
    ]);
    return { brief: brief!, testified: testified!, evaluated: evaluated!, command: command! };
  }

  test("every read-set entry of a performed run, a brief and an evaluation folds to a row its key answers", async () => {
    const repo = await makeRepo("reads-kinds");
    repos.push(repo);
    const runs = await readScope(repo);
    const index = new IndexDb(await makeDbPath("index.sqlite"));
    await index.fold(storeOf(repo));

    expect(index.readersOf(shared).map((row) => row.reader)).toEqual(
      expect.arrayContaining([runs["brief"], runs["testified"], runs["evaluated"]]),
    );
    expect(index.readersOf(shared)).toHaveLength(3);
    expect(index.readersOf(slotKey)).toEqual([
      { reader: runs["evaluated"], consumed: entry(read("the evaluated claim")).consumed },
    ]);
    expect(index.readersOf(read("only the brief read this")).map((row) => row.reader)).toEqual([runs["brief"]]);
    expect(index.readersOf(read("nobody read this"))).toEqual([]);
  });

  test("a fold walked commit by commit holds the same rows as one folded from nothing", async () => {
    const repo = await makeRepo("reads-cold-warm");
    repos.push(repo);
    const warmPath = await makeDbPath("warm.sqlite");
    const warm = new IndexDb(warmPath);
    await writeFixtureRecords(repo, [{ kind: "run", value: performedReader([entry(read("read before the rest"))]) }]);
    await warm.fold(storeOf(repo));
    await readScope(repo);
    await warm.fold(storeOf(repo));

    const coldPath = await makeDbPath("cold.sqlite");
    await new IndexDb(coldPath).fold(storeOf(repo));

    expect(tablesHeld(warmPath)["reads"]).toEqual(tablesHeld(coldPath)["reads"]);
    expect(tablesHeld(coldPath)["reads"]).toHaveLength(6);
  });

  test("readersOf answers through the index on key, never a scan", async () => {
    const repo = await makeRepo("reads-plan");
    repos.push(repo);
    await readScope(repo);
    const path = await makeDbPath("index.sqlite");
    await new IndexDb(path).fold(storeOf(repo));

    const raw = openIndexProvider().open(path);
    try {
      const plan = raw.prepare("EXPLAIN QUERY PLAN SELECT reader FROM reads WHERE key = ?").all(shared) as {
        detail: string;
      }[];
      expect(plan.map((step) => step.detail).join("\n")).toContain("USING INDEX reads_by_key");
    } finally {
      raw.close();
    }
  });

  test("a change reaches the readers of its key that consumed something else, and no reader of a key unmoved", async () => {
    const repo = await makeRepo("reads-reach");
    repos.push(repo);
    const [claim] = await writeFixtureRecords(repo, [{ kind: "claim", value: claimAtSlot("read-claim") }]);
    const [plain] = await writeFixtureRecords(repo, [
      { kind: "run", value: fixtureRunRecord("a record a reader read whole") },
    ]);
    const [reader] = await writeFixtureRecords(repo, [
      { kind: "run", value: evaluation([entry(claim!, slotKey), entry(plain!)]) },
    ]);
    const index = new IndexDb(await makeDbPath("index.sqlite"));
    await index.fold(storeOf(repo));
    expect(index.reachOf(slotKey)).toEqual([]);
    expect(index.reachOf(plain!)).toEqual([]);

    await writeFixtureRecords(repo, [
      {
        kind: "claim",
        value: { ...claimAtSlot("read-claim"), rendering: "read-claim, restated.", supersedes: [claim!] },
      },
      { kind: "run", value: { ...fixtureRunRecord("its successor"), supersedes: [plain!] } },
    ]);
    await index.fold(storeOf(repo));

    expect(index.reachOf(slotKey).map((row) => row.reader)).toEqual([reader]);
    expect(index.reachOf(plain!).map((row) => row.reader)).toEqual([reader]);
    expect(index.reachOf(read("nobody read this"))).toEqual([]);
  });

  test("a receipt for a recipe reaches the readers of the recipe that landed before it, and no reader after", async () => {
    const repo = await makeRepo("reads-recipe");
    repos.push(repo);
    const receipt = (output: string) => fixtureRunRecord(output);
    const recipeKey = `recipe:${recordId(receipt("any").recipe)}`;
    const [first] = await writeFixtureRecords(repo, [{ kind: "run", value: receipt("on the first tree") }]);
    await writeFixtureRecords(repo, [{ kind: "run", value: receipt("on another tree") }]);
    // Back on the first tree, the evaluation rests on the first receipt though a later one exists.
    const [reader] = await writeFixtureRecords(repo, [{ kind: "run", value: evaluation([entry(first!, recipeKey)]) }]);
    const index = new IndexDb(await makeDbPath("index.sqlite"));
    await index.fold(storeOf(repo));
    expect(index.reachOf(recipeKey)).toEqual([]);

    await writeFixtureRecords(repo, [{ kind: "run", value: receipt("a receipt landed since") }]);
    await index.fold(storeOf(repo));

    expect(index.reachOf(recipeKey).map((row) => row.reader)).toEqual([reader]);
  });

  test("an index folded before the reverse index existed is rebuilt, so its reads fill", async () => {
    const repo = await makeRepo("reads-rebuild");
    repos.push(repo);
    const runs = await readScope(repo);
    const path = await makeDbPath("index.sqlite");
    await new IndexDb(path).fold(storeOf(repo));
    const raw = openIndexProvider().open(path);
    raw.exec("UPDATE schema_meta SET version = 19 WHERE id = 0; DELETE FROM reads;");
    raw.close();

    const reopened = new IndexDb(path);
    expect(reopened.watermark()).toBeNull();
    await reopened.fold(storeOf(repo));

    expect(reopened.readersOf(read("only the brief read this")).map((row) => row.reader)).toEqual([runs["brief"]]);
  });
});
