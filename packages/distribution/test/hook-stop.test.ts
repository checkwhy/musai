import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type OperationContext, runHandler } from "@musai/api-core";
import { type Checkout, fixedClock, makeCheckout } from "@musai/test-support";
import { afterEach, describe, expect, test } from "vitest";
import { lastTurn } from "../src/hook/transcript.js";
import { checkRun } from "../src/ops/check.js";
import { hookStop } from "../src/ops/hook.js";
import { workspaceInit } from "../src/ops/workspace.js";

type Line = Record<string, unknown>;

function person(text: string, at: string): Line {
  return { type: "user", timestamp: at, message: { role: "user", content: text } };
}

function said(text: string, at: string): Line {
  return { type: "assistant", timestamp: at, message: { role: "assistant", content: [{ type: "text", text }] } };
}

function ran(command: string, at: string): Line[] {
  return [
    {
      type: "assistant",
      timestamp: at,
      message: { role: "assistant", content: [{ type: "tool_use", id: command, name: "Bash", input: { command } }] },
    },
    {
      type: "user",
      timestamp: at,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: command, content: "ok" }] },
    },
  ];
}

function jsonl(lines: readonly Line[]): string {
  return lines.map((line) => JSON.stringify(line)).join("\n");
}

describe("the transcript's last turn", () => {
  test("starts at the person's last message, never at a tool result", () => {
    const turn = lastTurn(
      jsonl([
        person("fix it", "2026-10-05T12:00:00.000Z"),
        ...ran("pnpm test", "2026-10-05T12:00:30.000Z"),
        said("All tests pass.", "2026-10-05T12:01:00.000Z"),
      ]),
    );

    expect(turn).toEqual({
      startedAt: "2026-10-05T12:00:00.000Z",
      closingText: "All tests pass.",
      commands: ["pnpm test"],
    });
  });

  test("closes on what was said after the turn's last command", () => {
    const turn = lastTurn(
      jsonl([
        person("fix it", "2026-10-05T12:00:00.000Z"),
        said("The tests pass.", "2026-10-05T12:00:10.000Z"),
        ...ran("git commit -m fix", "2026-10-05T12:00:20.000Z"),
        said("Committed.", "2026-10-05T12:00:30.000Z"),
      ]),
    );

    expect(turn?.closingText).toBe("Committed.");
  });

  test("skips a line that is not JSON", () => {
    const turn = lastTurn(
      `not json\n${jsonl([person("go", "2026-10-05T12:00:00.000Z"), said("Done.", "2026-10-05T12:00:01.000Z")])}`,
    );

    expect(turn?.closingText).toBe("Done.");
  });
});

