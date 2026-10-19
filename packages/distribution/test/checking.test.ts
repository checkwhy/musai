import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { clockFromEnvironment, type OperationContext, openWorkspace, runHandler } from "@musai/api-core";
import { buildModule } from "@musai/devkit";
import { INVOCATION_LIMITS_SLOT_ID } from "@musai/modules";
import {
  type CaseRecord,
  type ClaimRecord,
  type ClaimTypeDeclaration,
  type ContributionEntry,
  CURRENT_SCHEMA_VERSIONS,
  claimTypesFrom,
  type EvidenceEdge,
  exactDecimal,
  type ModuleRecord,
  type PerformedRunRecord,
  type RecordId,
  type RunRecord,
  recordId,
  SlotRefusedError,
  slotFor,
  timestamp,
  versionString,
} from "@musai/records";
import { RUNNER_PERFORMER } from "@musai/run";
import { initWorkspace, SLOTS_CONFIG_KEY, Store } from "@musai/store";
import {
  blobStoreOf,
  declareClaimTypes,
  fixedClock,
  foldedIndex,
  manifestWithContributions,
  receiptIds,
  writeTrustFile,
} from "@musai/test-support";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { caseBook, caseSoundcheck } from "../src/ops/case.js";
import { caseStatus } from "../src/ops/case-status.js";
import { claimStatus } from "../src/ops/claim.js";
import { viewRun } from "../src/ops/view.js";
import { claimWhy } from "../src/ops/why.js";

const CORE_MODULE_DIR = fileURLToPath(new URL("../../core-module", import.meta.url));
/** A second module contributing a rule of its own, so a claim can name two. */
const FIXTURE_MODULE_DIR = fileURLToPath(new URL("../../devkit/test/fixtures/modules/minimal", import.meta.url));
/** A module whose rule asks for a record by id, read from its condition, and for a run. */
const RECORD_NEED_MODULE_DIR = fileURLToPath(new URL("./fixtures/record-need", import.meta.url));
const RECORD_NEED_RULE = "record-need/cites-a-record";
/** A module whose rule holds tens of megabytes: inside the memory default, past a ceiling of 8. */
const ALLOCATES_MODULE_DIR = fileURLToPath(new URL("./fixtures/allocates", import.meta.url));
const ALLOCATES_RULE = "allocates/holds-after-allocating";
/** A module whose subscription asks, on every claim put, for the run its own rule asks for. */
const SENTINEL_MODULE_DIR = fileURLToPath(new URL("./fixtures/sentinel", import.meta.url));
const SENTINEL_KIND = "sentinel/watch";
/** The one recipe the sentinel's subscription and rule both name. */
const SENTINEL_COMMAND = ["node", "-e", "process.stdout.write('sentinel')"];
const CLAIM_TYPE = "musai.checking-test/claim@1";
const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: CLAIM_TYPE, identityDimensions: ["id"] };
const CLAIM_TYPES = claimTypesFrom([CLAIM_DECLARATION]);
const FIXED_INSTANT = timestamp("2026-01-01T00:00:00.000Z");

/** The core interpreter reads its parameters from the condition named for its contribution id. */
const DECLARATIVE = "musai.core/declarative";

function slotOf(id: string): string {
  return slotFor(CLAIM_DECLARATION, { id });
}

function recipe(command: readonly string[]): unknown {
  return {
    command: [...command],
    workingDirectory: "/",
    environment: {},
    declared: [],
    substrates: [],
    isolation: "hygiene",
  };
}

function exitCodeCheck(command: readonly string[], expected: number): string {
  return JSON.stringify({
    recipes: [{ name: "r", kind: "run", recipe: recipe(command) }],
    expectations: [{ kind: "exitCodeIs", recipe: "r", value: expected }],
  });
}

function checkClaim(id: string, parameters: string | null, evidence: ClaimRecord["evidence"] = []): ClaimRecord {
  return {
    kind: "claim",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: CLAIM_TYPE,
    about: [],
    slot: slotOf(id),
    conditions: parameters === null ? { id } : { id, [DECLARATIVE]: parameters },
    canonical: { statement: id },
    rendering: id,
    evidence,
    exclusiveGroup: null,
  };
}

function bareRun(output: string): RunRecord {
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

function edgeOn(run: RecordId, key: string): EvidenceEdge {
  return {
    run,
    selector: { module: "musai.core", parser: "exit-code", version: versionString("1"), key },
    item: recordId({ run, key }),
  };
}

/** Every id a derivation tree names, down to its leaves. */
function idsIn(node: unknown): string[] {
  if (node === null || typeof node !== "object") {
    return [];
  }
  const entry = node as { id?: unknown; children?: unknown };
  const here = typeof entry.id === "string" ? [entry.id] : [];
  const below = Array.isArray(entry.children) ? entry.children.flatMap(idsIn) : [];
  return [...here, ...below];
}

/** A case citing `claims` in `case.book`'s shape; `case.book` cannot mint one over a check. */
function caseOver(slug: string, claims: readonly RecordId[], projectCommit: string): CaseRecord {
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
      moduleRecord: recordId({ marker: "the module record a preset names, never installed here" }),
    },
    projectCommit,
    overrides: {},
    evaluatorVersion: versionString("1"),
  };
}

