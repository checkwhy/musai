import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { versionString } from "@musai/records";
import { gatewaySource } from "@musai/test-support";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { HOSTS, type ModuleHost } from "../src/module/hosts.js";
import {
  ENVELOPE_PROTOCOL,
  type EnvelopeRequest,
  type EnvelopeResponse,
  ERROR_CODES,
  encodeRequest,
  type InvokedContribution,
  kernelPoint,
} from "../src/rule/envelope.js";
import { InProcessHost } from "../src/rule/host.js";

const tsLoader = fileURLToPath(import.meta.resolve("@musai/test-support/ts-esm"));
const invokeInProcess = fileURLToPath(new URL("support/invoke-in-process.ts", import.meta.url));

const PURE_GATEWAY = gatewaySource("invoke", '      return { kind: "verdict", label: "open", reason: input.claimId };');

const TOUCHES_THE_MODULE_LOADER_GATEWAY = gatewaySource(
  "invoke",
  ['      const loader = globalThis["require"];', '      return loader("node:fs");'].join("\n"),
);

const READS_THE_CLOCK_GATEWAY = gatewaySource(
  "invoke",
  ["      const now = Date.now();", '      return { kind: "verdict", label: "open", reason: String(now) };'].join("\n"),
);

const DRAWS_RANDOMNESS_GATEWAY = gatewaySource(
  "invoke",
  [
    "      const value = Math.random();",
    '      return { kind: "verdict", label: "open", reason: String(value) };',
  ].join("\n"),
);

const WRITES_TO_ITS_OWN_SCOPE_GATEWAY = gatewaySource(
  "invoke",
  ["      counter += 1;", '      return { kind: "verdict", label: "open", reason: String(counter) };'].join("\n"),
  "let counter = 0;",
);

const THROWS_GATEWAY = gatewaySource("invoke", '      throw new Error("this rule always throws");');

const AWAITS_FOREVER_GATEWAY = gatewaySource(
  "invoke",
  [
    "      await new Promise(() => {});",
    '      return { kind: "verdict", label: "open", reason: "unreachable" };',
  ].join("\n"),
);

const RETURNS_MALFORMED_OUTPUT_GATEWAY = gatewaySource(
  "invoke",
  '      return { kind: "verdict", label: "unsure", reason: "not a real label" };',
);

const ASSIGNS_AN_UNDECLARED_NAME_GATEWAY = gatewaySource(
  "invoke",
  ["      undeclaredTotal = 1;", '      return { kind: "verdict", label: "open", reason: "assigned" };'].join("\n"),
);

/** The statement whose line the position fixture reports, found in the source, not counted. */
const READS_ITS_OWN_POSITION_STATEMENT = '      const frame = new Error().stack.split("\\n")[1];';

const READS_ITS_OWN_POSITION_GATEWAY = gatewaySource(
  "invoke",
  [READS_ITS_OWN_POSITION_STATEMENT, '      return { kind: "verdict", label: "open", reason: frame };'].join("\n"),
);

/** The position fixture behind a hashbang, which the type stripper and the bundler both keep. */
const STARTS_WITH_A_HASHBANG_GATEWAY = gatewaySource(
  "invoke",
  [READS_ITS_OWN_POSITION_STATEMENT, '      return { kind: "verdict", label: "open", reason: frame };'].join("\n"),
  "#!/usr/bin/env node",
);

/** A parameter named twice, which only strict mode refuses. */
const REPEATS_A_PARAMETER_GATEWAY = gatewaySource(
  "invoke",
  '      return { kind: "verdict", label: "open", reason: String(pair(1, 2)) };',
  "function pair(a, a) { return a; }",
);

const LOOPS_FOREVER_GATEWAY = gatewaySource(
  "invoke",
  ["      while (true) {", "        // never returns", "      }"].join("\n"),
);

const ALLOCATES_PAST_A_CEILING_GATEWAY = gatewaySource(
  "invoke",
  [
    "      const chunks = [];",
    "      while (true) {",
    '        chunks.push(new Array(1e6).fill("x"));',
    "      }",
  ].join("\n"),
);

