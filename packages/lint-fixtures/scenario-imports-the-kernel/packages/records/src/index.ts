// The target of the import next door, so the scenario has a value to reach
// for. This file is not itself bait.
export function canonicalId(value: object): string {
  return JSON.stringify(value);
}
