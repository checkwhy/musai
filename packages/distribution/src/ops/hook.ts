import { readFile } from "node:fs/promises";
import { type OperationDescriptor, openWorkspace } from "@musai/api-core";
import { instantOf, isTimestamp, type Timestamp, versionString } from "@musai/records";
import { lastTurn } from "../hook/transcript.js";

export interface HookStopInput {
  /** The JSON Claude Code hands a `Stop` hook on standard input. */
  readonly hook: { readonly transcript_path: string; readonly stop_hook_active?: boolean };
}

/** Claude Code's `Stop` decision; empty lets the turn end. */
export interface HookStopOutput {
  readonly decision?: "block";
  readonly reason?: string;
}

const SUBJECT =
  /\b(?:tests?|test suite|suites?|specs?|builds?|lint(?:er|ing)?|type ?checks?|typecheck(?:ing)?|checks)\b/i;

const PASSING = /\b(?:pass(?:es|ed|ing)?|green|succeed(?:s|ed)?|clean)\b/i;

const NEGATED = /\b(?:not|never)\b|n't\b/i;

const CHECKING_COMMAND =
  /\b(?:test|tests|vitest|jest|pytest|mocha|build|lint|eslint|biome|ruff|mypy|typecheck|tsc|check)\b/;

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
  return output.reason === undefined ? "passes" : `blocks: ${output.reason}`;
}

/** `hook.stop@1`: a turn ending on a claim that tests, a build or lint pass, with no receipt
 * minted since the person's last message, is blocked once with the `check` that would mint one. */
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
    },
  },
  effect: "read",
  authority: null,
  plans: true,
  reasons: ["invalid-input"],
  documentation:
    "Reads a Stop hook's transcript and blocks once a turn that says tests, a build or lint pass with no receipt minted since the person's last message.",
  paths: ["hook.transcript_path"],
  cli: {
    verb: "stop",
    group: "hook",
    positional: [],
    flags: [],
    input: "hook",
    describe: "block once a turn that says tests pass with no receipt minted this turn",
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
    const command = turn.commands.findLast((candidate) => CHECKING_COMMAND.test(candidate)) ?? "<command>";
    return {
      decision: "block",
      reason: `You said ${JSON.stringify(sentence)} with no receipt minted this turn. Mint one, or say what was not run: musai check ${JSON.stringify(sentence)} -- ${command}`,
    };
  },
};
