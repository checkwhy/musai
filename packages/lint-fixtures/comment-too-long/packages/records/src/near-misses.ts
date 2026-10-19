export const url = "https://example.test/a // not a comment, and /* not one either */";

/** One line. */
export function oneLine(): string {
  return url;
}

/**
 * Two content lines,
 * which is the limit.
 */
export function twoLines(): string {
  return `${url} // inside a template, not a comment`;
}

// biome-ignore lint/suspicious/noExplicitAny: a directive after a comment starts no run
// @ts-expect-error a second directive in a row is still a directive
export const directives: any = oneLine(twoLines());

export const pattern = /\/\/ not a comment/; // A trailing comment is one line.

// https://example.test/a-link-that-is-long-enough-to-run-past-the-one-hundred-character-limit-on-its-own
export const linked = pattern;