function requestFor(id: string, input: unknown): EnvelopeRequest {
  return { protocol: ENVELOPE_PROTOCOL, contribution: "rule", id, version: versionString("1"), input };
}

/** The kernel's `rule` point and an entry declaring nothing narrower: these tests pin the host. */
function ruleEntry(id: string): InvokedContribution {
  return {
    entry: { kind: "rule", id, version: versionString("1"), input: true, output: true, documentation: "" },
    point: kernelPoint("rule")!,
  };
}

const EMPTY_INPUT = { claimId: "claim-a", conditions: {}, evidence: [] };

describe("the in-process host: a bundle runs where the kernel's globals are not", () => {
  let scratchDir: string;

  beforeAll(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), "musai-host-"));
    await Promise.all([
      writeFile(join(scratchDir, "pure.rule.ts"), PURE_GATEWAY),
      writeFile(join(scratchDir, "touches-the-module-loader.rule.ts"), TOUCHES_THE_MODULE_LOADER_GATEWAY),
      writeFile(join(scratchDir, "reads-the-clock.rule.ts"), READS_THE_CLOCK_GATEWAY),
      writeFile(join(scratchDir, "draws-randomness.rule.ts"), DRAWS_RANDOMNESS_GATEWAY),
      writeFile(join(scratchDir, "writes-to-its-own-scope.rule.ts"), WRITES_TO_ITS_OWN_SCOPE_GATEWAY),
      writeFile(join(scratchDir, "throws.rule.ts"), THROWS_GATEWAY),
      writeFile(join(scratchDir, "awaits-forever.rule.ts"), AWAITS_FOREVER_GATEWAY),
      writeFile(join(scratchDir, "returns-malformed-output.rule.ts"), RETURNS_MALFORMED_OUTPUT_GATEWAY),
      writeFile(join(scratchDir, "loops-forever.rule.ts"), LOOPS_FOREVER_GATEWAY),
      writeFile(join(scratchDir, "allocates-past-a-ceiling.rule.ts"), ALLOCATES_PAST_A_CEILING_GATEWAY),
    ]);
  });

  test("a minimal gateway exposing the one export round-trips a request to a response", async () => {
    const host = new InProcessHost();
    const loaded = await host.load(join(scratchDir, "pure.rule.ts"), "invoke");
    const { response } = await host.invoke(loaded, requestFor("test/pure", EMPTY_INPUT), ruleEntry("test/pure"));
    expect(response).toEqual({
      ok: true,
      output: { kind: "verdict", label: "open", reason: "claim-a" },
      diagnostics: [],
    });
  });

  test("a request the module's own declared input schema refuses never reaches the module", async () => {
    const host = new InProcessHost();
    const loaded = await host.load(join(scratchDir, "pure.rule.ts"), "invoke");
    const pure = ruleEntry("test/pure");
    const narrow: InvokedContribution = {
      ...pure,
      entry: {
        ...pure.entry,
        input: {
          type: "object",
          properties: { claimId: { const: "claim-the-module-declares" } },
          required: ["claimId"],
        },
      },
    };

    const { response } = await host.invoke(loaded, requestFor("test/pure", EMPTY_INPUT), narrow);

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("invalid-input");
      expect(response.error.message).toContain("its own manifest's declared schema");
    }
  });

  test("an answer the module's own declared output schema refuses does not reach the caller as an answer", async () => {
    const host = new InProcessHost();
    const loaded = await host.load(join(scratchDir, "pure.rule.ts"), "invoke");
    const pure = ruleEntry("test/pure");
    const narrow: InvokedContribution = {
      ...pure,
      entry: {
        ...pure.entry,
        output: { type: "object", properties: { label: { const: "holds" } }, required: ["label"] },
      },
    };

    const { response } = await host.invoke(loaded, requestFor("test/pure", EMPTY_INPUT), narrow);

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("invalid-output");
      expect(response.error.message).toContain("its own manifest's declared schema");
    }
  });

  test("a gateway whose code touches the platform's module loader fails inside the context with the contribution-threw code", async () => {
    const host = new InProcessHost();
    const loaded = await host.load(join(scratchDir, "touches-the-module-loader.rule.ts"), "invoke");
    const { response } = await host.invoke(
      loaded,
      requestFor("test/touches-the-module-loader", EMPTY_INPUT),
      ruleEntry("test/touches-the-module-loader"),
    );
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("contribution-threw");
    }
  });

  test("a gateway reading the clock fails inside the context with the contribution-threw code", async () => {
    const host = new InProcessHost();
    const loaded = await host.load(join(scratchDir, "reads-the-clock.rule.ts"), "invoke");
    const { response } = await host.invoke(
      loaded,
      requestFor("test/reads-the-clock", EMPTY_INPUT),
      ruleEntry("test/reads-the-clock"),
    );
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("contribution-threw");
      expect(response.error.message).toContain("clock");
    }
  });

  test("a gateway drawing randomness fails inside the context with the contribution-threw code", async () => {
    const host = new InProcessHost();
    const loaded = await host.load(join(scratchDir, "draws-randomness.rule.ts"), "invoke");
    const { response } = await host.invoke(
      loaded,
      requestFor("test/draws-randomness", EMPTY_INPUT),
      ruleEntry("test/draws-randomness"),
    );
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("contribution-threw");
      expect(response.error.message).toContain("randomness");
    }
  });

  test("loading one bundle twice produces two contexts that share nothing: a bundle that writes to its own scope cannot see a prior invocation's write", async () => {
    const host = new InProcessHost();
    const modulePath = join(scratchDir, "writes-to-its-own-scope.rule.ts");
    const firstLoad = await host.load(modulePath, "invoke");
    const secondLoad = await host.load(modulePath, "invoke");

    const first = await host.invoke(
      firstLoad,
      requestFor("test/writes-to-its-own-scope", EMPTY_INPUT),
      ruleEntry("test/writes-to-its-own-scope"),
    );
    const second = await host.invoke(
      secondLoad,
      requestFor("test/writes-to-its-own-scope", EMPTY_INPUT),
      ruleEntry("test/writes-to-its-own-scope"),
    );
    const third = await host.invoke(
      firstLoad,
      requestFor("test/writes-to-its-own-scope", EMPTY_INPUT),
      ruleEntry("test/writes-to-its-own-scope"),
    );

    expect(first.response).toMatchObject({ ok: true, output: { reason: "1" } });
    expect(second.response).toMatchObject({ ok: true, output: { reason: "1" } });
    expect(third.response).toMatchObject({ ok: true, output: { reason: "1" } });
  });

  test("a contribution that throws comes back as a response and not as an exception", async () => {
    const host = new InProcessHost();
    const loaded = await host.load(join(scratchDir, "throws.rule.ts"), "invoke");
    await expect(
      host.invoke(loaded, requestFor("test/throws", EMPTY_INPUT), ruleEntry("test/throws")),
    ).resolves.toMatchObject({
      response: { ok: false, error: { code: "contribution-threw" } },
    });
  });

  test("an invocation whose response fails output validation comes back with the invalid-output code", async () => {
    const host = new InProcessHost();
    const loaded = await host.load(join(scratchDir, "returns-malformed-output.rule.ts"), "invoke");
    const { response } = await host.invoke(
      loaded,
      requestFor("test/returns-malformed-output", EMPTY_INPUT),
      ruleEntry("test/returns-malformed-output"),
    );
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("invalid-output");
    }
  });

  test("the execution bound covers asynchronous work: a gateway whose export awaits an unresolved promise comes back with the time-limit code", async () => {
    const host = new InProcessHost();
    const loaded = await host.load(join(scratchDir, "awaits-forever.rule.ts"), "invoke");
    const { response } = await host.invoke(
      loaded,
      requestFor("test/awaits-forever", EMPTY_INPUT),
      ruleEntry("test/awaits-forever"),
      { timeLimitMs: 100 },
    );
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("time-limit");
    }
  });

  test("a rule input carrying an invocation's answer adds an invoke: read beside dim: and evidence:", async () => {
    const host = new InProcessHost();
    const loaded = await host.load(join(scratchDir, "pure.rule.ts"), "invoke");
    const input = {
      claimId: "claim-a",
      conditions: { severity: "high" },
      evidence: [{ runId: `sha256:${"1".repeat(64)}`, exitCode: 0, output: "" }],
      invocations: [
        {
          need: { kind: "invoke", contribution: "some/contribution", input: {} },
          moduleRecord: `sha256:${"2".repeat(64)}`,
          output: null,
        },
      ],
    };
    const { readLog } = await host.invoke(loaded, requestFor("test/pure", input), ruleEntry("test/pure"));
    expect([...readLog.reads].sort()).toEqual(
      ["dim:severity=high", `evidence:sha256:${"1".repeat(64)}`, `invoke:sha256:${"2".repeat(64)}`].sort(),
    );
  });

  test("a rule input with no invocations reads only its conditions and evidence", async () => {
    const host = new InProcessHost();
    const loaded = await host.load(join(scratchDir, "pure.rule.ts"), "invoke");
    const input = {
      claimId: "claim-a",
      conditions: { severity: "high" },
      evidence: [{ runId: `sha256:${"1".repeat(64)}`, exitCode: 0, output: "" }],
    };
    const { readLog } = await host.invoke(loaded, requestFor("test/pure", input), ruleEntry("test/pure"));
    expect([...readLog.reads].sort()).toEqual(["dim:severity=high", `evidence:sha256:${"1".repeat(64)}`].sort());
  });
});

