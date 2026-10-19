import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexDb } from "@musai/fold";
import type { Rule, RuleInput, RuleInvocation } from "@musai/modules";
import * as hosts from "@musai/modules";
import { DEFAULT_TIME_LIMIT_MS, InProcessHost, kernelPoint, type Need, needId } from "@musai/modules";
import type { ContributionEntry, ModuleRecord, RunRecipe } from "@musai/records";
import { CURRENT_SCHEMA_VERSIONS, recordId, versionString } from "@musai/records";
import { Store } from "@musai/store";
import {
  type FixtureRepo,
  gatewaySource,
  invokerFromRule,
  makeFixtureRepo,
  manifestWithContributions,
  writeFixtureRecords,
} from "@musai/test-support";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { type NeedOutcome, runRestartLoop } from "../src/evaluator/restart.js";

/** A contributed point, so resolving it reads the fold as a pack's own point does. */
const ANSWERS_POINT = "invoke-fixture/answers";

/** Never performed, since nothing drives a callee's answer. */
const CALLEE_RECIPE: RunRecipe = {
  command: ["printf", "%s", "driven"],
  workingDirectory: "/",
  environment: {},
  declared: [],
  substrates: [],
  isolation: "hygiene",
};

const CALLEE_REQUEST = { kind: "request", needs: [{ kind: "run", recipe: CALLEE_RECIPE }] };

function pointEntry(id: string, version = "1"): ContributionEntry {
  return {
    kind: "point",
    id,
    version: versionString(version),
    input: { input: true, output: true, role: "invoke" },
    output: true,
    documentation: `the ${id} point`,
  };
}

function answeringAt(kind: string, id: string): ContributionEntry {
  return { kind, id, version: versionString("1"), input: true, output: true, documentation: `the ${id} contribution` };
}

/** Written straight through the store with stand-in ids: install admission is not under test. */
function moduleRecordFor(name: string, contributions: readonly ContributionEntry[]): ModuleRecord {
  return {
    kind: "module",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.module,
    name,
    version: versionString("1.0.0"),
    manifest: manifestWithContributions(contributions),
    bundle: recordId({ marker: `bundle-for-${name}` }),
    build: recordId({ marker: `build-for-${name}` }),
  };
}

const CALLER_ID = "caller/decides";

/** A request to invoke the very rule that invoked it. */
const CALLS_BACK_OUTPUT = {
  kind: "request",
  needs: [{ kind: "invoke", contribution: CALLER_ID, input: { round: 2 } }],
};

/** The gateway body of every callee, keyed by the module whose bundle carries it. */
const CALLEE_BODIES: Readonly<Record<string, string>> = {
  echo: "      return { echoed: input };",
  requester: `      return ${JSON.stringify(CALLEE_REQUEST)};`,
  refuser: '      throw new Error("the invoked contribution refuses this input");',
  mutual: `      return ${JSON.stringify(CALLS_BACK_OUTPUT)};`,
  spinner: "      while (true) {}",
};

/** A gateway, so the kernel's rule operand validates every round's input, answers included. */
const CALLER_CONTRIBUTION = {
  id: CALLER_ID,
  version: versionString("1"),
  entry: answeringAt("rule", CALLER_ID),
  point: kernelPoint("rule")!,
};

interface Fixture {
  readonly repo: FixtureRepo;
  readonly store: Store;
  readonly index: IndexDb;
  readonly modulePath: (moduleName: string) => string;
}

const repos: FixtureRepo[] = [];

let scratchDir: string;
let calleePaths: ReadonlyMap<string, string>;
let callerPath: string;

/** Asks for the `needs` in its conditions, then concludes with all the restart handed back. */
const CALLER_BODY = [
  "      if (input.invocations === undefined || input.invocations.length === 0) {",
  "        if (input.refusals !== undefined && input.refusals.length > 0) {",
  '          return { kind: "verdict", label: "open", reason: JSON.stringify({ refusals: input.refusals }) };',
  "        }",
  '        return { kind: "request", needs: JSON.parse(input.conditions.needs) };',
  "      }",
  "      return {",
  '        kind: "verdict",',
  '        label: "holds",',
  "        reason: JSON.stringify({ invocations: input.invocations, evidence: input.evidence }),",
  "      };",
].join("\n");

