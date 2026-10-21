import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type OperationContext, openWorkspace, runHandler } from "@musai/api-core";
import { type RecordId, timestamp } from "@musai/records";
import { LOCAL_DIR, MUSAI_DIR, readTrustBranch, Store, writeMainFiles } from "@musai/store";
import {
  bindCheckouts,
  type Checkout,
  fixedClock,
  fixWorkspaceKey,
  makeCheckout,
  pseudonymOf,
  receiptIds,
} from "@musai/test-support";
import { execa } from "execa";
import { afterEach, describe, expect, test } from "vitest";
import { caseBook } from "../src/ops/case.js";
import { caseStatus } from "../src/ops/case-status.js";
import { checkRun } from "../src/ops/check.js";
import { claimStatus } from "../src/ops/claim.js";
import { moduleBuild } from "../src/ops/module.js";
import { viewRun } from "../src/ops/view.js";
import { claimWhy } from "../src/ops/why.js";
import { workspaceInit } from "../src/ops/workspace.js";

const scope = "default";
const now = fixedClock("2026-10-01T00:00:00.000Z");

/** Exits 0 while `tracked.txt` holds what the checkout committed. */
const TRACKED_IS_HELLO = ["node", "-e", "process.exit(require('fs').readFileSync('tracked.txt','utf8')==='hello'?0:1)"];
const TRACKED_IS_HELLO_TEXT = `node -e "process.exit(require('fs').readFileSync('tracked.txt','utf8')==='hello'?0:1)"`;

const checkouts: Checkout[] = [];
const scratch: string[] = [];

