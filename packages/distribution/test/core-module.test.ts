import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildModule, runModuleTests } from "@musai/devkit";
import { runRestartLoop } from "@musai/evaluate";
import { IndexDb } from "@musai/fold";
import {
  ENVELOPE_PROTOCOL,
  type EnvelopeRequest,
  InProcessHost,
  type InvokedContribution,
  invokerFromModuleHost,
  kernelPoint,
} from "@musai/modules";
import { CURRENT_SCHEMA_VERSIONS, type ModuleRecord, recordId, validateRecord, versionString } from "@musai/records";
import { initWorkspace, Store } from "@musai/store";
import { blobStoreOf, fixedClock, foldedIndex } from "@musai/test-support";
import { afterEach, describe, expect, test } from "vitest";
import { repoGitDir } from "./repo-git-dir.js";

const MODULE_DIR = fileURLToPath(new URL("../../core-module/", import.meta.url));
const MODULE_PATH = fileURLToPath(new URL("../../core-module/module.ts", import.meta.url));
const DECLARATIVE_ID = "musai.core/declarative";

const FIXED_NOW = fixedClock("2026-08-30T00:00:00.000Z");

/** The entry an exchange is checked against, taken from the request; declared shapes are checked
 * where the manifest is derived. */
function entryFor(request: Pick<EnvelopeRequest, "contribution" | "id" | "version">): InvokedContribution {
  return {
    entry: {
      kind: request.contribution,
      id: request.id,
      version: request.version,
      input: true,
      output: true,
      documentation: "",
    },
    point: kernelPoint(request.contribution)!,
  };
}

/** The condition the interpreter reads its canonical parameters from. */
const PARAMETERS_CONDITION = "musai.core/declarative";

describe("the core module's own suite, driven through the fixture runner", () => {
  test("every fixture case passes under every host this machine can run a module through, and their replay agrees", async () => {
    const report = await runModuleTests(MODULE_DIR, { now: FIXED_NOW });
    const unexpected = report.results.filter((result) => result.status === "fail");
    expect(unexpected, JSON.stringify(unexpected, null, 2)).toEqual([]);
    expect(report.ok).toBe(true);
    // Each fixture runs through every host as a subprocess, which the default budget does not fit.
  }, 60_000);
});