beforeAll(async () => {
  scratchDir = await mkdtemp(join(tmpdir(), "musai-invoke-need-"));
  const paths = new Map<string, string>();
  for (const [moduleName, body] of Object.entries(CALLEE_BODIES)) {
    const path = join(scratchDir, `${moduleName}.contribution.ts`);
    await writeFile(path, gatewaySource("invoke", body));
    paths.set(moduleName, path);
  }
  calleePaths = paths;
  callerPath = join(scratchDir, "caller.rule.ts");
  await writeFile(callerPath, gatewaySource("invoke", CALLER_BODY));
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const repo of repos.splice(0)) {
    await repo.cleanup();
  }
});

async function foldOf(repo: FixtureRepo): Promise<IndexDb> {
  const index = new IndexDb();
  await index.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
  return index;
}

async function makeFixture(
  scope: string,
  pointEntries: readonly ContributionEntry[] = [pointEntry(ANSWERS_POINT)],
): Promise<Fixture> {
  const repo = await makeFixtureRepo(scope);
  repos.push(repo);
  const records: ModuleRecord[] = [
    moduleRecordFor("invoke-fixture", pointEntries),
    moduleRecordFor("echo", [answeringAt(ANSWERS_POINT, "echo/echoes")]),
    moduleRecordFor("requester", [answeringAt(ANSWERS_POINT, "requester/requests")]),
    moduleRecordFor("refuser", [answeringAt(ANSWERS_POINT, "refuser/throws")]),
    moduleRecordFor("mutual", [answeringAt(ANSWERS_POINT, "mutual/calls-back")]),
    moduleRecordFor("spinner", [answeringAt(ANSWERS_POINT, "spinner/spins")]),
    moduleRecordFor("unpointed", [answeringAt("unpointed/never-declared", "unpointed/answers")]),
    moduleRecordFor("uninstalled", [answeringAt(ANSWERS_POINT, "uninstalled/answers")]),
  ];
  await writeFixtureRecords(
    repo,
    records.map((value) => ({ kind: "module", value })),
  );
  const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
  const index = await foldOf(repo);
  return {
    repo,
    store,
    index,
    modulePath: (moduleName: string) => {
      const path = calleePaths.get(moduleName);
      if (path === undefined) {
        throw new Error(`no installed module named ${moduleName}`);
      }
      return path;
    },
  };
}

function invokeOf(contribution: string, input: unknown): Need {
  return { kind: "invoke", contribution, input };
}

/** What the caller gateway concluded with, parsed back out of its verdict reason. */
function concluded(reason: string): {
  readonly invocations?: readonly RuleInvocation[];
  readonly evidence?: readonly unknown[];
  readonly refusals?: readonly { readonly need: Need; readonly error: { code: string; message: string } }[];
} {
  return JSON.parse(reason);
}

/** Drives the caller gateway through a real host, asking for `needs` on its first round. */
async function driveCaller(fixture: Fixture, needs: readonly Need[], modulePath = fixture.modulePath) {
  const host = new InProcessHost();
  try {
    const loaded = await host.load(callerPath, "invoke");
    return await runRestartLoop({
      invoker: hosts.invokerFromModuleHost(host, loaded, CALLER_CONTRIBUTION),
      input: { claimId: "claim-invoke", conditions: { needs: JSON.stringify(needs) }, evidence: [] },
      store: fixture.store,
      index: fixture.index,
      modulePath,
      now: fixture.repo.now,
    });
  } finally {
    await host.close?.();
  }
}