afterEach(async () => {
  for (const checkout of checkouts.splice(0)) {
    await checkout.cleanup();
  }
  for (const dir of scratch.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A repository with one commit, holding a workspace at its top level. */
async function repositoryWithWorkspace(): Promise<{ readonly dir: string; readonly context: OperationContext }> {
  const checkout = await makeCheckout("hello");
  checkouts.push(checkout);
  const context: OperationContext = { workspace: checkout.dir, scope, now, principalName: "operator" };
  await runHandler(workspaceInit, { workspace: checkout.dir }, context);
  await fixWorkspaceKey(checkout.dir);
  return { dir: checkout.dir, context };
}

/** The tooling the claim's check recipe names. */
async function toolingOf(workspace: string, slot: string): Promise<unknown> {
  const opened = await openWorkspace({ workspace, scope, now });
  const claim = opened.index.claimAtSlot(slot)!;
  if (claim.record.kind !== "claim") {
    throw new Error(`no claim at ${slot}`);
  }
  const parameters = JSON.parse(claim.record.conditions["musai.core/declarative"] as string) as {
    recipes: { recipe: { tooling?: string[] } }[];
  };
  return parameters.recipes[0]!.recipe.tooling ?? [];
}

async function runCount(workspace: string): Promise<number> {
  return (await receiptIds(new Store({ ctx: { gitDir: join(workspace, MUSAI_DIR) }, scope, now }))).length;
}

describe("check: a sentence and a command become a claim and a receipt", () => {
  test("check mints one claim per sentence per repository, and checking again reuses it while the tree is unchanged", async () => {
    const { dir, context } = await repositoryWithWorkspace();

    const first = await runHandler(
      checkRun,
      { statement: "the tracked file says hello", command: TRACKED_IS_HELLO },
      context,
    );
    const runsAfterFirst = await runCount(dir);
    const second = await runHandler(
      checkRun,
      { statement: "the tracked file says hello", command: TRACKED_IS_HELLO },
      context,
    );

    expect(first.label).toBe("holds");
    expect(first.short).toMatch(/^[0-9a-f]{12}$/);
    expect(second.claim).toBe(first.claim);
    expect(second.slot).toBe(first.slot);
    expect(await runCount(dir)).toBe(runsAfterFirst);
    const opened = await openWorkspace({ workspace: dir, scope, now });
    const claim = opened.index.claimAtSlot(first.slot)!;
    expect(claim.record.kind === "claim" && claim.record.type).toBe("musai.core/check@1");
    const root = (await execa("git", ["-C", dir, "rev-list", "--max-parents=0", "HEAD"])).stdout.trim();
    expect(claim.record.kind === "claim" && claim.record.conditions["subject"]).toBe(`git:${root}`);
  }, 120_000);

  test("a sentence typed decomposed is the claim the composed sentence makes", async () => {
    const { context } = await repositoryWithWorkspace();

    const decomposed = await runHandler(
      checkRun,
      { statement: "the cafe\u0301 file says hello", command: TRACKED_IS_HELLO },
      context,
    );
    const composed = await runHandler(
      checkRun,
      { statement: "the caf\u00e9 file says hello", command: TRACKED_IS_HELLO },
      context,
    );

    expect(decomposed.label).toBe("holds");
    expect(composed.claim).toBe(decomposed.claim);
  }, 120_000);

  test("check refuses a new command under a sentence it already checks, naming --replace, and mints nothing", async () => {
    const { dir, context } = await repositoryWithWorkspace();
    const first = await runHandler(
      checkRun,
      { statement: "the tracked file says hello", command: TRACKED_IS_HELLO },
      context,
    );
    const runsBefore = await runCount(dir);

    const refused = await runHandler(
      checkRun,
      { statement: "the tracked file says hello", command: ["true"] },
      context,
    ).catch((error: unknown) => error);

    expect(refused).toMatchObject({ reason: "invalid-input", about: [first.short] });
    expect((refused as Error).message).toContain("--replace");
    const opened = await openWorkspace({ workspace: dir, scope, now });
    expect(opened.index.claimAtSlot(first.slot)?.id).toBe(first.claim);
    expect(await runCount(dir)).toBe(runsBefore);
  }, 120_000);

  test("a run outliving the call's run deadline ends the call, its claim open with no receipt", async () => {
    const { dir, context } = await repositoryWithWorkspace();
    const runsBefore = await runCount(dir);

    const ended = await runHandler(
      checkRun,
      { statement: "a slow check holds", command: ["sleep", "30"] },
      { ...context, runTimeoutMs: 200 },
    ).catch((error: unknown) => error);

    expect(ended).toMatchObject({ reason: "over-budget" });
    expect((ended as Error).message).toContain("outlived its 200 ms deadline");
    expect(await runCount(dir)).toBe(runsBefore);
    const status = await runHandler(claimStatus, { claim: "a slow check holds" }, { ...context, mode: "plan" });
    expect(status.label).toBe("open");
  }, 120_000);

  test("check with replace runs the new command under the sentence from then on", async () => {
    const { context } = await repositoryWithWorkspace();
    const first = await runHandler(
      checkRun,
      { statement: "the tracked file says hello", command: TRACKED_IS_HELLO },
      context,
    );

    const replaced = await runHandler(
      checkRun,
      { statement: "the tracked file says hello", command: ["true"], replace: true },
      context,
    );
    const again = await runHandler(checkRun, { statement: "the tracked file says hello", command: ["true"] }, context);

    expect(replaced.slot).toBe(first.slot);
    expect(replaced.claim).not.toBe(first.claim);
    expect(again.claim).toBe(replaced.claim);
  }, 120_000);

  test("a tool named beside the same command is no new command", async () => {
    const { context } = await repositoryWithWorkspace();
    await runHandler(checkRun, { statement: "printf runs", command: ["printf", "ok"] }, context);

    const widened = await runHandler(
      checkRun,
      { statement: "printf runs", command: ["printf", "ok"], tool: ["node"] },
      context,
    );

    expect(widened.label).toBe("holds");
  }, 120_000);

  test("check with a salt mints a salted claim and checks it as it checks any", async () => {
    const { dir, context } = await repositoryWithWorkspace();

    const checked = await runHandler(
      checkRun,
      { statement: "the tracked file says hello", command: TRACKED_IS_HELLO, salt: true },
      context,
    );

    expect(checked.label).toBe("holds");
    const opened = await openWorkspace({ workspace: dir, scope, now });
    expect(opened.read(checked.claim as RecordId)).toMatchObject({
      kind: "claim",
      salt: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  }, 120_000);

  test("check with a salt mints the salted claim where an unsalted one holds the slot, and reuses it after", async () => {
    const { dir, context } = await repositoryWithWorkspace();
    const asked = { statement: "the tracked file says hello", command: TRACKED_IS_HELLO };
    const unsalted = await runHandler(checkRun, asked, context);

    const salted = await runHandler(checkRun, { ...asked, salt: true }, context);
    const saltedAgain = await runHandler(checkRun, { ...asked, salt: true }, context);
    const plain = await runHandler(checkRun, asked, context);

    expect(salted.slot).toBe(unsalted.slot);
    expect(salted.claim).not.toBe(unsalted.claim);
    expect(saltedAgain.claim).toBe(salted.claim);
    expect(plain.claim).toBe(salted.claim);
    const opened = await openWorkspace({ workspace: dir, scope, now });
    expect(opened.read(salted.claim as RecordId)).toMatchObject({
      kind: "claim",
      salt: expect.stringMatching(/^[0-9a-f]{64}$/),
      supersedes: [unsalted.claim],
    });
  }, 120_000);

  test("a clone of the project and its store checks the same claim, loading its packs with no blobs directory", async () => {
    const { dir, context } = await repositoryWithWorkspace();
    const checked = { statement: "the tracked file says hello", command: TRACKED_IS_HELLO };
    const first = await runHandler(checkRun, checked, context);
    const clone = await mkdtemp(join(tmpdir(), "musai-check-clone-"));
    scratch.push(clone);
    await execa("git", ["clone", "--quiet", dir, join(clone, "project")]);
    const project = join(clone, "project");
    await execa("git", ["clone", "--quiet", "--bare", join(dir, MUSAI_DIR), join(project, MUSAI_DIR)]);

    const again = await runHandler(checkRun, checked, { ...context, workspace: project });

    expect(again.label).toBe("holds");
    expect(again.claim).toBe(first.claim);
    for (const holder of [dir, join(dir, MUSAI_DIR), project, join(project, MUSAI_DIR)]) {
      expect(await readdir(holder)).not.toContain("blobs");
    }
    expect(await readdir(join(project, MUSAI_DIR, LOCAL_DIR))).toContain("blobs");
  });

  test("check on an edited tree re-runs and can turn holds into fails", async () => {
    const { dir, context } = await repositoryWithWorkspace();
    const before = await runHandler(
      checkRun,
      { statement: "the tracked file says hello", command: TRACKED_IS_HELLO },
      context,
    );

    await writeFile(join(dir, "tracked.txt"), "goodbye");
    const after = await runHandler(
      checkRun,
      { statement: "the tracked file says hello", command: TRACKED_IS_HELLO },
      context,
    );

    expect(before.label).toBe("holds");
    expect(after.label).toBe("fails");
    expect(after.slot).toBe(before.slot);
  }, 120_000);

  test("a tree returned to what an earlier receipt measured reuses that receipt, running nothing", async () => {
    const { dir, context: fixed } = await repositoryWithWorkspace();
    // A clock that moves, so a re-run mints a run of its own rather than the bytes of the first.
    let second = 0;
    const context = { ...fixed, now: () => timestamp(new Date(Date.UTC(2026, 9, 1, 0, 0, second++)).toISOString()) };
    const sentence = { statement: "the tracked file says hello", command: TRACKED_IS_HELLO };
    const first = await runHandler(checkRun, sentence, context);
    await writeFile(join(dir, "tracked.txt"), "goodbye");
    await runHandler(checkRun, sentence, context);
    const runs = await runCount(dir);

    await writeFile(join(dir, "tracked.txt"), "hello");
    const read = await runHandler(claimStatus, { claim: first.short }, { ...context, mode: "plan" });
    const restored = await runHandler(checkRun, sentence, context);

    expect(read.label).toBe("holds");
    expect(restored.label).toBe("holds");
    expect(await runCount(dir)).toBe(runs);
  }, 120_000);

  test("check exits 0 when its claim holds and 7 when it fails", async () => {
    const { dir, context } = await repositoryWithWorkspace();
    const holds = await runHandler(
      checkRun,
      { statement: "the tracked file says hello", command: TRACKED_IS_HELLO },
      context,
    );
    await writeFile(join(dir, "tracked.txt"), "goodbye");
    const fails = await runHandler(
      checkRun,
      { statement: "the tracked file says hello", command: TRACKED_IS_HELLO },
      context,
    );

    expect(checkRun.exitCode(holds)).toBe(0);
    expect(checkRun.exitCode(fails)).toBe(7);
  }, 120_000);

  test("status exits 7 for a claim that does not hold and 0 for one that holds", async () => {
    const { dir, context } = await repositoryWithWorkspace();
    const checked = await runHandler(
      checkRun,
      { statement: "the tracked file says hello", command: TRACKED_IS_HELLO },
      context,
    );
    const holds = await runHandler(claimStatus, { claim: checked.short }, { ...context, mode: "plan" });
    await writeFile(join(dir, "tracked.txt"), "goodbye");
    const stale = await runHandler(claimStatus, { claim: checked.short }, { ...context, mode: "plan" });

    expect(claimStatus.exitCode(holds)).toBe(0);
    expect(stale.label).toBe("open");
    expect(claimStatus.exitCode(stale)).toBe(7);
  }, 120_000);

  test("status reads as check's line, naming the run that decided by the short id why prints", async () => {
    const { dir, context } = await repositoryWithWorkspace();
    await writeFile(join(dir, "tracked.txt"), "goodbye");
    const checked = await runHandler(
      checkRun,
      { statement: "the tracked file says hello", command: TRACKED_IS_HELLO },
      context,
    );
    const status = await runHandler(claimStatus, { claim: checked.short }, { ...context, mode: "plan" });
    const why = await runHandler(claimWhy, { claim: checked.short }, { ...context, mode: "plan" });
    const decider = why.runs.find((run) => !run.agrees)!;

    expect(status.short).toBe(checked.short);
    expect(status.decidedBy).toEqual({ kind: "run", id: decider.id, command: TRACKED_IS_HELLO });
    expect(claimStatus.renderText(status)).toBe(
      `✗ fails · ${checked.short} · run ${decider.id.slice(7, 19)} · ${TRACKED_IS_HELLO_TEXT}`,
    );
    expect(claimWhy.renderText(why)).toContain(`run ${decider.id.slice(7, 19)} · ${TRACKED_IS_HELLO_TEXT} ·`);
  }, 120_000);

  test("status prints the command a check's deciding run ran beside its verdict", async () => {
    const { context } = await repositoryWithWorkspace();
    const checked = await runHandler(checkRun, { statement: "tests pass", command: ["true"] }, context);

    const status = await runHandler(claimStatus, { claim: checked.short }, { ...context, mode: "plan" });

    expect(claimStatus.renderText(status)).toMatch(
      new RegExp(`^✓ holds · ${checked.short} · run [0-9a-f]{12} · true$`),
    );
  }, 120_000);

  test("status prints a command on its one line, every argument a shell would split or a terminal obey quoted and escaped", () => {
    const text = claimStatus.renderText({
      label: "holds",
      reason: null,
      short: "0123456789ab",
      decidedBy: {
        kind: "run",
        id: `sha256:${"cd".repeat(32)}`,
        command: ["sh", "-c", "echo ok\n✓ holds", "\u009b2J", ""],
      },
      comparison: { winner: "(none)", rival: null, via: "evidence", corroborated: [] },
    });

    expect(text).toBe(`✓ holds · 0123456789ab · run cdcdcdcdcdcd · sh -c "echo ok\\n✓ holds" "\\u009b2J" ""`);
  });

  test("a claim with nothing to decide it prints check's open line and names no record", () => {
    const text = claimStatus.renderText({
      label: "open",
      reason: "no-evidence",
      short: "0123456789ab",
      decidedBy: null,
      comparison: { winner: "(none)", rival: null, via: "no evidence", corroborated: [] },
    });

    expect(text).toBe("◌ open · 0123456789ab — no-evidence");
  });

  test("check names a program no module declares to the workspace's tools, and says so once", async () => {
    const { dir, context } = await repositoryWithWorkspace();
    const command = ["git", "rev-parse", "--is-inside-work-tree"];

    const first = await runHandler(checkRun, { statement: "this is a git work tree", command }, context);
    const second = await runHandler(checkRun, { statement: "this is a git work tree", command }, context);

    expect(first.toolsAdded).toEqual([]);
    expect(second.toolsAdded).toEqual([]);
    const printf = await runHandler(checkRun, { statement: "printf runs", command: ["printf", "ok"] }, context);
    expect(printf.toolsAdded).toEqual(["printf"]);
    expect((await readTrustBranch({ gitDir: join(dir, MUSAI_DIR) })).config.values["tools"]).toEqual(["printf"]);
  }, 120_000);

  test("a principal without configure-floor cannot widen the toolset, and the refusal names the line to add", async () => {
    const { dir, context } = await repositoryWithWorkspace();
    const gitDir = join(dir, MUSAI_DIR);
    await writeMainFiles({ gitDir }, { roles: "someone-else owner any\n" }, now);

    const refusal = await runHandler(checkRun, { statement: "printf runs", command: ["printf", "ok"] }, context).catch(
      (error: unknown) => error,
    );

    expect(refusal).toMatchObject({ reason: "not-authorised" });
    expect(String((refusal as Error).message)).toContain(`"tools": ["printf"]`);
    expect((await readTrustBranch({ gitDir })).config.values["tools"]).toBeUndefined();
  }, 120_000);

  test("a principal holding owner widens the toolset", async () => {
    const { dir, context } = await repositoryWithWorkspace();
    const gitDir = join(dir, MUSAI_DIR);
    await writeMainFiles({ gitDir }, { roles: `${pseudonymOf("operator")} owner any\n` }, now);

    const checked = await runHandler(checkRun, { statement: "printf runs", command: ["printf", "ok"] }, context);

    expect(checked).toMatchObject({ label: "holds", toolsAdded: ["printf"] });
  }, 120_000);

  test("a program that resolves nowhere is refused and never joins the toolset, so a later check still runs", async () => {
    const { dir, context } = await repositoryWithWorkspace();
    const gitDir = join(dir, MUSAI_DIR);
    const before = await readTrustBranch({ gitDir });

    const typo = await runHandler(
      checkRun,
      { statement: "a typo runs", command: ["musai-no-such-program"] },
      context,
    ).catch((error: unknown) => error);
    const named = await runHandler(
      checkRun,
      { statement: "a named tool runs", command: ["printf", "ok"], tool: ["musai-no-such-program"] },
      context,
    ).catch((error: unknown) => error);

    expect(typo).toMatchObject({ reason: "tool-unavailable", about: ["musai-no-such-program"] });
    expect(named).toMatchObject({ reason: "tool-unavailable", about: ["musai-no-such-program"] });
    expect((await readTrustBranch({ gitDir })).commit).toBe(before.commit);
    const later = await runHandler(checkRun, { statement: "printf runs", command: ["printf", "ok"] }, context);
    expect(later).toMatchObject({ label: "holds", toolsAdded: ["printf"] });
  }, 120_000);

  test("a new program is admitted only when the whole recipe resolves, so a toolset program gone missing admits nothing", async () => {
    const { dir, context } = await repositoryWithWorkspace();
    const gitDir = join(dir, MUSAI_DIR);
    await writeMainFiles({ gitDir }, { "config.json": `${JSON.stringify({ tools: ["musai-gone"] })}\n` }, now);
    const before = await readTrustBranch({ gitDir });

    const refusal = await runHandler(checkRun, { statement: "printf runs", command: ["printf", "ok"] }, context).catch(
      (error: unknown) => error,
    );

    expect(refusal).toMatchObject({ reason: "tool-unavailable", about: ["musai-gone"] });
    expect((await readTrustBranch({ gitDir })).commit).toBe(before.commit);
  }, 120_000);

  test("a model's relay checks with programs the toolset already admits", async () => {
    const { dir, context } = await repositoryWithWorkspace();
    const gitDir = join(dir, MUSAI_DIR);
    await runHandler(checkRun, { statement: "printf runs", command: ["printf", "ok"] }, { ...context, via: "tty" });

    const relayed = await runHandler(
      checkRun,
      { statement: "printf still runs", command: ["printf", "ok"] },
      { ...context, via: "model" },
    );

    expect(relayed).toMatchObject({ label: "holds", toolsAdded: [] });
    expect((await readTrustBranch({ gitDir })).config.values["tools"]).toEqual(["printf"]);
  }, 120_000);

  test("a script run through sh passes once sh is named as a tool the check reaches for", async () => {
    const { dir, context } = await repositoryWithWorkspace();
    const command = [
      "node",
      "-e",
      "process.exit(require('child_process').spawnSync('sh', ['-c', 'exit 0']).status === 0 ? 0 : 1)",
    ];

    const without = await runHandler(checkRun, { statement: "sh runs", command }, context);
    const withSh = await runHandler(checkRun, { statement: "sh runs", command, tool: ["sh"] }, context);

    expect(without.label).toBe("fails");
    expect(withSh.label).toBe("holds");
    expect(withSh.toolsAdded).toEqual(["sh"]);
    expect((await readTrustBranch({ gitDir: join(dir, MUSAI_DIR) })).config.values["tools"]).toEqual(["sh"]);
  }, 120_000);

  test("a check recipe lists the workspace's toolset as tooling, less its own program", async () => {
    const { dir, context } = await repositoryWithWorkspace();
    await writeMainFiles(
      { gitDir: join(dir, MUSAI_DIR) },
      { "config.json": `${JSON.stringify({ tools: ["sh", "printf"] })}\n` },
      now,
    );

    const checked = await runHandler(checkRun, { statement: "printf runs", command: ["printf", "ok"] }, context);

    expect(await toolingOf(dir, checked.slot)).toEqual(["sh"]);
  }, 120_000);

  test("a widened toolset makes the next check a successor at the same slot", async () => {
    const { dir, context } = await repositoryWithWorkspace();
    const first = await runHandler(
      checkRun,
      { statement: "the tracked file says hello", command: TRACKED_IS_HELLO },
      context,
    );

    const second = await runHandler(
      checkRun,
      { statement: "the tracked file says hello", command: TRACKED_IS_HELLO, tool: ["sh"] },
      context,
    );

    expect(second.slot).toBe(first.slot);
    expect(second.claim).not.toBe(first.claim);
    const opened = await openWorkspace({ workspace: dir, scope, now });
    const successor = opened.index.claimAtSlot(second.slot)!;
    expect(successor.record.kind === "claim" && successor.record.supersedes).toEqual([first.claim]);
    expect(await toolingOf(dir, second.slot)).toEqual(["sh"]);
  }, 120_000);

  test("a failing check whose program is missing from its PATH names it in a hint", async () => {
    const { context } = await repositoryWithWorkspace();

    const checked = await runHandler(
      checkRun,
      { statement: "a program nobody has runs", command: ["env", "musai-no-such-program"] },
      context,
    );

    expect(checked.label).toBe("fails");
    expect(checked.hint).toBe(
      "exit and output suggest a program missing from the declared PATH: musai-no-such-program? Add it with --tool or to the workspace toolset, or to .musai/local/tools.json where only this machine needs it.",
    );
  }, 120_000);

  test("a check failing for its own reason carries no hint", async () => {
    const { dir, context } = await repositoryWithWorkspace();
    await writeFile(join(dir, "tracked.txt"), "goodbye");

    const checked = await runHandler(
      checkRun,
      { statement: "the tracked file says hello", command: TRACKED_IS_HELLO },
      context,
    );

    expect(checked.label).toBe("fails");
    expect(checked.hint).toBeNull();
  }, 120_000);

  test("check refuses a tree binding another checkout holds, naming it, and leaves the binding", async () => {
    const { dir, context } = await repositoryWithWorkspace();
    const other = await mkdtemp(join(tmpdir(), "musai-other-checkout-"));
    scratch.push(other);
    const checkouts = join(dir, MUSAI_DIR, "local", "checkouts.json");
    await bindCheckouts(join(dir, MUSAI_DIR, "local"), { tree: other });

    const refusal = await runHandler(
      checkRun,
      { statement: "the tracked file says hello", command: TRACKED_IS_HELLO },
      context,
    ).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ reason: "declaration-conflict" });
    expect((refusal as Error).message).toContain(other);
    expect(JSON.parse(await readFile(checkouts, "utf8"))).toEqual({ tree: { directory: other } });
  }, 120_000);

  test("check refuses a program named by a path, writing nothing, and the workspace still opens", async () => {
    const { dir, context } = await repositoryWithWorkspace();

    const refusal = await runHandler(checkRun, { statement: "the script passes", command: ["./t.sh"] }, context).catch(
      (error: unknown) => error,
    );
    const viaTool = await runHandler(
      checkRun,
      { statement: "the script passes", command: ["node", "t.js"], tool: ["./sh"] },
      context,
    ).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ reason: "invalid-input" });
    expect((refusal as Error).message).toContain("sh ./t.sh");
    expect(viaTool).toMatchObject({ reason: "invalid-input" });
    expect((await readTrustBranch({ gitDir: join(dir, MUSAI_DIR) })).config.values["tools"]).toBeUndefined();
    await expect(openWorkspace({ workspace: dir, scope, now })).resolves.toBeDefined();
  }, 120_000);

  test("check outside a workspace is refused naming init", async () => {
    const checkout = await makeCheckout("hello");
    checkouts.push(checkout);
    const context: OperationContext = { workspace: checkout.dir, scope, now, principalName: "operator" };

    const refusal = await runHandler(checkRun, { statement: "anything", command: ["node"] }, context).catch(
      (error: unknown) => error,
    );

    expect(refusal).toMatchObject({ reason: "workspace-incomplete" });
  }, 120_000);

  test("check in a repository with no commit is refused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "musai-check-no-commit-"));
    scratch.push(dir);
    await execa("git", ["init", "--quiet", dir]);
    const context: OperationContext = { workspace: dir, scope, now, principalName: "operator" };
    await runHandler(workspaceInit, { workspace: dir }, context);

    const refusal = await runHandler(checkRun, { statement: "anything", command: ["node", "-e", ""] }, context).catch(
      (error: unknown) => error,
    );

    expect(refusal).toMatchObject({ reason: "invalid-input" });
    expect((refusal as Error).message).toContain("no commit");
    await expect(readFile(join(dir, MUSAI_DIR, "local", "checkouts.json"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 120_000);

  test("a checked claim read without performing answers as its last receipt, spawning nothing", async () => {
    const { dir, context } = await repositoryWithWorkspace();
    const checked = await runHandler(
      checkRun,
      { statement: "the tracked file says hello", command: TRACKED_IS_HELLO },
      context,
    );
    const runs = await runCount(dir);

    const read = await runHandler(claimStatus, { claim: checked.short }, { ...context, mode: "plan" });

    expect(read.label).toBe("holds");
    expect(await runCount(dir)).toBe(runs);
  }, 120_000);

  test("a check whose command writes into the tree it read names what it wrote in a hint", async () => {
    const { context } = await repositoryWithWorkspace();
    const output = await runHandler(
      checkRun,
      {
        statement: "the build writes its output",
        command: ["node", "-e", "require('fs').writeFileSync('out.txt','x')"],
      },
      context,
    );

    expect(output.label).toBe("holds");
    expect(output.hint).toBe(
      "the tree moved while the command ran, so the claim reads stale from now on: out.txt; ignore it in git, or have the command write it outside the tree",
    );
  }, 120_000);

  test("a check whose command leaves the tree as it read it carries no hint", async () => {
    const { context } = await repositoryWithWorkspace();
    const output = await runHandler(
      checkRun,
      { statement: "the tracked file says hello", command: TRACKED_IS_HELLO },
      context,
    );

    expect(output).toMatchObject({ label: "holds", hint: null });
  }, 120_000);

  test("a checked claim reads stale when the tree it read moves and nothing has re-run it", async () => {
    const { dir, context } = await repositoryWithWorkspace();
    const checked = await runHandler(
      checkRun,
      { statement: "the tracked file says hello", command: TRACKED_IS_HELLO },
      context,
    );
    const runs = await runCount(dir);

    await writeFile(join(dir, "tracked.txt"), "goodbye");
    const read = await runHandler(claimStatus, { claim: checked.short }, { ...context, mode: "plan" });

    expect(read).toMatchObject({ label: "open", reason: "stale" });
    expect(await runCount(dir)).toBe(runs);
  }, 120_000);

  test("a case whose checks' tree moved reads stale in list as in progress --plan, and neither runs anything", async () => {
    const { dir, context } = await repositoryWithWorkspace();
    await runHandler(moduleBuild, { dir: fileURLToPath(new URL("./fixtures/tree-command", import.meta.url)) }, context);
    await runHandler(caseBook, { slug: "watched", kind: "tree-command/watch" }, context);
    expect((await runHandler(caseStatus, { case: "watched" }, context)).done).toBe(true);
    const runs = await runCount(dir);

    await writeFile(join(dir, "tracked.txt"), "goodbye");
    const previewed = await runHandler(caseStatus, { case: "watched" }, { ...context, mode: "plan" });
    const listed = await runHandler(viewRun, {}, context);

    expect(previewed).toMatchObject({ done: false, reason: "claim-stale", counts: { holds: 0, open: 2 } });
    expect(caseStatus.renderText!(previewed).split("\n")[0]).toBe(
      "no gate awaits an answer, and a check reads stale until it runs again",
    );
    expect(listed.rows).toEqual([expect.objectContaining({ slug: "watched", status: "open", reason: "claim-stale" })]);
    expect(await runCount(dir)).toBe(runs);
  }, 240_000);

  test("why answers a failing check with its sentence, command, exit code and the output's last lines", async () => {
    const { context } = await repositoryWithWorkspace();
    const command = ["node", "-e", "for (let i = 1; i <= 7; i++) console.log('line ' + i); process.exit(1)"];
    const checked = await runHandler(checkRun, { statement: "seven lines are printed", command }, context);

    const why = await runHandler(claimWhy, { claim: checked.short }, { ...context, mode: "plan" });
    const text = claimWhy.renderText(why);

    expect(why).toMatchObject({ statement: "seven lines are printed", label: "fails", short: checked.short });
    expect("runs" in why && why.runs).toMatchObject([
      { command, exitCode: 1, outputTail: ["line 3", "line 4", "line 5", "line 6", "line 7"] },
    ]);
    expect(text.split("\n")[0]).toBe(`✗ fails · seven lines are printed (${checked.short})`);
    expect(text).toContain(
      `· node -e "for (let i = 1; i <= 7; i++) console.log('line ' + i); process.exit(1)" · exit 1`,
    );
    expect(text).toContain("line 7");
    expect("derivation" in why).toBe(false);
  }, 120_000);

  test("why --full answers the derivation tree with each run's details beneath its run", async () => {
    const { context } = await repositoryWithWorkspace();
    const checked = await runHandler(
      checkRun,
      { statement: "the tracked file says hello", command: TRACKED_IS_HELLO },
      context,
    );

    const why = await runHandler(claimWhy, { claim: checked.short, full: true }, { ...context, mode: "plan" });
    const lines = claimWhy.renderText(why).split("\n");

    expect("derivation" in why && why.derivation?.label).toBe("claim");
    const runLine = lines.findIndex((line) => /^\s+run sha256:/.test(line));
    expect(runLine).toBeGreaterThan(0);
    expect(lines[runLine + 1]).toMatch(/^\s+node -e .+ · exit 0 · tree [0-9a-f]{12}$/);
  }, 120_000);

  test("why names the tree that moved, with the digest its receipt recorded and the one it measures", async () => {
    const { dir, context } = await repositoryWithWorkspace();
    const checked = await runHandler(
      checkRun,
      { statement: "the tracked file says hello", command: TRACKED_IS_HELLO },
      context,
    );
    const committed = (await execa("git", ["-C", dir, "rev-parse", "HEAD^{tree}"])).stdout.trim();

    await writeFile(join(dir, "tracked.txt"), "goodbye");
    const why = JSON.stringify(await runHandler(claimWhy, { claim: checked.short }, { ...context, mode: "plan" }));

    expect(why).toContain("the working tree `tree` moved");
    expect(why).toContain(committed);
  }, 120_000);
});