describe("the derived manifest declares every parser this file contributes", () => {
  const scratchDirs: string[] = [];

  afterEach(async () => {
    for (const dir of scratchDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the manifest built from this module's own source names five parsers, each namespaced under musai.core", async () => {
    const dir = await mkdtemp(join(tmpdir(), "musai-core-module-build-"));
    scratchDirs.push(dir);
    const { gitDir } = await initWorkspace(dir, { now: FIXED_NOW });
    const store = new Store({ ctx: { gitDir }, scope: "build", now: FIXED_NOW });
    const index = await foldedIndex(store);
    const sourceGitDir = await repoGitDir();

    const result = await buildModule(MODULE_DIR, store, {
      blobs: blobStoreOf(dir),
      index,
      sourceGitDir,
      now: FIXED_NOW,
    });
    const moduleRecord = (await store.read(result.moduleRecordId, "module")) as {
      manifest: {
        contributions: readonly { kind: string; id: string; input: { properties?: Record<string, unknown> } }[];
      };
    };

    const parsers = moduleRecord.manifest.contributions.filter((entry) => entry.kind === "parser");
    for (const entry of parsers) {
      const properties = Object.keys(entry.input.properties ?? {});
      expect(properties).not.toContain("recipe");
      expect(properties).not.toContain("substrate");
      expect(properties).not.toContain("path");
    }
    expect(parsers.map((entry) => entry.id).sort()).toEqual(
      [
        "musai.core/exit-code",
        "musai.core/line-range",
        "musai.core/pointer",
        "musai.core/test-report",
        "musai.core/whole-run",
      ].sort(),
    );
    for (const entry of moduleRecord.manifest.contributions) {
      expect(entry.id.startsWith("musai.core/")).toBe(true);
    }
  });

  test("the same manifest names eight slots and three presets, each namespaced under musai.core", async () => {
    const dir = await mkdtemp(join(tmpdir(), "musai-core-module-build-"));
    scratchDirs.push(dir);
    const { gitDir } = await initWorkspace(dir, { now: FIXED_NOW });
    const store = new Store({ ctx: { gitDir }, scope: "build", now: FIXED_NOW });
    const index = await foldedIndex(store);
    const sourceGitDir = await repoGitDir();

    const result = await buildModule(MODULE_DIR, store, {
      blobs: blobStoreOf(dir),
      index,
      sourceGitDir,
      now: FIXED_NOW,
    });
    const moduleRecord = (await store.read(result.moduleRecordId, "module")) as {
      manifest: { contributions: readonly { kind: string; id: string }[] };
    };

    const slots = moduleRecord.manifest.contributions.filter((entry) => entry.kind === "slot");
    expect(slots.map((entry) => entry.id).sort()).toEqual(
      [
        "musai.core/brief-budget",
        "musai.core/invocation-limits",
        "musai.core/isolation-policy",
        "musai.core/need-concurrency",
        "musai.core/pack-irreversible",
        "musai.core/resolution-age",
        "musai.core/signing-level",
        "musai.core/staleness-policy",
      ].sort(),
    );

    const presets = moduleRecord.manifest.contributions.filter((entry) => entry.kind === "preset");
    expect(presets.map((entry) => entry.id).sort()).toEqual(
      ["musai.core/bare", "musai.core/ci", "musai.core/interactive"].sort(),
    );
  });

  test("the same manifest names four requirements, each naming its own binary and an install line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "musai-core-module-build-"));
    scratchDirs.push(dir);
    const { gitDir } = await initWorkspace(dir, { now: FIXED_NOW });
    const store = new Store({ ctx: { gitDir }, scope: "build", now: FIXED_NOW });
    const index = await foldedIndex(store);
    const sourceGitDir = await repoGitDir();

    const result = await buildModule(MODULE_DIR, store, {
      blobs: blobStoreOf(dir),
      index,
      sourceGitDir,
      now: FIXED_NOW,
    });
    const moduleRecord = (await store.read(result.moduleRecordId, "module")) as {
      manifest: {
        contributions: readonly { kind: string; id: string; input: { binary?: string; install?: string } }[];
      };
    };

    const requirements = moduleRecord.manifest.contributions.filter((entry) => entry.kind === "requirement");
    expect(requirements.map((entry) => entry.id).sort()).toEqual(
      ["musai.core/git", "musai.core/ssh-keygen", "musai.core/node", "musai.core/docker"].sort(),
    );
    for (const entry of requirements) {
      expect(typeof entry.input.binary).toBe("string");
      expect(typeof entry.input.install).toBe("string");
    }
  });
});

describe("the line-range parser reads the same lines regardless of line-ending convention", () => {
  test("an LF-joined output and a CRLF-joined output of the same lines select the same ranges", async () => {
    const host = new InProcessHost();
    const loaded = await host.load(MODULE_PATH, "invoke");
    const request = (output: string) => ({
      protocol: ENVELOPE_PROTOCOL,
      contribution: "parser" as const,
      id: "musai.core/line-range",
      version: versionString("1"),
      input: { output, exitCode: 0 },
    });
    const lfRequest = request("first\nsecond\nthird");
    const crlfRequest = request("first\r\nsecond\r\nthird");
    const lf = await host.invoke(loaded, lfRequest, entryFor(lfRequest));
    const crlf = await host.invoke(loaded, crlfRequest, entryFor(crlfRequest));
    expect(lf.response).toEqual(crlf.response);
    expect(lf.response.ok && lf.response.output).toMatchObject({ "1-3": "first\nsecond\nthird" });
  });
});

