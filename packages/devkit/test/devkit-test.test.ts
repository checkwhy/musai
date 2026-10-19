import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HOSTS } from "@musai/modules";
import type { RunRecipe } from "@musai/records";
import { canonicalBytes, type RecordId, rawId, recordId, recordPath } from "@musai/records";
import { fixedClock, gatewaySource } from "@musai/test-support";
import { afterEach, describe, expect, test } from "vitest";
import { type FixtureCase, type Golden, readFixtureStore, readGolden, writeGolden } from "../src/fixtures.js";
import { scaffoldModule } from "../src/scaffold.js";
import { runModuleTests } from "../src/test.js";

const FIXED_INSTANT = "2026-08-30T00:00:00.000Z";
const FIXED_NOW = fixedClock(FIXED_INSTANT);

const FAKE_RUN_ID: RecordId = `sha256:${"a".repeat(64)}`;

const DECIDES_FROM_EVIDENCE_BODY = [
  "      if (input.evidence.length === 0) {",
  '        return { kind: "verdict", label: "open", reason: "no evidence yet" };',
  "      }",
  "      return input.evidence[0].exitCode === 0",
  '        ? { kind: "verdict", label: "holds", reason: "the receipt exited cleanly" }',
  '        : { kind: "verdict", label: "fails", reason: "the receipt exited with a fault" };',
].join("\n");

const PRINTF_RECIPE: RunRecipe = {
  command: ["printf", "%s", "ok"],
  workingDirectory: "/",
  environment: {},
  declared: [],
  substrates: [],
  isolation: "hygiene",
};
const PRINTF_RECIPE_ID = recordId(PRINTF_RECIPE);

/** The verdict's reason is a JavaScript expression, so a rule can echo what it was handed. */
function requestsARunBody(recipe: RunRecipe, reason = '"ran"'): string {
  return [
    "      if (input.evidence.length === 0) {",
    `        return { kind: "request", needs: [{ kind: "run", recipe: ${JSON.stringify(recipe)} }] };`,
    "      }",
    `      return { kind: "verdict", label: "holds", reason: ${reason} };`,
  ].join("\n");
}

const REQUESTS_A_RUN_BODY = requestsARunBody(PRINTF_RECIPE);

/** Performing it creates `marker`, so whether it ran is read from disk; the path is in its id. */
function writesMarkerRecipe(marker: string): RunRecipe {
  return {
    command: ["node", "-e", 'require("node:fs").writeFileSync(process.argv[1], "")', marker],
    workingDirectory: "/",
    environment: {},
    declared: [],
    substrates: [],
    isolation: "hygiene",
  };
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

async function scratchModule(name: string, source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `musai-test-module-${name}-`));
  cleanups.push(async () => rm(dir, { recursive: true, force: true }));
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name, version: "1.0.0", private: true, type: "module" }, null, 2),
  );
  await writeFile(join(dir, "module.ts"), source);
  return dir;
}

/** A path where nothing exists until a recipe writes it. */
async function scratchMarker(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `musai-test-marker-${name}-`));
  cleanups.push(async () => rm(dir, { recursive: true, force: true }));
  return join(dir, "performed");
}

