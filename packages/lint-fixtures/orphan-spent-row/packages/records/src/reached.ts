// Reached from `caller.ts`, so neither its one export nor the file itself is
// an orphan, while the allowlist beside this tree still carries a row for each.
export function reached(text: string): string {
  return text.trim();
}
