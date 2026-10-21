import { readFile, realpath } from "node:fs/promises";
import {
  type OperationContext,
  type OperationDescriptor,
  openWorkspace,
  runHandler,
  type Workspace,
} from "@musai/api-core";
import { instantOf, isKernelError, isTimestamp, type Timestamp, versionString } from "@musai/records";
import { resolveWorkTree } from "@musai/store";
import { lastTurn, type Turn } from "../hook/transcript.js";
import { checkRun, programsToAdmit, SentenceClaimedError } from "./check.js";

export interface HookStopInput {
  /** The JSON Claude Code hands a `Stop` hook on standard input. */
  readonly hook: { readonly transcript_path: string; readonly stop_hook_active?: boolean };
}

/** Claude Code's `Stop` decision; empty lets the turn end. */
export interface HookStopOutput {
  readonly decision?: "block";
  readonly reason?: string;
  /** Shown to the person: the claim minted for the turn's sentence, which holds. */
  readonly systemMessage?: string;
}

const SUBJECT =
  /\b(?:tests?|test suite|suites?|specs?|builds?|lint(?:er|ing)?|type ?checks?|typecheck(?:ing)?|checks)\b/i;

const PASSING = /\b(?:pass(?:es|ed|ing)?|green|succeed(?:s|ed)?|clean)\b/i;

const NEGATED = /\b(?:not|never)\b|n't\b/i;

const CHECKING_COMMAND =
  /\b(?:test|tests|vitest|jest|pytest|mocha|build|lint|eslint|biome|ruff|mypy|typecheck|tsc|check)\b/;

const CHECKERS = new Set(["vitest", "jest", "pytest", "mocha", "tsc", "eslint", "biome", "ruff", "mypy"]);

const RUNNERS = new Set(["npm", "pnpm", "yarn", "bun", "npx", "go", "cargo", "make"]);

const SCRIPT_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);

const CHECKING_WORDS = new Set(["test", "tests", "lint", "build", "typecheck", "check"]);

/** Below the Stop hook's 600 s timeout in `plugin/hooks/hooks.json`, so the hook answers first. */
export const HOOK_RUN_TIMEOUT_MS = 540_000;

/** Words a check runs as they stand: nothing a shell would quote, expand, redirect or chain, and
 * a first word naming a program rather than a path or a variable. */
const PLAIN_COMMAND = /^[\w@%+:,.-]+(?:[ \t]+[\w@%+=:,./-]+)*$/;

