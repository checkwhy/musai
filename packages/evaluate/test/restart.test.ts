import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { IndexDb } from "@musai/fold";
import type { Rule, RuleInput, RuleOutput, RuleRequestOutput } from "@musai/modules";
import { InProcessHost, invokerFromModuleHost, kernelPoint, type Need } from "@musai/modules";
import type { PerformedRunRecord, RunRecipe, RunRecord } from "@musai/records";
import {
  CURRENT_SCHEMA_VERSIONS,
  canonicalBytes,
  type RecordId,
  slotFor,
  TRIPLE_CLAIM_TYPE,
  TRIPLE_DECLARATION,
  timestamp,
  versionString,
} from "@musai/records";
import { RUNNER_PERFORMER, requirementsFromModules, resolveBinaries } from "@musai/run";
import { Store } from "@musai/store";
import {
  bindCheckouts,
  type Checkout,
  commitContent,
  type FixtureRepo,
  fixedClock,
  gatewaySource,
  headCommit,
  headTree,
  invokerFromRule,
  makeCheckout,
  makeFixtureRepo,
} from "@musai/test-support";
import { afterEach, describe, expect, test } from "vitest";
import { ageLimitMsFromSlot, RESOLUTION_AGE_SLOT_ID, runRestartLoop, satisfyNeeds } from "../src/evaluator/restart.js";

function bytesToValue(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** A bare-command recipe for tests that care only about command, directory and environment. */
function recipeFor(command: string[], workingDirectory: string, environment: Record<string, string> = {}): RunRecipe {
  return { command, workingDirectory, environment, declared: [], substrates: [], isolation: "hygiene" };
}

/** A one-need run request over a minimal recipe. */
function requestFor(
  command: string[],
  workingDirectory: string,
  environment: Record<string, string> = {},
): RuleRequestOutput {
  return { kind: "request", needs: [{ kind: "run", recipe: recipeFor(command, workingDirectory, environment) }] };
}

describe("the rule contract: a plain, byte-serializable value in each direction", () => {
  test("a RuleInput round-trips through canonical bytes to a deep-equal value", () => {
    const input: RuleInput = {
      claimId: "claim-a",
      conditions: { "server-commit": "d4e66f1f36" },
      evidence: [{ runId: "sha256:aa", exitCode: 0, output: "ok" }],
    };
    expect(bytesToValue(canonicalBytes(input))).toEqual(input);
  });

  test("a RuleOutput request round-trips through canonical bytes to a deep-equal value", () => {
    const output: RuleOutput = requestFor(["printf", "%s", "hi"], "/work", { PATH: "/usr/bin" });
    expect(bytesToValue(canonicalBytes(output))).toEqual(output);
    expect(output.kind).toBe("request");
  });

  test("a RuleOutput verdict round-trips through canonical bytes to a deep-equal value", () => {
    const output: RuleOutput = { kind: "verdict", label: "holds", reason: "the receipt confirms it" };
    expect(bytesToValue(canonicalBytes(output))).toEqual(output);
    expect(output.kind).not.toBe("request");
  });
});

describe("an invoker adapted from a plain function: a bare function call, nothing more", () => {
  const emptyInput: RuleInput = { claimId: "claim-a", conditions: {}, evidence: [] };

  test("a rule returning a verdict on its first invocation is invoked exactly once", async () => {
    let calls = 0;
    const rule: Rule = () => {
      calls++;
      return { kind: "verdict", label: "holds", reason: "immediate" };
    };
    const { output } = await invokerFromRule(rule).invoke(emptyInput);
    expect(calls).toBe(1);
    expect(output).toEqual({ kind: "verdict", label: "holds", reason: "immediate" });
  });

  test("an invocation records a read log naming the claim and every condition and evidence id the input carried", async () => {
    const input: RuleInput = {
      claimId: "claim-a",
      conditions: { "server-commit": "d4e66f1f36" },
      evidence: [{ runId: "sha256:aa", exitCode: 0, output: "ok" }],
    };
    const rule: Rule = () => ({ kind: "verdict", label: "holds", reason: "done" });
    const { readLog } = await invokerFromRule(rule).invoke(input);
    expect(readLog.claimId).toBe("claim-a");
    expect([...readLog.reads].sort()).toEqual(["dim:server-commit=d4e66f1f36", "evidence:sha256:aa"]);
  });

  test("an invoker adapted from a host-loaded gateway answers through the same pair a plain function's invoker returns", async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), "musai-restart-host-"));
    const modulePath = join(scratchDir, "always-fails.rule.ts");
    await writeFile(
      modulePath,
      gatewaySource("invoke", '      return { kind: "verdict", label: "fails", reason: "no" };'),
    );
    const host = new InProcessHost();
    const loaded = await host.load(modulePath, "invoke");
    const invoker = invokerFromModuleHost(host, loaded, {
      id: "test/always-fails",
      version: versionString("1"),
      entry: {
        kind: "rule",
        id: "test/always-fails",
        version: versionString("1"),
        input: true,
        output: true,
        documentation: "",
      },
      point: kernelPoint("rule")!,
    });
    const { output } = await invoker.invoke(emptyInput);
    expect(output).toEqual({ kind: "verdict", label: "fails", reason: "no" });
  });
});

describe("the host offers a rule nothing the byte boundary could not carry", () => {
  test("a rule attempting a filesystem read through the context fails", async () => {
    const emptyInput: RuleInput = { claimId: "claim-a", conditions: {}, evidence: [] };
    const rule: Rule = (_input, context) => {
      (context as unknown as { fs: { readFileSync: (path: string) => string } }).fs.readFileSync("/etc/passwd");
      return { kind: "verdict", label: "holds", reason: "unreached" };
    };
    await expect(invokerFromRule(rule).invoke(emptyInput)).rejects.toThrow();
  });

  test("a rule attempting a network call through the context fails", async () => {
    const emptyInput: RuleInput = { claimId: "claim-a", conditions: {}, evidence: [] };
    const rule: Rule = (_input, context) => {
      (context as unknown as { net: { connect: (port: number) => void } }).net.connect(80);
      return { kind: "verdict", label: "holds", reason: "unreached" };
    };
    await expect(invokerFromRule(rule).invoke(emptyInput)).rejects.toThrow();
  });

  test("a rule attempting to read the clock through the context fails", async () => {
    const emptyInput: RuleInput = { claimId: "claim-a", conditions: {}, evidence: [] };
    const rule: Rule = (_input, context) => {
      (context as unknown as { clock: { now: () => number } }).clock.now();
      return { kind: "verdict", label: "holds", reason: "unreached" };
    };
    await expect(invokerFromRule(rule).invoke(emptyInput)).rejects.toThrow();
  });

  test("a rule attempting to read the environment through the context fails", async () => {
    const emptyInput: RuleInput = { claimId: "claim-a", conditions: {}, evidence: [] };
    const rule: Rule = (_input, context) => {
      (context as unknown as { env: { get: (name: string) => string | undefined } }).env.get("HOME");
      return { kind: "verdict", label: "holds", reason: "unreached" };
    };
    await expect(invokerFromRule(rule).invoke(emptyInput)).rejects.toThrow();
  });

  test("the context object exposes no member that returns a function or a handle", async () => {
    const emptyInput: RuleInput = { claimId: "claim-a", conditions: {}, evidence: [] };
    let capturedContext: Record<string, never> | null = null;
    const rule: Rule = (_input, context) => {
      capturedContext = context;
      return { kind: "verdict", label: "holds", reason: "captured" };
    };
    await invokerFromRule(rule).invoke(emptyInput);
    expect(capturedContext).not.toBeNull();
    const shape: Record<string, unknown> = capturedContext ?? {};
    for (const value of Object.values(shape)) {
      expect(typeof value).not.toBe("function");
      expect(value).not.toHaveProperty("then");
    }
  });
});

