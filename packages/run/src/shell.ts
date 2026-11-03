import { printable } from "./printable.js";

const BARE = /^[\w@+:,./-]+$/;

const NAMED: Readonly<Record<string, string>> = { "\\": "\\\\", "'": "\\'", "\n": "\\n", "\t": "\\t", "\r": "\\r" };

// Three octal digits, as `\xHH` followed by a hex digit is unspecified in POSIX.1-2024.
function escapedBytes(character: string): string {
  return [...Buffer.from(character, "utf8")].map((byte) => `\\${byte.toString(8).padStart(3, "0")}`).join("");
}

function dollarWord(arg: string): string {
  const body = [...arg].map(
    (character) => NAMED[character] ?? (printable(character) === character ? character : escapedBytes(character)),
  );
  return `$'${body.join("")}'`;
}

/** A word a POSIX shell reads back as `arg`: bare where no character splits, expands or assigns, in
 * POSIX.1-2024 `$'…'` where `printable` would escape one, else in single quotes. */
export function shellWord(arg: string): string {
  if (BARE.test(arg)) {
    return arg;
  }
  return printable(arg) === arg ? `'${arg.replaceAll("'", `'\\''`)}'` : dollarWord(arg);
}

/** Arguments as one line a POSIX shell splits back into them, with nothing a terminal acts on. */
export function commandLine(argv: readonly string[]): string {
  return argv.map(shellWord).join(" ");
}

/** The shells that read a `$'…'` word, which an `sh` older than POSIX.1-2024 may not. */
export const DOLLAR_QUOTE_SHELLS = "a shell reading $'…' (bash, zsh, ksh or a POSIX.1-2024 sh)";

/** Whether `commandLine` writes any of `argv` as a `$'…'` word. */
export function holdsDollarWord(argv: readonly string[]): boolean {
  return argv.some((arg) => printable(arg) !== arg);
}
