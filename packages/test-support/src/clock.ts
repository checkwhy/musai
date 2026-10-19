import { type Clock, timestamp } from "@musai/records";

/** Answers one instant on every call, so two runs of a test mint the same bytes. */
export function fixedClock(instant: string): Clock {
  const fixed = timestamp(instant);
  return () => fixed;
}
/** The instant every scenario pins through `MUSAI_NOW`, so two runs mint the same receipts. */
export const SCENARIO_INSTANT = "2026-01-01T00:00:00.000Z";