describe("runRestartLoop: the kernel performs the run and invokes the rule again", () => {
  const repos: FixtureRepo[] = [];

  afterEach(async () => {
    for (const repo of repos.splice(0)) {
      await repo.cleanup();
    }
  });

  async function freshRepo(scope: string): Promise<FixtureRepo> {
    const repo = await makeFixtureRepo(scope);
    repos.push(repo);
    return repo;
  }

  test("a rule needing one receipt is invoked exactly twice and its claim resolves", async () => {
    const repo = await freshRepo("restart-one");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    let calls = 0;
    const rule: Rule = (input) => {
      calls++;
      const receipt = input.evidence[0];
      if (receipt === undefined) {
        return requestFor(["printf", "%s", "ok"], "/");
      }
      return { kind: "verdict", label: "holds", reason: `receipt said ${receipt.output}` };
    };

    const result = await runRestartLoop({
      invoker: invokerFromRule(rule),
      input: { claimId: "claim-one", conditions: {}, evidence: [] },
      store,
      index: new IndexDb(),
      now: repo.now,
    });

    expect(calls).toBe(2);
    expect(result.invocations).toBe(2);
    expect(result.verdict).toEqual({ kind: "verdict", label: "holds", reason: "receipt said ok" });
    expect(result.receipts).toHaveLength(1);
  });

  test("a satisfied run need answers with evidence, a receipt and a record in the round's satisfied ids, and nothing else", async () => {
    const repo = await freshRepo("restart-satisfied-shape");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const inputs: RuleInput[] = [];
    const rule: Rule = (input) => {
      inputs.push(input);
      return input.evidence.length === 0
        ? requestFor(["printf", "%s", "satisfied"], "/")
        : { kind: "verdict", label: "holds", reason: "the receipt arrived" };
    };

    const result = await runRestartLoop({
      invoker: invokerFromRule(rule),
      input: { claimId: "claim-satisfied-shape", conditions: {}, evidence: [] },
      store,
      index: new IndexDb(),
      now: repo.now,
    });

    const restarted = inputs[1]!;
    expect(restarted.evidence).toHaveLength(1);
    expect(restarted.evidence[0]).toMatchObject({ exitCode: 0, output: "satisfied" });
    expect(restarted.invocations ?? []).toEqual([]);
    expect(result.receipts).toEqual([{ id: restarted.evidence[0]!.runId, need: "run" }]);
    expect(result.rounds[0]!.satisfied).toEqual([restarted.evidence[0]!.runId]);
  });

  test("the receipt the kernel minted is readable through the ordinary store read path and appears in the index", async () => {
    const repo = await freshRepo("restart-readable");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const rule: Rule = (input) => {
      if (input.evidence.length === 0) {
        return requestFor(["printf", "%s", "receipt-body"], "/");
      }
      return { kind: "verdict", label: "holds", reason: "done" };
    };

    const result = await runRestartLoop({
      invoker: invokerFromRule(rule),
      input: { claimId: "claim-readable", conditions: {}, evidence: [] },
      store,
      index: new IndexDb(),
      now: repo.now,
    });
    const runId = result.receipts[0]!.id;

    const readBack = (await store.read(runId, "run")) as RunRecord;
    expect(readBack.kind).toBe("run");
    expect(readBack.observation.output).toBe("receipt-body");
    // Written at this kernel's schema version, naming the runner as performer.
    expect(readBack.schemaVersion).toBe(CURRENT_SCHEMA_VERSIONS.run);
    expect(readBack.performer).toEqual(RUNNER_PERFORMER);
    expect(readBack.determinism).toBe("nondeterministic");
    expect(readBack.observation.cost).toEqual({});

    const index = new IndexDb();
    await index.fold(store);
    const runsListed = await store.list("run");
    expect(runsListed).toContain(runId);
  });

  test("the receipt records the command, the working directory and the exit code", async () => {
    const repo = await freshRepo("restart-fields");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const rule: Rule = (input) => {
      if (input.evidence.length === 0) {
        return requestFor(["true"], "/tmp");
      }
      return { kind: "verdict", label: "holds", reason: "done" };
    };

    const result = await runRestartLoop({
      invoker: invokerFromRule(rule),
      input: { claimId: "claim-fields", conditions: {}, evidence: [] },
      store,
      index: new IndexDb(),
      now: repo.now,
    });
    const receipt = (await store.read(result.receipts[0]!.id, "run")) as PerformedRunRecord;

    expect(receipt.recipe.command).toEqual(["true"]);
    expect(receipt.recipe.workingDirectory).toBe("/tmp");
    expect(receipt.observation.exitCode).toBe(0);
  });

  test("the run's environment contains only declared variables: an undeclared parent variable never reaches the receipt", async () => {
    process.env["MUSAI_TEST_UNDECLARED"] = "should-never-appear";
    try {
      const repo = await freshRepo("restart-env");
      const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
      const rule: Rule = (input) => {
        if (input.evidence.length === 0) {
          return requestFor(["node", "-e", "process.stdout.write(String(process.env.MUSAI_TEST_UNDECLARED))"], "/");
        }
        return { kind: "verdict", label: "holds", reason: "done" };
      };

      const result = await runRestartLoop({
        invoker: invokerFromRule(rule),
        input: { claimId: "claim-env", conditions: {}, evidence: [] },
        store,
        index: new IndexDb(),
        now: repo.now,
      });
      const receipt = (await store.read(result.receipts[0]!.id, "run")) as PerformedRunRecord;

      expect(receipt.recipe.environment).toEqual({});
      expect(receipt.observation.output).toBe("undefined");
    } finally {
      delete process.env["MUSAI_TEST_UNDECLARED"];
    }
  });

  test("a rule requesting the same run twice is stopped after the second request and its claim is open", async () => {
    const repo = await freshRepo("restart-stalled");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    let calls = 0;
    const stubbornRule: Rule = () => {
      calls++;
      return requestFor(["printf", "%s", "same"], "/");
    };

    const result = await runRestartLoop({
      invoker: invokerFromRule(stubbornRule),
      input: { claimId: "claim-stalled", conditions: {}, evidence: [] },
      store,
      index: new IndexDb(),
      now: repo.now,
    });

    expect(calls).toBe(2);
    expect(result.invocations).toBe(2);
    expect(result.verdict.label).toBe("open");
  });

  test("a rule requesting two different runs resolves after three invocations", async () => {
    const repo = await freshRepo("restart-two-runs");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    let calls = 0;
    const rule: Rule = (input) => {
      calls++;
      if (input.evidence.length === 0) {
        return requestFor(["printf", "%s", "first"], "/");
      }
      if (input.evidence.length === 1) {
        return requestFor(["printf", "%s", "second"], "/");
      }
      return { kind: "verdict", label: "holds", reason: "both receipts present" };
    };

    const result = await runRestartLoop({
      invoker: invokerFromRule(rule),
      input: { claimId: "claim-two-runs", conditions: {}, evidence: [] },
      store,
      index: new IndexDb(),
      now: repo.now,
    });

    expect(calls).toBe(3);
    expect(result.invocations).toBe(3);
    expect(result.receipts).toHaveLength(2);
    expect(result.verdict).toEqual({ kind: "verdict", label: "holds", reason: "both receipts present" });
  });

  test("no continuation crosses the boundary: the request the loop acted on round-trips through bytes unchanged", async () => {
    const repo = await freshRepo("restart-bytes");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const emittedRequests: RuleOutput[] = [];
    const rule: Rule = (input) => {
      if (input.evidence.length === 0) {
        const request: RuleOutput = requestFor(["printf", "%s", "seam"], "/");
        emittedRequests.push(request);
        return request;
      }
      return { kind: "verdict", label: "holds", reason: "done" };
    };

    await runRestartLoop({
      invoker: invokerFromRule(rule),
      input: { claimId: "claim-bytes", conditions: {}, evidence: [] },
      store,
      index: new IndexDb(),
      now: repo.now,
    });

    expect(emittedRequests).toHaveLength(1);
    const roundTripped = JSON.parse(new TextDecoder().decode(canonicalBytes(emittedRequests[0])));
    expect(roundTripped).toEqual(emittedRequests[0]);
  });

  test("a registry no installed module of which declares it refuses the resolution-age slot, workspace-incomplete, naming it", () => {
    expect(() => ageLimitMsFromSlot(new Map(), {})).toThrow(
      expect.objectContaining({ reason: "workspace-incomplete", code: "workspace", about: [RESOLUTION_AGE_SLOT_ID] }),
    );
  });

  test("handed an age limit over a registry no installed module of which declares it, the loop refuses the need-concurrency slot, workspace-incomplete, naming it, before the rule is invoked", async () => {
    const repo = await freshRepo("restart-undeclared-concurrency");
    let calls = 0;
    const rule: Rule = () => {
      calls++;
      return { kind: "verdict", label: "holds", reason: "never reached" };
    };

    await expect(
      runRestartLoop({
        invoker: invokerFromRule(rule),
        input: { claimId: "claim-undeclared-concurrency", conditions: {}, evidence: [] },
        store: new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }),
        index: new IndexDb(),
        now: repo.now,
        slotRegistry: new Map(),
        ageLimitMs: 60_000,
      }),
    ).rejects.toMatchObject({
      reason: "workspace-incomplete",
      code: "workspace",
      about: ["musai.core/need-concurrency"],
    });
    expect(calls).toBe(0);
  });
});

