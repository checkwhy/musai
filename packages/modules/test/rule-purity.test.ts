import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { versionString } from "@musai/records";
import { gatewaySource } from "@musai/test-support";
import { beforeEach, describe, expect, test } from "vitest";
import type { RuleInput } from "../src/rule/contract.js";
import {
  ENVELOPE_PROTOCOL,
  type EnvelopeRequest,
  type InvokedContribution,
  kernelPoint,
} from "../src/rule/envelope.js";
import { InProcessHost, RuleImportError } from "../src/rule/host.js";
import { checkRuleImports, INTERPOLATION_SPECIFIER } from "../src/rule/imports.js";

const CORPUS_DIR = fileURLToPath(new URL("./corpus", import.meta.url));
const ONE_RUN_RULE_PATH = fileURLToPath(new URL("./corpus/requests-one-run.rule.ts", import.meta.url));
const FILESYSTEM_RULE_PATH = fileURLToPath(new URL("./corpus/reaches-for-the-filesystem.rule.ts", import.meta.url));
const INTERPOLATION_RULE_PATH = fileURLToPath(new URL("./corpus/interpolates-a-dependency.rule.ts", import.meta.url));
const CLOCK_RULE_PATH = fileURLToPath(new URL("./corpus/reaches-for-the-clock.rule.ts", import.meta.url));
const RANDOMNESS_RULE_PATH = fileURLToPath(new URL("./corpus/reaches-for-randomness.rule.ts", import.meta.url));

/** Every fixture this corpus ships, paired with the export the host loads it by. */
const CORPUS_FIXTURES: readonly { readonly path: string; readonly exportName: string }[] = [
  { path: ONE_RUN_RULE_PATH, exportName: "invoke" },
  { path: FILESYSTEM_RULE_PATH, exportName: "reachesForTheFilesystemRule" },
  { path: INTERPOLATION_RULE_PATH, exportName: "interpolatesADependencyRule" },
  { path: CLOCK_RULE_PATH, exportName: "invoke" },
  { path: RANDOMNESS_RULE_PATH, exportName: "invoke" },
];

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

const EMPTY_INPUT: RuleInput = { claimId: "claim", conditions: {}, evidence: [] };

/** Spelled here: importing it from the fixture would evaluate the module proved never to run. */
const EVALUATION_WITNESS_KEY = "__musaiReachesForTheFilesystemRuleEvaluated";

/** The same witness for the fixture hiding its reach in a template interpolation. */
const INTERPOLATION_WITNESS_KEY = "__musaiInterpolatesADependencyRuleEvaluated";

function evaluationWitness(key: string = EVALUATION_WITNESS_KEY): boolean | undefined {
  return (globalThis as unknown as Record<string, boolean | undefined>)[key];
}

describe("a rule module loads only after its own imports have been checked", () => {
  const host = new InProcessHost();

  beforeEach(() => {
    delete (globalThis as unknown as Record<string, boolean | undefined>)[EVALUATION_WITNESS_KEY];
    delete (globalThis as unknown as Record<string, boolean | undefined>)[INTERPOLATION_WITNESS_KEY];
  });

  test("a pure rule module loads through the host and requests the one run it needs on its first invocation", async () => {
    const loaded = await host.load(ONE_RUN_RULE_PATH, "invoke");
    const { response } = await host.invoke(loaded, requestFor("test/one-run", EMPTY_INPUT), ruleEntry("test/one-run"));
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.output).toMatchObject({ kind: "request" });
    }
  });

  test("a rule module importing the filesystem is refused, naming the offending specifier and its line", async () => {
    let caught: unknown;
    try {
      await host.load(FILESYSTEM_RULE_PATH, "reachesForTheFilesystemRule");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RuleImportError);
    const importError = caught as RuleImportError;
    expect(importError.violations).toContainEqual({ specifier: "node:fs", line: 1 });
    expect(importError.message).toContain("node:fs");
    expect(importError.message).toContain("line 1");
  });

  test("the refused module was never evaluated", async () => {
    expect(evaluationWitness()).toBeUndefined();
    await expect(host.load(FILESYSTEM_RULE_PATH, "reachesForTheFilesystemRule")).rejects.toThrow(RuleImportError);
    expect(evaluationWitness()).toBeUndefined();
  });

  test("a rule module reaching for a dependency inside a template literal's interpolation is refused before it is evaluated, naming the interpolation and its line", async () => {
    const source = await readFile(INTERPOLATION_RULE_PATH, "utf8");
    const interpolationLine = source.split("\n").findIndex((line) => line.includes("${")) + 1;
    expect(interpolationLine).toBeGreaterThan(0);

    expect(evaluationWitness(INTERPOLATION_WITNESS_KEY)).toBeUndefined();
    let caught: unknown;
    try {
      await host.load(INTERPOLATION_RULE_PATH, "interpolatesADependencyRule");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RuleImportError);
    const importError = caught as RuleImportError;
    expect(importError.violations).toContainEqual({ specifier: INTERPOLATION_SPECIFIER, line: interpolationLine });
    expect(importError.message).toContain(`line ${interpolationLine}`);
    expect(evaluationWitness(INTERPOLATION_WITNESS_KEY)).toBeUndefined();
  });
});