describe("the pointer parser refuses what it cannot answer, each by name", () => {
  test("an output that does not parse as JSON comes back as a thrown contribution, never an empty map", async () => {
    const host = new InProcessHost();
    const loaded = await host.load(MODULE_PATH, "invoke");
    const inlineRequest = {
      protocol: ENVELOPE_PROTOCOL,
      contribution: "parser" as const,
      id: "musai.core/pointer",
      version: versionString("1"),
      input: { output: "not json at all", exitCode: 0 },
    };
    const { response } = await host.invoke(loaded, inlineRequest, entryFor(inlineRequest));
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("contribution-threw");
      expect(response.error.message).toContain("could not parse");
    }
  });

  test("a pointer path the document does not hold is simply a key this parser never produced", async () => {
    const host = new InProcessHost();
    const loaded = await host.load(MODULE_PATH, "invoke");
    const inlineRequest = {
      protocol: ENVELOPE_PROTOCOL,
      contribution: "parser" as const,
      id: "musai.core/pointer",
      version: versionString("1"),
      input: { output: JSON.stringify({ data: { status: "ok" } }), exitCode: 0 },
    };
    const { response } = await host.invoke(loaded, inlineRequest, entryFor(inlineRequest));
    expect(response.ok).toBe(true);
    if (response.ok) {
      const map = response.output as Record<string, unknown>;
      expect(Object.hasOwn(map, "/data/missing")).toBe(false);
    }
  });
});

function declarativeConditions(parameters: unknown): Record<string, string> {
  return { [PARAMETERS_CONDITION]: JSON.stringify(parameters) };
}

