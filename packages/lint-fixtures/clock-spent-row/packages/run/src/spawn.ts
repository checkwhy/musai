// A read in a file the clock check's allowlist names, so its row is used and
// the read is let. This file is not itself bait.
export function started(): number {
  return performance.now();
}