/** Markdown emphasis and list markers dropped, so the sentence reads as a claim's statement. */
function plain(sentence: string): string {
  return sentence
    .replace(/[*_`]/g, "")
    .replace(/^\s*(?:[-+>]|\d+[.)])\s+/, "")
    .trim();
}

function passSentence(text: string): string | undefined {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map(plain)
    .find((sentence) => SUBJECT.test(sentence) && PASSING.test(sentence) && !NEGATED.test(sentence));
}

async function readable(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function renderHookStopText(output: HookStopOutput): string {
  if (output.reason !== undefined) {
    return `blocks: ${output.reason}`;
  }
  return output.systemMessage ?? "passes";
}

function plainWords(command: string): string[] | undefined {
  const trimmed = command.trim();
  return PLAIN_COMMAND.test(trimmed) ? trimmed.split(/[ \t]+/) : undefined;
}

/** A flag or a path inside the tree, so nothing after a check moves where or what it runs. */
function staysInTree(word: string): boolean {
  if (word.includes("=")) {
    return false;
  }
  if (word.startsWith("-")) {
    return !word.includes("/");
  }
  return word.includes("/") && !word.startsWith("/") && !word.split("/").includes("..");
}

/** A checker with its own arguments, or a runner's checking subcommand with only flags and paths
 * in the tree after it, so `make test deploy` and `cargo run test` name no check. */
function namesCheck(words: readonly string[]): boolean {
  const [program = "", ...rest] = words;
  if (CHECKERS.has(program)) {
    return true;
  }
  if (!RUNNERS.has(program)) {
    return false;
  }
  const verb = rest[0] ?? "";
  if (verb === "exec" && CHECKERS.has(rest[1] ?? "")) {
    return true;
  }
  const [subcommand = "", ...after] = verb === "run" && SCRIPT_RUNNERS.has(program) ? rest.slice(1) : rest;
  return (CHECKERS.has(subcommand) || CHECKING_WORDS.has(subcommand)) && after.every(staysInTree);
}

function checkWords(command: string): string[] | undefined {
  const words = plainWords(command);
  return words !== undefined && namesCheck(words) ? words : undefined;
}

async function resolved(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/** Whether the turn ran the command at the root of the repository the workspace sits in. */
async function ranAtRoot(turn: Turn, command: string, workspace: string): Promise<boolean> {
  const top = await resolveWorkTree(workspace);
  const root = top === null ? null : await resolved(top);
  if (root === null) {
    return false;
  }
  for (const candidate of turn.commands) {
    if (candidate.command === command && candidate.ran && candidate.cwd !== null) {
      if ((await resolved(candidate.cwd)) === root) {
        return true;
      }
    }
  }
  return false;
}

function proposalOf(sentence: string, command: string): string {
  return `musai check ${JSON.stringify(sentence)} -- ${command}`;
}

function unreceipted(sentence: string, proposal: string, why = ""): HookStopOutput {
  return {
    decision: "block",
    reason: `You said ${JSON.stringify(sentence)} with no receipt minted this turn${why}. Mint one, or say what was not run: ${proposal}`,
  };
}

/** Mints the claim through `check`, which runs the command in its declared environment. */
async function minted(
  sentence: string,
  command: string,
  words: readonly string[],
  context: OperationContext,
): Promise<HookStopOutput> {
  const said = JSON.stringify(sentence);
  try {
    const checked = await runHandler(
      checkRun,
      { statement: sentence, command: [...words] },
      { ...context, runTimeoutMs: HOOK_RUN_TIMEOUT_MS },
    );
    if (checked.label === "holds") {
      return { systemMessage: `musai checked ${said} by ${command}: it holds · ${checked.short}` };
    }
    const verdict = checked.label === "fails" ? "it fails" : `it is open: ${checked.reason}`;
    return {
      decision: "block",
      reason: `You said ${said}, and musai checked it by ${command}: ${verdict} · ${checked.short}. Say what does not pass, or fix it.`,
    };
  } catch (error) {
    if (!isKernelError(error)) {
      throw error;
    }
    if (error instanceof SentenceClaimedError) {
      return unreceipted(sentence, `musai status ${error.short}`, ", and it is a claim checked by another command");
    }
    return unreceipted(sentence, proposalOf(sentence, command), `, and musai could not check it: ${error.detail}`);
  }
}

/** Minted only where the turn ran a check at the repository's root that admits no new tool. */
async function checkedOrProposed(
  sentence: string,
  turn: Turn,
  opened: Workspace,
  context: OperationContext,
): Promise<HookStopOutput> {
  const chosen =
    turn.commands.findLast((candidate) => checkWords(candidate.command) !== undefined) ??
    turn.commands.findLast((candidate) => CHECKING_COMMAND.test(candidate.command));
  const command = chosen?.command ?? "<command>";
  const proposal = proposalOf(sentence, command);
  const words = checkWords(command);
  if (words === undefined || !(await ranAtRoot(turn, command, context.workspace))) {
    return unreceipted(sentence, proposal);
  }
  const admitted = programsToAdmit(opened, [words[0]!]);
  if (admitted.length > 0) {
    return unreceipted(
      sentence,
      proposal,
      `, and checking it would add ${admitted.join(", ")} to the workspace's tools`,
    );
  }
  return minted(sentence, command, words, context);
}

/** `hook.stop@1`: a turn saying tests, a build or lint pass with no receipt since the person
 * wrote is checked where it ran the command, and blocked once with that `check` otherwise. */
export const hookStop: OperationDescriptor<HookStopInput, HookStopOutput> = {
  id: "hook.stop",
  version: versionString("1"),
  input: {
    type: "object",
    additionalProperties: false,
    required: ["hook"],
    properties: {
      hook: {
        type: "object",
        required: ["transcript_path"],
        properties: {
          transcript_path: { type: "string", minLength: 1 },
          stop_hook_active: { type: "boolean" },
        },
      },
    },
  },
  output: {
    type: "object",
    additionalProperties: false,
    properties: {
      decision: { const: "block" },
      reason: { type: "string" },
      systemMessage: { type: "string" },
    },
  },
  effect: "performs",
  authority: null,
  plans: false,
  reasons: ["invalid-input"],
  documentation:
    "Reads a Stop hook's transcript and, for a turn that says tests, a build or lint pass with no receipt minted since the person's last message, checks the claim where the turn ran its command and blocks once otherwise.",
  paths: ["hook.transcript_path"],
  cli: {
    verb: "stop",
    group: "hook",
    positional: [],
    flags: [],
    input: "hook",
    describe: "check a turn's claim that tests pass where the turn ran its command, and block once otherwise",
  },
  renderText: renderHookStopText,
  exitCode: () => 0,
  async handler(input, context) {
    if (input.hook.stop_hook_active === true) {
      return {};
    }
    const transcript = await readable(input.hook.transcript_path);
    const turn = transcript === undefined ? null : lastTurn(transcript);
    const sentence = turn === null ? undefined : passSentence(turn.closingText);
    if (turn === null || sentence === undefined || !isTimestamp(turn.startedAt)) {
      return {};
    }
    const opened = await openWorkspace(context);
    const since = instantOf(turn.startedAt);
    const receipted = opened.index.receiptStarts().some((startedAt) => instantOf(startedAt as Timestamp) >= since);
    if (receipted) {
      return {};
    }
    return checkedOrProposed(sentence, turn, opened, context);
  },
};
