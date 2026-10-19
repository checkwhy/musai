// Reached from `caller.ts`, so neither its one export nor the file itself is
// an orphan. This file is not itself bait.
export function reached(text: string): string {
  return text.trim();
}
