import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type OperationContext, openWorkspace, runHandler } from "@musai/api-core";
import { type Checkout, fixedClock, makeCheckout } from "@musai/test-support";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { lastTurn } from "../src/hook/transcript.js";
import { checkRun } from "../src/ops/check.js";
import { configSet } from "../src/ops/config.js";
import { HOOK_RUN_TIMEOUT_MS, hookStop } from "../src/ops/hook.js";
import { workspaceInit } from "../src/ops/workspace.js";

type Line = Record<string, unknown>;

/** Lines in the shape Claude Code writes its session transcript, which it does not publish. */
const CLAUDE_CODE_TRANSCRIPT = fileURLToPath(new URL("./fixtures/transcript/claude-code.jsonl", import.meta.url));

const HOOKS = fileURLToPath(new URL("../../../plugin/hooks/hooks.json", import.meta.url));

const PROJECT = "/work/project";

function person(text: string, at: string): Line {
  return { type: "user", timestamp: at, message: { role: "user", content: text } };
}

function said(text: string, at: string): Line {
  return { type: "assistant", timestamp: at, message: { role: "assistant", content: [{ type: "text", text }] } };
}

function called(command: string, at: string, cwd = PROJECT, input: Line = {}): Line {
  return {
    type: "assistant",
    timestamp: at,
    cwd,
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: command, name: "Bash", input: { command, ...input } }],
    },
  };
}

function result(command: string, at: string, isError: boolean): Line {
  return {
    type: "user",
    timestamp: at,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: command, content: isError ? "denied" : "ok", is_error: isError }],
    },
  };
}

function ran(command: string, at: string, cwd = PROJECT): Line[] {
  return [called(command, at, cwd), result(command, at, false)];
}

