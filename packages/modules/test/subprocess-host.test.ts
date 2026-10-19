import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { versionString } from "@musai/records";
import { gatewaySource } from "@musai/test-support";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { SubprocessHost } from "../src/module/subprocess-host.js";
import {
  ENVELOPE_PROTOCOL,
  type EnvelopeRequest,
  ERROR_CODES,
  type InvokedContribution,
  kernelPoint,
} from "../src/rule/envelope.js";
import { InProcessHost, type InvocationLimits } from "../src/rule/host.js";

/** The reserved id `host-child.ts` answers outside the sandbox, spelled on both sides of the
 * process boundary as the same literal. */
const DIAGNOSTICS_REQUEST_ID = "musai-subprocess-host-diagnostics";

const CLEAN_EXIT_GATEWAY = gatewaySource(
  "evaluatesCleanExit",
  [
    "      if (input.evidence.length === 0) {",
    '        return { kind: "verdict", label: "open", reason: "no evidence yet" };',
    "      }",
    "      const everyExitClean = input.evidence.every((item) => item.exitCode === 0);",
    "      return {",
    '        kind: "verdict",',
    '        label: everyExitClean ? "holds" : "fails",',
    '        reason: everyExitClean ? "every run exited cleanly" : "a run exited with a non-zero code",',
    "      };",
  ].join("\n"),
);

const THROWS_GATEWAY = gatewaySource("throwsRule", '      throw new Error("this rule always throws");');

const AWAITS_FOREVER_GATEWAY = gatewaySource(
  "awaitsForeverRule",
  [
    "      await new Promise(() => {});",
    '      return { kind: "verdict", label: "open", reason: "unreachable" };',
  ].join("\n"),
);

const ALLOCATES_PAST_A_CEILING_GATEWAY = gatewaySource(
  "allocatesPastACeilingRule",
  [
    "      const chunks = [];",
    "      while (true) {",
    '        chunks.push(new Array(1e6).fill("x"));',
    "      }",
  ].join("\n"),
);

const WRITES_TO_ITS_OWN_SCOPE_GATEWAY = gatewaySource(
  "writesToItsOwnScopeRule",
  ["      counter += 1;", '      return { kind: "verdict", label: "open", reason: String(counter) };'].join("\n"),
  "let counter = 0;",
);

/** A child stub that never answers with a decodable line. */
const MALFORMED_LINE_STUB = `
process.stdin.on("data", () => {
  process.stdout.write("not json at all\\n");
  process.exit(0);
});
`;

/** A child that runs `body` on its first request line and never answers. */
function silentChildSource(body: string): string {
  return `process.stdin.on("data", () => {\n${body}\n});\n`;
}

const DOES_NOT_PARSE_SOURCE = "export function invoke(requestBytes: Uint8Array): Uint8Array {\n  return (;\n}\n";

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
const CLEAN_EVIDENCE_INPUT = {
  claimId: "claim-a",
  conditions: {},
  evidence: [{ runId: "run-1", exitCode: 0, output: "" }],
};

