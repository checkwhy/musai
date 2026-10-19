import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexDb } from "@musai/fold";
import { DEFAULT_TIME_LIMIT_MS, ENVELOPE_PROTOCOL, type EnvelopeRequest, encodeRequest } from "@musai/modules";
import type { ModuleRecord, PerformedRunRecord, RunObservation } from "@musai/records";
import { CURRENT_SCHEMA_VERSIONS, recordId, SealedValueError, type Selector, versionString } from "@musai/records";
import { RUNNER_PERFORMER } from "@musai/run";
import { Store } from "@musai/store";
import {
  type FixtureRepo,
  gatewaySource,
  makeFixtureRepo,
  PARSER_FIXTURE_MODULE,
  PARSER_FIXTURE_SELECTOR,
  PARSER_FIXTURE_SOURCE,
  parserFixtureManifest,
  writeFixtureRecords,
} from "@musai/test-support";
import { afterEach, describe, expect, test } from "vitest";
import {
  type AdmissionWorkspace,
  admitEvidenceEdge,
  reducedParserInput,
  SelectorRefusedError,
} from "../src/evaluator/admission.js";

/** Every record here carries this instant, so a run's id depends only on what it observed. */
const FIXED_INSTANT = "2026-08-30T00:00:00.000Z";

function selectorWith(change: Partial<Selector>): Selector {
  return { ...PARSER_FIXTURE_SELECTOR, ...change };
}

/** Bundle and build ids go unread: `modulePath` hands the host the fixture's source directly. */
function fixtureModuleRecord(): ModuleRecord {
  return {
    kind: "module",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.module,
    name: PARSER_FIXTURE_MODULE,
    version: versionString("1"),
    manifest: parserFixtureManifest(),
    bundle: recordId({ marker: "parser-fixture-bundle-never-written-in-this-test" }),
    build: recordId({ marker: "parser-fixture-build-never-written-in-this-test" }),
  };
}

function runRecordWithExitCode(exitCode: number): PerformedRunRecord {
  return {
    kind: "run",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
    runKind: "run",
    determinism: "nondeterministic",
    performer: RUNNER_PERFORMER,
    recipe: {
      command: ["node", "-e", `process.exit(${String(exitCode)})`],
      workingDirectory: "/",
      environment: {},
      declared: [],
      substrates: [],
      isolation: "hygiene",
    },
    observation: {
      resolved: [],
      isolationHeld: "hygiene",
      binaries: [],
      bindings: [],
      output: "",
      outputLossy: false,
      exitCode,
      scrubbed: [],
      startedAt: FIXED_INSTANT as never,
      finishedAt: FIXED_INSTANT as never,
      reads: [],
      cost: {},
    },
  };
}

interface Fixture {
  repo: FixtureRepo;
  workspace: AdmissionWorkspace;
  runId(exitCode: number): Promise<string>;
}

async function makeFixture(): Promise<Fixture> {
  const repo = await makeFixtureRepo("admission");
  const modulePath = join(repo.workspace, "parser-fixture.ts");
  await writeFile(modulePath, PARSER_FIXTURE_SOURCE);
  await writeFixtureRecords(repo, [{ kind: "module", value: fixtureModuleRecord() }]);
  const index = new IndexDb();
  await index.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
  const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
  const workspace: AdmissionWorkspace = { index, store, modulePath: () => modulePath };
  return {
    repo,
    workspace,
    async runId(exitCode: number) {
      const [id] = await store.putMany([{ kind: "run", value: runRecordWithExitCode(exitCode) }]);
      return id!;
    },
  };
}