describe("a list of needs, satisfied once each, and a stall you can see coming", () => {
  const repos: FixtureRepo[] = [];
  const scratchDirs: string[] = [];

  afterEach(async () => {
    for (const repo of repos.splice(0)) {
      await repo.cleanup();
    }
    scratchDirs.length = 0;
  });

  async function freshRepo(scope: string): Promise<FixtureRepo> {
    const repo = await makeFixtureRepo(scope);
    repos.push(repo);
    return repo;
  }

  async function scratchFile(name: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "musai-restart-"));
    scratchDirs.push(dir);
    return join(dir, name);
  }

  test("a contribution asking for three needs in one round gets three results folded into one restart", async () => {
    const repo = await freshRepo("restart-three-needs");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    let calls = 0;
    const rule: Rule = (input) => {
      calls++;
      if (input.evidence.length === 0) {
        return {
          kind: "request",
          needs: [
            { kind: "run", recipe: recipeFor(["printf", "%s", "first"], "/") },
            { kind: "run", recipe: recipeFor(["printf", "%s", "second"], "/") },
            { kind: "run", recipe: recipeFor(["printf", "%s", "third"], "/") },
          ],
        };
      }
      return { kind: "verdict", label: "holds", reason: `${input.evidence.length} receipts` };
    };

    const result = await runRestartLoop({
      invoker: invokerFromRule(rule),
      input: { claimId: "claim-three-needs", conditions: {}, evidence: [] },
      store,
      index: new IndexDb(),
      now: repo.now,
    });

    expect(calls).toBe(2);
    expect(result.invocations).toBe(2);
    expect(result.receipts).toHaveLength(3);
    expect(result.verdict).toEqual({ kind: "verdict", label: "holds", reason: "3 receipts" });
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]!.needs).toHaveLength(3);
    expect(result.rounds[0]!.satisfied).toHaveLength(3);
  });

  test("two contributions requesting one recipe in one evaluation cause exactly one spawn", async () => {
    const repo = await freshRepo("restart-shared-need");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const index = new IndexDb();
    const counterFile = await scratchFile("counter");
    await writeFile(counterFile, "");
    const sharedRecipe = recipeFor(
      ["node", "-e", `require("node:fs").appendFileSync(${JSON.stringify(counterFile)}, "1")`],
      "/",
    );
    const evaluationOutcomes = new Map();
    const askOnce: Rule = (input) =>
      input.evidence.length === 0
        ? { kind: "request", needs: [{ kind: "run", recipe: sharedRecipe }] }
        : { kind: "verdict", label: "holds", reason: "done" };

    const resultA = await runRestartLoop({
      invoker: invokerFromRule(askOnce),
      input: { claimId: "claim-shared-a", conditions: {}, evidence: [] },
      store,
      index,
      evaluationOutcomes,
      now: repo.now,
    });
    const resultB = await runRestartLoop({
      invoker: invokerFromRule(askOnce),
      input: { claimId: "claim-shared-b", conditions: {}, evidence: [] },
      store,
      index,
      evaluationOutcomes,
      now: repo.now,
    });

    expect(resultA.receipts[0]!.id).toBe(resultB.receipts[0]!.id);
    expect(await readFile(counterFile, "utf8")).toBe("1");
  });

  test("a receipt already in the store satisfies without spawning", async () => {
    const repo = await freshRepo("restart-reuse");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const index = new IndexDb();
    const counterFile = await scratchFile("counter");
    await writeFile(counterFile, "");
    const recipe = recipeFor(
      ["node", "-e", `require("node:fs").appendFileSync(${JSON.stringify(counterFile)}, "1")`],
      "/",
    );
    const askOnce: Rule = (input) =>
      input.evidence.length === 0
        ? { kind: "request", needs: [{ kind: "run", recipe }] }
        : { kind: "verdict", label: "holds", reason: "done" };

    const seeded = await runRestartLoop({
      invoker: invokerFromRule(askOnce),
      input: { claimId: "claim-seed", conditions: {}, evidence: [] },
      store,
      index,
      now: repo.now,
    });
    await index.fold(store);
    expect(await readFile(counterFile, "utf8")).toBe("1");

    const reused = await runRestartLoop({
      invoker: invokerFromRule(askOnce),
      input: { claimId: "claim-reuse", conditions: {}, evidence: [] },
      store,
      index,
      now: repo.now,
    });

    expect(reused.receipts[0]!.id).toBe(seeded.receipts[0]!.id);
    expect(await readFile(counterFile, "utf8")).toBe("1");
  });

  test("a receipt already in the store is refused rather than reused once no installed module declares its binary", async () => {
    const repo = await freshRepo("restart-reuse-unauthorised");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const index = new IndexDb();
    const counterFile = await scratchFile("counter");
    await writeFile(counterFile, "");
    const recipe = recipeFor(
      ["node", "-e", `require("node:fs").appendFileSync(${JSON.stringify(counterFile)}, "1")`],
      "/",
    );
    const askOnce: Rule = (input) =>
      input.evidence.length === 0
        ? { kind: "request", needs: [{ kind: "run", recipe }] }
        : { kind: "verdict", label: "holds", reason: "done" };
    await runRestartLoop({
      invoker: invokerFromRule(askOnce),
      input: { claimId: "claim-seed", conditions: {}, evidence: [] },
      store,
      index,
      now: repo.now,
    });
    await index.fold(store);
    const tip = await store.tip();

    const outcomes = await satisfyNeeds({
      needs: [{ kind: "run", recipe }],
      index,
      store,
      evaluationOutcomes: new Map(),
      ageLimitMs: Number.POSITIVE_INFINITY,
      requirementRegistry: requirementsFromModules([]),
      now: repo.now,
    });

    expect([...outcomes.values()]).toMatchObject([{ kind: "refused", reason: "undeclared-binary" }]);
    expect(await store.tip()).toBe(tip);
    expect(await readFile(counterFile, "utf8")).toBe("1");
  });

  test("a receipt whose substrate moved does not satisfy", async () => {
    const repo = await freshRepo("restart-substrate-moved");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const index = new IndexDb();
    const substratePath = await scratchFile("substrate.txt");
    await writeFile(substratePath, "original");
    const recipe: RunRecipe = {
      command: ["cat", substratePath],
      workingDirectory: "/",
      environment: {},
      declared: [],
      substrates: [{ uri: `file://${substratePath}` }],
      isolation: "hygiene",
    };
    const askOnce: Rule = (input) =>
      input.evidence.length === 0
        ? { kind: "request", needs: [{ kind: "run", recipe }] }
        : { kind: "verdict", label: "holds", reason: "done" };

    const first = await runRestartLoop({
      invoker: invokerFromRule(askOnce),
      input: { claimId: "claim-substrate-1", conditions: {}, evidence: [] },
      store,
      index,
      now: repo.now,
    });
    await index.fold(store);

    await writeFile(substratePath, "changed");

    const second = await runRestartLoop({
      invoker: invokerFromRule(askOnce),
      input: { claimId: "claim-substrate-2", conditions: {}, evidence: [] },
      store,
      index,
      now: repo.now,
    });

    expect(second.receipts[0]!.id).not.toBe(first.receipts[0]!.id);
  });

  test("a receipt whose bound secret was rotated to a new value does not satisfy", async () => {
    const repo = await freshRepo("restart-secret-rotated");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const index = new IndexDb();
    const localDir = join(repo.ctx.gitDir, "local");
    await mkdir(localDir, { recursive: true });
    const bindingsPath = join(localDir, "bindings.json");
    await writeFile(bindingsPath, JSON.stringify({ TOKEN: { value: "first", secret: true } }), { mode: 0o600 });
    await chmod(bindingsPath, 0o600);

    const recipe: RunRecipe = {
      command: ["printf", "%s", "reads a secret"],
      workingDirectory: "/",
      environment: {},
      declared: [{ name: "TOKEN", secret: true }],
      substrates: [],
      isolation: "hygiene",
    };
    const askOnce: Rule = (input) =>
      input.evidence.length === 0
        ? { kind: "request", needs: [{ kind: "run", recipe }] }
        : { kind: "verdict", label: "holds", reason: "done" };

    const first = await runRestartLoop({
      invoker: invokerFromRule(askOnce),
      input: { claimId: "claim-secret-1", conditions: {}, evidence: [] },
      store,
      index,
      localDir,
      now: repo.now,
    });
    await index.fold(store);

    // The same value binds to the same keyed hash, so the receipt still answers.
    const unchanged = await runRestartLoop({
      invoker: invokerFromRule(askOnce),
      input: { claimId: "claim-secret-2", conditions: {}, evidence: [] },
      store,
      index,
      localDir,
      now: repo.now,
    });
    expect(unchanged.receipts[0]!.id).toBe(first.receipts[0]!.id);

    await writeFile(bindingsPath, JSON.stringify({ TOKEN: { value: "second", secret: true } }), { mode: 0o600 });
    await chmod(bindingsPath, 0o600);

    const rotated = await runRestartLoop({
      invoker: invokerFromRule(askOnce),
      input: { claimId: "claim-secret-3", conditions: {}, evidence: [] },
      store,
      index,
      localDir,
      now: repo.now,
    });
    expect(rotated.receipts[0]!.id).not.toBe(first.receipts[0]!.id);
  });

  test("a receipt older than the supplied age limit does not satisfy", async () => {
    const repo = await freshRepo("restart-age-limit");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const index = new IndexDb();
    const recipe = recipeFor(["printf", "%s", "aging"], "/");
    const askOnce: Rule = (input) =>
      input.evidence.length === 0
        ? { kind: "request", needs: [{ kind: "run", recipe }] }
        : { kind: "verdict", label: "holds", reason: "done" };

    const old = await runRestartLoop({
      invoker: invokerFromRule(askOnce),
      input: { claimId: "claim-age-1", conditions: {}, evidence: [] },
      store,
      index,
      now: fixedClock("2020-01-01T00:00:00.000Z"),
    });
    await index.fold(store);

    const fresh = await runRestartLoop({
      invoker: invokerFromRule(askOnce),
      input: { claimId: "claim-age-2", conditions: {}, evidence: [] },
      store,
      index,
      ageLimitMs: 1000,
      now: repo.now,
    });

    expect(fresh.receipts[0]!.id).not.toBe(old.receipts[0]!.id);
  });

  test("a refused need arrives in the next invocation's input as a canonical error, and the rule concludes from it", async () => {
    const repo = await freshRepo("restart-refusal");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const rule: Rule = (input) => {
      const refusal = input.refusals?.[0];
      if (refusal !== undefined) {
        return { kind: "verdict", label: "open", reason: `refused: ${refusal.error.code}` };
      }
      return { kind: "request", needs: [{ kind: "record", id: `sha256:${"0".repeat(64)}` }] };
    };

    let threw = false;
    let result: Awaited<ReturnType<typeof runRestartLoop>> | undefined;
    try {
      result = await runRestartLoop({
        invoker: invokerFromRule(rule),
        input: { claimId: "claim-refusal", conditions: {}, evidence: [] },
        store,
        index: new IndexDb(),
        now: repo.now,
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result?.verdict).toEqual({ kind: "verdict", label: "open", reason: "refused: need-refused" });
  });

  test("each receipt in the loop's result names the kind of need that produced it", async () => {
    const repo = await freshRepo("restart-receipt-kinds");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now, claimTypes: repo.claimTypes });
    const conditions = { subject: "the loop", predicate: "names", object: "each receipt's need" };
    const held = await store.put("claim", {
      kind: "claim",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
      type: TRIPLE_CLAIM_TYPE,
      about: [],
      slot: slotFor(TRIPLE_DECLARATION, conditions),
      conditions,
      canonical: conditions,
      rendering: "the loop names each receipt's need.",
      evidence: [],
      exclusiveGroup: null,
    });
    const index = new IndexDb();
    await index.fold(store);
    const rule: Rule = (input) =>
      input.evidence.length === 0
        ? {
            kind: "request",
            needs: [
              { kind: "record", id: held },
              { kind: "run", recipe: recipeFor(["printf", "%s", "beside a record"], "/") },
            ],
          }
        : { kind: "verdict", label: "holds", reason: "done" };

    const result = await runRestartLoop({
      invoker: invokerFromRule(rule),
      input: { claimId: "claim-receipt-kinds", conditions: {}, evidence: [] },
      store,
      index,
      now: repo.now,
    });

    expect(result.verdict.label).toBe("holds");
    expect(result.receipts).toEqual([
      { id: held, need: "record" },
      { id: result.rounds[0]!.satisfied[1], need: "run" },
    ]);
    expect(((await store.read(result.receipts[1]!.id, "run")) as RunRecord).observation.output).toBe("beside a record");
  });

  test("a record need hands the rule the record it names on the next round, once", async () => {
    const repo = await freshRepo("restart-record-handed");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now, claimTypes: repo.claimTypes });
    const conditions = { subject: "an atom", predicate: "reads", object: "as a record" };
    const held = await store.put("claim", {
      kind: "claim",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
      type: TRIPLE_CLAIM_TYPE,
      about: [],
      slot: slotFor(TRIPLE_DECLARATION, conditions),
      conditions,
      canonical: conditions,
      rendering: "the atom the rule reads.",
      evidence: [],
      exclusiveGroup: null,
    });
    const index = new IndexDb();
    await index.fold(store);
    const handed: unknown[] = [];
    const rule: Rule = (input) => {
      handed.push(input.records);
      const read = input.records?.find((entry) => entry.id === held)?.record as { rendering?: string } | undefined;
      return read === undefined
        ? { kind: "request", needs: [{ kind: "record", id: held }] }
        : { kind: "verdict", label: "holds", reason: `read ${read.rendering}` };
    };

    const result = await runRestartLoop({
      invoker: invokerFromRule(rule),
      input: { claimId: "claim-record-handed", conditions: {}, evidence: [] },
      store,
      index,
      now: repo.now,
    });

    expect(result.verdict).toEqual({ kind: "verdict", label: "holds", reason: "read the atom the rule reads." });
    expect(handed).toEqual([undefined, [{ id: held, record: index.recordById(held)!.record }]]);
  });

  test("a record need naming a superseded claim is handed the claim at its slot now", async () => {
    const repo = await freshRepo("restart-record-successor");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now, claimTypes: repo.claimTypes });
    const conditions = { subject: "an atom", predicate: "was", object: "restated" };
    const first = {
      kind: "claim" as const,
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
      type: TRIPLE_CLAIM_TYPE,
      about: [],
      slot: slotFor(TRIPLE_DECLARATION, conditions),
      conditions,
      canonical: conditions,
      rendering: "as first written.",
      evidence: [],
      exclusiveGroup: null,
    };
    const named = await store.put("claim", first);
    const successor = await store.put("claim", { ...first, rendering: "as restated.", supersedes: [named] });
    const index = new IndexDb();
    await index.fold(store);
    const rule: Rule = (input) => {
      const read = input.records?.[0]?.record as { rendering?: string } | undefined;
      return read === undefined
        ? { kind: "request", needs: [{ kind: "record", id: named }] }
        : { kind: "verdict", label: "holds", reason: `read ${read.rendering}` };
    };

    const result = await runRestartLoop({
      invoker: invokerFromRule(rule),
      input: { claimId: "claim-record-successor", conditions: {}, evidence: [] },
      store,
      index,
      now: repo.now,
    });

    expect(result.verdict.reason).toBe("read as restated.");
    expect(result.readSet).toEqual([
      { key: `slot:${first.slot}`, consumed: { sha256: successor.slice("sha256:".length) } },
    ]);
  });

  test("a record need may name a record its own evaluation minted", async () => {
    const repo = await freshRepo("restart-own-receipt");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const rule: Rule = (input) => {
      const refusal = input.refusals?.[0];
      if (refusal !== undefined) {
        return { kind: "verdict", label: "open", reason: `${refusal.error.code}: ${refusal.error.message}` };
      }
      if (input.evidence.length === 0) {
        return requestFor(["printf", "%s", "first"], "/");
      }
      if (input.evidence.length === 1) {
        return {
          kind: "request",
          needs: [
            { kind: "record", id: input.evidence[0]!.runId as RecordId },
            { kind: "run", recipe: recipeFor(["printf", "%s", "second"], "/") },
          ],
        };
      }
      return { kind: "verdict", label: "holds", reason: "the receipt it named was given" };
    };

    const result = await runRestartLoop({
      invoker: invokerFromRule(rule),
      input: { claimId: "claim-own-receipt", conditions: {}, evidence: [] },
      store,
      index: new IndexDb(),
      now: repo.now,
    });

    expect(result.verdict).toEqual({ kind: "verdict", label: "holds", reason: "the receipt it named was given" });
    const minted = result.receipts[0]!.id;
    expect(result.rounds[1]!.satisfied).toContain(minted);
    // The receipt is listed once, under the run need that minted it.
    expect(result.receipts.filter((entry) => entry.id === minted)).toEqual([{ id: minted, need: "run" }]);
  });

  test("a receipt a run need answered is read as a run whichever need named it first", async () => {
    const repo = await freshRepo("restart-record-then-run");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const index = new IndexDb();
    const recipe = recipeFor(["printf", "%s", "held"], "/");
    const seeded = await runRestartLoop({
      invoker: invokerFromRule((input) =>
        input.evidence.length === 0
          ? { kind: "request", needs: [{ kind: "run", recipe }] }
          : { kind: "verdict", label: "holds", reason: "seeded" },
      ),
      input: { claimId: "claim-seed-held", conditions: {}, evidence: [] },
      store,
      index,
      now: repo.now,
    });
    await index.fold(store);
    const held = seeded.receipts[0]!.id;

    // Round one names the held receipt as a record; round two asks for the run it satisfies.
    const rule: Rule = (input) => {
      if (input.evidence.length === 0) {
        return {
          kind: "request",
          needs: [
            { kind: "record", id: held },
            { kind: "run", recipe: recipeFor(["printf", "%s", "beside it"], "/") },
          ],
        };
      }
      if (input.evidence.length === 1) {
        return { kind: "request", needs: [{ kind: "run", recipe }] };
      }
      return { kind: "verdict", label: "holds", reason: "both runs read" };
    };

    const result = await runRestartLoop({
      invoker: invokerFromRule(rule),
      input: { claimId: "claim-record-then-run", conditions: {}, evidence: [] },
      store,
      index,
      now: repo.now,
    });

    expect(result.verdict).toEqual({ kind: "verdict", label: "holds", reason: "both runs read" });
    expect(result.rounds[1]!.satisfied).toEqual([held]);
    expect(result.receipts).toEqual([
      { id: held, need: "run" },
      { id: result.rounds[0]!.satisfied[1], need: "run" },
    ]);
  });

  test("two needs completing in either order produce identical results", async () => {
    const repo = await freshRepo("restart-order-independent");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });

    async function runInOrder(order: "as-declared" | "reversed") {
      const needs: Need[] = [
        { kind: "run", recipe: recipeFor(["printf", "%s", "alpha"], "/") },
        { kind: "run", recipe: recipeFor(["printf", "%s", "beta"], "/") },
      ];
      const ordered = order === "as-declared" ? needs : [...needs].reverse();
      const rule: Rule = (input) =>
        input.evidence.length === 0
          ? { kind: "request", needs: ordered }
          : { kind: "verdict", label: "holds", reason: `${input.evidence.length} receipts` };
      const result = await runRestartLoop({
        invoker: invokerFromRule(rule),
        input: { claimId: `claim-order-${order}`, conditions: {}, evidence: [] },
        store,
        index: new IndexDb(),
        now: repo.now,
      });
      return { verdict: result.verdict, receiptCount: result.receipts.length };
    }

    const [asDeclared, reversed] = await Promise.all([runInOrder("as-declared"), runInOrder("reversed")]);
    expect(asDeclared.verdict).toEqual(reversed.verdict);
    expect(asDeclared.receiptCount).toBe(reversed.receiptCount);
  });

  test("a need kind outside run, fetch, record and invoke is refused with the unsupported code", async () => {
    const repo = await freshRepo("restart-unsupported-need");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const bogusNeed = { kind: "bogus" } as unknown as Need;

    const outcomes = await satisfyNeeds({
      needs: [bogusNeed],
      index: new IndexDb(),
      store,
      evaluationOutcomes: new Map(),
      ageLimitMs: Number.POSITIVE_INFINITY,
      now: repo.now,
    });

    const outcome = [...outcomes.values()][0]!;
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.error.code).toBe("unsupported-need");
      expect(outcome.reason).toBe("unsupported-format");
    }
  });

  test("a request carrying an empty needs list is a stall, not a request the loop tries to satisfy", async () => {
    const repo = await freshRepo("restart-empty-needs");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    let calls = 0;
    const rule: Rule = () => {
      calls++;
      return { kind: "request", needs: [] };
    };

    const result = await runRestartLoop({
      invoker: invokerFromRule(rule),
      input: { claimId: "claim-empty-needs", conditions: {}, evidence: [] },
      store,
      index: new IndexDb(),
      now: repo.now,
    });

    expect(calls).toBe(1);
    expect(result.verdict.label).toBe("open");
    expect(result.receipts).toHaveLength(0);
  });
});

