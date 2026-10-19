// The target of the imports next door, so the fold has types and values to
// reach for. This file is not itself bait.
export interface RecordStore {
  head(): string;
}

export interface Lane {
  name: string;
}

export function openStore(): RecordStore {
  return { head: () => "" };
}

export function openLane(): Lane {
  return { name: "" };
}
