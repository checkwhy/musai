import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type OperationContext, openWorkspace, runHandler } from "@musai/api-core";
import { type RecordId, recordId } from "@musai/records";
import { MUSAI_DIR } from "@musai/store";
import { fixedClock, makeCheckout } from "@musai/test-support";
import { execa } from "execa";
import { describe, expect, onTestFinished, test } from "vitest";
import { type CheckRunInput, checkRun } from "../src/ops/check.js";
import { moduleBuild } from "../src/ops/module.js";
import { renderMarkdown } from "../src/ops/render.js";
import { workspaceInit } from "../src/ops/workspace.js";

const scope = "default";
const now = fixedClock("2026-10-11T00:00:00.000Z");
/** A rule that asks for the record its condition names, and for one clean run. */
const RECORD_NEED_MODULE_DIR = fileURLToPath(new URL("./fixtures/record-need", import.meta.url));
const RECORD_NEED_RULE = "record-need/cites-a-record";
/** A module contributing a kind beside a rule of its own. */
const TWO_RULERS_MODULE_DIR = fileURLToPath(new URL("./fixtures/two-rulers", import.meta.url));
const TWO_RULERS_KIND = "two-rulers/audit";
const TWO_RULERS_RULE = "two-rulers/audits";
const TRACKED_IS_HELLO = ["node", "-e", "process.exit(require('fs').readFileSync('tracked.txt','utf8')==='hello'?0:1)"];
const CITES = "the first check is on record";

/** A repository with one commit, holding a workspace with both fixture modules installed. */
async function workspaceWithRules(): Promise<{ readonly dir: string; readonly context: OperationContext }> {
  const checkout = await makeCheckout("hello");
  onTestFinished(() => checkout.cleanup());
  const context: OperationContext = { workspace: checkout.dir, scope, now, principalName: "operator" };
  await runHandler(workspaceInit, { workspace: checkout.dir }, context);
  await runHandler(moduleBuild, { dir: RECORD_NEED_MODULE_DIR }, context);
  await runHandler(moduleBuild, { dir: TWO_RULERS_MODULE_DIR }, context);
  return { dir: checkout.dir, context };
}

/** Every ref the store holds and the tree binding, so a refusal can be shown to write neither. */
async function written(dir: string): Promise<string> {
  const refs = (await execa("git", ["--git-dir", join(dir, MUSAI_DIR), "for-each-ref"])).stdout;
  const binding = await readFile(join(dir, MUSAI_DIR, "local", "checkouts.json"), "utf8").catch(() => "");
  return `${refs}\n${binding}`;
}

async function refusalOf(input: CheckRunInput, context: OperationContext): Promise<unknown> {
  return runHandler(checkRun, input, context).catch((error: unknown) => error);
}

async function conditionsAt(dir: string, slot: string): Promise<unknown> {
  const claim = (await openWorkspace({ workspace: dir, scope, now })).index.claimAtSlot(slot);
  return claim?.record.kind === "claim" ? claim.record.conditions : undefined;
}