describe("a rule that asks the kernel to invoke another contribution", () => {
  test("is restarted with the answer in invocations, with no evidence and no receipt minted", async () => {
    const fixture = await makeFixture("invoke-answered");
    const need = invokeOf("echo/echoes", { value: 41 });

    const result = await driveCaller(fixture, [need]);

    expect(result.invocations).toBe(2);
    expect(result.receipts).toEqual([]);
    expect(result.verdict.label).toBe("holds");
    const answer = concluded(result.verdict.reason);
    expect(answer.evidence).toEqual([]);
    expect(answer.invocations).toHaveLength(1);
    expect(answer.invocations![0]!.need).toEqual(need);
    expect(answer.invocations![0]!.output).toEqual({ echoed: { value: 41 } });
  });

  test("carries the module record the fold holds for the contribution that answered", async () => {
    const fixture = await makeFixture("invoke-module-record");

    const result = await driveCaller(fixture, [invokeOf("echo/echoes", { value: 1 })]);

    const answer = concluded(result.verdict.reason);
    expect(answer.invocations![0]!.moduleRecord).toBe(fixture.index.contributionById("echo/echoes")!.moduleRecord);
  });

  test("the module record an invoke answered from enters the read log under the invoke prefix", async () => {
    const fixture = await makeFixture("invoke-read-log");

    const result = await driveCaller(fixture, [invokeOf("echo/echoes", { value: 1 })]);

    const moduleRecord = fixture.index.contributionById("echo/echoes")!.moduleRecord;
    expect(result.readLog.reads).toContain(`invoke:${moduleRecord}`);
  });

  test("names the invoke in the round's needs and never in its satisfied records, which an invoke mints none of", async () => {
    const fixture = await makeFixture("invoke-round");
    const need = invokeOf("echo/echoes", { value: 7 });

    const result = await driveCaller(fixture, [need]);

    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]!.needs).toEqual([needId(need)]);
    expect(result.rounds[0]!.satisfied).toEqual([]);
  });
});

