import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DECLARATIVE_RULE, type OperationContext, openWorkspace, runHandler } from "@musai/api-core";
import { blobPath, type ModuleRecord, recordPath } from "@musai/records";
import {
  type Checkout,
  fixedClock,
  generateTestKey,
  makeCheckout,
  rewriteBlob,
  type TestKey,
} from "@musai/test-support";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { untarGz } from "../src/export/untar.js";
import { caseBook } from "../src/ops/case.js";
import { caseStatus } from "../src/ops/case-status.js";
import { checkRun } from "../src/ops/check.js";
import { bundleExport } from "../src/ops/export.js";
import { moduleBuild } from "../src/ops/module.js";
import { releaseRevoke } from "../src/ops/release.js";
import { bundleRerun } from "../src/ops/rerun.js";
import { workspaceInit } from "../src/ops/workspace.js";

const scope = "default";
const now = fixedClock("2026-10-11T00:00:00.000Z");
/** A rule running the command its condition names in the project's working tree. */
const TREE_COMMAND_MODULE_DIR = fileURLToPath(new URL("./fixtures/tree-command", import.meta.url));
const TREE_COMMAND_RULE = "tree-command/exits-cleanly";
const TRACKED_IS_HELLO = ["node", "-e", "process.exit(require('fs').readFileSync('tracked.txt','utf8')==='hello'?0:1)"];
const TRACKED_IS_FILLED = ["node", "-e", "process.exit(require('fs').readFileSync('tracked.txt','utf8').length>0?0:1)"];
const STATEMENT = "the tracked file says hello";
/** Its one claim the module's rule judges over TRACKED_IS_HELLO, its other the interpreter. */
const TREE_COMMAND_KIND = "tree-command/watch";
/** Its one claim the interpreter judges over TRACKED_IS_FILLED and then TRACKED_IS_HELLO. */
const TREE_COMMAND_PAIR_KIND = "tree-command/pair";
/** Its one claim the interpreter judges by whether a run printing the tracked file prints hello. */
const TREE_COMMAND_PRINTS_KIND = "tree-command/prints";
/** As TREE_COMMAND_PRINTS_KIND, with the module deciding the expectation. */
const TREE_COMMAND_DECIDED_HERE_KIND = "tree-command/decided-here";
const SAYS_HELLO = "tree-command/says-hello";
const PRINTS_TRACKED = ["node", "-e", "process.stdout.write(require('fs').readFileSync('tracked.txt','utf8'))"];

let key: TestKey;
let scratch: string;
const checkouts: Checkout[] = [];

beforeAll(async () => {
  key = await generateTestKey("operator");
  scratch = await mkdtemp(join(tmpdir(), "musai-rule-bundle-"));
}, 60_000);

