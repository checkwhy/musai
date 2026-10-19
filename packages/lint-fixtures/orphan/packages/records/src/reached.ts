// Bait for the orphan check: `strayHelper` is exported and no file outside
// this one names it, while `reached` next to it is called from `caller.ts`, so
// the file itself is reached and only the one export is an orphan.
export function reached(text: string): string {
  return text.trim();
}

export function strayHelper(text: string): string {
  return text.toUpperCase();
}