describe("a receipt for a named commit is reused by the commit's tree, and a pinned receipt has no age", () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
  });

  async function freshRepo(scope: string): Promise<FixtureRepo> {
    const repo = await makeFixtureRepo(scope);
    cleanups.push(() => repo.cleanup());
    return repo;
  }

  async function freshCheckout(content: string): Promise<Checkout> {
    const checkout = await makeCheckout(content);
    cleanups.push(() => checkout.cleanup());
    return checkout;
  }

  async function scratchDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "musai-restart-pinned-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return dir;
  }

  /** A workspace whose counter file gains one byte per spawn of `counting`. */
  async function workspace(scope: string) {
    const repo = await freshRepo(scope);
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const index = new IndexDb();
    const localDir = join(repo.ctx.gitDir, "local");
    await mkdir(localDir, { recursive: true });
    const counterFile = join(await scratchDir(), "counter");
    await writeFile(counterFile, "");
    const counting = (substrates: RunRecipe["substrates"], declared: RunRecipe["declared"] = []): RunRecipe => ({
      command: ["node", "-e", `require("node:fs").appendFileSync(${JSON.stringify(counterFile)}, "1")`],
      workingDirectory: substrates.some((substrate) => substrate.digest?.gitCommit !== undefined) ? "." : "/",
      environment: {},
      declared,
      substrates,
      isolation: "hygiene",
    });
    const evaluate = (recipe: RunRecipe, claimId: string, clock = repo.now, ageLimitMs?: number) =>
      runRestartLoop({
        invoker: invokerFromRule(askOnce(recipe)),
        input: { claimId, conditions: {}, evidence: [] },
        store,
        index,
        localDir,
        now: clock,
        ...(ageLimitMs === undefined ? {} : { ageLimitMs }),
      }).then(async (result) => {
        await index.fold(store);
        return result;
      });
    return { store, index, localDir, counterFile, counting, evaluate };
  }

  /** Asks for one run: `holds` on its receipt, `open` with the refusal's own message. */
  function askOnce(recipe: RunRecipe): Rule {
    return (input) => {
      const refusal = input.refusals?.[0];
      if (refusal !== undefined) {
        return { kind: "verdict", label: "open", reason: refusal.error.message };
      }
      return input.evidence.length === 0
        ? { kind: "request", needs: [{ kind: "run", recipe }] }
        : { kind: "verdict", label: "holds", reason: "done" };
    };
  }

  const LONG_AGO = "2020-01-01T00:00:00.000Z";

  test("a second evaluation of a checkout recipe at the same commit reuses the first receipt without spawning", async () => {
    const { localDir, counterFile, counting, evaluate } = await workspace("checkout-same-commit");
    const checkout = await freshCheckout("first");
    await bindCheckouts(localDir, { repo: checkout.dir });
    const recipe = counting([{ name: "repo", digest: { gitCommit: await headCommit(checkout.dir) } }]);

    const first = await evaluate(recipe, "claim-checkout-1");
    const second = await evaluate(recipe, "claim-checkout-2");

    expect(first.receipts).toHaveLength(1);
    expect(second.receipts[0]!.id).toBe(first.receipts[0]!.id);
    expect(await readFile(counterFile, "utf8")).toBe("1");
  });

  test("after the checkout moves to a new commit and is dirtied, the first commit's receipt is still reused without spawning", async () => {
    const { localDir, counterFile, counting, evaluate } = await workspace("checkout-moved-on");
    const checkout = await freshCheckout("first");
    await bindCheckouts(localDir, { repo: checkout.dir });
    const recipe = counting([{ name: "repo", digest: { gitCommit: await headCommit(checkout.dir) } }]);

    const first = await evaluate(recipe, "claim-moved-1");
    await commitContent(checkout.dir, "second");
    await writeFile(join(checkout.dir, "tracked.txt"), "dirtied");
    const again = await evaluate(recipe, "claim-moved-2");

    expect(again.receipts[0]!.id).toBe(first.receipts[0]!.id);
    expect(await readFile(counterFile, "utf8")).toBe("1");
  });

  test("bound to a repository that does not hold the commit, the receipt is not reused and the spawn arm refuses the need, minting nothing", async () => {
    const { localDir, counterFile, counting, evaluate } = await workspace("checkout-rebound");
    const checkout = await freshCheckout("first");
    const other = await freshCheckout("another history");
    await bindCheckouts(localDir, { repo: checkout.dir });
    const commit = await headCommit(checkout.dir);
    const recipe = counting([{ name: "repo", digest: { gitCommit: commit } }]);

    await evaluate(recipe, "claim-rebound-1");
    await bindCheckouts(localDir, { repo: other.dir });
    const rebound = await evaluate(recipe, "claim-rebound-2");

    expect(rebound.receipts).toHaveLength(0);
    expect(rebound.verdict.label).toBe("open");
    expect(rebound.verdict.reason).toContain(commit);
    expect(rebound.verdict.reason).not.toContain(basename(other.dir));
    expect(await readFile(counterFile, "utf8")).toBe("1");
  });

  test("a dirty checkout at a commit no receipt covers refuses the need, minting nothing", async () => {
    const { localDir, counterFile, counting, evaluate } = await workspace("checkout-dirty");
    const checkout = await freshCheckout("first");
    await bindCheckouts(localDir, { repo: checkout.dir });
    const recipe = counting([{ name: "repo", digest: { gitCommit: await headCommit(checkout.dir) } }]);
    const committedTree = await headTree(checkout.dir);
    await writeFile(join(checkout.dir, "tracked.txt"), "dirtied");

    const dirty = await evaluate(recipe, "claim-dirty");

    expect(dirty.receipts).toHaveLength(0);
    expect(dirty.verdict.label).toBe("open");
    expect(dirty.verdict.reason).toContain(committedTree);
    expect(dirty.verdict.reason).not.toContain(basename(checkout.dir));
    expect(await readFile(counterFile, "utf8")).toBe("");
  });

  test("a checkout recipe whose working directory is absent at its commit mints no receipt and refuses the need", async () => {
    const { localDir, counting, evaluate } = await workspace("checkout-absent-directory");
    const checkout = await freshCheckout("first");
    await bindCheckouts(localDir, { repo: checkout.dir });
    const recipe = {
      ...counting([{ name: "repo", digest: { gitCommit: await headCommit(checkout.dir) } }]),
      workingDirectory: "absent-at-this-commit",
    };

    const result = await evaluate(recipe, "claim-absent-directory");

    expect(result.receipts).toHaveLength(0);
    expect(result.verdict.label).toBe("open");
    expect(result.verdict.reason).toContain("ENOENT");
  });

  test("a checkout recipe's receipt is reused at any age, without spawning", async () => {
    const { localDir, counterFile, counting, evaluate } = await workspace("pinned-checkout");
    const checkout = await freshCheckout("first");
    await bindCheckouts(localDir, { repo: checkout.dir });
    const recipe = counting([{ name: "repo", digest: { gitCommit: await headCommit(checkout.dir) } }]);

    const old = await evaluate(recipe, "claim-pinned-checkout-1", fixedClock(LONG_AGO));
    const later = await evaluate(recipe, "claim-pinned-checkout-2", undefined, 0);

    expect(later.receipts[0]!.id).toBe(old.receipts[0]!.id);
    expect(await readFile(counterFile, "utf8")).toBe("1");
  });

  /** A recipe over the working tree bound as `tree`, counting its spawns. */
  function overTree(counting: (substrates: RunRecipe["substrates"]) => RunRecipe): RunRecipe {
    return { ...counting([{ name: "tree", uri: "musai:tree" }]), workingDirectory: "." };
  }

  test("a receipt over a tree is reused while the tree measures the same, whatever its age", async () => {
    const { localDir, counterFile, counting, evaluate } = await workspace("tree-unchanged");
    const checkout = await freshCheckout("first");
    await writeFile(join(checkout.dir, "untracked.txt"), "never committed");
    await bindCheckouts(localDir, { tree: checkout.dir });
    const recipe = overTree(counting);

    const old = await evaluate(recipe, "claim-tree-1", fixedClock(LONG_AGO));
    const later = await evaluate(recipe, "claim-tree-2", undefined, 0);

    expect(later.receipts[0]!.id).toBe(old.receipts[0]!.id);
    expect(await readFile(counterFile, "utf8")).toBe("1");
  });

  test("a tree that moved re-runs the recipe", async () => {
    const { localDir, counterFile, counting, evaluate } = await workspace("tree-moved");
    const checkout = await freshCheckout("first");
    await bindCheckouts(localDir, { tree: checkout.dir });
    const recipe = overTree(counting);

    const first = await evaluate(recipe, "claim-tree-moved-1");
    await writeFile(join(checkout.dir, "tracked.txt"), "edited, not committed");
    const again = await evaluate(recipe, "claim-tree-moved-2");

    expect(again.receipts[0]!.id).not.toBe(first.receipts[0]!.id);
    expect(await readFile(counterFile, "utf8")).toBe("11");
  });

  test("a checkout recipe that also stands on a sha256 substrate is redone once its receipt ages out, since nothing checks that digest before a run", async () => {
    const { localDir, counterFile, counting, evaluate } = await workspace("unpinned-sha256");
    const checkout = await freshCheckout("first");
    await bindCheckouts(localDir, { repo: checkout.dir });
    const recipe = counting([
      { name: "repo", digest: { gitCommit: await headCommit(checkout.dir) } },
      { digest: { sha256: "a".repeat(64) } },
    ]);

    const old = await evaluate(recipe, "claim-unpinned-sha-1", fixedClock(LONG_AGO));
    const later = await evaluate(recipe, "claim-unpinned-sha-2", undefined, 0);

    expect(later.receipts[0]!.id).not.toBe(old.receipts[0]!.id);
    expect(await readFile(counterFile, "utf8")).toBe("11");
  });

  test.skipIf(process.platform === "win32")(
    "a pinned recipe whose program changed under the PATH is redone once its receipt ages out",
    async () => {
      const { localDir, counting, evaluate } = await workspace("pinned-program-moved");
      const checkout = await freshCheckout("first");
      await bindCheckouts(localDir, { repo: checkout.dir });
      const program = "musai-pinned-probe";
      const dirA = await scratchDir();
      const dirB = await scratchDir();
      for (const [dir, comment] of [
        [dirA, "the copy the receipt was taken with"],
        [dirB, "the copy that replaced it"],
      ] as const) {
        await writeFile(join(dir, program), ["#!/bin/sh", `# ${comment}`, "exit 0", ""].join("\n"));
        await chmod(join(dir, program), 0o755);
      }
      const recipe = {
        ...counting([{ name: "repo", digest: { gitCommit: await headCommit(checkout.dir) } }]),
        command: [program],
      };
      const originalPath = process.env["PATH"] ?? "";
      try {
        process.env["PATH"] = `${dirA}${delimiter}${originalPath}`;
        const old = await evaluate(recipe, "claim-program-1", fixedClock(LONG_AGO));
        process.env["PATH"] = `${dirB}${delimiter}${originalPath}`;
        const later = await evaluate(recipe, "claim-program-2", undefined, 0);

        expect(later.receipts[0]!.id).not.toBe(old.receipts[0]!.id);
      } finally {
        process.env["PATH"] = originalPath;
      }
    },
  );

  test("a checkout receipt whose working directory leaves the checkout is not reused once it ages out, since that directory was never measured", async () => {
    const { store, index, localDir, counting, evaluate } = await workspace("unpinned-escaping");
    const checkout = await freshCheckout("first");
    await bindCheckouts(localDir, { repo: checkout.dir });
    const commit = await headCommit(checkout.dir);
    const recipe = { ...counting([{ name: "repo", digest: { gitCommit: commit } }]), workingDirectory: "../outside" };
    const [node] = await resolveBinaries(["node"]);
    const escaped = await store.put("run", {
      kind: "run",
      schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
      runKind: "run",
      performer: RUNNER_PERFORMER,
      determinism: "nondeterministic",
      recipe,
      observation: {
        resolved: [{ name: "repo", digest: { gitCommit: commit, gitTree: await headTree(checkout.dir) } }],
        isolationHeld: "hygiene",
        binaries: [{ name: node!.name, digest: node!.digest }],
        bindings: [],
        output: "",
        outputLossy: false,
        exitCode: 0,
        scrubbed: [],
        startedAt: timestamp(LONG_AGO),
        finishedAt: timestamp(LONG_AGO),
        reads: [],
        cost: {},
      },
      supersedes: [],
    } satisfies RunRecord);
    await index.fold(store);

    const later = await evaluate(recipe, "claim-escaping", undefined, 0);

    expect(later.receipts.map((receipt) => receipt.id)).not.toContain(escaped);
    expect(later.verdict.reason).toContain("leaves the checkout");
  });

  test("a recipe declaring no substrate is redone once its receipt ages out", async () => {
    const { counterFile, counting, evaluate } = await workspace("unpinned-no-substrate");
    const recipe = counting([]);

    const old = await evaluate(recipe, "claim-unpinned-1", fixedClock(LONG_AGO));
    const later = await evaluate(recipe, "claim-unpinned-2", undefined, 0);

    expect(later.receipts[0]!.id).not.toBe(old.receipts[0]!.id);
    expect(await readFile(counterFile, "utf8")).toBe("11");
  });

  test("a checkout recipe that declares a name is redone once its receipt ages out", async () => {
    const { localDir, counterFile, counting, evaluate } = await workspace("unpinned-declared");
    const checkout = await freshCheckout("first");
    await bindCheckouts(localDir, { repo: checkout.dir });
    const bindingsPath = join(localDir, "bindings.json");
    await writeFile(bindingsPath, JSON.stringify({ PLAIN_NAME: { value: "plain", secret: false } }), { mode: 0o600 });
    await chmod(bindingsPath, 0o600);
    const recipe = counting(
      [{ name: "repo", digest: { gitCommit: await headCommit(checkout.dir) } }],
      [{ name: "PLAIN_NAME", secret: false }],
    );

    const old = await evaluate(recipe, "claim-declared-1", fixedClock(LONG_AGO));
    const later = await evaluate(recipe, "claim-declared-2", undefined, 0);

    expect(later.receipts[0]!.id).not.toBe(old.receipts[0]!.id);
    expect(await readFile(counterFile, "utf8")).toBe("11");
  });
});
