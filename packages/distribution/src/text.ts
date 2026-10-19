import type { ClaimStatus } from "@musai/evaluate";

/** A record's text made safe for one line: a line break could forge a receipt line and a control
 * sequence could redraw the terminal, so each is escaped, reversibly. */
export function inlineText(text: string): string {
  let inlined = "";
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (character === "\\") {
      inlined += "\\\\";
    } else if (character === "\n") {
      inlined += "\\n";
    } else if (character === "\r") {
      inlined += "\\r";
    } else if (character === "\t") {
      inlined += "\\t";
    } else if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      inlined += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      inlined += character;
    }
  }
  return inlined;
}

/** Inline text that markdown renders as written: every character that could open markup is
 * escaped with the backslash CommonMark reads back. */
export function markdownText(text: string): string {
  return inlineText(text).replace(/[`*_[\]<>#|~!]/g, "\\$&");
}

/** A command on one line, an argument quoted only where a shell would split or strip it and
 * escaped where a line break or a control sequence would act. */
export function commandText(command: readonly string[]): string {
  return command
    .map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `"${inlineText(arg).replace(/"/g, '\\"')}"`))
    .join(" ");
}

/** A command as one markdown code span, its fence longer than any run of backticks it quotes. */
export function markdownCommand(command: readonly string[]): string {
  const text = commandText(command);
  const fence = "`".repeat(Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length)) + 1);
  return `${fence}${text}${fence}`;
}

const MARKS: Readonly<Record<ClaimStatus["label"], string>> = { holds: "✓", fails: "✗", open: "◌" };

export function markOf(label: ClaimStatus["label"]): string {
  return MARKS[label];
}