describe("the Stop hook: a pass sentence with no receipt this turn is stopped once", () => {
  const checkouts: Checkout[] = [];

  afterEach(async () => {
    for (const checkout of checkouts.splice(0)) {
      await checkout.cleanup();
    }
  });

  async function workspace(at = "2026-10-05T11:00:00.000Z"): Promise<{ dir: string; context: OperationContext }> {
    const made = await makeCheckout();
    checkouts.push(made);
    const context: OperationContext = { workspace: made.dir, scope: "default", now: fixedClock(at) };
    await runHandler(workspaceInit, { workspace: made.dir }, context);
    return { dir: made.dir, context };
  }

  async function transcript(dir: string, lines: readonly Line[]): Promise<string> {
    const path = join(dir, "transcript.jsonl");
    await writeFile(path, jsonl(lines));
    return path;
  }

  test("blocks a pass sentence with no receipt this turn", async () => {
    const { dir, context } = await workspace();
    const path = await transcript(dir, [
      person("make the suite green", "2026-10-05T12:00:00.000Z"),
      ...ran("pnpm test", "2026-10-05T12:00:30.000Z"),
      said("Fixed the parser. All tests pass now.", "2026-10-05T12:01:00.000Z"),
    ]);

    const output = await runHandler(hookStop, { hook: { transcript_path: path } }, context);

    expect(output.decision).toBe("block");
    expect(output.reason).toContain('musai check "All tests pass now." -- pnpm test');
  }, 60_000);

  test("passes when a receipt was minted after the person's last message", async () => {
    const { dir, context } = await workspace();
    await runHandler(
      checkRun,
      { statement: "true holds", command: ["true"] },
      { ...context, now: fixedClock("2026-10-05T12:00:40.000Z") },
    );
    const path = await transcript(dir, [
      person("make the suite green", "2026-10-05T12:00:00.000Z"),
      ...ran("pnpm test", "2026-10-05T12:00:30.000Z"),
      said("All tests pass.", "2026-10-05T12:01:00.000Z"),
    ]);

    const output = await runHandler(hookStop, { hook: { transcript_path: path } }, context);

    expect(output).toEqual({});
  }, 60_000);

  test("blocks when the only receipt was minted before the person's last message", async () => {
    const { dir, context } = await workspace();
    await runHandler(
      checkRun,
      { statement: "true holds", command: ["true"] },
      { ...context, now: fixedClock("2026-10-05T11:30:00.000Z") },
    );
    const path = await transcript(dir, [
      person("and now?", "2026-10-05T12:00:00.000Z"),
      said("The build succeeds.", "2026-10-05T12:01:00.000Z"),
    ]);

    const output = await runHandler(hookStop, { hook: { transcript_path: path } }, context);

    expect(output.decision).toBe("block");
  }, 60_000);

  test("never blocks with stop_hook_active", async () => {
    const { dir, context } = await workspace();
    const path = await transcript(dir, [
      person("go", "2026-10-05T12:00:00.000Z"),
      said("All tests pass.", "2026-10-05T12:01:00.000Z"),
    ]);

    const output = await runHandler(hookStop, { hook: { transcript_path: path, stop_hook_active: true } }, context);

    expect(output).toEqual({});
  }, 60_000);

  test("names the turn's last test, build or lint command", async () => {
    const { dir, context } = await workspace();
    const path = await transcript(dir, [
      person("go", "2026-10-05T12:00:00.000Z"),
      ...ran("pnpm build", "2026-10-05T12:00:10.000Z"),
      ...ran("pnpm lint", "2026-10-05T12:00:20.000Z"),
      ...ran("git status", "2026-10-05T12:00:30.000Z"),
      said("Lint is clean.", "2026-10-05T12:01:00.000Z"),
    ]);

    const output = await runHandler(hookStop, { hook: { transcript_path: path } }, context);

    expect(output.reason).toContain('musai check "Lint is clean." -- pnpm lint');
  }, 60_000);

  test("names a placeholder command when the turn ran none", async () => {
    const { dir, context } = await workspace();
    const path = await transcript(dir, [
      person("go", "2026-10-05T12:00:00.000Z"),
      said("The tests passed.", "2026-10-05T12:01:00.000Z"),
    ]);

    const output = await runHandler(hookStop, { hook: { transcript_path: path } }, context);

    expect(output.reason).toContain('musai check "The tests passed." -- <command>');
  }, 60_000);

  test("ignores a pass sentence in an earlier turn", async () => {
    const { dir, context } = await workspace();
    const path = await transcript(dir, [
      person("run them", "2026-10-05T12:00:00.000Z"),
      said("All tests pass.", "2026-10-05T12:00:10.000Z"),
      person("thanks", "2026-10-05T12:01:00.000Z"),
      said("You're welcome.", "2026-10-05T12:01:20.000Z"),
    ]);

    const output = await runHandler(hookStop, { hook: { transcript_path: path } }, context);

    expect(output).toEqual({});
  }, 60_000);

  test("passes a sentence saying the tests do not pass", async () => {
    const { dir, context } = await workspace();
    const path = await transcript(dir, [
      person("go", "2026-10-05T12:00:00.000Z"),
      said("The tests don't pass yet.", "2026-10-05T12:01:00.000Z"),
    ]);

    const output = await runHandler(hookStop, { hook: { transcript_path: path } }, context);

    expect(output).toEqual({});
  }, 60_000);

  test("passes on a transcript it cannot read", async () => {
    const { dir, context } = await workspace();

    const output = await runHandler(
      hookStop,
      { hook: { transcript_path: join(dir, "no-such-transcript.jsonl") } },
      context,
    );

    expect(output).toEqual({});
  }, 60_000);
});