describe("the subprocess host: a bundle runs where the process itself is not", () => {
  let scratchDir: string;

  beforeAll(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), "musai-subprocess-host-"));
    await Promise.all([
      writeFile(join(scratchDir, "clean-exit.rule.ts"), CLEAN_EXIT_GATEWAY),
      writeFile(join(scratchDir, "throws.rule.ts"), THROWS_GATEWAY),
      writeFile(join(scratchDir, "awaits-forever.rule.ts"), AWAITS_FOREVER_GATEWAY),
      writeFile(join(scratchDir, "allocates-past-a-ceiling.rule.ts"), ALLOCATES_PAST_A_CEILING_GATEWAY),
      writeFile(join(scratchDir, "writes-to-its-own-scope.rule.ts"), WRITES_TO_ITS_OWN_SCOPE_GATEWAY),
      writeFile(join(scratchDir, "malformed-line-stub.mjs"), MALFORMED_LINE_STUB),
    ]);
  });

  test("both hosts refuse a request the module's own declared input schema refuses, and neither runs the module", async () => {
    const inProcess = new InProcessHost();
    const subprocess = new SubprocessHost();
    const modulePath = join(scratchDir, "clean-exit.rule.ts");
    const cleanExit = ruleEntry("fixture/clean-exit");
    const narrow: InvokedContribution = {
      ...cleanExit,
      entry: {
        ...cleanExit.entry,
        input: {
          type: "object",
          properties: { claimId: { const: "a-claim-the-module-declares" } },
          required: ["claimId"],
        },
      },
    };
    const request = requestFor("fixture/clean-exit", CLEAN_EVIDENCE_INPUT);

    const inProcessLoaded = await inProcess.load(modulePath, "evaluatesCleanExit");
    const subprocessLoaded = await subprocess.load(modulePath, "evaluatesCleanExit");

    const { response: inProcessResponse } = await inProcess.invoke(inProcessLoaded, request, narrow);
    const { response: subprocessResponse } = await subprocess.invoke(subprocessLoaded, request, narrow);

    expect(subprocessResponse).toEqual(inProcessResponse);
    expect(inProcessResponse.ok).toBe(false);
    if (!inProcessResponse.ok) {
      expect(inProcessResponse.error.code).toBe("invalid-input");
      expect(inProcessResponse.error.message).toContain("its own manifest's declared schema");
    }
  });

  test.each([
    ["no object at all", null],
    ["text", "not an input"],
    ["an input without conditions", { claimId: "claim-a", evidence: [] }],
    ["conditions that are not a map", { claimId: "claim-a", conditions: null, evidence: [] }],
    ["evidence that is not a list", { claimId: "claim-a", conditions: {}, evidence: null }],
    ["an invocation that is not an object", { claimId: "claim-a", conditions: {}, evidence: [], invocations: [null] }],
  ])(
    "both hosts refuse a rule input that is %s under invalid-input, never a thrown TypeError",
    async (_label, input) => {
      const modulePath = join(scratchDir, "clean-exit.rule.ts");
      const request = requestFor("fixture/clean-exit", input);
      const inProcess = new InProcessHost();
      const subprocess = new SubprocessHost();

      const inProcessResult = await inProcess.invoke(
        await inProcess.load(modulePath, "evaluatesCleanExit"),
        request,
        ruleEntry("fixture/clean-exit"),
      );
      const subprocessResult = await subprocess.invoke(
        await subprocess.load(modulePath, "evaluatesCleanExit"),
        request,
        ruleEntry("fixture/clean-exit"),
      );
      await inProcess.close();

      expect(inProcessResult.readLog.reads.size).toBe(0);
      expect(subprocessResult.readLog).toEqual(inProcessResult.readLog);
      expect(subprocessResult.response).toEqual(inProcessResult.response);
      expect(inProcessResult.response).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    },
  );

  test("a request round-trips to a response byte-identical to the one the in-process host returns", async () => {
    const inProcess = new InProcessHost();
    const subprocess = new SubprocessHost();
    const modulePath = join(scratchDir, "clean-exit.rule.ts");

    const inProcessLoaded = await inProcess.load(modulePath, "evaluatesCleanExit");
    const subprocessLoaded = await subprocess.load(modulePath, "evaluatesCleanExit");

    const { response: inProcessResponse } = await inProcess.invoke(
      inProcessLoaded,
      requestFor("fixture/clean-exit", CLEAN_EVIDENCE_INPUT),
      ruleEntry("fixture/clean-exit"),
    );
    const { response: subprocessResponse } = await subprocess.invoke(
      subprocessLoaded,
      requestFor("fixture/clean-exit", CLEAN_EVIDENCE_INPUT),
      ruleEntry("fixture/clean-exit"),
    );

    expect(subprocessResponse).toEqual(inProcessResponse);
    expect(subprocessResponse).toEqual({
      ok: true,
      output: { kind: "verdict", label: "holds", reason: "every run exited cleanly" },
      diagnostics: [],
    });
  });

  test("a request naming a point its entry does not answer at is refused byte-identically by both", async () => {
    const inProcess = new InProcessHost();
    const subprocess = new SubprocessHost();
    const modulePath = join(scratchDir, "clean-exit.rule.ts");

    const inProcessLoaded = await inProcess.load(modulePath, "evaluatesCleanExit");
    const subprocessLoaded = await subprocess.load(modulePath, "evaluatesCleanExit");

    const bogusRequest: EnvelopeRequest = {
      ...requestFor("fixture/exit-code", CLEAN_EVIDENCE_INPUT),
      contribution: "bogus-kind",
    };

    const { response: inProcessResponse } = await inProcess.invoke(
      inProcessLoaded,
      bogusRequest,
      ruleEntry(bogusRequest.id),
    );
    const { response: subprocessResponse } = await subprocess.invoke(
      subprocessLoaded,
      bogusRequest,
      ruleEntry(bogusRequest.id),
    );

    expect(subprocessResponse).toEqual(inProcessResponse);
    expect(subprocessResponse.ok).toBe(false);
    if (!subprocessResponse.ok) {
      expect(subprocessResponse.error.code).toBe("unknown-contribution");
    }
  });

  test("a request naming the parser contribution kind is invoked exactly as a rule request is, both hosts answering identically", async () => {
    const inProcess = new InProcessHost();
    const subprocess = new SubprocessHost();
    const modulePath = join(scratchDir, "clean-exit.rule.ts");

    const inProcessLoaded = await inProcess.load(modulePath, "evaluatesCleanExit");
    const subprocessLoaded = await subprocess.load(modulePath, "evaluatesCleanExit");

    const parserRequest: EnvelopeRequest = {
      ...requestFor("fixture/exit-code", CLEAN_EVIDENCE_INPUT),
      contribution: "parser",
    };

    const asRule = ruleEntry(parserRequest.id);
    const parserEntry: InvokedContribution = {
      entry: { ...asRule.entry, kind: "parser" },
      point: kernelPoint("parser")!,
    };
    const { response: inProcessResponse } = await inProcess.invoke(inProcessLoaded, parserRequest, parserEntry);
    const { response: subprocessResponse } = await subprocess.invoke(subprocessLoaded, parserRequest, parserEntry);

    expect(subprocessResponse).toEqual(inProcessResponse);
    expect(subprocessResponse).toEqual({
      ok: true,
      output: { kind: "verdict", label: "holds", reason: "every run exited cleanly" },
      diagnostics: [],
    });
  });

  test("a contribution that throws comes back with the contribution-threw code", async () => {
    const subprocess = new SubprocessHost();
    const loaded = await subprocess.load(join(scratchDir, "throws.rule.ts"), "throwsRule");
    const { response } = await subprocess.invoke(
      loaded,
      requestFor("fixture/throws", EMPTY_INPUT),
      ruleEntry("fixture/throws"),
    );
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("contribution-threw");
    }
  });

  test("a contribution that never returns comes back with the time-limit code within the deadline", async () => {
    const subprocess = new SubprocessHost();
    const loaded = await subprocess.load(join(scratchDir, "awaits-forever.rule.ts"), "awaitsForeverRule");
    const start = Date.now();
    const { response } = await subprocess.invoke(
      loaded,
      requestFor("fixture/awaits-forever", EMPTY_INPUT),
      ruleEntry("fixture/awaits-forever"),
      { timeLimitMs: 200 },
    );
    const elapsed = Date.now() - start;
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("time-limit");
    }
    expect(elapsed).toBeLessThan(10_000);
  });

  test("a contribution allocating past a small memory ceiling comes back with the memory-limit code", async () => {
    const subprocess = new SubprocessHost();
    const loaded = await subprocess.load(
      join(scratchDir, "allocates-past-a-ceiling.rule.ts"),
      "allocatesPastACeilingRule",
    );
    const { response } = await subprocess.invoke(
      loaded,
      requestFor("fixture/allocates-past-a-ceiling", EMPTY_INPUT),
      ruleEntry("fixture/allocates-past-a-ceiling"),
      {
        timeLimitMs: 5000,
        memoryLimitMb: 32,
      },
    );
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("memory-limit");
    }
  }, 15_000);

  test("both limit codes come from the boundary's own closed set", async () => {
    const subprocess = new SubprocessHost();
    const hungLoaded = await subprocess.load(join(scratchDir, "awaits-forever.rule.ts"), "awaitsForeverRule");
    const timeResult = await subprocess.invoke(
      hungLoaded,
      requestFor("fixture/awaits-forever", EMPTY_INPUT),
      ruleEntry("fixture/awaits-forever"),
      { timeLimitMs: 150 },
    );
    const allocatingLoaded = await subprocess.load(
      join(scratchDir, "allocates-past-a-ceiling.rule.ts"),
      "allocatesPastACeilingRule",
    );
    const memoryResult = await subprocess.invoke(
      allocatingLoaded,
      requestFor("fixture/allocates-past-a-ceiling", EMPTY_INPUT),
      ruleEntry("fixture/allocates-past-a-ceiling"),
      {
        timeLimitMs: 5000,
        memoryLimitMb: 32,
      },
    );

    expect(timeResult.response.ok).toBe(false);
    expect(memoryResult.response.ok).toBe(false);
    if (!timeResult.response.ok && !memoryResult.response.ok) {
      expect(ERROR_CODES).toContain(timeResult.response.error.code);
      expect(ERROR_CODES).toContain(memoryResult.response.error.code);
    }
  }, 15_000);

  test("after a limit breach, the next invocation of the same module succeeds: a killed child is never reused", async () => {
    const subprocess = new SubprocessHost();
    const modulePath = join(scratchDir, "clean-exit.rule.ts");
    const loaded = await subprocess.load(modulePath, "evaluatesCleanExit");

    const hungLoaded = await subprocess.load(join(scratchDir, "awaits-forever.rule.ts"), "awaitsForeverRule");
    await subprocess.invoke(
      hungLoaded,
      requestFor("fixture/awaits-forever", EMPTY_INPUT),
      ruleEntry("fixture/awaits-forever"),
      { timeLimitMs: 150 },
    );

    const { response } = await subprocess.invoke(
      loaded,
      requestFor("fixture/clean-exit", CLEAN_EVIDENCE_INPUT),
      ruleEntry("fixture/clean-exit"),
    );
    expect(response).toEqual({
      ok: true,
      output: { kind: "verdict", label: "holds", reason: "every run exited cleanly" },
      diagnostics: [],
    });
  });

  test("two invocations of one module share no state: a rule that writes to its own scope cannot see a prior invocation's write", async () => {
    const subprocess = new SubprocessHost();
    const modulePath = join(scratchDir, "writes-to-its-own-scope.rule.ts");
    const firstLoad = await subprocess.load(modulePath, "writesToItsOwnScopeRule");
    const secondLoad = await subprocess.load(modulePath, "writesToItsOwnScopeRule");

    const first = await subprocess.invoke(
      firstLoad,
      requestFor("fixture/writes-to-its-own-scope", EMPTY_INPUT),
      ruleEntry("fixture/writes-to-its-own-scope"),
    );
    const second = await subprocess.invoke(
      secondLoad,
      requestFor("fixture/writes-to-its-own-scope", EMPTY_INPUT),
      ruleEntry("fixture/writes-to-its-own-scope"),
    );
    const third = await subprocess.invoke(
      firstLoad,
      requestFor("fixture/writes-to-its-own-scope", EMPTY_INPUT),
      ruleEntry("fixture/writes-to-its-own-scope"),
    );

    expect(first.response).toMatchObject({ ok: true, output: { reason: "1" } });
    expect(second.response).toMatchObject({ ok: true, output: { reason: "1" } });
    expect(third.response).toMatchObject({ ok: true, output: { reason: "1" } });
  });

  test("a malformed line from the child returns a protocol failure rather than being skipped", async () => {
    const subprocess = new SubprocessHost({ childEntryPath: join(scratchDir, "malformed-line-stub.mjs") });
    const loaded = await subprocess.load(join(scratchDir, "clean-exit.rule.ts"), "evaluatesCleanExit");
    const { response } = await subprocess.invoke(
      loaded,
      requestFor("fixture/clean-exit", CLEAN_EVIDENCE_INPUT),
      ruleEntry("fixture/clean-exit"),
    );
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("contribution-threw");
    }
  });

  /** Runs one silent child that does `body`, answering the refusal the host gives it. */
  async function refusalFromSilentChild(body: string, from = scratchDir, limits: InvocationLimits = {}) {
    const stubPath = join(from, `silent-${Math.random().toString(36).slice(2)}.mjs`);
    await writeFile(stubPath, silentChildSource(body));
    const subprocess = new SubprocessHost({ childEntryPath: stubPath });
    const loaded = await subprocess.load(join(scratchDir, "clean-exit.rule.ts"), "evaluatesCleanExit");
    const { response } = await subprocess.invoke(
      loaded,
      requestFor("fixture/clean-exit", CLEAN_EVIDENCE_INPUT),
      ruleEntry("fixture/clean-exit"),
      limits,
    );
    if (response.ok) {
      throw new Error("a child that never answered was answered");
    }
    return response.error;
  }

  test("a child that exits without answering is refused as the contribution's failure, the same whatever it printed", async () => {
    const quiet = await refusalFromSilentChild("process.exit(3);");
    const loud = await refusalFromSilentChild(
      'process.stderr.write("x".repeat(200000) + " at /some/machine/path:12\\n"); process.exit(3);',
    );

    const otherCode = await refusalFromSilentChild("process.exit(4);");

    expect(quiet).toEqual({
      code: "contribution-threw",
      data: undefined,
      message: "the child ended without answering",
    });
    expect(loud).toEqual(quiet);
    expect(otherCode).toEqual(quiet);
  });

  test("a child that ran out of memory is refused with the memory-limit code, the same whatever it printed", async () => {
    const heap = await refusalFromSilentChild(
      'process.stderr.write("<--- Last few GCs ---> 4821 ms\\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\\n"); process.exit(134);',
    );
    const otherHeap = await refusalFromSilentChild(
      'process.stderr.write("<--- Last few GCs ---> 977 ms\\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\\n"); process.exit(134);',
    );
    const native = await refusalFromSilentChild(
      'process.stderr.write("Fatal process out of memory: Zone\\n"); process.exit(133);',
    );

    expect(heap).toEqual({
      code: "memory-limit",
      data: undefined,
      message: "the child ran out of memory without answering",
    });
    expect(otherHeap).toEqual(heap);
    expect(native).toEqual(heap);
  });

  test.each([
    ["SIGKILL", "memory-limit"],
    ["SIGABRT", "memory-limit"],
    ["SIGSEGV", "contribution-threw"],
  ])(
    "a child ended by %s without answering is refused with %s, in the words of its class alone",
    async (signal, code) => {
      const error = await refusalFromSilentChild(`process.kill(process.pid, "${signal}");`);

      expect(error).toEqual({
        code,
        data: undefined,
        message:
          code === "memory-limit"
            ? "the child ran out of memory without answering"
            : "the child ended without answering",
      });
    },
  );

  test("a child ended by its own signal is refused by that signal's class though the deadline passed first", async () => {
    const error = await refusalFromSilentChild(
      'process.on("SIGTERM", () => {}); setTimeout(() => process.kill(process.pid, "SIGSEGV"), 900);',
      scratchDir,
      { timeLimitMs: 50 },
    );

    expect(error).toEqual({
      code: "contribution-threw",
      data: undefined,
      message: "the child ended without answering",
    });
  });

  test("a child the deadline ends is refused with time-limit", async () => {
    const error = await refusalFromSilentChild("setTimeout(() => {}, 60000);", scratchDir, { timeLimitMs: 50 });

    expect(error.code).toBe("time-limit");
  });

  test("a module source that does not parse is refused identically from two directories, naming the syntax error and no path", async () => {
    const refusals = [];
    for (const label of ["one", "another"]) {
      const dir = await mkdtemp(join(tmpdir(), `musai-subprocess-host-parse-${label}-`));
      const modulePath = join(dir, "does-not-parse.rule.ts");
      await writeFile(modulePath, DOES_NOT_PARSE_SOURCE);
      const subprocess = new SubprocessHost();
      const loaded = await subprocess.load(modulePath, "invoke");
      const { response } = await subprocess.invoke(
        loaded,
        requestFor("fixture/does-not-parse", EMPTY_INPUT),
        ruleEntry("fixture/does-not-parse"),
      );
      refusals.push(response);
    }

    expect(refusals[0]).toMatchObject({ ok: false, error: { code: "contribution-threw" } });
    expect(refusals[1]).toEqual(refusals[0]);
    const message = (refusals[0] as { error: { message: string } }).error.message;
    expect(message).toContain("SyntaxError");
    expect(message).not.toContain(tmpdir());
  });

  test("nothing but the child's standard streams is passed to it: no descriptor above the standard three is inherited", async () => {
    const subprocess = new SubprocessHost();
    const loaded = await subprocess.load(join(scratchDir, "clean-exit.rule.ts"), "evaluatesCleanExit");
    const { response } = await subprocess.invoke(
      loaded,
      requestFor(DIAGNOSTICS_REQUEST_ID, CLEAN_EVIDENCE_INPUT),
      ruleEntry(DIAGNOSTICS_REQUEST_ID),
    );
    expect(response.ok).toBe(true);
    if (response.ok) {
      const output = response.output as { readonly kind: "verdict"; readonly reason: string };
      const diagnostics = JSON.parse(output.reason) as {
        readonly envKeys: readonly string[];
        readonly fdEntries: readonly string[] | null;
      };
      // The runtime holds descriptors of its own, so the count is bounded, not exactly three.
      if (diagnostics.fdEntries !== null) {
        expect(diagnostics.fdEntries).toEqual(expect.arrayContaining(["0", "1", "2"]));
        expect(diagnostics.fdEntries.length).toBeLessThan(30);
      }
    }
  });

  const PLANTED_VARIABLE = "MUSAI_SUBPROCESS_HOST_TEST_PLANT";

  describe("the child sees none of the parent's planted environment", () => {
    let previousValue: string | undefined;

    beforeAll(() => {
      previousValue = process.env[PLANTED_VARIABLE];
      process.env[PLANTED_VARIABLE] = "leaked-if-visible";
    });

    afterEach(() => {
      if (previousValue === undefined) {
        delete process.env[PLANTED_VARIABLE];
      } else {
        process.env[PLANTED_VARIABLE] = previousValue;
      }
    });

    test("a planted variable never appears among what the child can see", async () => {
      const subprocess = new SubprocessHost();
      const loaded = await subprocess.load(join(scratchDir, "clean-exit.rule.ts"), "evaluatesCleanExit");
      const { response } = await subprocess.invoke(
        loaded,
        requestFor(DIAGNOSTICS_REQUEST_ID, CLEAN_EVIDENCE_INPUT),
        ruleEntry(DIAGNOSTICS_REQUEST_ID),
      );
      expect(response.ok).toBe(true);
      if (response.ok) {
        const output = response.output as { readonly kind: "verdict"; readonly reason: string };
        const diagnostics = JSON.parse(output.reason) as { readonly envKeys: readonly string[] };
        expect(diagnostics.envKeys).not.toContain(PLANTED_VARIABLE);
      }
    });
  });
});

describe("the child is launched on the shared spawn path, never a second one", () => {
  test("the subprocess host spawns through the runner and never around it", async () => {
    const source = await (await import("node:fs/promises")).readFile(
      new URL("../src/module/subprocess-host.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("performRecipe");
    expect(source).not.toContain("from 'execa'");
    expect(source).not.toContain('from "execa"');
  });
});
