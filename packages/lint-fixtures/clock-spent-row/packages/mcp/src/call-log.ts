// Bait for the clock check: the allowlist names this file, and it reads no
// clock — its one `Date` is built from a value, and a comment naming
// Date.now() reads nothing — so the row grants permission nobody is using.
export function logName(stamp: number): string {
  return `call-${new Date(stamp).toISOString()}.jsonl`;
}
