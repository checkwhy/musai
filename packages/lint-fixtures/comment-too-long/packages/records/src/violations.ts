// A header comment sits before the first statement.
export const first = 1;

/**
 * A doc comment of three content lines,
 * one more than the limit,
 * and one more again.
 */
export function tooLong(): number {
  return first;
}

// Two line comments in a row
// are one line too many.
export const second = 2;

// One line comment that runs past the one-hundred character limit, since it keeps on saying far too much.
export const third = 3;
