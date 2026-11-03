import type { ClaimStatus } from "@musai/evaluate";
import { commandLine, printable } from "@musai/run";

/** A record's text made safe for one line, reversibly, its backslashes doubled before
 * `printable` escapes what would break the line or act on the terminal. */
export function inlineText(text: string): string {
  return printable(text.replaceAll("\\", "\\\\"));
}

/** Inline text that markdown renders as written: every character that could open markup is
 * escaped with the backslash CommonMark reads back. */
export function markdownText(text: string): string {
  return inlineText(text).replace(/[`*_[\]<>#|~!]/g, "\\$&");
}

/** A command as one markdown code span, its fence longer than any run of backticks it quotes. */
export function markdownCommand(command: readonly string[]): string {
  const text = commandLine(command);
  const fence = "`".repeat(Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length)) + 1);
  return `${fence}${text}${fence}`;
}

const MARKS: Readonly<Record<ClaimStatus["label"], string>> = { holds: "✓", fails: "✗", open: "◌" };

export function markOf(label: ClaimStatus["label"]): string {
  return MARKS[label];
}