/** What Claude Code writes where a permission rule or a hook refused the call. */
function refused(command: string, at: string, cwd = PROJECT): Line[] {
  return [called(command, at, cwd), result(command, at, true)];
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
      commands: [{ command: "pnpm test", ran: true, cwd: PROJECT }],
    });
  });

  test("reads the line shape Claude Code writes: prompts, tool uses, their results and the rest", async () => {
    const turn = lastTurn(await readFile(CLAUDE_CODE_TRANSCRIPT, "utf8"));

    expect(turn).toEqual({
      startedAt: "2026-10-05T12:00:00.000Z",
      closingText: "Fixed the parser. All tests pass now.",
      commands: [
        { command: "pnpm test", ran: true, cwd: PROJECT },
        { command: "pnpm lint", ran: false, cwd: PROJECT },
        { command: "pnpm test --watch", ran: false, cwd: PROJECT },
        { command: "pnpm build", ran: false, cwd: `${PROJECT}/packages/core` },
      ],
    });
  });

  test("counts a command whose result never came back as not run", () => {
    const turn = lastTurn(
      jsonl([
        person("go", "2026-10-05T12:00:00.000Z"),
        called("pnpm test", "2026-10-05T12:00:10.000Z"),
        said("All tests pass.", "2026-10-05T12:01:00.000Z"),
      ]),
    );

    expect(turn?.commands).toEqual([{ command: "pnpm test", ran: false, cwd: PROJECT }]);
  });

  test("counts a command whose result is an error, as a refused call's is, as not run", () => {
    const turn = lastTurn(
      jsonl([
        person("go", "2026-10-05T12:00:00.000Z"),
        ...refused("pnpm test", "2026-10-05T12:00:10.000Z"),
        said("All tests pass.", "2026-10-05T12:01:00.000Z"),
      ]),
    );

    expect(turn?.commands).toEqual([{ command: "pnpm test", ran: false, cwd: PROJECT }]);
  });

  test("counts a command run in the background as not run", () => {
    const turn = lastTurn(
      jsonl([
        person("go", "2026-10-05T12:00:00.000Z"),
        called("pnpm test", "2026-10-05T12:00:10.000Z", PROJECT, { run_in_background: true }),
        result("pnpm test", "2026-10-05T12:00:11.000Z", false),
        said("All tests pass.", "2026-10-05T12:01:00.000Z"),
      ]),
    );

    expect(turn?.commands).toEqual([{ command: "pnpm test", ran: false, cwd: PROJECT }]);
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

describe("the Stop hook: a pass sentence with no receipt this turn is checked or stopped once", () => {
  const checkouts: Checkout[] = [];
  const bins: string[] = [];

  /** A `vitest` that passes unless handed `--fail`, and a `make` that passes its `test` alone. */
  beforeEach(async () => {
    const bin = await mkdtemp(join(tmpdir(), "musai-hook-bin-"));
    bins.push(bin);
    await writeFile(join(bin, "vitest"), '#!/bin/sh\n[ "$1" != --fail ]\n');
    await writeFile(join(bin, "make"), '#!/bin/sh\n[ "$1" = test ]\n');
    await chmod(join(bin, "vitest"), 0o755);
    await chmod(join(bin, "make"), 0o755);
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env["PATH"]}`);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const checkout of checkouts.splice(0)) {
      await checkout.cleanup();
    }
    for (const bin of bins.splice(0)) {
      await rm(bin, { recursive: true, force: true });
    }
  });

  async function workspace(
    at = "2026-10-05T11:00:00.000Z",
    tools: readonly string[] = ["vitest", "make"],
  ): Promise<{ dir: string; context: OperationContext }> {
    const made = await makeCheckout();
    checkouts.push(made);
    const context: OperationContext = { workspace: made.dir, scope: "default", now: fixedClock(at) };
    await runHandler(workspaceInit, { workspace: made.dir }, context);
    if (tools.length > 0) {
      await runHandler(configSet, { key: "tools", value: JSON.stringify(tools) }, { ...context, via: "tty" });
    }
    return { dir: made.dir, context };
  }

  async function transcript(dir: string, lines: readonly Line[]): Promise<string> {
    const path = join(dir, "transcript.jsonl");
    await writeFile(path, jsonl(lines));
    return path;
  }

  async function receipts(context: OperationContext): Promise<readonly string[]> {
    return (await openWorkspace(context)).index.receiptStarts();
  }

  test("mints the claim by the check the turn ran at the repository's root", async () => {
    const { dir, context } = await workspace("2026-10-05T12:02:00.000Z");
    const path = await transcript(dir, [
      person("make the suite green", "2026-10-05T12:00:00.000Z"),
      ...ran("vitest", "2026-10-05T12:00:30.000Z", dir),
      said("Fixed the parser. All tests pass now.", "2026-10-05T12:01:00.000Z"),
    ]);

    const output = await runHandler(hookStop, { hook: { transcript_path: path } }, context);

    expect(output.decision).toBeUndefined();
    expect(output.systemMessage).toMatch(/^musai checked "All tests pass now\." by vitest: it holds · [0-9a-f]+$/);
    expect(await runHandler(hookStop, { hook: { transcript_path: path } }, context)).toEqual({});
  }, 60_000);

  test("blocks once naming the minted claim where the check the turn ran fails", async () => {
    const { dir, context } = await workspace("2026-10-05T12:02:00.000Z");
    const path = await transcript(dir, [
      person("make the suite green", "2026-10-05T12:00:00.000Z"),
      ...ran("vitest --fail", "2026-10-05T12:00:30.000Z", dir),
      said("All tests pass.", "2026-10-05T12:01:00.000Z"),
    ]);

    const output = await runHandler(hookStop, { hook: { transcript_path: path } }, context);

    expect(output.decision).toBe("block");
    expect(output.reason).toMatch(/^You said "All tests pass\.", and musai checked it by vitest --fail: it fails · /);
  }, 60_000);

  test("mints the claim by a runner's checking subcommand followed by flags", async () => {
    const { dir, context } = await workspace("2026-10-05T12:02:00.000Z");
    const path = await transcript(dir, [
      person("make the suite green", "2026-10-05T12:00:00.000Z"),
      ...ran("make test -k", "2026-10-05T12:00:30.000Z", dir),
      said("All tests pass.", "2026-10-05T12:01:00.000Z"),
    ]);

    const output = await runHandler(hookStop, { hook: { transcript_path: path } }, context);

    expect(output.systemMessage).toMatch(/^musai checked "All tests pass\." by make test -k: it holds · /);
  }, 60_000);

  test("proposes, and never runs, a command a refused call named", async () => {
    const { dir, context } = await workspace();
    const before = await receipts(context);
    await mkdir(join(dir, "build"));
    const path = await transcript(dir, [
      person("clean up", "2026-10-05T12:00:00.000Z"),
      ...refused("rm -rf build", "2026-10-05T12:00:30.000Z", dir),
      said("The build is clean.", "2026-10-05T12:01:00.000Z"),
    ]);

    const output = await runHandler(hookStop, { hook: { transcript_path: path } }, context);

    expect(output.decision).toBe("block");
    expect(output.reason).toContain('musai check "The build is clean." -- rm -rf build');
    expect((await stat(join(dir, "build"))).isDirectory()).toBe(true);
    expect(await receipts(context)).toEqual(before);
  }, 60_000);

  test("proposes, and never runs, a check a refused call named", async () => {
    const { dir, context } = await workspace();
    const before = await receipts(context);
    const path = await transcript(dir, [
      person("make the suite green", "2026-10-05T12:00:00.000Z"),
      ...refused("vitest", "2026-10-05T12:00:30.000Z", dir),
      said("All tests pass.", "2026-10-05T12:01:00.000Z"),
    ]);

    const output = await runHandler(hookStop, { hook: { transcript_path: path } }, context);

    expect(output.reason).toContain(
      'with no receipt minted this turn. Mint one, or say what was not run: musai check "All tests pass." -- vitest',
    );
    expect(await receipts(context)).toEqual(before);
  }, 60_000);

  test("proposes, and never runs, a command that returned but names no check", async () => {
    const { dir, context } = await workspace();
    const before = await receipts(context);
    const path = await transcript(dir, [
      person("ship it", "2026-10-05T12:00:00.000Z"),
      ...ran("git push origin test", "2026-10-05T12:00:30.000Z", dir),
      said("All tests pass.", "2026-10-05T12:01:00.000Z"),
    ]);

    const output = await runHandler(hookStop, { hook: { transcript_path: path } }, context);

    expect(output.reason).toContain('musai check "All tests pass." -- git push origin test');
    expect(await receipts(context)).toEqual(before);
  }, 60_000);

  test("proposes a runner's checking subcommand followed by another target", async () => {
    const { dir, context } = await workspace();
    const before = await receipts(context);
    const path = await transcript(dir, [
      person("ship it", "2026-10-05T12:00:00.000Z"),
      ...ran("make test deploy", "2026-10-05T12:00:30.000Z", dir),
      said("All tests pass.", "2026-10-05T12:01:00.000Z"),
    ]);

    const output = await runHandler(hookStop, { hook: { transcript_path: path } }, context);

    expect(output.reason).toContain('musai check "All tests pass." -- make test deploy');
    expect(await receipts(context)).toEqual(before);
  }, 60_000);

  test.each([
    "make run test",
    "cargo run test",
    "go run check",
    "npm test --prefix /elsewhere",
    "make test SHELL=/bin/x",
    "go test ../sibling",
  ])(
    "proposes %s, which runs something other than a check in the tree, and runs nothing",
    async (command) => {
      const { dir, context } = await workspace();
      const before = await receipts(context);
      const path = await transcript(dir, [
        person("ship it", "2026-10-05T12:00:00.000Z"),
        ...ran(command, "2026-10-05T12:00:30.000Z", dir),
        said("All tests pass.", "2026-10-05T12:01:00.000Z"),
      ]);

      const output = await runHandler(hookStop, { hook: { transcript_path: path } }, context);

      expect(output.reason).toContain(`musai check "All tests pass." -- ${command}`);
      expect(await receipts(context)).toEqual(before);
    },
    60_000,
  );

  test("proposes the check the turn ran in the background", async () => {
    const { dir, context } = await workspace();
    const before = await receipts(context);
    const path = await transcript(dir, [
      person("make the suite green", "2026-10-05T12:00:00.000Z"),
      called("vitest", "2026-10-05T12:00:30.000Z", dir, { run_in_background: true }),
      result("vitest", "2026-10-05T12:00:31.000Z", false),
      said("All tests pass.", "2026-10-05T12:01:00.000Z"),
    ]);

    const output = await runHandler(hookStop, { hook: { transcript_path: path } }, context);

    expect(output.reason).toContain('musai check "All tests pass." -- vitest');
    expect(await receipts(context)).toEqual(before);
  }, 60_000);

  test("proposes the check the turn ran outside the repository's root", async () => {
    const { dir, context } = await workspace();
    const before = await receipts(context);
    await mkdir(join(dir, "packages"));
    const path = await transcript(dir, [
      person("make the suite green", "2026-10-05T12:00:00.000Z"),
      ...ran("vitest", "2026-10-05T12:00:30.000Z", join(dir, "packages")),
      said("All tests pass.", "2026-10-05T12:01:00.000Z"),
    ]);

    const output = await runHandler(hookStop, { hook: { transcript_path: path } }, context);

    expect(output.reason).toContain('musai check "All tests pass." -- vitest');
    expect(await receipts(context)).toEqual(before);
  }, 60_000);

  test("proposes the check where checking it would add its program to the workspace's tools", async () => {
    const { dir, context } = await workspace("2026-10-05T11:00:00.000Z", []);
    const path = await transcript(dir, [
      person("make the suite green", "2026-10-05T12:00:00.000Z"),
      ...ran("vitest", "2026-10-05T12:00:30.000Z", dir),
      said("All tests pass.", "2026-10-05T12:01:00.000Z"),
    ]);

    const output = await runHandler(hookStop, { hook: { transcript_path: path } }, context);

    expect(output.reason).toBe(
      'You said "All tests pass." with no receipt minted this turn, and checking it would add vitest to the workspace\'s tools. Mint one, or say what was not run: musai check "All tests pass." -- vitest',
    );
    expect((await openWorkspace(context)).tools).not.toContain("vitest");
  }, 60_000);

  test("proposes re-checking a sentence already claimed by another command, never replacing it", async () => {
    const { dir, context } = await workspace();
    await runHandler(
      checkRun,
      { statement: "All tests pass.", command: ["vitest", "--fail"] },
      { ...context, now: fixedClock("2026-10-05T11:30:00.000Z") },
    );
    const path = await transcript(dir, [
      person("make the suite green", "2026-10-05T12:00:00.000Z"),
      ...ran("vitest", "2026-10-05T12:00:30.000Z", dir),
      said("All tests pass.", "2026-10-05T12:01:00.000Z"),
    ]);

    const output = await runHandler(hookStop, { hook: { transcript_path: path } }, context);

    expect(output.reason).toContain("it is a claim checked by another command");
    expect(output.reason).toMatch(/: musai status \S+$/);
    expect(output.reason).not.toContain("--replace");
  }, 60_000);

  test("bounds the check's run below the Stop hook's timeout", async () => {
    const hooks = JSON.parse(await readFile(HOOKS, "utf8")) as {
      hooks: { Stop: { hooks: { timeout: number }[] }[] };
    };
    const { dir, context } = await workspace("2026-10-05T12:02:00.000Z");
    const path = await transcript(dir, [
      person("make the suite green", "2026-10-05T12:00:00.000Z"),
      ...ran("vitest", "2026-10-05T12:00:30.000Z", dir),
      said("All tests pass.", "2026-10-05T12:01:00.000Z"),
    ]);
    const checking = vi.spyOn(checkRun, "handler");

    await runHandler(hookStop, { hook: { transcript_path: path } }, context);

    expect(checking.mock.calls[0]![1].runTimeoutMs).toBe(HOOK_RUN_TIMEOUT_MS);
    expect(HOOK_RUN_TIMEOUT_MS).toBeLessThan(hooks.hooks.Stop[0]!.hooks[0]!.timeout * 1000);
  }, 60_000);

  test("proposes the check where the turn's command never returned a result", async () => {
    const { dir, context } = await workspace();
    const path = await transcript(dir, [
      person("make the suite green", "2026-10-05T12:00:00.000Z"),
      called("pnpm test", "2026-10-05T12:00:30.000Z", dir),
      said("Fixed the parser. All tests pass now.", "2026-10-05T12:01:00.000Z"),
    ]);

    const output = await runHandler(hookStop, { hook: { transcript_path: path } }, context);

    expect(output.decision).toBe("block");
    expect(output.reason).toContain('musai check "All tests pass now." -- pnpm test');
  }, 60_000);

  test("proposes the check where the command the turn ran is one only a shell reads", async () => {
    const { dir, context } = await workspace();
    const path = await transcript(dir, [
      person("make the suite green", "2026-10-05T12:00:00.000Z"),
      ...ran("pnpm test 2>&1 | tail -5", "2026-10-05T12:00:30.000Z", dir),
      said("All tests pass.", "2026-10-05T12:01:00.000Z"),
    ]);

    const output = await runHandler(hookStop, { hook: { transcript_path: path } }, context);

    expect(output.decision).toBe("block");
    expect(output.reason).toContain('musai check "All tests pass." -- pnpm test 2>&1 | tail -5');
  }, 60_000);

  test("proposes the check where the command the turn ran names a program by its path", async () => {
    const { dir, context } = await workspace();
    const path = await transcript(dir, [
      person("make the suite green", "2026-10-05T12:00:00.000Z"),
      ...ran("./test.sh", "2026-10-05T12:00:30.000Z", dir),
      said("All tests pass.", "2026-10-05T12:01:00.000Z"),
    ]);

    const output = await runHandler(hookStop, { hook: { transcript_path: path } }, context);

    expect(output.decision).toBe("block");
    expect(output.reason).toContain('musai check "All tests pass." -- ./test.sh');
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

  test("names the turn's last check, over a later command that only holds a checking word", async () => {
    const { dir, context } = await workspace();
    const path = await transcript(dir, [
      person("go", "2026-10-05T12:00:00.000Z"),
      called("pnpm build", "2026-10-05T12:00:10.000Z"),
      called("pnpm lint", "2026-10-05T12:00:20.000Z"),
      ...ran("git status", "2026-10-05T12:00:30.000Z"),
      ...ran("git push origin test", "2026-10-05T12:00:40.000Z"),
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