describe("the depth of an invoke chain", () => {
  test("a contribution whose own output is a request is invoked once and none of its needs performed", async () => {
    const fixture = await makeFixture("invoke-depth-one");
    const spy = vi.spyOn(hosts, "invokeThroughHost");

    const result = await driveCaller(fixture, [invokeOf("requester/requests", { value: 1 })]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(concluded(result.verdict.reason).invocations![0]!.output).toEqual(CALLEE_REQUEST);
    expect(result.receipts).toEqual([]);
    const refolded = await foldOf(fixture.repo);
    expect(refolded.receiptByRecipe(needId({ kind: "run", recipe: CALLEE_RECIPE }))).toBeUndefined();
  });

  test("two contributions naming each other reach a verdict rather than spinning, the callee called once", async () => {
    const fixture = await makeFixture("invoke-mutual");
    const spy = vi.spyOn(hosts, "invokeThroughHost");

    const result = await driveCaller(fixture, [invokeOf("mutual/calls-back", { round: 1 })]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.verdict.label).toBe("holds");
    expect(concluded(result.verdict.reason).invocations![0]!.output).toEqual({
      kind: "request",
      needs: [{ kind: "invoke", contribution: CALLER_ID, input: { round: 2 } }],
    });
    expect(result.receipts).toEqual([]);
  });
});

describe("the per-evaluation table an invoke is remembered in", () => {
  test("one contribution and one input asked for by two rules of one evaluation is invoked once", async () => {
    const fixture = await makeFixture("invoke-shared-table");
    const spy = vi.spyOn(hosts, "invokeThroughHost");
    const evaluationOutcomes = new Map<string, NeedOutcome>();
    const need = invokeOf("echo/echoes", { value: 3 });
    const rule: Rule = (input) =>
      input.invocations === undefined || input.invocations.length === 0
        ? { kind: "request", needs: [need] }
        : { kind: "verdict", label: "holds", reason: JSON.stringify(input.invocations[0]!.output) };

    for (const claimId of ["claim-first", "claim-second"]) {
      const result = await runRestartLoop({
        invoker: invokerFromRule(rule),
        input: { claimId, conditions: {}, evidence: [] },
        store: fixture.store,
        index: fixture.index,
        modulePath: fixture.modulePath,
        evaluationOutcomes,
        now: fixture.repo.now,
      });
      expect(result.verdict.reason).toBe(JSON.stringify({ echoed: { value: 3 } }));
    }

    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("one contribution asked for with two inputs is two needs and two answers", async () => {
    const fixture = await makeFixture("invoke-two-inputs");
    const spy = vi.spyOn(hosts, "invokeThroughHost");
    const needs = [invokeOf("echo/echoes", { value: 1 }), invokeOf("echo/echoes", { value: 2 })];

    const result = await driveCaller(fixture, needs);

    expect(spy).toHaveBeenCalledTimes(2);
    const answers = concluded(result.verdict.reason).invocations!;
    expect(answers.map((answer) => answer.output)).toEqual([{ echoed: { value: 1 } }, { echoed: { value: 2 } }]);
  });

  test("an invoke carried forward from an earlier round is listed once, however many rounds name it again", async () => {
    const fixture = await makeFixture("invoke-carried-forward");
    const first = invokeOf("echo/echoes", { value: 1 });
    const second = invokeOf("echo/echoes", { value: 2 });
    const inputs: RuleInput[] = [];
    const rule: Rule = (input) => {
      inputs.push(input);
      if (inputs.length === 1) {
        return { kind: "request", needs: [first] };
      }
      if (inputs.length === 2) {
        return { kind: "request", needs: [first, second] };
      }
      return { kind: "verdict", label: "holds", reason: "both answers arrived" };
    };

    await runRestartLoop({
      invoker: invokerFromRule(rule),
      input: { claimId: "claim-carried-forward", conditions: {}, evidence: [] },
      store: fixture.store,
      index: fixture.index,
      modulePath: fixture.modulePath,
      now: fixture.repo.now,
    });

    const answers = inputs[2]!.invocations!;
    expect(answers).toHaveLength(2);
    expect(answers.filter((answer) => needId(answer.need) === needId(first))).toHaveLength(1);
    expect(answers.map((answer) => answer.output)).toEqual([{ echoed: { value: 1 } }, { echoed: { value: 2 } }]);
  });

  test("a rule asking again for the invoke it was already answered stalls and the claim is left open", async () => {
    const fixture = await makeFixture("invoke-stall");
    const need = invokeOf("echo/echoes", { value: 5 });
    const inputs: RuleInput[] = [];
    const rule: Rule = (input) => {
      inputs.push(input);
      return { kind: "request", needs: [need] };
    };

    const result = await runRestartLoop({
      invoker: invokerFromRule(rule),
      input: { claimId: "claim-stall", conditions: {}, evidence: [] },
      store: fixture.store,
      index: fixture.index,
      modulePath: fixture.modulePath,
      now: fixture.repo.now,
    });

    expect(inputs).toHaveLength(2);
    expect(inputs[1]!.refusals ?? []).toEqual([]);
    expect(inputs[1]!.invocations).toHaveLength(1);
    expect(result.verdict.label).toBe("open");
  });
});

describe("an invoke the kernel refuses", () => {
  /** Asks once and concludes from the refusal, as the asking contribution reads it. */
  async function refusalFor(
    fixture: Fixture,
    need: Need,
    modulePath: ((moduleName: string) => string) | undefined,
  ): Promise<{ readonly code: string; readonly message: string }> {
    const inputs: RuleInput[] = [];
    const rule: Rule = (input) => {
      inputs.push(input);
      return input.refusals === undefined || input.refusals.length === 0
        ? { kind: "request", needs: [need] }
        : { kind: "verdict", label: "open", reason: input.refusals[0]!.error.message };
    };

    const result = await runRestartLoop({
      invoker: invokerFromRule(rule),
      input: { claimId: "claim-refused", conditions: {}, evidence: [] },
      store: fixture.store,
      index: fixture.index,
      modulePath,
      now: fixture.repo.now,
    });

    expect(result.verdict.label).toBe("open");
    expect(result.receipts).toEqual([]);
    const refusals = inputs[1]!.refusals!;
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.need).toEqual(need);
    return refusals[0]!.error;
  }

  test("an evaluation resolving no module path refuses the invoke as a kind it does not support", async () => {
    const fixture = await makeFixture("invoke-no-module-path");

    const error = await refusalFor(fixture, invokeOf("echo/echoes", { value: 1 }), undefined);

    expect(error.code).toBe("unsupported-need");
    expect(error.message).toContain("echo/echoes");
  });

  test("a contribution whose module the workspace has not installed refuses the invoke by that module's name", async () => {
    const fixture = await makeFixture("invoke-no-module-installed");

    const error = await refusalFor(fixture, invokeOf("uninstalled/answers", { value: 1 }), fixture.modulePath);

    expect(error.code).toBe("need-refused");
    expect(error.message).toContain("uninstalled");
  });

  test("a contribution the workspace does not hold refuses the invoke by its id", async () => {
    const fixture = await makeFixture("invoke-no-contribution");

    const error = await refusalFor(fixture, invokeOf("echo/never-contributed", { value: 1 }), fixture.modulePath);

    expect(error.code).toBe("need-refused");
    expect(error.message).toContain("echo/never-contributed");
  });

  test("a contribution answering at a point nothing declares refuses the invoke by that point", async () => {
    const fixture = await makeFixture("invoke-no-point");

    const error = await refusalFor(fixture, invokeOf("unpointed/answers", { value: 1 }), fixture.modulePath);

    expect(error.code).toBe("need-refused");
    expect(error.message).toContain("unpointed/never-declared");
  });

  test("a machine providing no host refuses the invoke by saying so", async () => {
    const fixture = await makeFixture("invoke-no-host");
    vi.spyOn(hosts, "invokeThroughHost").mockResolvedValue(undefined);

    const error = await refusalFor(fixture, invokeOf("echo/echoes", { value: 1 }), fixture.modulePath);

    expect(error.code).toBe("need-refused");
    expect(error.message).toContain("no host");
  });

  test("a contribution that refuses the input carries the envelope error's own code and message back", async () => {
    const fixture = await makeFixture("invoke-callee-refused");

    const error = await refusalFor(fixture, invokeOf("refuser/throws", { value: 1 }), fixture.modulePath);

    expect(error.code).toBe("need-refused");
    expect(error.message).toContain("contribution-threw");
    expect(error.message).toContain("the invoked contribution refuses this input");
  });

  test("a fold whose point is declared twice refuses the invoke in the registry's own words", async () => {
    const fixture = await makeFixture("invoke-duplicated-point", [
      pointEntry(ANSWERS_POINT),
      pointEntry(ANSWERS_POINT, "2"),
    ]);

    const error = await refusalFor(fixture, invokeOf("echo/echoes", { value: 1 }), fixture.modulePath);

    expect(error.code).toBe("need-refused");
    expect(error.message).toContain("declared more than once");
  });
});

describe("the bounds an invoked contribution runs under", () => {
  test("a contribution that never answers is refused at the time limit the evaluation hands down, before the host's own fallback", async () => {
    const fixture = await makeFixture("invoke-handed-limits");
    const need = invokeOf("spinner/spins", { value: 1 });
    const rule: Rule = (input) =>
      input.refusals === undefined || input.refusals.length === 0
        ? { kind: "request", needs: [need] }
        : { kind: "verdict", label: "open", reason: input.refusals[0]!.error.message };

    const started = Date.now();
    const result = await runRestartLoop({
      invoker: invokerFromRule(rule),
      input: { claimId: "claim-bounded", conditions: {}, evidence: [] },
      store: fixture.store,
      index: fixture.index,
      modulePath: fixture.modulePath,
      invocationLimits: { timeLimitMs: 200 },
      now: fixture.repo.now,
    });
    const elapsed = Date.now() - started;

    expect(result.verdict.reason).toContain("time-limit");
    expect(elapsed).toBeLessThan(DEFAULT_TIME_LIMIT_MS);
  });
});