describe("admitting an evidence edge", () => {
  const repos: FixtureRepo[] = [];

  afterEach(async () => {
    for (const repo of repos.splice(0)) {
      await repo.cleanup();
    }
  });

  test("an edge naming a held parser and a produced key is admitted and carries a content id", async () => {
    const fixture = await makeFixture();
    repos.push(fixture.repo);
    const run = await fixture.runId(0);

    const result = await admitEvidenceEdge(PARSER_FIXTURE_SELECTOR, run as never, fixture.workspace);

    expect(result.edge.run).toBe(run);
    expect(result.edge.item).toBe(recordId(0));
    expect(result.moduleRecord).toBeDefined();
  });

  test("a parser that never answers is refused at the admission workspace's own time limit, before the host's own fallback", async () => {
    const fixture = await makeFixture();
    repos.push(fixture.repo);
    const run = await fixture.runId(0);
    const scratch = await mkdtemp(join(tmpdir(), "musai-admission-limits-"));
    try {
      const spinning = join(scratch, "spins.parser.ts");
      await writeFile(spinning, gatewaySource("invoke", "      while (true) {}"));

      const started = Date.now();
      const admitting = admitEvidenceEdge(PARSER_FIXTURE_SELECTOR, run as never, {
        ...fixture.workspace,
        modulePath: () => spinning,
        invocationLimits: { timeLimitMs: 200 },
      });

      await expect(admitting).rejects.toThrow("time-limit");
      expect(Date.now() - started).toBeLessThan(DEFAULT_TIME_LIMIT_MS);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("an edge naming a parser the workspace does not hold is refused naming module, parser and version", async () => {
    const fixture = await makeFixture();
    repos.push(fixture.repo);
    const run = await fixture.runId(0);

    await expect(
      admitEvidenceEdge(selectorWith({ parser: "no-such-parser" }), run as never, fixture.workspace),
    ).rejects.toThrow(SelectorRefusedError);

    try {
      await admitEvidenceEdge(selectorWith({ parser: "no-such-parser" }), run as never, fixture.workspace);
      expect.unreachable("admission should have refused");
    } catch (error) {
      expect(error).toBeInstanceOf(SelectorRefusedError);
      const message = (error as Error).message;
      expect(message).toContain(PARSER_FIXTURE_MODULE);
      expect(message).toContain("no-such-parser");
      expect(message).toContain("1");
    }
  });

  test("an edge naming a key the parser does not produce is refused naming the key", async () => {
    const fixture = await makeFixture();
    repos.push(fixture.repo);
    const run = await fixture.runId(0);

    try {
      await admitEvidenceEdge(selectorWith({ key: "no-such-key" }), run as never, fixture.workspace);
      expect.unreachable("admission should have refused");
    } catch (error) {
      expect(error).toBeInstanceOf(SelectorRefusedError);
      expect((error as Error).message).toContain("no-such-key");
    }
  });

  test("two observations whose selected items are equal produce one content id; two whose selected items differ produce two", async () => {
    const fixture = await makeFixture();
    repos.push(fixture.repo);
    const runA = await fixture.runId(0);
    const runB = await fixture.runId(0);
    const runC = await fixture.runId(1);

    const selector = PARSER_FIXTURE_SELECTOR;
    const resultA = await admitEvidenceEdge(selector, runA as never, fixture.workspace);
    const resultB = await admitEvidenceEdge(selector, runB as never, fixture.workspace);
    const resultC = await admitEvidenceEdge(selector, runC as never, fixture.workspace);

    expect(resultA.edge.item).toBe(resultB.edge.item);
    expect(resultA.edge.item).not.toBe(resultC.edge.item);
  });

  test("a parser invocation's input carries the observation and no recipe field, asserted against the encoded request bytes", () => {
    const observation = runRecordWithExitCode(0).observation;
    const input = reducedParserInput(observation);
    const request: EnvelopeRequest = {
      protocol: ENVELOPE_PROTOCOL,
      contribution: "parser",
      id: `${PARSER_FIXTURE_SELECTOR.module}/${PARSER_FIXTURE_SELECTOR.parser}`,
      version: versionString("1"),
      input,
    };
    const bytes = encodeRequest(request);
    const roundTripped = JSON.parse(new TextDecoder().decode(bytes)) as { input: Record<string, unknown> };
    expect(Object.hasOwn(roundTripped.input, "recipe")).toBe(false);
    expect(Object.hasOwn(roundTripped.input, "substrate")).toBe(false);
    expect(Object.hasOwn(roundTripped.input, "workingDirectory")).toBe(false);
    expect(roundTripped.input).toEqual({ output: "", exitCode: 0 });
  });

  test("a run whose output is sealed admits no evidence, since a parser reads text and this kernel cannot unseal one", () => {
    const observation = {
      ...runRecordWithExitCode(0).observation,
      output: { $sealed: { alg: "aes-256-gcm", keyId: "key-1", ciphertext: "Y2lwaGVy", digest: "a".repeat(64) } },
    } as RunObservation;
    expect(() => reducedParserInput(observation)).toThrow(SealedValueError);
  });
});