describe("a claim whose conditions name a rule is settled by running it", () => {
  let workspace: string;
  let localDir: string;
  let store: Store;
  const scope = "default";
  const now = fixedClock("2026-08-30T00:00:00.000Z");

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-checking-"));
    const initialised = await initWorkspace(workspace, { now });
    const gitDir = initialised.gitDir;
    localDir = initialised.localDir;
    store = new Store({ ctx: { gitDir }, scope, now, claimTypes: CLAIM_TYPES });
    await declareClaimTypes(store, [CLAIM_DECLARATION]);
    await buildModule(CORE_MODULE_DIR, store, {
      blobs: blobStoreOf(workspace),
      index: await foldedIndex(store),
      now,
    });
  }, 120_000);

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  function ctx(): OperationContext {
    return { workspace, scope, now };
  }

  /** A wall clock: under one fixed instant a second spawn mints the record the first did. */
  function wallClockCtx(): OperationContext {
    return { workspace, scope, now: clockFromEnvironment() };
  }

  async function runCount(): Promise<number> {
    return (await receiptIds(store)).length;
  }

  test("a check whose expectation the run meets holds, on the rule's own verdict", async () => {
    await store.putMany([
      { kind: "claim", value: checkClaim("passes", exitCodeCheck(["node", "-e", "process.exit(0)"], 0)) },
    ]);

    const status = await runHandler(claimStatus, { claim: slotOf("passes") }, ctx());

    // The claim carries no evidence: the rule's conclusion holds it up.
    expect(status.label).toBe("holds");
    expect(status.comparison.winner).toContain(DECLARATIVE);
    expect(status.comparison.via).toBe("receipt");
  }, 60_000);

  test("a check whose expectation the run does not meet fails", async () => {
    await store.putMany([
      { kind: "claim", value: checkClaim("faults", exitCodeCheck(["node", "-e", "process.exit(3)"], 0)) },
    ]);

    const status = await runHandler(claimStatus, { claim: slotOf("faults") }, ctx());

    expect(status.label).toBe("fails");
  }, 60_000);

  test("a failing check beats the receipt a claim already rests on", async () => {
    const [held] = await store.putMany([{ kind: "run", value: bareRun("the receipt this claim was filed with") }]);
    await store.putMany([
      {
        kind: "claim",
        value: checkClaim("contested", exitCodeCheck(["node", "-e", "process.exit(4)"], 0), [
          edgeOn(held!, "exitCode"),
        ]),
      },
    ]);

    const status = await runHandler(claimStatus, { claim: slotOf("contested") }, ctx());

    // Two receipts equal on kind, scope and weight: an attack the target does not beat defeats it.
    expect(status.label).toBe("fails");
  }, 60_000);

  test("a check performs each of its recipes once per evaluation, and again on the next at the age the module declares", async () => {
    const parameters = JSON.stringify({
      recipes: [
        { name: "first", kind: "run", recipe: recipe(["node", "-e", "process.exit(0)"]) },
        { name: "second", kind: "run", recipe: recipe(["node", "-e", "process.stdout.write('x')"]) },
      ],
      expectations: [
        { kind: "exitCodeIs", recipe: "first", value: 0 },
        { kind: "equals", selector: { recipe: "second", field: "output" }, value: "x" },
      ],
    });
    await store.putMany([{ kind: "claim", value: checkClaim("twice", parameters) }]);

    const before = await runCount();
    const first = await runHandler(claimStatus, { claim: slotOf("twice") }, wallClockCtx());
    const afterFirst = await runCount();
    const second = await runHandler(claimStatus, { claim: slotOf("twice") }, wallClockCtx());

    expect(first.label).toBe("holds");
    expect(second.label).toBe("holds");
    // A need runs once per recipe per evaluation; a zero resolution age re-runs it next time.
    expect(afterFirst - before).toBe(2);
    expect((await runCount()) - afterFirst).toBe(2);
  }, 60_000);

  test("a check whose recipe is refused before it spawns reads open, and its status and why both carry the refusal", async () => {
    const refused = JSON.stringify({
      recipes: [
        {
          name: "r",
          kind: "run",
          recipe: { ...(recipe(["node", "-e", "process.exit(0)"]) as object), workingDirectory: "unrooted" },
        },
      ],
      expectations: [{ kind: "exitCodeIs", recipe: "r", value: 0 }],
    });
    await store.putMany([{ kind: "claim", value: checkClaim("refused", refused) }]);

    const status = await runHandler(claimStatus, { claim: slotOf("refused") }, ctx());
    const why = await runHandler(claimWhy, { claim: slotOf("refused") }, ctx());

    expect(status.label).toBe("open");
    expect(status.detail).toContain("the working directory unrooted is relative");
    expect(why).toMatchObject({ detail: status.detail });
  }, 60_000);

  /** A check whose recipe declares `name`: it reads the bindings file and, for a secret, keys. */
  function declaringCheck(name: string, secret: boolean): string {
    return JSON.stringify({
      recipes: [
        {
          name: "r",
          kind: "run",
          recipe: { ...(recipe(["node", "-e", "process.exit(0)"]) as object), declared: [{ name, secret }] },
        },
      ],
      expectations: [{ kind: "exitCodeIs", recipe: "r", value: 0 }],
    });
  }

  test("a malformed bindings file refuses the check with a detail naming the file and no path on this machine", async () => {
    const bindingsPath = join(localDir, "bindings.json");
    await writeFile(bindingsPath, "{ not json", { mode: 0o600 });
    try {
      await store.putMany([{ kind: "claim", value: checkClaim("malformed-bindings", declaringCheck("PLAIN", false)) }]);

      const status = await runHandler(claimStatus, { claim: slotOf("malformed-bindings") }, ctx());

      expect(status.label).toBe("open");
      expect(status.detail).toContain("bindings.json");
      expect(status.detail).not.toContain(localDir);
      expect(status.detail).not.toContain(workspace);
    } finally {
      await rm(bindingsPath, { force: true });
    }
  }, 60_000);

  test("a key file with a mode wider than its owner refuses the check with a detail naming the file and no path on this machine", async () => {
    const bindingsPath = join(localDir, "bindings.json");
    const keysPath = join(localDir, "keys.json");
    await writeFile(bindingsPath, JSON.stringify({ TOKEN: { secret: true, value: "a-bound-secret" } }), {
      mode: 0o600,
    });
    await writeFile(keysPath, JSON.stringify({ keys: [] }));
    await chmod(keysPath, 0o644);
    try {
      await store.putMany([{ kind: "claim", value: checkClaim("wide-key-file", declaringCheck("TOKEN", true)) }]);

      const status = await runHandler(claimStatus, { claim: slotOf("wide-key-file") }, ctx());

      expect(status.label).toBe("open");
      expect(status.detail).toContain("keys.json");
      expect(status.detail).toContain("644");
      expect(status.detail).not.toContain(localDir);
      expect(status.detail).not.toContain(workspace);
    } finally {
      await rm(bindingsPath, { force: true });
      await rm(keysPath, { force: true });
    }
  }, 60_000);

  test("a name only the workspace's configuration declares secret reaches the check's run, which records it as a keyed hash and still holds", async () => {
    const trust = { gitDir: join(workspace, ".musai") };
    const bindingsPath = join(localDir, "bindings.json");
    const value = "bound-plain-declared-secret";
    await writeTrustFile(trust, "config.json", JSON.stringify({ declaredNames: { LAYER_TOKEN: { secret: true } } }));
    await writeFile(bindingsPath, JSON.stringify({ LAYER_TOKEN: { secret: false, value } }), { mode: 0o600 });
    try {
      await store.putMany([
        { kind: "claim", value: checkClaim("layer-declared-secret", declaringCheck("LAYER_TOKEN", false)) },
      ]);

      const status = await runHandler(claimStatus, { claim: slotOf("layer-declared-secret") }, ctx());

      expect(status.label).toBe("holds");
      const bindings: PerformedRunRecord["observation"]["bindings"][number][] = [];
      for (const id of await receiptIds(store)) {
        const run = (await store.read(id, "run")) as PerformedRunRecord;
        bindings.push(...run.observation.bindings.filter((binding) => binding.name === "LAYER_TOKEN"));
      }
      expect(bindings).toHaveLength(1);
      expect(bindings[0]).toMatchObject({ secret: true, value: null });
      expect(typeof bindings[0]!.keyedHash).toBe("string");
      expect(JSON.stringify(bindings)).not.toContain(value);
    } finally {
      await writeTrustFile(trust, "config.json", "{}\n");
      await rm(bindingsPath, { force: true });
    }
  }, 60_000);

  test("a check's rule runs under the invocation limits the workspace's configuration assigns at the project layer", async () => {
    await buildModule(ALLOCATES_MODULE_DIR, store, {
      blobs: blobStoreOf(workspace),
      index: await foldedIndex(store),
      now,
    });
    await store.putMany([
      {
        kind: "claim",
        value: {
          ...checkClaim("allocates-under-a-ceiling", null),
          conditions: { id: "allocates-under-a-ceiling", [ALLOCATES_RULE]: "" },
        },
      },
    ]);
    const trust = { gitDir: join(workspace, ".musai") };

    const unbounded = await runHandler(claimStatus, { claim: slotOf("allocates-under-a-ceiling") }, ctx());
    expect(unbounded.label).toBe("holds");

    await writeTrustFile(
      trust,
      "config.json",
      JSON.stringify({ [SLOTS_CONFIG_KEY]: { [INVOCATION_LIMITS_SLOT_ID]: { timeLimitMs: 2000, memoryLimitMb: 8 } } }),
    );
    try {
      const bounded = await runHandler(claimStatus, { claim: slotOf("allocates-under-a-ceiling") }, ctx());

      expect(bounded.label).toBe("open");
      expect(bounded.detail).toContain("memory-limit");
    } finally {
      await writeTrustFile(trust, "config.json", "{}\n");
    }
  }, 120_000);

  test("a check whose recipe declares a name secret that the bindings file binds plain holds on the receipt it minted", async () => {
    const bindingsPath = join(localDir, "bindings.json");
    await writeFile(
      bindingsPath,
      JSON.stringify({ RECIPE_TOKEN: { secret: false, value: "bound-plain-recipe-secret" } }),
      {
        mode: 0o600,
      },
    );
    try {
      await store.putMany([
        { kind: "claim", value: checkClaim("recipe-declared-secret", declaringCheck("RECIPE_TOKEN", true)) },
      ]);

      const status = await runHandler(claimStatus, { claim: slotOf("recipe-declared-secret") }, ctx());

      expect(status.label).toBe("holds");
    } finally {
      await rm(bindingsPath, { force: true });
    }
  }, 60_000);

  test("a check that holds carries no detail", async () => {
    await store.putMany([
      { kind: "claim", value: checkClaim("holds-plainly", exitCodeCheck(["node", "-e", "process.exit(0)"], 0)) },
    ]);

    const status = await runHandler(claimStatus, { claim: slotOf("holds-plainly") }, ctx());

    expect(status.label).toBe("holds");
    expect("detail" in status).toBe(false);
  }, 60_000);

  test("a claim naming no rule is a judgment, and evaluating it runs nothing", async () => {
    const [held] = await store.putMany([{ kind: "run", value: bareRun("what this judgment rests on") }]);
    await store.putMany([{ kind: "claim", value: checkClaim("judged", null, [edgeOn(held!, "exitCode")]) }]);

    const before = await runCount();
    const status = await runHandler(claimStatus, { claim: slotOf("judged") }, ctx());

    expect(status.label).toBe("holds");
    expect(await runCount()).toBe(before);
  }, 60_000);

  test("why walks from a checked claim down to the run that settled it", async () => {
    await store.putMany([
      { kind: "claim", value: checkClaim("explained", exitCodeCheck(["node", "-e", "process.exit(0)"], 0)) },
    ]);

    const why = await runHandler(claimWhy, { claim: slotOf("explained"), full: true }, ctx());

    const runs = await store.list("run");
    expect(idsIn(why.derivation).some((id) => runs.includes(id as RecordId))).toBe(true);
  }, 60_000);

  test("a case's own verbs settle every check it cites, and a sweep over the same case settles none", async () => {
    const claim = checkClaim("cited-by-a-case", exitCodeCheck(["node", "-e", "process.exit(0)"], 0));
    const [claimId] = await store.putMany([{ kind: "claim", value: claim }]);
    const opened = await openWorkspace({ workspace, scope, now });
    await store.putMany([{ kind: "case", value: caseOver("a-case-over-a-check", [claimId!], opened.matrix.commit) }]);

    // The sweep reads this case's claims, so the count below is a control, not an empty workspace.
    const beforeSweep = await runCount();
    const listed = await runHandler(viewRun, { view: "musai.core/cases" }, wallClockCtx());
    expect(JSON.stringify(listed)).toContain("a-case-over-a-check");
    expect(await runCount()).toBe(beforeSweep);

    const sound = await runHandler(caseSoundcheck, { case: "a-case-over-a-check" }, wallClockCtx());
    expect(sound.claims.map((entry) => entry.label)).toEqual(["holds"]);
    expect(await runCount()).toBeGreaterThan(beforeSweep);

    const afterSoundcheck = await runCount();
    await runHandler(caseStatus, { case: "a-case-over-a-check" }, wallClockCtx());
    expect(await runCount()).toBeGreaterThan(afterSoundcheck);
  }, 120_000);

  test("a case its check's receipt settled is listed done and previewed done, and neither runs anything", async () => {
    const claim = checkClaim("settled-by-its-check", exitCodeCheck(["node", "-e", "process.exit(0)"], 0));
    const [claimId] = await store.putMany([{ kind: "claim", value: claim }]);
    const opened = await openWorkspace({ workspace, scope, now });
    await store.putMany([{ kind: "case", value: caseOver("a-settled-case", [claimId!], opened.matrix.commit) }]);
    await runHandler(caseSoundcheck, { case: "a-settled-case" }, wallClockCtx());
    const before = await runCount();

    const listed = await runHandler(viewRun, { view: "musai.core/cases" }, wallClockCtx());
    const previewed = await runHandler(caseStatus, { case: "a-settled-case" }, { ...wallClockCtx(), mode: "plan" });

    const rows = (listed as unknown as { rows: { slug: string; status: string }[] }).rows;
    expect(rows.find((row) => row.slug === "a-settled-case")?.status).toBe("done");
    expect(previewed).toMatchObject({ done: true, counts: { holds: 1, fails: 0, open: 0 } });
    expect(await runCount()).toBe(before);
  }, 120_000);

  test("a case one of whose checks fails is listed open and previewed open, and neither runs anything", async () => {
    const holding = checkClaim("a-check-that-holds", exitCodeCheck(["node", "-e", "process.exit(0)"], 0));
    const failing = checkClaim("a-check-that-fails", exitCodeCheck(["node", "-e", "process.exit(1)"], 0));
    const claimIds = await store.putMany([
      { kind: "claim", value: holding },
      { kind: "claim", value: failing },
    ]);
    const opened = await openWorkspace({ workspace, scope, now });
    await store.putMany([{ kind: "case", value: caseOver("a-failing-case", claimIds, opened.matrix.commit) }]);
    await runHandler(caseSoundcheck, { case: "a-failing-case" }, wallClockCtx());
    const before = await runCount();

    const listed = await runHandler(viewRun, { view: "musai.core/cases" }, wallClockCtx());
    const previewed = await runHandler(caseStatus, { case: "a-failing-case" }, { ...wallClockCtx(), mode: "plan" });

    const rows = (listed as unknown as { rows: { slug: string; status: string; reason?: string }[] }).rows;
    expect(rows.find((row) => row.slug === "a-failing-case")).toMatchObject({ status: "open", reason: "claim-fails" });
    expect(previewed).toMatchObject({ done: false, reason: "claim-fails", counts: { holds: 1, fails: 1, open: 0 } });
    expect(await runCount()).toBe(before);
  }, 120_000);

  test("a case whose check nothing has run lists that check unchecked, as its preview does, and only performing runs it", async () => {
    const claim = checkClaim("never-run", exitCodeCheck(["node", "-e", "process.exit(0) /* never-run */"], 0));
    const [claimId] = await store.putMany([{ kind: "claim", value: claim }]);
    const opened = await openWorkspace({ workspace, scope, now });
    await store.putMany([{ kind: "case", value: caseOver("an-unchecked-case", [claimId!], opened.matrix.commit) }]);
    const before = await runCount();

    const rowOf = async () => {
      const listed = await runHandler(viewRun, { view: "musai.core/cases" }, wallClockCtx());
      const rows = (listed as unknown as { rows: { slug: string; status: string; reason?: string }[] }).rows;
      return rows.find((row) => row.slug === "an-unchecked-case");
    };
    const previewed = await runHandler(caseStatus, { case: "an-unchecked-case" }, { ...wallClockCtx(), mode: "plan" });
    expect(await rowOf()).toMatchObject({ status: "open", reason: "claim-unchecked" });
    expect(previewed).toMatchObject({
      done: false,
      reason: "claim-unchecked",
      counts: { holds: 0, fails: 0, open: 1 },
    });
    expect(caseStatus.renderText!(previewed).split("\n")[0]).toBe(
      "no gate awaits an answer, and 1 check has not run here",
    );
    expect(await runCount()).toBe(before);

    const performed = await runHandler(caseStatus, { case: "an-unchecked-case" }, wallClockCtx());
    expect(performed).toMatchObject({ done: true, counts: { holds: 1, fails: 0, open: 0 } });
    expect(await runCount()).toBeGreaterThan(before);
    expect(await rowOf()).toMatchObject({ status: "done" });
  }, 120_000);

  test("a case with an unrun check and a claim no run settles lists the claim open, not unchecked", async () => {
    const unrun = checkClaim(
      "unrun-beside-a-judgment",
      exitCodeCheck(["node", "-e", "process.exit(0) /* beside */"], 0),
    );
    const judgment = checkClaim("a-judgment-nothing-settles", null);
    const claimIds = await store.putMany([
      { kind: "claim", value: unrun },
      { kind: "claim", value: judgment },
    ]);
    const opened = await openWorkspace({ workspace, scope, now });
    await store.putMany([{ kind: "case", value: caseOver("an-open-case", claimIds, opened.matrix.commit) }]);

    const listed = await runHandler(viewRun, { view: "musai.core/cases" }, wallClockCtx());
    const rows = (listed as unknown as { rows: { slug: string; status: string; reason?: string }[] }).rows;
    expect(rows.find((row) => row.slug === "an-open-case")).toMatchObject({ status: "open", reason: "claim-open" });
  }, 120_000);

  test("a claim naming two rules in its conditions is refused rather than settled by either, and so is the sweep listing a case citing it", async () => {
    // A second module's rule, so the claim below names two.
    await buildModule(FIXTURE_MODULE_DIR, store, {
      blobs: blobStoreOf(workspace),
      index: await foldedIndex(store),
      now,
    });
    const parameters = exitCodeCheck(["node", "-e", "process.exit(0)"], 0);
    const [claimId] = await store.putMany([
      {
        kind: "claim",
        value: {
          ...checkClaim("two-rulers", parameters),
          conditions: { id: "two-rulers", [DECLARATIVE]: parameters, "fixture-minimal/clean-exit": "{}" },
        },
      },
    ]);

    await expect(runHandler(claimStatus, { claim: slotOf("two-rulers") }, ctx())).rejects.toThrow(/more than one rule/);

    // A sweep settles no check but still reads which rule a claim names, so the refusal reaches it.
    const opened = await openWorkspace({ workspace, scope, now });
    await store.putMany([
      { kind: "case", value: caseOver("a-case-over-two-rulers", [claimId!], opened.matrix.commit) },
    ]);
    await expect(runHandler(viewRun, { view: "musai.core/cases" }, ctx())).rejects.toMatchObject({
      reason: "invalid-input",
      about: [slotOf("two-rulers")],
    });
  }, 120_000);

  test("a check whose rule requested a record does not read that record as a run", async () => {
    await buildModule(RECORD_NEED_MODULE_DIR, store, {
      blobs: blobStoreOf(workspace),
      index: await foldedIndex(store),
      now,
    });
    const [cited] = await store.putMany([{ kind: "claim", value: checkClaim("cited-by-a-rule", null) }]);
    await store.putMany([
      {
        kind: "claim",
        value: {
          ...checkClaim("cites-a-record", null),
          conditions: { id: "cites-a-record", [RECORD_NEED_RULE]: cited! },
        },
      },
    ]);

    const status = await runHandler(claimStatus, { claim: slotOf("cites-a-record") }, ctx());

    expect(status.label).toBe("holds");
    expect(status.comparison.winner).toContain(RECORD_NEED_RULE);
    expect(status.comparison.via).toBe("receipt");
  }, 120_000);

  test("an evidence run naming a binary no installed module declares leaves the check open, saying so, and mints nothing", async () => {
    const binary = "definitely-not-a-real-binary-musai-test";
    await store.putMany([
      { kind: "claim", value: checkClaim("undeclared-binary", exitCodeCheck([binary, "-e", "0"], 0)) },
    ]);

    const status = await runHandler(claimStatus, { claim: slotOf("undeclared-binary") }, ctx());

    expect(status.label).toBe("open");
    // `detail`, not the comparison's reason, tells a refusal before spawning from a failed spawn.
    expect(status.detail).toContain(`refusing to run ${binary}: no installed module declares it as a requirement`);
    for (const id of await store.list("run")) {
      const run = (await store.read(id, "run")) as RunRecord;
      expect(run.recipe.command).not.toContain(binary);
    }
  }, 60_000);

  test("a program only the workspace's toolset names is refused for a claim that is not a check", async () => {
    const gitDir = join(workspace, ".musai");
    await writeTrustFile({ gitDir }, "config.json", `${JSON.stringify({ tools: ["printf"] })}\n`);
    try {
      await store.putMany([{ kind: "claim", value: checkClaim("toolset-only", exitCodeCheck(["printf", "ok"], 0)) }]);

      const status = await runHandler(claimStatus, { claim: slotOf("toolset-only") }, ctx());

      expect(status.label).toBe("open");
      expect(status.detail).toContain("refusing to run printf");
    } finally {
      await writeTrustFile({ gitDir }, "config.json", "{}\n");
    }
  }, 60_000);

  test("a run a pack's rule requests is authorised by a binary another installed module declares", async () => {
    // An install of bytes the name already resolves to commits nothing.
    await buildModule(RECORD_NEED_MODULE_DIR, store, {
      blobs: blobStoreOf(workspace),
      index: await foldedIndex(store),
      now,
    });
    const index = await foldedIndex(store);
    expect(index.contributionsOf("requirement").filter((row) => row.moduleName === "record-need")).toHaveLength(0);

    const [cited] = await store.putMany([{ kind: "claim", value: checkClaim("cited-by-an-untooled-rule", null) }]);
    await store.putMany([
      {
        kind: "claim",
        value: {
          ...checkClaim("authorised-by-another-module", null),
          conditions: { id: "authorised-by-another-module", [RECORD_NEED_RULE]: cited! },
        },
      },
    ]);

    const status = await runHandler(claimStatus, { claim: slotOf("authorised-by-another-module") }, ctx());

    // With a zero resolution age and a fixed clock, an earlier receipt is reused, not re-spawned.
    expect(status.label).toBe("holds");
    const runs = await Promise.all(
      (await store.list("run")).map((id) => store.read(id, "run") as Promise<PerformedRunRecord>),
    );
    // Record-need declares no requirement; core's `node` row authorises the run it asked for.
    const cleanExit = runs.find((run) => isDeepStrictEqual(run.recipe.command, ["node", "-e", "process.exit(0)"]));
    expect(cleanExit).toBeDefined();
    expect(cleanExit!.observation.binaries.map((binary) => binary.name)).toContain("node");
  }, 120_000);
});

