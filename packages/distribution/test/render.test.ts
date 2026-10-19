import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OperationContext, openWorkspace, runHandler } from "@musai/api-core";
import { type CaseRecord, CURRENT_SCHEMA_VERSIONS, type RecordId, recordId, versionString } from "@musai/records";
import { MUSAI_DIR, Store } from "@musai/store";
import { type Checkout, fixedClock, makeCheckout } from "@musai/test-support";
import { afterEach, describe, expect, onTestFinished, test } from "vitest";
import { checkRun } from "../src/ops/check.js";
import { renderMarkdown } from "../src/ops/render.js";
import { workspaceInit } from "../src/ops/workspace.js";
import { renderDossier } from "../src/view/render.js";

const scope = "default";
const now = fixedClock("2026-10-01T00:00:00.000Z");
const TRACKED_IS_HELLO = ["node", "-e", "process.exit(require('fs').readFileSync('tracked.txt','utf8')==='hello'?0:1)"];

const checkouts: Checkout[] = [];

afterEach(async () => {
  for (const checkout of checkouts.splice(0)) {
    await checkout.cleanup();
  }
});

async function checkedRepository(
  statement: string,
): Promise<{ dir: string; context: OperationContext; claim: string }> {
  const checkout = await makeCheckout("hello");
  checkouts.push(checkout);
  const context: OperationContext = { workspace: checkout.dir, scope, now, principalName: "operator" };
  await runHandler(workspaceInit, { workspace: checkout.dir }, context);
  const checked = await runHandler(checkRun, { statement, command: TRACKED_IS_HELLO }, context);
  return { dir: checkout.dir, context, claim: checked.claim };
}

async function runCount(workspace: string): Promise<number> {
  return (await new Store({ ctx: { gitDir: join(workspace, MUSAI_DIR) }, scope, now }).list("run")).length;
}

describe("render: what the receipts say, marked, never performed", () => {
  test("render marks a moved tree's claim stale without running it", async () => {
    const { dir, context } = await checkedRepository("the tracked file says hello");
    const before = await runHandler(renderMarkdown, {}, context);
    const runs = await runCount(dir);

    await writeFile(join(dir, "tracked.txt"), "goodbye");
    const after = await runHandler(renderMarkdown, {}, context);

    expect(before.markdown).toMatch(
      /^- \[x\] ✓ the tracked file says hello · `node -e ".+"` — `musai why [0-9a-f]{12}`$/,
    );
    expect(after.markdown).toMatch(
      /^- \[ \] ◌ the tracked file says hello \(stale\) · `node -e ".+"` — `musai why [0-9a-f]{12}`$/,
    );
    expect(await runCount(dir)).toBe(runs);
  }, 120_000);

  test("the checklist names each claim's sentence, label and short id, line for line", async () => {
    const { dir, context } = await checkedRepository("the tracked file says hello");
    await writeFile(join(dir, "tracked.txt"), "goodbye");
    await runHandler(checkRun, { statement: "the tracked file is never empty", command: ["true"] }, context);

    const rendered = await runHandler(renderMarkdown, {}, context);

    const lines = rendered.markdown.split("\n");
    expect(rendered.claims).toHaveLength(lines.length);
    for (const [index, claim] of (rendered.claims ?? []).entries()) {
      expect(lines[index]).toContain(claim.statement);
      expect(lines[index]).toContain(`\`musai why ${claim.short}\``);
      expect(lines[index]).toContain(
        claim.label === "open" ? `(${claim.reason})` : claim.label === "holds" ? "✓" : "✗",
      );
    }
    expect(rendered.claims?.map(({ label, reason }) => `${label} ${reason}`).sort()).toEqual([
      "holds null",
      "open stale",
    ]);
  }, 120_000);

  test("a sentence carrying a line break or markup renders as text", async () => {
    const { context } = await checkedRepository("two\nlines, **bold** and <b>");

    const rendered = await runHandler(renderMarkdown, {}, context);

    expect(rendered.markdown.split("\n")).toHaveLength(1);
    expect(rendered.markdown).toContain("two\\nlines, \\*\\*bold\\*\\* and \\<b\\>");
  }, 120_000);

  test("a checklist line shows beside a check's verdict the command its deciding run ran", async () => {
    const { context } = await checkedRepository("the tracked file says hello");
    await runHandler(checkRun, { statement: "tests pass", command: ["true"] }, context);

    const rendered = await runHandler(renderMarkdown, {}, context);

    expect(rendered.markdown).toContain("✓ tests pass · `true` — `musai why ");
  }, 120_000);

  test("a command carrying backticks or markup renders inside one code span, as written", async () => {
    const { context } = await checkedRepository("the tracked file says hello");
    const command = ["node", "-e", "console.log('`**not bold**` <b>')"];
    await runHandler(checkRun, { statement: "it prints", command }, context);

    const rendered = await runHandler(renderMarkdown, {}, context);

    expect(rendered.markdown).toContain("✓ it prints · ``node -e \"console.log('`**not bold**` <b>')\"`` — ");
  }, 120_000);

  test("a markdown file's footnote resolving to a checked claim is marked, and the rest is left as written", async () => {
    const { context, claim } = await checkedRepository("the tracked file says hello");
    const label = claim.slice("sha256:".length, "sha256:".length + 12);
    // Outside the checked tree, which a new file inside would move.
    const notes = await mkdtemp(join(tmpdir(), "musai-render-notes-"));
    onTestFinished(() => rm(notes, { recursive: true, force: true }));
    const file = join(notes, "NOTES.md");
    const body = `The tracked file says hello.[^${label}] Nothing else is claimed.[^ffffffffffff]\n`;
    const receipts = `\n## Receipts\n\n[^${label}]: ${claim}\n`;
    await writeFile(file, body + receipts);

    const rendered = await runHandler(renderMarkdown, { file }, context);

    expect(rendered.markdown).toBe(
      `The tracked file says hello.✓[^${label}] Nothing else is claimed.[^ffffffffffff]\n${receipts}`,
    );
    expect(rendered.claims).toBeUndefined();
  }, 120_000);
});

describe("the dossier: each claim's verdict beside what decided it", () => {
  test("a checked claim reads as its receipts say, with the command that decided it, running nothing", async () => {
    const { dir, claim } = await checkedRepository("the tracked file says hello");
    const caseRecord: CaseRecord = {
      kind: "case",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.case,
      type: null,
      slug: "checked-case",
      claims: [claim as RecordId],
      preset: { module: "musai.core", contribution: "musai.core/bare", moduleRecord: recordId({ marker: "dossier" }) },
      projectCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      overrides: {},
      evaluatorVersion: versionString("1"),
    };
    const store = new Store({ ctx: { gitDir: join(dir, MUSAI_DIR) }, scope, now });
    const [caseId] = await store.putMany([{ kind: "case", value: caseRecord }]);
    const runs = await runCount(dir);
    const opened = await openWorkspace({ workspace: dir, scope, now });
    try {
      const dossier = await renderDossier(opened, caseId!, caseRecord, []);

      expect(dossier).toMatch(/^- the tracked file says hello — holds · `node -e ".+"`$/m);
      expect(await runCount(dir)).toBe(runs);
    } finally {
      opened.close();
    }
  }, 120_000);
});
