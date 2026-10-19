// The names the packages next door re-export or use, so each has a definer to
// point back to. This file is not itself bait.
export const ACTIONS = ["rule", "publish"] as const;

export function point(value: string): string {
  return value;
}

export type Scope = readonly string[];