describe("an invocation that cannot end is an error code, not a hang", () => {
  let scratchDir: string;

  beforeAll(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), "musai-host-limits-"));
    await Promise.all([
      writeFile(join(scratchDir, "loops-forever.rule.ts"), LOOPS_FOREVER_GATEWAY),
      writeFile(join(scratchDir, "allocates-past-a-ceiling.rule.ts"), ALLOCATES_PAST_A_CEILING_GATEWAY),
      writeFile(join(scratchDir, "pure.rule.ts"), PURE_GATEWAY),
    ]);
  });

  test("a gateway that never returns comes back with the time-limit code within the deadline", async () => {
    const host = new InProcessHost();
    const loaded = await host.load(join(scratchDir, "loops-forever.rule.ts"), "invoke");
    const start = Date.now();
    const { response } = await host.invoke(
      loaded,
      requestFor("test/loops-forever", EMPTY_INPUT),
      ruleEntry("test/loops-forever"),
      { timeLimitMs: 200 },
    );
    const elapsed = Date.now() - start;
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("time-limit");
    }
    expect(elapsed).toBeLessThan(5000);
  });

  test("a gateway allocating past a small memory ceiling comes back with the memory-limit code and the test process survives", async () => {
    const host = new InProcessHost();
    const loaded = await host.load(join(scratchDir, "allocates-past-a-ceiling.rule.ts"), "invoke");
    const { response } = await host.invoke(
      loaded,
      requestFor("test/allocates-past-a-ceiling", EMPTY_INPUT),
      ruleEntry("test/allocates-past-a-ceiling"),
      {
        timeLimitMs: 2000,
        memoryLimitMb: 8,
      },
    );
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("memory-limit");
    }
  });

  test.each(["--max-old-space-size=4096", "--max-heap-size=4096"])(
    "a small memory ceiling holds in a process whose shell exports %s",
    async (flag) => {
      const invocation = {
        request: requestFor("test/allocates-past-a-ceiling", EMPTY_INPUT),
        contribution: ruleEntry("test/allocates-past-a-ceiling"),
        limits: { timeLimitMs: 2000, memoryLimitMb: 8 },
      };
      const invoked = await promisify(execFile)(
        process.execPath,
        [
          "--import",
          tsLoader,
          invokeInProcess,
          join(scratchDir, "allocates-past-a-ceiling.rule.ts"),
          JSON.stringify(invocation),
        ],
        { env: { ...process.env, NODE_OPTIONS: flag } },
      );
      const response = JSON.parse(invoked.stdout) as EnvelopeResponse;
      expect(response.ok).toBe(false);
      if (!response.ok) {
        expect(response.error.code).toBe("memory-limit");
      }
    },
  );

  test("after a limit breach, the next invocation of the same module succeeds", async () => {
    const host = new InProcessHost();
    const modulePath = join(scratchDir, "pure.rule.ts");
    const loaded = await host.load(modulePath, "invoke");

    const hungLoaded = await host.load(join(scratchDir, "loops-forever.rule.ts"), "invoke");
    await host.invoke(hungLoaded, requestFor("test/loops-forever", EMPTY_INPUT), ruleEntry("test/loops-forever"), {
      timeLimitMs: 200,
    });

    const { response } = await host.invoke(loaded, requestFor("test/pure", EMPTY_INPUT), ruleEntry("test/pure"));
    expect(response).toEqual({
      ok: true,
      output: { kind: "verdict", label: "open", reason: "claim-a" },
      diagnostics: [],
    });
  });

  test("both limit codes come from the boundary's closed set", async () => {
    const host = new InProcessHost();
    const hungLoaded = await host.load(join(scratchDir, "loops-forever.rule.ts"), "invoke");
    const timeResult = await host.invoke(
      hungLoaded,
      requestFor("test/loops-forever", EMPTY_INPUT),
      ruleEntry("test/loops-forever"),
      { timeLimitMs: 150 },
    );
    const allocatingLoaded = await host.load(join(scratchDir, "allocates-past-a-ceiling.rule.ts"), "invoke");
    const memoryResult = await host.invoke(
      allocatingLoaded,
      requestFor("test/allocates-past-a-ceiling", EMPTY_INPUT),
      ruleEntry("test/allocates-past-a-ceiling"),
      {
        timeLimitMs: 2000,
        memoryLimitMb: 8,
      },
    );

    expect(timeResult.response.ok).toBe(false);
    expect(memoryResult.response.ok).toBe(false);
    if (!timeResult.response.ok && !memoryResult.response.ok) {
      expect(ERROR_CODES).toContain(timeResult.response.error.code);
      expect(ERROR_CODES).toContain(memoryResult.response.error.code);
    }
  });
});