describe("a check is performed only where the rule record naming its rule admits the claim's conditions", () => {
  let workspace: string;
  let store: Store;
  let goldRule: RecordId;
  const scope = "default";
  const now = fixedClock("2026-08-30T00:00:00.000Z");

  function declarativeRule(name: string, tier: string, supersedes: RecordId[] = []) {
    return {
      kind: "rule" as const,
      schemaVersion: CURRENT_SCHEMA_VERSIONS.rule,
      name,
      scope: { tier },
      weight: exactDecimal("1"),
      supersedes,
      contribution: DECLARATIVE,
    };
  }

  /** A check at `tier` whose recipe is its own, so any spawn for it mints a receipt. */
  function tieredCheck(id: string, tier: string | null): ClaimRecord {
    const claim = checkClaim(id, exitCodeCheck(["node", "-e", `process.exit(0) /* ${id} */`], 0));
    return tier === null ? claim : { ...claim, conditions: { ...claim.conditions, tier } };
  }

  // Its own workspace: a rule record naming the interpreter would reach every check above.
  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-checking-scoped-"));
    const { gitDir } = await initWorkspace(workspace, { now });
    store = new Store({ ctx: { gitDir }, scope, now, claimTypes: CLAIM_TYPES });
    await declareClaimTypes(store, [CLAIM_DECLARATION]);
    await buildModule(CORE_MODULE_DIR, store, {
      blobs: blobStoreOf(workspace),
      index: await foldedIndex(store),
      now,
    });
    [goldRule] = await store.putMany([{ kind: "rule", value: declarativeRule("gold-only", "gold") }]);
  }, 120_000);

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  function ctx(): OperationContext {
    return { workspace, scope, now };
  }

  async function runCount(): Promise<number> {
    return (await receiptIds(store)).length;
  }

  test("a check whose conditions the rule's scope admits is performed and holds", async () => {
    await store.putMany([{ kind: "claim", value: tieredCheck("gold", "gold") }]);

    const status = await runHandler(claimStatus, { claim: slotOf("gold") }, ctx());

    expect(status.label).toBe("holds");
    expect(status.comparison.winner).toContain(DECLARATIVE);
  }, 60_000);

  test("a check outside the rule's scope reads inapplicable, and nothing is spawned or minted for it", async () => {
    await store.putMany([{ kind: "claim", value: tieredCheck("bronze", "bronze") }]);
    const before = await runCount();

    const status = await runHandler(claimStatus, { claim: slotOf("bronze") }, ctx());

    expect(status.label).toBe("open");
    expect(status.reason).toBe("inapplicable");
    expect(status.detail).toContain("out of scope");
    expect(await runCount()).toBe(before);
  }, 60_000);

  test("a check naming no value on a dimension the rule's scope names reads inapplicable", async () => {
    await store.putMany([{ kind: "claim", value: tieredCheck("untiered", null) }]);
    const before = await runCount();

    const status = await runHandler(claimStatus, { claim: slotOf("untiered") }, ctx());

    expect(status.label).toBe("open");
    expect(status.reason).toBe("inapplicable");
    expect(await runCount()).toBe(before);
  }, 60_000);

  test("two live rule records naming one rule refuse the read by name, and superseding one of them lifts the refusal", async () => {
    const [silverRule] = await store.putMany([{ kind: "rule", value: declarativeRule("silver-only", "silver") }]);

    const refusal = await runHandler(claimStatus, { claim: slotOf("gold") }, ctx()).catch((caught: unknown) => caught);

    expect(refusal).toMatchObject({ reason: "declaration-conflict" });
    expect((refusal as { about: readonly string[] }).about).toEqual([DECLARATIVE, ...[goldRule, silverRule!].sort()]);

    // A replacement stating no contribution withdraws the policy rather than contending with it.
    await store.putMany([
      { kind: "rule", value: { ...declarativeRule("silver-only", "silver", [silverRule!]), contribution: null } },
    ]);

    const status = await runHandler(claimStatus, { claim: slotOf("gold") }, ctx());
    expect(status.label).toBe("holds");
  }, 60_000);
});

