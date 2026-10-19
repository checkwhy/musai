import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OperationContext, runHandler, validateOperationOutput } from "@musai/api-core";
import { type Audience, type PerformedRunRecord, performedRun, type RunRecord, textOf } from "@musai/records";
import { containerEngineAvailable, DEFAULT_CONTAINER_ENGINE, STATION_IMAGE_CONFIG_KEY } from "@musai/run";
import { MUSAI_DIR, readTrustBranch, Store } from "@musai/store";
import { fixedClock, localImageRunning, makeCheckout, receiptIds, writeTrustFile } from "@musai/test-support";
import { describe, expect, onTestFinished, test } from "vitest";
import { checkRun } from "../src/ops/check.js";
import { moduleBuild, moduleNew, moduleTest } from "../src/ops/module.js";
import { workspaceInit } from "../src/ops/workspace.js";

const now = fixedClock("2026-10-11T00:00:00.000Z");
const SCOPE = "default";
const RULE = "scaffolded/exits-cleanly";
const SCAFFOLDED_COMMAND = "process.stdout.write('ok')";
const SCAFFOLDED_REASON = "the run exited cleanly";
const PRINTS_CWD = "process.stdout.write(process.cwd())";
const WRITES_INTO_TREE = "require('fs').writeFileSync('written.txt', 'x')";
const STATEMENT = "the scaffolded module's command exits cleanly";

/** A project's workspace with a module installed from a scaffold edited to run `command`. */
async function scaffoldedBesideProject(command = PRINTS_CWD) {
  const checkout = await makeCheckout("hello");
  onTestFinished(() => checkout.cleanup());
  const moduleDir = await mkdtemp(join(tmpdir(), "musai-scaffolded-module-"));
  onTestFinished(() => rm(moduleDir, { recursive: true, force: true }));
  const author: OperationContext = { workspace: checkout.dir, scope: SCOPE, now, principalName: "operator" };
  await runHandler(workspaceInit, { workspace: checkout.dir }, author);

  const scaffolded = await runHandler(moduleNew, { dir: moduleDir }, author);
  expect(scaffolded.testReport?.ok).toBe(true);
  const source = join(moduleDir, "module.ts");
  await writeFile(source, (await readFile(source, "utf8")).replace(SCAFFOLDED_COMMAND, command));
  await runHandler(moduleBuild, { dir: moduleDir }, author);

  const gitDir = join(checkout.dir, MUSAI_DIR);
  const store = new Store({ ctx: { gitDir }, scope: SCOPE, now });
  return { project: checkout.dir, gitDir, store, author };
}

async function cwdRuns(store: Store): Promise<PerformedRunRecord[]> {
  const runs = await Promise.all(
    (await receiptIds(store)).map(async (id) => performedRun(id, (await store.read(id, "run")) as RunRecord)),
  );
  return runs.filter((run) => run.recipe.command[2] === PRINTS_CWD);
}

describe("a module scaffolded, edited and installed judges a claim checked by its rule", () => {
  test("its run stands in the project's working tree, never the filesystem root", async () => {
    const { project, store, author } = await scaffoldedBesideProject();

    const checked = await runHandler(checkRun, { statement: STATEMENT, rule: RULE }, author);

    expect([checked.label, checked.reason]).toEqual(["holds", null]);
    const [run] = await cwdRuns(store);
    expect(run!.recipe.workingDirectory).toBe(".");
    expect(textOf(run!.observation.output, "the scaffolded run's cwd")).toBe(await realpath(project));
  }, 240_000);

  test("a hint names what the rule's run wrote into the tree it read", async () => {
    const { author } = await scaffoldedBesideProject(WRITES_INTO_TREE);

    const checked = await runHandler(checkRun, { statement: STATEMENT, rule: RULE }, author);

    expect(checked.label).toBe("holds");
    expect(checked.hint).toContain("the tree moved while the command ran");
    expect(checked.hint).toContain("written.txt");
  }, 240_000);

  test("under a clearance its run is not refused for where it stands, and holds in the station's image", async (context) => {
    if (!(await containerEngineAvailable(DEFAULT_CONTAINER_ENGINE))) {
      context.skip("no container engine answers on this machine");
    }
    const image = await localImageRunning(["node", "-e", ""]);
    if (image === undefined) {
      context.skip("no locally held image runs node");
    }
    const { gitDir, store, author } = await scaffoldedBesideProject();
    const { values } = (await readTrustBranch({ gitDir })).config;
    const configured = { ...values, [STATION_IMAGE_CONFIG_KEY]: `${image!.repository}@sha256:${image!.digest}` };
    await writeTrustFile({ gitDir }, "config.json", `${JSON.stringify(configured)}\n`);
    await writeTrustFile({ gitDir }, "audiences", "writer\n");
    const station = { ...author, clearance: "writer" as Audience };

    const checked = await runHandler(checkRun, { statement: STATEMENT, rule: RULE }, station);

    expect([checked.label, checked.reason]).toEqual(["holds", null]);
    const [inContainer] = (await cwdRuns(store)).filter((run) => run.recipe.isolation === "container");
    expect(inContainer?.observation.isolationHeld).toBe("container");
  }, 240_000);
});

describe("a scaffold's answer and its module test's", () => {
  test("are held to their closed output schemas, which refuse a stray field at any depth", async () => {
    const checkout = await makeCheckout("hello");
    onTestFinished(() => checkout.cleanup());
    const moduleDir = await mkdtemp(join(tmpdir(), "musai-scaffolded-module-"));
    onTestFinished(() => rm(moduleDir, { recursive: true, force: true }));
    const author: OperationContext = { workspace: checkout.dir, scope: SCOPE, now, principalName: "operator" };
    await runHandler(workspaceInit, { workspace: checkout.dir }, author);

    const scaffolded = await runHandler(moduleNew, { dir: moduleDir }, author);
    const again = await runHandler(moduleNew, { dir: moduleDir }, author);
    const source = join(moduleDir, "module.ts");
    await writeFile(source, (await readFile(source, "utf8")).replace(SCAFFOLDED_REASON, "a reason its golden lacks"));
    const tested = await runHandler(moduleTest, { dir: moduleDir }, author);
    const report = scaffolded.testReport!;
    const [result] = report.results;
    const failed = tested.results.find((candidate) => candidate.mismatches.length > 0)!;

    expect(again.testReport).toBeNull();
    expect(tested.ok).toBe(false);
    expect(failed.mismatches[0]).toMatchObject({ half: "response", path: "$.reason" });
    expect(validateOperationOutput(moduleNew, scaffolded)).toEqual({ ok: true });
    expect(validateOperationOutput(moduleNew, again)).toEqual({ ok: true });
    expect(validateOperationOutput(moduleTest, tested)).toEqual({ ok: true });
    for (const stray of [
      { ...scaffolded, stray: 1 },
      { ...scaffolded, testReport: { ...report, stray: 1 } },
      { ...scaffolded, testReport: { ...report, results: [{ ...result!, stray: 1 }] } },
    ]) {
      expect(validateOperationOutput(moduleNew, stray)).toMatchObject({ ok: false });
    }
    for (const stray of [
      { ...tested, stray: 1 },
      { ...tested, results: [{ ...failed, mismatches: [{ ...failed.mismatches[0]!, stray: 1 }] }] },
    ]) {
      expect(validateOperationOutput(moduleTest, stray)).toMatchObject({ ok: false });
    }
  }, 240_000);
});