async function writeFixtureInput(
  dir: string,
  contributionId: string,
  fixtureName: string,
  version: string,
  input: unknown,
): Promise<void> {
  const path = join(dir, "fixtures", contributionId, `${fixtureName}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ version, input }, null, 2));
}

async function caseFor(
  dir: string,
  contributionId: string,
  fixtureName: string,
): Promise<{ store: Awaited<ReturnType<typeof readFixtureStore>>; fixtureCase: FixtureCase }> {
  const store = await readFixtureStore(dir);
  const fixtureCase = store.cases.find(
    (entry) => entry.contributionId === contributionId && entry.name === fixtureName,
  );
  if (fixtureCase === undefined) {
    throw new Error(`no fixture case found for ${contributionId}/${fixtureName}`);
  }
  return { store, fixtureCase };
}

describe("running a module's own fixtures drives the real evaluation with performing switched off", () => {
  test("a passing case passes under every registered, available host", async () => {
    const dir = await scratchModule("clean-decide", gatewaySource("invoke", DECIDES_FROM_EVIDENCE_BODY));
    const contributionId = "clean-decide/decides";
    await writeFixtureInput(dir, contributionId, "holds-when-clean", "1", {
      claimId: "claim-clean",
      conditions: {},
      evidence: [{ runId: FAKE_RUN_ID, exitCode: 0, output: "ok" }],
    });
    const { store, fixtureCase } = await caseFor(dir, contributionId, "holds-when-clean");
    const golden: Golden = {
      response: { kind: "verdict", label: "holds", reason: "the receipt exited cleanly" },
      reads: [`evidence:${FAKE_RUN_ID}`],
      rounds: [
        {
          output: { kind: "verdict", label: "holds", reason: "the receipt exited cleanly" },
          reads: [`evidence:${FAKE_RUN_ID}`],
        },
      ],
    };
    await writeGolden(store, fixtureCase, golden);

    const report = await runModuleTests(dir, { now: FIXED_NOW });

    expect(report.ok).toBe(true);
    const executed = report.results.filter((result) => result.status !== "skipped");
    expect(executed.length).toBeGreaterThanOrEqual(2);
    for (const result of executed) {
      expect(result.status).toBe("pass");
    }
    expect(report.results.some((result) => result.host === "replay" && result.status === "pass")).toBe(true);
  });

  test("a golden differing by one byte fails with a path into the canonical JSON and a byte offset", async () => {
    const dir = await scratchModule("byte-diff", gatewaySource("invoke", DECIDES_FROM_EVIDENCE_BODY));
    const contributionId = "byte-diff/decides";
    await writeFixtureInput(dir, contributionId, "case", "1", {
      claimId: "claim-byte",
      conditions: {},
      evidence: [{ runId: FAKE_RUN_ID, exitCode: 0, output: "ok" }],
    });
    const { store, fixtureCase } = await caseFor(dir, contributionId, "case");
    const golden: Golden = {
      response: { kind: "verdict", label: "fails", reason: "wrong on purpose" },
      reads: [`evidence:${FAKE_RUN_ID}`],
      rounds: [
        { output: { kind: "verdict", label: "fails", reason: "wrong on purpose" }, reads: [`evidence:${FAKE_RUN_ID}`] },
      ],
    };
    await writeGolden(store, fixtureCase, golden);

    const report = await runModuleTests(dir, { now: FIXED_NOW });

    expect(report.ok).toBe(false);
    const failed = report.results.find((result) => result.host === "in-process");
    expect(failed?.status).toBe("fail");
    const mismatch = failed?.mismatches.find((entry) => entry.half === "response");
    expect(mismatch?.path).toBeDefined();
    expect(mismatch?.byteOffset).toBeTypeOf("number");
  });

  test("a response that matches and a read-log that does not fails, naming which half moved", async () => {
    const dir = await scratchModule("reads-diff", gatewaySource("invoke", DECIDES_FROM_EVIDENCE_BODY));
    const contributionId = "reads-diff/decides";
    await writeFixtureInput(dir, contributionId, "case", "1", {
      claimId: "claim-reads",
      conditions: {},
      evidence: [{ runId: FAKE_RUN_ID, exitCode: 0, output: "ok" }],
    });
    const { store, fixtureCase } = await caseFor(dir, contributionId, "case");
    const wrongRead = `evidence:sha256:${"b".repeat(64)}`;
    const golden: Golden = {
      response: { kind: "verdict", label: "holds", reason: "the receipt exited cleanly" },
      reads: [wrongRead],
      rounds: [
        { output: { kind: "verdict", label: "holds", reason: "the receipt exited cleanly" }, reads: [wrongRead] },
      ],
    };
    await writeGolden(store, fixtureCase, golden);

    const report = await runModuleTests(dir, { now: FIXED_NOW });

    expect(report.ok).toBe(false);
    const failed = report.results.find((result) => result.host === "in-process");
    expect(failed?.status).toBe("fail");
    expect(failed?.mismatches.some((entry) => entry.half === "response")).toBe(false);
    const readsMismatch = failed?.mismatches.find((entry) => entry.half === "reads");
    expect(readsMismatch?.missing).toContain(wrongRead);
    expect(readsMismatch?.extra).toContain(`evidence:${FAKE_RUN_ID}`);
  });

  test("a recipe with no recorded receipt fails by name with its recipe id, and is never performed", async () => {
    const marker = await scratchMarker("unrecorded");
    const recipe = writesMarkerRecipe(marker);
    const dir = await scratchModule("unrecorded", gatewaySource("invoke", requestsARunBody(recipe)));
    const contributionId = "unrecorded/decides";
    await writeFixtureInput(dir, contributionId, "case", "1", {
      claimId: "claim-unrecorded",
      conditions: {},
      evidence: [],
    });

    const report = await runModuleTests(dir, { now: FIXED_NOW });

    await expect(access(marker)).rejects.toThrow();
    expect(report.ok).toBe(false);
    const failed = report.results.find((result) => result.host === "in-process");
    expect(failed?.status).toBe("fail");
    expect(failed?.message).toContain(recordId(recipe));
  });

  test("an input carrying an absolute path is refused by the runner rather than passed to a contribution", async () => {
    const dir = await scratchModule("machine-local", gatewaySource("invoke", DECIDES_FROM_EVIDENCE_BODY));
    const contributionId = "machine-local/decides";
    await writeFixtureInput(dir, contributionId, "case", "1", {
      claimId: "claim-local",
      conditions: { path: "/etc/hosts" },
      evidence: [],
    });

    await expect(runModuleTests(dir, { now: FIXED_NOW })).rejects.toThrow(/absolute path/);
  });

  test("a fixture naming a point the kernel does not ship is refused by name, since a module directory holds no fold to resolve it from", async () => {
    const dir = await scratchModule("acme", gatewaySource("invoke", DECIDES_FROM_EVIDENCE_BODY));
    const path = join(dir, "fixtures", "acme", "decides", "case.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ version: "1", input: {}, contribution: "acme/p" }, null, 2));

    await expect(runModuleTests(dir, { now: FIXED_NOW })).rejects.toThrow(
      /acme\/decides.*acme\/p.*not an installed workspace/,
    );
  });

  test("a module with no fixture at all fails the run naming the module rather than passing an empty suite", async () => {
    const dir = await scratchModule("empty-suite", gatewaySource("invoke", DECIDES_FROM_EVIDENCE_BODY));

    const report = await runModuleTests(dir, { now: FIXED_NOW });

    expect(report.ok).toBe(false);
    expect(report.results).toHaveLength(1);
    expect(report.results[0]?.message).toContain("empty-suite");
  });

  test("two runs of one suite report their failures in the same order", async () => {
    const dir = await scratchModule("ordering", gatewaySource("invoke", DECIDES_FROM_EVIDENCE_BODY));
    const cases: readonly [string, string][] = [
      ["ordering/b", "z"],
      ["ordering/a", "only"],
      ["ordering/b", "a"],
    ];
    for (const [contributionId, name] of cases) {
      await writeFixtureInput(dir, contributionId, name, "1", {
        claimId: `claim-${name}`,
        conditions: {},
        evidence: [],
      });
    }

    const first = await runModuleTests(dir, { now: FIXED_NOW });
    const second = await runModuleTests(dir, { now: FIXED_NOW });

    const orderOf = (report: typeof first): string[] => {
      const seen: string[] = [];
      for (const result of report.results) {
        const key = `${result.contribution}/${result.fixture}`;
        if (!seen.includes(key)) {
          seen.push(key);
        }
      }
      return seen;
    };

    const firstOrder = orderOf(first);
    const secondOrder = orderOf(second);
    expect(firstOrder).toEqual(secondOrder);
    expect(firstOrder).toEqual(["ordering/a/only", "ordering/b/a", "ordering/b/z"]);
  });
});

describe("recordings the real runner made, and goldens updated only when asked", () => {
  test("with recording on, an unrecorded recipe is performed through the real runner and its receipt lands in the fixture store, validating through the ordinary record validator", async () => {
    const dir = await scratchModule("record-mode", gatewaySource("invoke", REQUESTS_A_RUN_BODY));
    const contributionId = "record-mode/decides";
    await writeFixtureInput(dir, contributionId, "case", "1", {
      claimId: "claim-record",
      conditions: {},
      evidence: [],
    });

    const report = await runModuleTests(dir, { record: true, update: true, now: FIXED_NOW });

    const inProcess = report.results.find((result) => result.host === "in-process");
    expect(inProcess?.status).toBe("updated");

    // readFixtureStore reads every receipt through the store's reader, so this read validates it.
    const storeAfter = await readFixtureStore(dir);
    const receipt = storeAfter.storedReceiptForRecipe(PRINTF_RECIPE_ID)?.record;
    expect(receipt).toBeDefined();
    expect(receipt?.observation.exitCode).toBe(0);
  });

  test("a recorded receipt keeps the id its stored bytes digest to when its kind has since moved to a newer version", async () => {
    const dir = await scratchModule(
      "older-receipt",
      gatewaySource("invoke", requestsARunBody(PRINTF_RECIPE, "input.evidence[0].runId")),
    );
    const contributionId = "older-receipt/decides";
    await writeFixtureInput(dir, contributionId, "case", "1", {
      claimId: "claim-older",
      conditions: {},
      evidence: [],
    });
    await runModuleTests(dir, { record: true, now: FIXED_NOW });
    const current = (await readFixtureStore(dir)).storedReceiptForRecipe(PRINTF_RECIPE_ID)!.record;
    const currentPath = join(dir, recordPath("run", recordId(current)));
    const olderBytes = canonicalBytes({ ...current, schemaVersion: 3 });
    const olderId = rawId(olderBytes);
    expect(olderId).not.toBe(recordId(current));
    await rm(currentPath);
    const olderPath = join(dir, recordPath("run", olderId));
    await mkdir(dirname(olderPath), { recursive: true });
    await writeFile(olderPath, olderBytes);

    await runModuleTests(dir, { update: true, now: FIXED_NOW });

    const { store, fixtureCase } = await caseFor(dir, contributionId, "case");
    expect((await readGolden(store, fixtureCase))?.response).toEqual({
      kind: "verdict",
      label: "holds",
      reason: olderId,
    });
  });

  test("a second run with recording off passes against the receipt the first run recorded, performing nothing", async () => {
    const marker = await scratchMarker("record-then-replay");
    const dir = await scratchModule(
      "record-then-replay",
      gatewaySource("invoke", requestsARunBody(writesMarkerRecipe(marker))),
    );
    const contributionId = "record-then-replay/decides";
    await writeFixtureInput(dir, contributionId, "case", "1", {
      claimId: "claim-second",
      conditions: {},
      evidence: [],
    });

    await runModuleTests(dir, { record: true, update: true, now: FIXED_NOW });
    await expect(access(marker)).resolves.toBeUndefined();
    await rm(marker);

    const report = await runModuleTests(dir, { now: FIXED_NOW });

    await expect(access(marker)).rejects.toThrow();
    expect(report.ok).toBe(true);
  });

  test("with updating on, a mismatched golden is rewritten and reported as updated rather than as passed", async () => {
    const dir = await scratchModule("update-mode", gatewaySource("invoke", DECIDES_FROM_EVIDENCE_BODY));
    const contributionId = "update-mode/decides";
    await writeFixtureInput(dir, contributionId, "case", "1", {
      claimId: "claim-update",
      conditions: {},
      evidence: [{ runId: FAKE_RUN_ID, exitCode: 0, output: "ok" }],
    });
    const { store, fixtureCase } = await caseFor(dir, contributionId, "case");
    const wrongGolden: Golden = {
      response: { kind: "verdict", label: "fails", reason: "wrong on purpose" },
      reads: [`evidence:${FAKE_RUN_ID}`],
      rounds: [
        { output: { kind: "verdict", label: "fails", reason: "wrong on purpose" }, reads: [`evidence:${FAKE_RUN_ID}`] },
      ],
    };
    await writeGolden(store, fixtureCase, wrongGolden);

    const report = await runModuleTests(dir, { update: true, now: FIXED_NOW });

    expect(report.results.find((result) => result.host === "in-process")?.status).toBe("updated");
    const rewritten = await readGolden(store, fixtureCase);
    expect(rewritten?.response).toEqual({ kind: "verdict", label: "holds", reason: "the receipt exited cleanly" });
  });

  test("with updating off, a mismatched golden leaves the file byte-identical", async () => {
    const dir = await scratchModule("no-update", gatewaySource("invoke", DECIDES_FROM_EVIDENCE_BODY));
    const contributionId = "no-update/decides";
    await writeFixtureInput(dir, contributionId, "case", "1", {
      claimId: "claim-no-update",
      conditions: {},
      evidence: [{ runId: FAKE_RUN_ID, exitCode: 0, output: "ok" }],
    });
    const { store, fixtureCase } = await caseFor(dir, contributionId, "case");
    const wrongGolden: Golden = {
      response: { kind: "verdict", label: "fails", reason: "wrong on purpose" },
      reads: [`evidence:${FAKE_RUN_ID}`],
      rounds: [
        { output: { kind: "verdict", label: "fails", reason: "wrong on purpose" }, reads: [`evidence:${FAKE_RUN_ID}`] },
      ],
    };
    await writeGolden(store, fixtureCase, wrongGolden);
    const goldenPath = join(dir, "goldens", contributionId, "case.json");
    const before = await readFile(goldenPath, "utf8");

    const report = await runModuleTests(dir, { now: FIXED_NOW });

    const after = await readFile(goldenPath, "utf8");
    expect(after).toBe(before);
    expect(report.ok).toBe(false);
  });

  test("recording writes receipts and leaves goldens untouched without updating; updating writes goldens and leaves receipts untouched without recording", async () => {
    const recordOnlyDir = await scratchModule("record-only", gatewaySource("invoke", REQUESTS_A_RUN_BODY));
    const recordOnlyContribution = "record-only/decides";
    await writeFixtureInput(recordOnlyDir, recordOnlyContribution, "case", "1", {
      claimId: "claim-record-only",
      conditions: {},
      evidence: [],
    });

    const recordOnlyReport = await runModuleTests(recordOnlyDir, { record: true, now: FIXED_NOW });
    const recordOnlyStore = await readFixtureStore(recordOnlyDir);
    expect(recordOnlyStore.storedReceiptForRecipe(PRINTF_RECIPE_ID)?.record).toBeDefined();
    const { store: caseStore, fixtureCase } = await caseFor(recordOnlyDir, recordOnlyContribution, "case");
    expect(await readGolden(caseStore, fixtureCase)).toBeUndefined();
    expect(recordOnlyReport.results.find((result) => result.host === "in-process")?.status).toBe("fail");

    const updateOnlyDir = await scratchModule("update-only", gatewaySource("invoke", REQUESTS_A_RUN_BODY));
    const updateOnlyContribution = "update-only/decides";
    await writeFixtureInput(updateOnlyDir, updateOnlyContribution, "case", "1", {
      claimId: "claim-update-only",
      conditions: {},
      evidence: [],
    });

    const updateOnlyReport = await runModuleTests(updateOnlyDir, { update: true, now: FIXED_NOW });
    const updateOnlyStore = await readFixtureStore(updateOnlyDir);
    expect(updateOnlyStore.storedReceiptForRecipe(PRINTF_RECIPE_ID)?.record).toBeUndefined();
    expect(updateOnlyReport.ok).toBe(false);
  });
});

describe("module test runs a module's source as strict as its bundle runs installed", () => {
  test("a module whose source assigns to an undeclared name fails its fixtures under module test, as its bundle would fail installed", async () => {
    const dir = await scratchModule(
      "undeclared-name",
      gatewaySource("invoke", ["      undeclaredTotal = 1;", DECIDES_FROM_EVIDENCE_BODY].join("\n")),
    );
    const contributionId = "undeclared-name/decides";
    await writeFixtureInput(dir, contributionId, "holds-when-clean", "1", {
      claimId: "claim-undeclared",
      conditions: {},
      evidence: [{ runId: FAKE_RUN_ID, exitCode: 0, output: "ok" }],
    });
    const { store, fixtureCase } = await caseFor(dir, contributionId, "holds-when-clean");
    const holds = { kind: "verdict", label: "holds", reason: "the receipt exited cleanly" };
    await writeGolden(store, fixtureCase, {
      response: holds,
      reads: [`evidence:${FAKE_RUN_ID}`],
      rounds: [{ output: holds, reads: [`evidence:${FAKE_RUN_ID}`] }],
    });

    const report = await runModuleTests(dir, { now: FIXED_NOW });

    expect.soft(report.ok).toBe(false);
    const ranOn: string[] = [];
    for (const descriptor of HOSTS) {
      const resultsForHost = report.results.filter((result) => result.host === descriptor.name);
      if (!(await descriptor.available())) {
        expect(resultsForHost.map((result) => result.status)).toEqual(["skipped"]);
        expect(resultsForHost[0]?.message).toContain(descriptor.name);
        continue;
      }
      ranOn.push(descriptor.name);
      expect.soft(resultsForHost.length, descriptor.name).toBeGreaterThan(0);
      for (const result of resultsForHost) {
        expect.soft(result.status, descriptor.name).toBe("fail");
        const response = result.mismatches.find((mismatch) => mismatch.half === "response");
        expect.soft(JSON.stringify(response?.actual), descriptor.name).toContain("undeclaredTotal");
      }
    }
    expect(ranOn.length).toBeGreaterThanOrEqual(2);
  });

  test("a module whose source does not parse fails its fixtures as the module's own failure, naming the syntax error", async () => {
    const dir = await scratchModule(
      "does-not-parse",
      gatewaySource("invoke", ["      return (;", DECIDES_FROM_EVIDENCE_BODY].join("\n")),
    );
    const contributionId = "does-not-parse/decides";
    await writeFixtureInput(dir, contributionId, "holds-when-clean", "1", {
      claimId: "claim-unparsed",
      conditions: {},
      evidence: [{ runId: FAKE_RUN_ID, exitCode: 0, output: "ok" }],
    });

    const report = await runModuleTests(dir, { now: FIXED_NOW });

    expect(report.ok).toBe(false);
    const inProcess = report.results.filter((result) => result.host === "in-process");
    expect(inProcess.map((result) => result.status)).toEqual(["fail"]);
    expect(inProcess[0]?.message).toContain("SyntaxError");
  });

  test("updating over a module whose source does not parse writes no golden from any host", async () => {
    const dir = await scratchModule(
      "unparsed-update",
      gatewaySource("invoke", ["      return (;", DECIDES_FROM_EVIDENCE_BODY].join("\n")),
    );
    const contributionId = "unparsed-update/decides";
    await writeFixtureInput(dir, contributionId, "holds-when-clean", "1", {
      claimId: "claim-unparsed",
      conditions: {},
      evidence: [{ runId: FAKE_RUN_ID, exitCode: 0, output: "ok" }],
    });

    const report = await runModuleTests(dir, { now: FIXED_NOW, update: true });

    expect(report.ok).toBe(false);
    const { store, fixtureCase } = await caseFor(dir, contributionId, "holds-when-clean");
    expect(await readGolden(store, fixtureCase)).toBeUndefined();
  });

  test("a module whose source starts with a hashbang passes its fixtures under module test on every host", async () => {
    const dir = await scratchModule(
      "hashbang",
      gatewaySource("invoke", DECIDES_FROM_EVIDENCE_BODY, "#!/usr/bin/env node"),
    );
    const contributionId = "hashbang/decides";
    await writeFixtureInput(dir, contributionId, "holds-when-clean", "1", {
      claimId: "claim-hashbang",
      conditions: {},
      evidence: [{ runId: FAKE_RUN_ID, exitCode: 0, output: "ok" }],
    });
    const { store, fixtureCase } = await caseFor(dir, contributionId, "holds-when-clean");
    const holds = { kind: "verdict", label: "holds", reason: "the receipt exited cleanly" };
    await writeGolden(store, fixtureCase, {
      response: holds,
      reads: [`evidence:${FAKE_RUN_ID}`],
      rounds: [{ output: holds, reads: [`evidence:${FAKE_RUN_ID}`] }],
    });

    const report = await runModuleTests(dir, { now: FIXED_NOW });

    const ranOn: string[] = [];
    for (const descriptor of HOSTS) {
      if (!(await descriptor.available())) {
        continue;
      }
      ranOn.push(descriptor.name);
      const resultsForHost = report.results.filter((result) => result.host === descriptor.name);
      expect.soft(resultsForHost.length, descriptor.name).toBeGreaterThan(0);
      for (const result of resultsForHost) {
        expect.soft({ status: result.status, mismatches: result.mismatches }, descriptor.name).toEqual({
          status: "pass",
          mismatches: [],
        });
      }
    }
    expect(ranOn.length).toBeGreaterThanOrEqual(2);
    expect(report.ok).toBe(true);
  });
});

describe("the scaffolded default template, proven runnable through every registered host locally", () => {
  test("what `module new` emits builds and passes under every host this machine can run a module through, never only under the CI step that drives the built CLI", async () => {
    const dir = await mkdtemp(join(tmpdir(), "musai-test-scaffold-hosts-"));
    cleanups.push(async () => rm(dir, { recursive: true, force: true }));

    const result = await scaffoldModule(dir, { now: FIXED_NOW });
    expect(result.created).toBe(true);
    expect(result.testReport).not.toBeNull();
    expect(result.testReport?.ok).toBe(true);

    const availableHostNames: string[] = [];
    for (const descriptor of HOSTS) {
      if (await descriptor.available()) {
        availableHostNames.push(descriptor.name);
      }
    }
    expect(availableHostNames.length).toBeGreaterThan(0);

    for (const hostName of availableHostNames) {
      const resultsForHost = result.testReport?.results.filter((entry) => entry.host === hostName) ?? [];
      expect(resultsForHost.length, `expected ${hostName} to have run at least one fixture case`).toBeGreaterThan(0);
      for (const entry of resultsForHost) {
        expect(entry.status, `${hostName}/${entry.contribution}/${entry.fixture}: ${entry.message ?? ""}`).not.toBe(
          "fail",
        );
        expect(entry.status, `${hostName}/${entry.contribution}/${entry.fixture} was skipped as unavailable`).not.toBe(
          "skipped",
        );
      }
    }
  });
});