describe("a subscription is a run at its trigger, and its receipt is evidence like any other", () => {
  let workspace: string;
  let store: Store;
  const scope = "default";
  const now = fixedClock("2026-08-30T00:00:00.000Z");

  // Its own workspace: the subscription fires on every claim put.
  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-subscription-"));
    const { gitDir } = await initWorkspace(workspace, { now });
    store = new Store({ ctx: { gitDir }, scope, now });
    await buildModule(CORE_MODULE_DIR, store, { blobs: blobStoreOf(workspace), index: await foldedIndex(store), now });
    await buildModule(SENTINEL_MODULE_DIR, store, {
      blobs: blobStoreOf(workspace),
      index: await foldedIndex(store),
      now,
    });
  }, 120_000);

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  function ctx(): OperationContext {
    return { workspace, scope, now: clockFromEnvironment() };
  }

  /** Every run of the sentinel recipe; under the wall clock each spawn is its own record. */
  async function sentinelRuns(): Promise<RecordId[]> {
    const runs: RecordId[] = [];
    for (const id of await store.list("run")) {
      const run = (await store.read(id, "run")) as RunRecord;
      if (isDeepStrictEqual(run.recipe.command, SENTINEL_COMMAND)) {
        runs.push(id);
      }
    }
    return runs;
  }

  test("an evaluation within the resolution age its case allows rests on the receipt a subscription minted at the event, and why walks down to it", async () => {
    const booked = await runHandler(
      caseBook,
      { slug: "watched", kind: SENTINEL_KIND, overrides: { "musai.core/resolution-age": 3600000 } },
      ctx(),
    );
    const claim = booked.minted.find((item) => item.kind === "claim")!.record as ClaimRecord;

    // Booking puts the claim, and the subscription runs the recipe before any rule asks.
    const atTheEvent = await sentinelRuns();
    expect(atTheEvent).toHaveLength(1);

    const why = await runHandler(claimWhy, { claim: claim.slot, full: true }, ctx());

    // The rule's recipe is the subscription's, within the case's age, so its receipt is cited.
    expect(await sentinelRuns()).toEqual(atTheEvent);
    expect(idsIn(why.derivation)).toContain(atTheEvent[0]);
  }, 120_000);
});