describe("checkRuleImports refuses a source declaring anything beyond a type-only import of the rule contract", () => {
  test("a pure rule's own source declares nothing else", async () => {
    const source = await readFile(ONE_RUN_RULE_PATH, "utf8");
    expect(checkRuleImports(source)).toEqual([]);
  });

  test("a bare package import is refused", () => {
    const source = [`import { z } from "zod";`, `export const rule = () => {};`].join("\n");
    expect(checkRuleImports(source)).toContainEqual({ specifier: "zod", line: 1 });
  });

  test("a value import of the contract is refused", () => {
    const source = `import { Rule } from "../../src/rule/contract.js";\n`;
    expect(checkRuleImports(source)).toContainEqual({ specifier: "../../src/rule/contract.js", line: 1 });
  });

  test("a re-export is refused even when its specifier names the contract", () => {
    const source = `export { Rule } from "../../src/rule/contract.js";\n`;
    expect(checkRuleImports(source)).toContainEqual({ specifier: "../../src/rule/contract.js", line: 1 });
  });

  test("a dynamic import is refused", () => {
    const source = `const load = () => import("node:fs");\n`;
    expect(checkRuleImports(source)).toContainEqual({ specifier: "node:fs", line: 1 });
  });

  test("a template literal with an interpolation is refused as something the scan cannot see into, whatever the interpolation holds", () => {
    const source = [
      `import type { Rule } from "../../src/rule/contract.js";`,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture module's own source, spelled as text so the scan reads a real interpolation to refuse
      "const label = `claim ${1 + 1}`;",
      `export const interpolatingRule: Rule = (_input) => ({ kind: "verdict", label: "open", reason: label });`,
    ].join("\n");
    expect(checkRuleImports(source)).toEqual([{ specifier: INTERPOLATION_SPECIFIER, line: 2 }]);
  });

  test("a template literal without an interpolation is not a dependency", () => {
    const source = [
      `import type { Rule } from "../../src/rule/contract.js";`,
      "const label = `import { readFileSync } from 'node:fs'`;",
      `export const plainTemplateRule: Rule = (_input) => ({ kind: "verdict", label: "open", reason: label });`,
    ].join("\n");
    expect(checkRuleImports(source)).toEqual([]);
  });

  test("a forbidden specifier appearing only inside a comment or a string literal does not cause a refusal", () => {
    const source = [
      `// import { readFileSync } from "node:fs";`,
      `const note = "import { readFileSync } from 'node:fs';";`,
      `import type { Rule } from "../../src/rule/contract.js";`,
      `export const stillValidRule: Rule = (_input) => ({ kind: "verdict", label: "open", reason: "unused" });`,
    ].join("\n");
    expect(checkRuleImports(source)).toEqual([]);
  });

  test("a dependency declared through a form other than the one permitted is reported even when its specifier names the contract", () => {
    const source = [
      `import type { Rule } from "../../src/rule/contract.js";`,
      `import contract = require("../../src/rule/contract.js");`,
      `export const oddFormRule: Rule = (_input) => ({ kind: "verdict", label: "open", reason: "unused" });`,
    ].join("\n");
    expect(checkRuleImports(source)).toContainEqual({ specifier: "../../src/rule/contract.js", line: 2 });
  });

  test("a bundle with several disallowed imports is refused naming every specifier, not only the first", () => {
    const source = [
      `import { z } from "zod";`,
      `import { readFileSync } from "node:fs";`,
      `import { createHash } from "node:crypto";`,
      `export const manyImportsRule = () => ({ kind: "verdict", label: "open", reason: "unused" });`,
    ].join("\n");
    const violations = checkRuleImports(source);
    expect(violations.map((violation) => violation.specifier).sort()).toEqual(["node:crypto", "node:fs", "zod"]);
  });
});

