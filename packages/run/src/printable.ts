function unprintable(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0x2028 ||
    code === 0x2029
  );
}

/** Text kept on one line and in the order written, as the Go verifier's printable package keeps it:
 * a control, a line separator or a bidirectional formatting character escaped as `\uXXXX`. */
export function printable(text: string): string {
  return [...text]
    .map((character) => {
      const code = character.charCodeAt(0);
      return unprintable(code) ? `\\u${code.toString(16).padStart(4, "0")}` : character;
    })
    .join("");
}
