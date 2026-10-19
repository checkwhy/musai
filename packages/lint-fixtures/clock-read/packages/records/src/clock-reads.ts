// Bait for the clock check: three reads of the machine's clock, one an
// alias, in a file no allowlist row names, among five spellings that read
// nothing; this comment is the first, naming Date.now() without reading it.
export function stampedNow(): number {
  return Date.now();
}

export function parsed(value: string): number {
  return new Date(value).getTime();
}

export const described = "a string holding new Date() is text, not a read";

export function standIn(forbiddenDate: { now: () => number }): void {
  forbiddenDate.now = (): never => {
    throw new Error("no clock here");
  };
}

export function logName(): string {
  return `call-${Date.now()}.jsonl`;
}

export const read = Date.now;

export function dayOf(calendar: { Date: (day: number) => string }): string {
  return calendar.Date(1);
}