describe("a check over a fold whose slot set the registry refuses", () => {
  let workspace: string;
  let store: Store;
  const scope = "default";
  const now = fixedClock("2026-08-30T00:00:00.000Z");
  const COLLIDING_SLOT = "colliding-pack/limit";

  /** The colliding slot at `version`: well-formed alone, refused beside its twin. */
  function slotAt(version: string): ContributionEntry {
    return {
      kind: "slot",
      id: COLLIDING_SLOT,
      version: versionString(version),
      input: { layers: ["project"], hasDefault: true, default: 1 },
      output: { type: "integer" },
      documentation: "d",
    };
  }

  // Its own workspace; the slot written straight through the store, as git lands it, skips install.
  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-checking-colliding-slot-"));
    const { gitDir } = await initWorkspace(workspace, { now });
    store = new Store({ ctx: { gitDir }, scope, now, claimTypes: CLAIM_TYPES });
    await declareClaimTypes(store, [CLAIM_DECLARATION]);
    await buildModule(CORE_MODULE_DIR, store, {
      blobs: blobStoreOf(workspace),
      index: await foldedIndex(store),
      now,
    });
    const colliding: ModuleRecord = {
      kind: "module",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.module,
      name: "colliding-pack",
      version: versionString("1.0.0"),
      manifest: manifestWithContributions([slotAt("1"), slotAt("2")]),
      bundle: null,
      build: null,
    };
    await store.put("module", colliding);
  }, 120_000);

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("a check refuses naming the slot the registry cannot register, and mints no receipt", async () => {
    await store.putMany([
      { kind: "claim", value: checkClaim("unreadable", exitCodeCheck(["node", "-e", "process.exit(0)"], 0)) },
    ]);
    const before = (await store.list("run")).length;

    const status = runHandler(claimStatus, { claim: slotOf("unreadable") }, { workspace, scope, now });

    await expect(status).rejects.toBeInstanceOf(SlotRefusedError);
    await expect(status).rejects.toThrow(COLLIDING_SLOT);
    expect((await store.list("run")).length).toBe(before);
  }, 60_000);
});