describe("the worker channel: only bytes cross it, in either direction", () => {
  let scratchDir: string;
  let worker: Worker | undefined;

  beforeAll(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), "musai-host-channel-"));
    await writeFile(join(scratchDir, "pure.rule.ts"), PURE_GATEWAY);
  });

  afterEach(async () => {
    await worker?.terminate();
    worker = undefined;
  });

  test("every value the worker sends or receives is a Uint8Array", async () => {
    const workerUrl = fileURLToPath(new URL("../src/rule/sandbox-worker.ts", import.meta.url));
    worker = new Worker(workerUrl, {
      workerData: {
        source: PURE_GATEWAY,
        exportName: "invoke",
        modulePath: join(scratchDir, "pure.rule.ts"),
        timeLimitMs: 2000,
      },
    });
    const sent = encodeRequest(requestFor("test/pure", EMPTY_INPUT));
    expect(sent).toBeInstanceOf(Uint8Array);

    const received = await new Promise<unknown>((resolve, reject) => {
      worker!.once("message", resolve);
      worker!.once("error", reject);
      worker!.postMessage(sent);
    });
    expect(received).toBeInstanceOf(Uint8Array);
  });
});

interface RunningHost {
  readonly name: string;
  readonly host: ModuleHost;
}

/** Every host this machine can run, each skipped one logged by name; since two rows are always
 * available, a run that skipped every host fails. */