describe("two independent layers: a scan over the source, and a context around what runs", () => {
  test("the corpus ships exactly the five fixtures this suite exercises", async () => {
    const entries = await readdir(CORPUS_DIR);
    const fixtures = entries.filter((name) => name.endsWith(".rule.ts"));
    expect(fixtures.length).toBe(5);
  });

  test("a gateway importing nothing at all passes the scan", async () => {
    const source = await readFile(CLOCK_RULE_PATH, "utf8");
    expect(checkRuleImports(source)).toEqual([]);
    const randomnessSource = await readFile(RANDOMNESS_RULE_PATH, "utf8");
    expect(checkRuleImports(randomnessSource)).toEqual([]);
  });

  test("a gateway reaching for the clock passes the scan and fails in the context with the contribution-threw code", async () => {
    const host = new InProcessHost();
    const loaded = await host.load(CLOCK_RULE_PATH, "invoke");
    const { response } = await host.invoke(
      loaded,
      requestFor("test/reaches-for-the-clock", EMPTY_INPUT),
      ruleEntry("test/reaches-for-the-clock"),
    );
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("contribution-threw");
    }
  });

  test("a gateway drawing randomness passes the scan and fails in the context with the contribution-threw code", async () => {
    const host = new InProcessHost();
    const loaded = await host.load(RANDOMNESS_RULE_PATH, "invoke");
    const { response } = await host.invoke(
      loaded,
      requestFor("test/reaches-for-randomness", EMPTY_INPUT),
      ruleEntry("test/reaches-for-randomness"),
    );
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("contribution-threw");
    }
  });

  test("the two layers stop different fixtures: neither the scan-stopped set nor the context-stopped set contains the other", async () => {
    const host = new InProcessHost();
    const scanStopped = new Set<string>();
    const contextStopped = new Set<string>();

    for (const fixture of CORPUS_FIXTURES) {
      const source = await readFile(fixture.path, "utf8");
      if (checkRuleImports(source).length > 0) {
        scanStopped.add(fixture.path);
        continue;
      }
      const loaded = await host.load(fixture.path, fixture.exportName);
      const { response } = await host.invoke(
        loaded,
        requestFor(`test/${fixture.exportName}`, EMPTY_INPUT),
        ruleEntry(`test/${fixture.exportName}`),
      );
      if (!response.ok) {
        contextStopped.add(fixture.path);
      }
    }

    expect(scanStopped.size).toBeGreaterThan(0);
    expect(contextStopped.size).toBeGreaterThan(0);
    expect([...scanStopped].some((path) => contextStopped.has(path))).toBe(false);
    expect([...contextStopped].some((path) => scanStopped.has(path))).toBe(false);
  });
});

describe("what an invocation could read is recorded from the request the kernel handed it", () => {
  test("a contribution reporting a read of its own does not change what was recorded", async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), "musai-rule-purity-reads-"));
    const modulePath = join(scratchDir, "claims-a-read.rule.ts");
    await writeFile(
      modulePath,
      gatewaySource(
        "invoke",
        '      return { kind: "verdict", label: "holds", reason: "evidence:sha256:" + "a".repeat(64) + " was read" };',
      ),
    );
    const host = new InProcessHost();
    const loaded = await host.load(modulePath, "invoke");
    const claimedReadId = `evidence:sha256:${"a".repeat(64)}`;
    const request = requestFor("test/claims-a-read", EMPTY_INPUT);

    const { readLog } = await host.invoke(loaded, request, ruleEntry(request.id));
    expect(readLog.reads.has(claimedReadId)).toBe(false);
  });
});