afterAll(async () => {
  await rm(key.dir, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

afterEach(async () => {
  for (const checkout of checkouts.splice(0)) {
    await checkout.cleanup();
  }
});

async function checkout(content = "hello"): Promise<{ dir: string; context: OperationContext }> {
  const made = await makeCheckout(content);
  checkouts.push(made);
  return { dir: made.dir, context: { workspace: made.dir, scope, now, principalName: key.name, via: "signature" } };
}

/** A sender with the module installed and `root` settled by its rule, ready to export `root`. */
async function sender(settle: (context: OperationContext) => Promise<string>) {
  const made = await checkout();
  await runHandler(workspaceInit, { workspace: made.dir, key: key.keyPath }, made.context);
  await runHandler(moduleBuild, { dir: TREE_COMMAND_MODULE_DIR }, made.context);
  const root = await settle(made.context);
  const module = (await openWorkspace(made.context)).index.contributionById(TREE_COMMAND_RULE)!.moduleRecord;
  const out = (name: string) => join(scratch, `${name}.tar.gz`);
  const exported = (name: string) =>
    runHandler(bundleExport, { id: root, to: "public", out: out(name), key: key.keyPath }, made.context);
  return { ...made, module, out, exported };
}

/** A sender whose case of `kind` holds its `holds` claims, ready to export the case. */
function caseSender(kind: string, holds: number) {
  return sender(async (context) => {
    const booked = await runHandler(caseBook, { slug: "watched", kind }, context);
    const progress = await runHandler(caseStatus, { case: "watched" }, context);
    expect(progress.counts).toMatchObject({ holds, fails: 0, open: 0 });
    return booked.case;
  });
}

/** A sender whose installed module's rule holds a check, ready to export it. */
function checkSender() {
  return sender(async (context) => {
    const checked = await runHandler(
      checkRun,
      { statement: STATEMENT, rule: TREE_COMMAND_RULE, parameters: JSON.stringify(TRACKED_IS_HELLO) },
      context,
    );
    expect(checked.label).toBe("holds");
    return checked.claim;
  });
}

describe("a check a module's rule judges leaves with what a stranger re-derives its verdict from", () => {
  test("its bundle carries the rule's receipt and the module, code and build, and nothing reads underivable", async () => {
    const from = await checkSender();

    const output = await from.exported("carried");

    const files = untarGz(new Uint8Array(await readFile(from.out("carried"))));
    const runs = [...files.keys()].filter((path) => path.startsWith("records/run/"));
    const commands = runs.map((path) => JSON.parse(new TextDecoder().decode(files.get(path))).recipe.command);
    expect(commands).toContainEqual(TRACKED_IS_HELLO);
    const module = (await openWorkspace(from.context)).read(from.module) as ModuleRecord;
    expect(files.has(recordPath("module", from.module))).toBe(true);
    expect(files.has(recordPath("run", module.build!))).toBe(true);
    expect(files.has(blobPath(module.bundle!))).toBe(true);
    expect(output.underivable).toBeUndefined();
  }, 240_000);

  test("a cold workspace without the module re-runs it and reaches the same verdict", async () => {
    const from = await checkSender();
    await from.exported("same-verdict");
    const receiver = await checkout();

    const output = await runHandler(bundleRerun, { bundle: from.out("same-verdict"), yes: true }, receiver.context);

    expect(output.claims).toEqual([]);
    const [rule] = output.rules!;
    expect([rule!.rule, rule!.recorded, rule!.rerun, rule!.verdict]).toEqual([
      TREE_COMMAND_RULE,
      "holds",
      "holds",
      "matches",
    ]);
    expect(rule!.runs.map((run) => [run.command, run.rerun?.exitCode])).toEqual([[TRACKED_IS_HELLO, 0]]);
    expect(bundleRerun.exitCode(output)).toBe(0);
  }, 240_000);

  test("on a tree where its command fails, the re-derived verdict differs and exits as unheld", async () => {
    const from = await checkSender();
    await from.exported("other-tree");
    const receiver = await checkout("goodbye");

    const output = await runHandler(bundleRerun, { bundle: from.out("other-tree"), yes: true }, receiver.context);

    expect(output.rules!.map((rule) => [rule.recorded, rule.rerun, rule.verdict])).toEqual([
      ["holds", "fails", "differs"],
    ]);
    expect(bundleRerun.exitCode(output)).toBe(7);
  }, 240_000);

  test("a module that cannot leave is named by export, and rerun reads the check as not re-derivable", async () => {
    const from = await checkSender();
    await from.exported("released");
    await runHandler(releaseRevoke, { id: from.module, to: "public", key: key.keyPath }, from.context);

    const output = await from.exported("withheld");

    expect(output.underivable).toEqual([
      { claim: expect.any(String), rule: TREE_COMMAND_RULE, why: expect.stringContaining("stays home") },
    ]);
    const files = untarGz(new Uint8Array(await readFile(from.out("withheld"))));
    expect(files.has(recordPath("module", from.module))).toBe(false);
    const receiver = await checkout();
    const rerun = await runHandler(bundleRerun, { bundle: from.out("withheld"), yes: true }, receiver.context);
    expect(rerun.rules!.map((rule) => [rule.verdict, rule.recorded, rule.rerun])).toEqual([
      ["not-re-derivable", null, null],
    ]);
    expect(rerun.rules![0]!.why).toContain(`no module contributing ${TREE_COMMAND_RULE}`);
    expect(bundleRerun.exitCode(rerun)).toBe(7);
    expect(bundleRerun.renderText!(rerun)).toContain(`rule ${TREE_COMMAND_RULE} not re-derivable here`);
  }, 240_000);
});

describe("a case of a kind whose claims a module's rule judges leaves with what a stranger re-derives", () => {
  test("a cold workspace without the module re-runs each claim and reaches the same verdicts", async () => {
    const from = await caseSender(TREE_COMMAND_KIND, 2);
    await from.exported("case-same-verdicts");
    const receiver = await checkout();

    const output = await runHandler(
      bundleRerun,
      { bundle: from.out("case-same-verdicts"), yes: true },
      receiver.context,
    );

    expect(output.claims.map((claim) => [claim.statement, claim.verdict])).toEqual([
      ["the tracked file says something in watched", "matches"],
    ]);
    expect(output.rules!.map((rule) => [rule.statement, rule.rule, rule.recorded, rule.rerun, rule.verdict])).toEqual([
      ["the tracked file says hello in watched", TREE_COMMAND_RULE, "holds", "holds", "matches"],
    ]);
    expect(bundleRerun.exitCode(output)).toBe(0);
  }, 240_000);

  test("a bundle without the module its rule needs reads that claim not re-derivable, and exits as unheld", async () => {
    const from = await caseSender(TREE_COMMAND_KIND, 2);
    await from.exported("case-released");
    await runHandler(releaseRevoke, { id: from.module, to: "public", key: key.keyPath }, from.context);
    await from.exported("case-withheld");
    const receiver = await checkout();

    const output = await runHandler(bundleRerun, { bundle: from.out("case-withheld"), yes: true }, receiver.context);

    expect(output.rules!.map((rule) => [rule.statement, rule.verdict, rule.recorded, rule.rerun])).toEqual([
      ["the tracked file says hello in watched", "not-re-derivable", null, null],
    ]);
    expect(output.rules![0]!.why).toContain(`no module contributing ${TREE_COMMAND_RULE}`);
    expect(bundleRerun.exitCode(output)).toBe(7);
  }, 240_000);
});

describe("a claim the interpreter judges over two recipes leaves with the runs of both", () => {
  test("its case's bundle carries a receipt of each recipe", async () => {
    const from = await caseSender(TREE_COMMAND_PAIR_KIND, 1);

    await from.exported("pair-carried");

    const files = untarGz(new Uint8Array(await readFile(from.out("pair-carried"))));
    const commands = [...files.keys()]
      .filter((path) => path.startsWith("records/run/"))
      .map((path) => JSON.parse(new TextDecoder().decode(files.get(path))).recipe.command);
    expect(commands).toContainEqual(TRACKED_IS_FILLED);
    expect(commands).toContainEqual(TRACKED_IS_HELLO);
  }, 240_000);

  test("a cold workspace re-runs both recipes and the interpreter reaches the same verdict over them", async () => {
    const from = await caseSender(TREE_COMMAND_PAIR_KIND, 1);
    await from.exported("pair-same-verdict");
    const receiver = await checkout();

    const output = await runHandler(
      bundleRerun,
      { bundle: from.out("pair-same-verdict"), yes: true },
      receiver.context,
    );

    expect(output.claims).toEqual([]);
    expect(output.rules!.map((rule) => [rule.statement, rule.rule, rule.recorded, rule.rerun, rule.verdict])).toEqual([
      ["the tracked file says something and hello in watched", DECLARATIVE_RULE, "holds", "holds", "matches"],
    ]);
    expect(output.rules![0]!.runs.map((run) => [run.command, run.rerun?.exitCode])).toEqual([
      [TRACKED_IS_FILLED, 0],
      [TRACKED_IS_HELLO, 0],
    ]);
    expect(bundleRerun.exitCode(output)).toBe(0);
  }, 240_000);

  test("on a tree where only its second recipe fails, the re-derived verdict differs and exits as unheld", async () => {
    const from = await caseSender(TREE_COMMAND_PAIR_KIND, 1);
    await from.exported("pair-other-tree");
    const receiver = await checkout("goodbye");

    const output = await runHandler(bundleRerun, { bundle: from.out("pair-other-tree"), yes: true }, receiver.context);

    expect(output.rules!.map((rule) => [rule.recorded, rule.rerun, rule.verdict])).toEqual([
      ["holds", "fails", "differs"],
    ]);
    expect(bundleRerun.exitCode(output)).toBe(7);
  }, 240_000);
});

describe("a claim the interpreter judges over one recipe by more than its exit code is re-derived", () => {
  test("a cold workspace whose run prints what the claim expects reaches the same verdict", async () => {
    const from = await caseSender(TREE_COMMAND_PRINTS_KIND, 1);
    await from.exported("prints-same-verdict");
    const receiver = await checkout();

    const output = await runHandler(
      bundleRerun,
      { bundle: from.out("prints-same-verdict"), yes: true },
      receiver.context,
    );

    expect(output.claims).toEqual([]);
    expect(output.rules!.map((rule) => [rule.statement, rule.rule, rule.recorded, rule.rerun, rule.verdict])).toEqual([
      ["the tracked file says hello when printed in watched", DECLARATIVE_RULE, "holds", "holds", "matches"],
    ]);
    expect(output.rules![0]!.runs.map((run) => [run.command, run.rerun?.exitCode])).toEqual([[PRINTS_TRACKED, 0]]);
    expect(bundleRerun.exitCode(output)).toBe(0);
  }, 240_000);

  test("a run that exits cleanly but prints something else re-derives as fails, and exits as unheld", async () => {
    const from = await caseSender(TREE_COMMAND_PRINTS_KIND, 1);
    await from.exported("prints-other-tree");
    const receiver = await checkout("goodbye");

    const output = await runHandler(
      bundleRerun,
      { bundle: from.out("prints-other-tree"), yes: true },
      receiver.context,
    );

    expect(output.rules!.map((rule) => [rule.recorded, rule.rerun, rule.verdict])).toEqual([
      ["holds", "fails", "differs"],
    ]);
    expect(output.rules![0]!.runs.map((run) => run.rerun?.exitCode)).toEqual([0]);
    expect(bundleRerun.exitCode(output)).toBe(7);
  }, 240_000);
});

describe("a claim whose expectation a module decides leaves with that module", () => {
  test("its bundle carries the module, code and build, and a cold workspace reaches the same verdict", async () => {
    const from = await caseSender(TREE_COMMAND_DECIDED_HERE_KIND, 1);

    const exported = await from.exported("decided-carried");

    expect(exported.underivable).toBeUndefined();
    const files = untarGz(new Uint8Array(await readFile(from.out("decided-carried"))));
    const module = (await openWorkspace(from.context)).read(from.module) as ModuleRecord;
    expect(files.has(recordPath("module", from.module))).toBe(true);
    expect(files.has(recordPath("run", module.build!))).toBe(true);
    expect(files.has(blobPath(module.bundle!))).toBe(true);
    const receiver = await checkout();
    const output = await runHandler(bundleRerun, { bundle: from.out("decided-carried"), yes: true }, receiver.context);
    expect(output.claims).toEqual([]);
    expect(output.rules!.map((rule) => [rule.rule, rule.recorded, rule.rerun, rule.verdict])).toEqual([
      [DECLARATIVE_RULE, "holds", "holds", "matches"],
    ]);
    expect(bundleRerun.exitCode(output)).toBe(0);
  }, 240_000);

  test("one whose module has no build here is named by export, and rerun names that module uncarried", async () => {
    const from = await caseSender(TREE_COMMAND_DECIDED_HERE_KIND, 1);
    const module = (await openWorkspace(from.context)).read(from.module) as ModuleRecord;
    await rewriteBlob(from.dir, module.bundle!, null);

    const exported = await from.exported("decided-no-build");

    expect(exported.underivable).toEqual([
      {
        claim: expect.any(String),
        rule: DECLARATIVE_RULE,
        why: expect.stringMatching(new RegExp(`${SAYS_HELLO}.*no build on this machine`)),
      },
    ]);
    expect(bundleExport.renderText!(exported)).toContain(`rule ${DECLARATIVE_RULE} judging`);
    const receiver = await checkout();
    const output = await runHandler(bundleRerun, { bundle: from.out("decided-no-build"), yes: true }, receiver.context);
    expect(output.rules!.map((rule) => [rule.rule, rule.verdict, rule.recorded, rule.rerun])).toEqual([
      [DECLARATIVE_RULE, "not-re-derivable", null, null],
    ]);
    expect(output.rules![0]!.why).toBe(
      `the module ${module.name} ${module.version} deciding its expectation ${SAYS_HELLO} was not carried: no build on the exporting machine`,
    );
    expect(bundleRerun.exitCode(output)).toBe(7);
  }, 240_000);

  test("a check the interpreter judges by its exit code leaves with no module, though one is installed", async () => {
    const from = await sender(async (context) => {
      const checked = await runHandler(checkRun, { statement: STATEMENT, command: TRACKED_IS_HELLO }, context);
      expect(checked.label).toBe("holds");
      return checked.claim;
    });

    const exported = await from.exported("plain-check");

    const files = untarGz(new Uint8Array(await readFile(from.out("plain-check"))));
    expect([...files.keys()].filter((path) => path.startsWith("records/module/"))).toEqual([]);
    expect([exported.blobs, exported.underivable]).toEqual([0, undefined]);
  }, 240_000);
});

test("a module whose code this machine lacks is named by export, and rerun names it uncarried", async () => {
  const from = await checkSender();
  const module = (await openWorkspace(from.context)).read(from.module) as ModuleRecord;
  await rewriteBlob(from.dir, module.bundle!, null);

  const output = await from.exported("no-build");

  expect(output.underivable).toEqual([
    { claim: expect.any(String), rule: TREE_COMMAND_RULE, why: expect.stringContaining("no build on this machine") },
  ]);
  const receiver = await checkout();
  const rerun = await runHandler(bundleRerun, { bundle: from.out("no-build"), yes: true }, receiver.context);
  expect(rerun.rules!.map((rule) => rule.verdict)).toEqual(["not-re-derivable"]);
  expect(rerun.rules![0]!.why).toBe(
    `its module ${module.name} ${module.version} was not carried: no build on the exporting machine`,
  );
  expect(bundleRerun.exitCode(rerun)).toBe(7);
}, 240_000);