async function everyAvailableHost(): Promise<readonly RunningHost[]> {
  const running: RunningHost[] = [];
  for (const descriptor of HOSTS) {
    if (await descriptor.available()) {
      running.push({ name: descriptor.name, host: descriptor.create() });
    } else {
      process.stdout.write(
        `host: skipped ${descriptor.name} — this machine does not provide what this host needs to run\n`,
      );
    }
  }
  expect(new Set(running.map((entry) => entry.host.constructor)).size).toBeGreaterThanOrEqual(2);
  return running;
}

describe("a module's source runs strict on every host, as its bundle does", () => {
  let scratchDir: string;

  beforeAll(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), "musai-host-strict-"));
    await Promise.all([
      writeFile(join(scratchDir, "assigns-an-undeclared-name.rule.ts"), ASSIGNS_AN_UNDECLARED_NAME_GATEWAY),
      writeFile(join(scratchDir, "reads-its-own-position.rule.ts"), READS_ITS_OWN_POSITION_GATEWAY),
      writeFile(join(scratchDir, "repeats-a-parameter.rule.ts"), REPEATS_A_PARAMETER_GATEWAY),
      writeFile(join(scratchDir, "starts-with-a-hashbang.rule.ts"), STARTS_WITH_A_HASHBANG_GATEWAY),
    ]);
  });

  test("refuses a module that assigns to an undeclared name, on every host", async () => {
    const modulePath = join(scratchDir, "assigns-an-undeclared-name.rule.ts");
    for (const { name, host } of await everyAvailableHost()) {
      try {
        const loaded = await host.load(modulePath, "invoke");
        const { response } = await host.invoke(
          loaded,
          requestFor("test/assigns-an-undeclared-name", EMPTY_INPUT),
          ruleEntry("test/assigns-an-undeclared-name"),
        );
        expect.soft(response, name).toMatchObject({ ok: false, error: { code: "contribution-threw" } });
        if (!response.ok) {
          expect.soft(response.error.message, name).toContain("undeclaredTotal");
        }
      } finally {
        await host.close?.();
      }
    }
  });

  test("a module reads its own position at the line its source puts it, on every host", async () => {
    const modulePath = join(scratchDir, "reads-its-own-position.rule.ts");
    const line = READS_ITS_OWN_POSITION_GATEWAY.split("\n").indexOf(READS_ITS_OWN_POSITION_STATEMENT) + 1;
    expect(line, "the statement's line in the source written").toBeGreaterThan(0);
    for (const { name, host } of await everyAvailableHost()) {
      try {
        const loaded = await host.load(modulePath, "invoke");
        const { response } = await host.invoke(
          loaded,
          requestFor("test/reads-its-own-position", EMPTY_INPUT),
          ruleEntry("test/reads-its-own-position"),
        );
        expect.soft(response.ok, name).toBe(true);
        if (response.ok) {
          expect
            .soft((response.output as { readonly reason: string }).reason, name)
            .toContain(`${modulePath}:${line}:`);
        }
      } finally {
        await host.close?.();
      }
    }
  });

  test("a module whose source starts with a hashbang loads and answers, its lines where its source puts them, on every host", async () => {
    const modulePath = join(scratchDir, "starts-with-a-hashbang.rule.ts");
    const line = STARTS_WITH_A_HASHBANG_GATEWAY.split("\n").indexOf(READS_ITS_OWN_POSITION_STATEMENT) + 1;
    expect(line, "the statement's line in the source written").toBeGreaterThan(1);
    for (const { name, host } of await everyAvailableHost()) {
      try {
        const response = await host.load(modulePath, "invoke").then(
          async (loaded) =>
            (
              await host.invoke(
                loaded,
                requestFor("test/starts-with-a-hashbang", EMPTY_INPUT),
                ruleEntry("test/starts-with-a-hashbang"),
              )
            ).response,
          (error: unknown) => ({ ok: false as const, refusedAtLoad: String(error) }),
        );
        expect.soft(response, name).toMatchObject({ ok: true });
        if (response.ok) {
          expect
            .soft((response.output as { readonly reason: string }).reason, name)
            .toContain(`${modulePath}:${line}:`);
        }
      } finally {
        await host.close?.();
      }
    }
  });

  test("the in-process host refuses at load a module whose source is not strict-mode syntax", async () => {
    const host = new InProcessHost();
    const refusal = await host.load(join(scratchDir, "repeats-a-parameter.rule.ts"), "invoke").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(SyntaxError);
    expect((refusal as SyntaxError).message).toMatch(/Duplicate parameter name/);
  });
});