describe("check --rule: a claim judged by an installed module's rule", () => {
  test("a check naming a rule mints a check claim whose conditions carry the rule and its parameters, and the rule judges it", async () => {
    const { dir, context } = await workspaceWithRules();
    const cited = await runHandler(
      checkRun,
      { statement: "the tracked file says hello", command: TRACKED_IS_HELLO },
      context,
    );

    const checked = await runHandler(
      checkRun,
      { statement: CITES, rule: RECORD_NEED_RULE, parameters: cited.claim },
      context,
    );

    expect([checked.label, checked.reason, checked.toolsAdded]).toEqual(["holds", null, []]);
    const opened = await openWorkspace({ workspace: dir, scope, now });
    expect(opened.read(checked.claim as RecordId)).toMatchObject({ kind: "claim", type: "musai.core/check@1" });
    expect(await conditionsAt(dir, checked.slot)).toEqual({
      subject: ((await conditionsAt(dir, cited.slot)) as { subject: string }).subject,
      statement: CITES,
      [RECORD_NEED_RULE]: cited.claim,
    });
  }, 180_000);

  test("the parameters a check names reach its rule as the value of the rule's condition", async () => {
    const { context } = await workspaceWithRules();
    const cited = await runHandler(
      checkRun,
      { statement: "the tracked file says hello", command: TRACKED_IS_HELLO },
      context,
    );
    const absent = recordId({ never: "minted" });

    const unrecorded = await runHandler(
      checkRun,
      { statement: CITES, rule: RECORD_NEED_RULE, parameters: absent },
      context,
    );
    const recorded = await runHandler(
      checkRun,
      { statement: CITES, rule: RECORD_NEED_RULE, parameters: cited.claim, replace: true },
      context,
    );

    expect(unrecorded.label).toBe("open");
    expect(recorded.label).toBe("holds");
  }, 180_000);

  test("a rule no installed module contributes is refused naming the rules installed, writing nothing", async () => {
    const { dir, context } = await workspaceWithRules();
    const before = await written(dir);

    const refused = await refusalOf({ statement: CITES, rule: "nobody/ships-this" }, context);

    expect(refused).toMatchObject({ reason: "no-such-record", about: ["nobody/ships-this"] });
    expect((refused as Error).message).toContain(`the rules installed here: ${RECORD_NEED_RULE}, ${TWO_RULERS_RULE}`);
    expect(await written(dir)).toBe(before);
  }, 180_000);

  test("a kind, a preset or the core's own interpreter named as the rule is refused saying what it is, writing nothing", async () => {
    const { dir, context } = await workspaceWithRules();
    const before = await written(dir);

    const kind = await refusalOf({ statement: CITES, rule: TWO_RULERS_KIND }, context);
    const preset = await refusalOf({ statement: CITES, rule: "musai.core/bare" }, context);
    const declarative = await refusalOf({ statement: CITES, rule: "musai.core/declarative" }, context);

    expect(kind).toMatchObject({ reason: "invalid-input", about: [TWO_RULERS_KIND] });
    expect((kind as Error).message).toContain("a kind contribution, not a rule");
    expect(preset).toMatchObject({ reason: "invalid-input", about: ["musai.core/bare"] });
    expect((preset as Error).message).toContain("a preset contribution, not a rule");
    expect(declarative).toMatchObject({ reason: "invalid-input", about: ["musai.core/declarative"] });
    expect((declarative as Error).message).toContain('check "<sentence>" -- <command>');
    expect(await written(dir)).toBe(before);
  }, 180_000);

  test("a check naming both a command and a rule, neither, a tool beside a rule, or parameters beside a command is refused, writing nothing", async () => {
    const { dir, context } = await workspaceWithRules();
    const before = await written(dir);

    const refusals = await Promise.all(
      [
        { statement: CITES, command: TRACKED_IS_HELLO, rule: RECORD_NEED_RULE },
        { statement: CITES },
        { statement: CITES, rule: RECORD_NEED_RULE, tool: ["sh"] },
        { statement: CITES, command: TRACKED_IS_HELLO, parameters: "x" },
      ].map((input) => refusalOf(input, context)),
    );

    for (const refused of refusals) {
      expect(refused).toMatchObject({ reason: "invalid-input" });
    }
    expect(await written(dir)).toBe(before);
  }, 180_000);

  test("a sentence checked by a command and then by a rule is one claim, the rule's a successor at its slot", async () => {
    const { dir, context } = await workspaceWithRules();
    const byCommand = await runHandler(checkRun, { statement: CITES, command: TRACKED_IS_HELLO }, context);

    const byRule = await runHandler(
      checkRun,
      { statement: CITES, rule: RECORD_NEED_RULE, parameters: byCommand.claim, replace: true },
      context,
    );
    const byCommandAgain = await runHandler(
      checkRun,
      { statement: CITES, command: TRACKED_IS_HELLO, replace: true },
      context,
    );

    expect(byRule.slot).toBe(byCommand.slot);
    expect(byRule.claim).not.toBe(byCommand.claim);
    const opened = await openWorkspace({ workspace: dir, scope, now });
    expect(opened.read(byRule.claim as RecordId)).toMatchObject({ supersedes: [byCommand.claim] });
    expect(byCommandAgain.slot).toBe(byCommand.slot);
    expect(opened.index.claimAtSlot(byCommand.slot)?.id).toBe(byCommandAgain.claim);
    expect(await conditionsAt(dir, byCommand.slot)).not.toHaveProperty([RECORD_NEED_RULE]);
  }, 180_000);

  test("render lists a check its rule judged beside the checks a command judged", async () => {
    const { context } = await workspaceWithRules();
    const cited = await runHandler(
      checkRun,
      { statement: "the tracked file says hello", command: TRACKED_IS_HELLO },
      context,
    );
    const checked = await runHandler(
      checkRun,
      { statement: CITES, rule: RECORD_NEED_RULE, parameters: cited.claim },
      context,
    );

    const rendered = await runHandler(renderMarkdown, {}, context);

    expect(rendered.claims).toContainEqual({ statement: CITES, label: "holds", reason: null, short: checked.short });
  }, 180_000);
});