describe("the declarative interpreter uses the ordinary restart path and nothing else", () => {
  test("its first round returns needs and its second returns a verdict, asserted by counting invocations", async () => {
    const host = new InProcessHost();
    const loaded = await host.load(MODULE_PATH, "invoke");
    const invoker = invokerFromModuleHost(host, loaded, {
      id: DECLARATIVE_ID,
      version: versionString("1"),
      ...entryFor({ contribution: "rule", id: DECLARATIVE_ID, version: versionString("1") }),
    });
    const parameters = {
      recipes: [
        {
          name: "r",
          kind: "run",
          recipe: {
            command: ["node", "-e", "process.exit(0)"],
            workingDirectory: "/",
            environment: {},
            declared: [],
            substrates: [],
            isolation: "hygiene",
          },
        },
      ],
      expectations: [{ kind: "exitCodeIs", recipe: "r", value: 0 }],
    };
    const dir = await mkdtemp(join(tmpdir(), "musai-declarative-restart-"));
    try {
      const { gitDir } = await initWorkspace(dir, { now: FIXED_NOW });
      const store = new Store({ ctx: { gitDir }, scope: "restart", now: FIXED_NOW });
      const result = await runRestartLoop({
        invoker,
        input: { claimId: "declarative-invocation-count", conditions: declarativeConditions(parameters), evidence: [] },
        store,
        index: new IndexDb(),
        now: FIXED_NOW,
      });
      expect(result.invocations).toBe(2);
      expect(result.verdict).toMatchObject({ label: "holds" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("what a recipe the kernel could not perform decides", () => {
  /** Drives one parameter object through the whole restart path against a real store. */
  async function decide(claimId: string, parameters: unknown): Promise<unknown> {
    const host = new InProcessHost();
    const loaded = await host.load(MODULE_PATH, "invoke");
    const invoker = invokerFromModuleHost(host, loaded, {
      id: DECLARATIVE_ID,
      version: versionString("1"),
      ...entryFor({ contribution: "rule", id: DECLARATIVE_ID, version: versionString("1") }),
    });
    const dir = await mkdtemp(join(tmpdir(), "musai-declarative-refusal-"));
    try {
      const { gitDir } = await initWorkspace(dir, { now: FIXED_NOW });
      const store = new Store({ ctx: { gitDir }, scope: "refusal", now: FIXED_NOW });
      const result = await runRestartLoop({
        invoker,
        input: { claimId, conditions: declarativeConditions(parameters), evidence: [] },
        store,
        index: new IndexDb(),
        now: FIXED_NOW,
      });
      return result.verdict;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const absentBinary = {
    command: ["musai-no-such-binary"],
    workingDirectory: "/",
    environment: {},
    declared: [],
    substrates: [],
    isolation: "hygiene",
  };
  const printsOk = {
    command: ["node", "-e", "process.stdout.write('ok')"],
    workingDirectory: "/",
    environment: {},
    declared: [],
    substrates: [],
    isolation: "hygiene",
  };

  test("leaves the check open rather than reading the recipe that did run as the one that did not", async () => {
    const verdict = await decide("declarative-refused-recipe", {
      recipes: [
        { name: "absent", kind: "run", recipe: absentBinary },
        { name: "present", kind: "run", recipe: printsOk },
      ],
      expectations: [{ kind: "equals", selector: { recipe: "absent", field: "output" }, value: "ok" }],
    });

    // Evidence lines up with recipes by position, so a dropped recipe would misattribute output.
    expect(verdict).toMatchObject({ label: "open" });
    expect((verdict as { reason: string }).reason).toContain("musai-no-such-binary");
  });

  test("refuses a parameter object whose two recipes reduce to one need, naming the count it cannot line up", async () => {
    const verdict = await decide("declarative-duplicate-recipe", {
      recipes: [
        { name: "first", kind: "run", recipe: printsOk },
        { name: "second", kind: "run", recipe: printsOk },
      ],
      expectations: [{ kind: "equals", selector: { recipe: "second", field: "output" }, value: "ok" }],
    });

    // A conclusive error the rule folds forward reaches the caller as an open verdict.
    expect(verdict).toMatchObject({ label: "open" });
    expect((verdict as { reason: string }).reason).toContain("evidence for 1 of its 2 recipes");
  });
});

describe("the declarative rule decides the six kinds it knows inline and asks the kernel to invoke whatever decides any other", () => {
  /** A kind no module here answers for; to the rule it is only a contribution id. */
  const CONTRIBUTED = "elsewhere.example/approximately";
  const recipe = {
    command: ["node", "-e", "process.stdout.write('ok')"],
    workingDirectory: "/",
    environment: {},
    declared: [],
    substrates: [],
    isolation: "hygiene",
  };
  const evidence = { runId: `sha256:${"a".repeat(64)}`, exitCode: 0, output: "ok" };
  const contributed = { kind: CONTRIBUTED, selector: { recipe: "r", field: "output" }, tolerance: 2 };

  function invokeOf(expectation: unknown) {
    return { kind: "invoke", contribution: CONTRIBUTED, input: { expectation, evidence: { r: evidence } } };
  }

  /** What `expectation`'s invoke answered, with a stand-in module record. */
  function invocationOf(expectation: unknown, output: unknown) {
    return { need: invokeOf(expectation), moduleRecord: `sha256:${"b".repeat(64)}`, output };
  }

  /** One round of the rule through the host, from a hand-built input rather than a restart loop. */
  async function answer(
    parameters: unknown,
    round: { evidence?: unknown[]; refusals?: unknown[]; invocations?: unknown[] },
  ): Promise<unknown> {
    const host = new InProcessHost();
    const loaded = await host.load(MODULE_PATH, "invoke");
    const inlineRequest = {
      protocol: ENVELOPE_PROTOCOL,
      contribution: "rule" as const,
      id: DECLARATIVE_ID,
      version: versionString("1"),
      input: {
        claimId: "declarative-contributed-kind",
        conditions: declarativeConditions(parameters),
        evidence: round.evidence ?? [],
        ...(round.refusals === undefined ? {} : { refusals: round.refusals }),
        ...(round.invocations === undefined ? {} : { invocations: round.invocations }),
      },
    };
    const { response } = await host.invoke(loaded, inlineRequest, entryFor(inlineRequest));
    expect(response.ok, JSON.stringify(response)).toBe(true);
    return response.ok ? response.output : undefined;
  }

  const oneRecipe = { recipes: [{ name: "r", kind: "run", recipe }] };

  test("an expectation of one of the six kinds is decided inline and asks for no invoke", async () => {
    const output = await answer(
      { ...oneRecipe, expectations: [{ kind: "exitCodeIs", recipe: "r", value: 0 }] },
      { evidence: [evidence] },
    );
    expect(output).toEqual({ kind: "verdict", label: "holds", reason: "r's exit code is 0 as expected" });
  });

  test("an expectation of any other kind asks for one invoke naming that kind, handed the expectation and the evidence by recipe name", async () => {
    const output = (await answer({ ...oneRecipe, expectations: [contributed] }, { evidence: [evidence] })) as {
      kind: string;
      needs: unknown[];
    };
    expect(output.kind).toBe("request");
    expect(output.needs).toHaveLength(1);
    expect(output.needs[0]).toEqual(invokeOf(contributed));
  });

  test("the invoked contribution's answer decides the expectation, whichever way it went", async () => {
    const parameters = { ...oneRecipe, expectations: [contributed] };
    const met = await answer(parameters, {
      evidence: [evidence],
      invocations: [invocationOf(contributed, { met: true, reason: "close enough" })],
    });
    expect(met).toEqual({ kind: "verdict", label: "holds", reason: "close enough" });

    const unmet = await answer(parameters, {
      evidence: [evidence],
      invocations: [invocationOf(contributed, { met: false, reason: "too far off" })],
    });
    expect(unmet).toEqual({ kind: "verdict", label: "fails", reason: "too far off" });
  });

  test("an answer is matched to its expectation whatever order the need carries the expectation's keys in", async () => {
    const reordered = { tolerance: 2, selector: { field: "output", recipe: "r" }, kind: CONTRIBUTED };
    const output = await answer(
      { ...oneRecipe, expectations: [contributed] },
      { evidence: [evidence], invocations: [invocationOf(reordered, { met: true, reason: "close enough" })] },
    );
    expect(output).toEqual({ kind: "verdict", label: "holds", reason: "close enough" });
  });

  test("an invoke the kernel refused leaves the check open, naming the kind and the refusal", async () => {
    const message = `refusing to invoke ${CONTRIBUTED}: the workspace holds no contribution of that id`;
    const output = (await answer(
      { ...oneRecipe, expectations: [contributed] },
      { evidence: [evidence], refusals: [{ need: invokeOf(contributed), error: { code: "need-refused", message } }] },
    )) as { kind: string; label: string; reason: string };
    expect(output).toMatchObject({ kind: "verdict", label: "open" });
    expect(output.reason).toContain(`${CONTRIBUTED}: ${message}`);
  });

  test("a run the kernel refused leaves the check open with the reason a refused recipe has always read", async () => {
    const output = await answer(
      { ...oneRecipe, expectations: [contributed] },
      { refusals: [{ need: { kind: "run", recipe }, error: { code: "need-refused", message: "no such binary" } }] },
    );
    expect(output).toEqual({
      kind: "verdict",
      label: "open",
      reason: "the kernel could not perform every recipe this check names, so nothing decides it: no such binary",
    });
  });

  test("an invoked contribution answering anything but whether the expectation was met and why leaves the check open, naming the kind", async () => {
    const output = (await answer(
      { ...oneRecipe, expectations: [contributed] },
      { evidence: [evidence], invocations: [invocationOf(contributed, { verdict: "yes" })] },
    )) as { kind: string; label: string; reason: string };
    expect(output).toMatchObject({ kind: "verdict", label: "open" });
    expect(output.reason).toContain(CONTRIBUTED);
  });

  test("two expectations of other kinds ask two invokes and are decided independently", async () => {
    const other = { kind: CONTRIBUTED, selector: { recipe: "r", field: "output" }, tolerance: 0 };
    const parameters = { ...oneRecipe, expectations: [contributed, other] };
    const asked = (await answer(parameters, { evidence: [evidence] })) as { kind: string; needs: unknown[] };
    expect(asked.kind).toBe("request");
    expect(asked.needs).toEqual([invokeOf(contributed), invokeOf(other)]);

    const decided = await answer(parameters, {
      evidence: [evidence],
      invocations: [
        invocationOf(contributed, { met: true, reason: "within two" }),
        invocationOf(other, { met: false, reason: "not exact" }),
      ],
    });
    expect(decided).toEqual({ kind: "verdict", label: "fails", reason: "not exact" });
  });

  test("evidence for fewer recipes than the parameter object names concludes with the rule's own error, answered invokes or not", async () => {
    const output = (await answer(
      {
        recipes: [
          { name: "r", kind: "run", recipe },
          { name: "s", kind: "run", recipe },
        ],
        expectations: [contributed],
      },
      { evidence: [evidence], invocations: [invocationOf(contributed, { met: true, reason: "close enough" })] },
    )) as { kind: string; error: { message: string } };
    expect(output.kind).toBe("error");
    expect(output.error.message).toContain("evidence for 1 of its 2 recipes");
  });

  test("an expectation naming no kind is refused by the parameter parser, naming what it lacks", async () => {
    const output = (await answer(
      { ...oneRecipe, expectations: [{ selector: { recipe: "r", field: "output" } }] },
      { evidence: [evidence] },
    )) as { kind: string; error: { message: string } };
    expect(output.kind).toBe("error");
    expect(output.error.message).toContain("an expectation with no kind");
  });
});

describe("the interpreter is a module contribution, reachable only where it is installed", () => {
  test("a host with a different module loaded — the core module absent from the workspace — refuses the interpreter's own id with the unknown-contribution code", async () => {
    const standInDir = await mkdtemp(join(tmpdir(), "musai-no-core-module-"));
    try {
      const standInPath = join(standInDir, "module.ts");
      await writeFile(
        standInPath,
        [
          "export function invoke(requestBytes) {",
          "  const text = new TextDecoder().decode(requestBytes);",
          "  const request = JSON.parse(text);",
          '  return new TextEncoder().encode(JSON.stringify({ ok: false, error: { code: "unknown-contribution", data: { id: request.id }, message: request.id + " is not answered by this stand-in" } }));',
          "}",
        ].join("\n"),
      );
      const host = new InProcessHost();
      const loaded = await host.load(standInPath, "invoke");
      const inlineRequest = {
        protocol: ENVELOPE_PROTOCOL,
        contribution: "rule" as const,
        id: DECLARATIVE_ID,
        version: versionString("1"),
        input: { claimId: "declarative-absent", conditions: {}, evidence: [] },
      };
      const { response } = await host.invoke(loaded, inlineRequest, entryFor(inlineRequest));
      expect(response.ok).toBe(false);
      if (!response.ok) {
        expect(response.error.code).toBe("unknown-contribution");
      }
    } finally {
      await rm(standInDir, { recursive: true, force: true });
    }
  });
});

describe("a run-shaped declarative check reaches the same verdict as the default template's own coded rule", () => {
  test("both hold over a recipe that exits cleanly", async () => {
    const host = new InProcessHost();
    const loaded = await host.load(MODULE_PATH, "invoke");
    const invoker = invokerFromModuleHost(host, loaded, {
      id: DECLARATIVE_ID,
      version: versionString("1"),
      ...entryFor({ contribution: "rule", id: DECLARATIVE_ID, version: versionString("1") }),
    });
    const parameters = {
      recipes: [
        {
          name: "r",
          kind: "run",
          recipe: {
            command: ["node", "-e", "process.stdout.write('ok')"],
            workingDirectory: "/",
            environment: {},
            declared: [],
            substrates: [],
            isolation: "hygiene",
          },
        },
      ],
      expectations: [{ kind: "exitCodeIs", recipe: "r", value: 0 }],
    };
    const dir = await mkdtemp(join(tmpdir(), "musai-declarative-vs-template-"));
    try {
      const { gitDir } = await initWorkspace(dir, { now: FIXED_NOW });
      const store = new Store({ ctx: { gitDir }, scope: "compare", now: FIXED_NOW });
      const result = await runRestartLoop({
        invoker,
        input: { claimId: "declarative-vs-template", conditions: declarativeConditions(parameters), evidence: [] },
        store,
        index: new IndexDb(),
        now: FIXED_NOW,
      });
      // The default template's coded rule decides the same recipe shape the same way.
      expect(result.verdict).toMatchObject({ label: "holds" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("a data-only module — a manifest with no bundle — contributes a working declarative check", () => {
  test("its manifest validates and its own check, evaluated through the interpreter, reaches a real verdict end to end through the fixture runner", async () => {
    const dataOnlyModule: ModuleRecord = {
      kind: "module",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.module,
      name: "dataonly.example",
      version: versionString("1"),
      manifest: {
        protocolVersion: ENVELOPE_PROTOCOL,
        contributions: [
          {
            kind: "rule",
            id: "dataonly.example/exits-cleanly",
            version: versionString("1"),
            input: true,
            output: true,
            documentation:
              "evaluated by musai.core/declarative with a parameter object checking that a run naming only node as its own binary exits cleanly — this manifest carries no bundle, since it has no code of its own",
          },
        ],
        sourceTree: { digest: { gitTree: "b".repeat(40) } },
        toolchain: [],
        packages: [],
      },
      bundle: null,
      build: null,
    };

    const validation = validateRecord(dataOnlyModule);
    expect(validation.ok).toBe(true);
    expect(recordId(dataOnlyModule)).toBeDefined();

    const dir = await mkdtemp(join(tmpdir(), "musai-data-only-module-"));
    try {
      const { gitDir } = await initWorkspace(dir, { now: FIXED_NOW });
      const store = new Store({ ctx: { gitDir }, scope: "dataonly", now: FIXED_NOW });
      const [moduleId] = await store.putMany([{ kind: "module", value: dataOnlyModule }]);
      const index = await foldedIndex(store);

      const listed = index.contributionById("dataonly.example/exits-cleanly");
      expect(listed?.moduleRecord).toBe(moduleId);
      expect(listed?.entry.kind).toBe("rule");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    // The data-only module ships no bundle, so its check is the core interpreter's fixture case.
    const report = await runModuleTests(MODULE_DIR, { now: FIXED_NOW });
    const dataOnlyCase = report.results.find(
      (result) => result.host === "in-process" && result.fixture === "data-only-example",
    );
    expect(dataOnlyCase?.status).toBe("pass");
  }, 60_000);
});

describe("every fixture receipt this module's own suite recorded validates through the ordinary record validator", () => {
  test("each run record under records/run/ has a file digest equal to its own record id", async () => {
    async function walk(dir: string): Promise<string[]> {
      const entries = await readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const entryPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...(await walk(entryPath)));
        } else if (entry.name.endsWith(".json")) {
          files.push(entryPath);
        }
      }
      return files;
    }
    const runDir = join(MODULE_DIR, "records", "run");
    const files = await walk(runDir);
    expect(files.length).toBeGreaterThan(0);
    for (const filePath of files) {
      const bytes = await readFile(filePath, "utf8");
      const record = JSON.parse(bytes) as unknown;
      const validation = validateRecord(record);
      expect(validation.ok, `${filePath}: ${validation.ok ? "" : validation.error}`).toBe(true);
      const expectedId = recordId(validation.ok ? validation.record : record);
      expect(filePath.endsWith(`${expectedId.replace("sha256:", "")}.json`)).toBe(true);
    }
  });
});
