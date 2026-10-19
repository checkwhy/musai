import type { Conditions } from "../conditions/condition-value.js";

/** Everything a booking knows, handed to a kind; a kind performs no I/O. */
export interface KindInput {
  readonly slug: string;
  readonly about: readonly string[];
  readonly overrides: Readonly<Record<string, unknown>>;
}

/** One claim of a kind's setlist, never with a slot, evidence or predecessor: the kernel computes
 * the slot, and what holds a claim up is found by evaluating it. */
export interface KindClaim {
  readonly type: string;
  readonly conditions: Conditions;
  readonly canonical: unknown;
  readonly rendering: string;
  readonly about?: readonly string[];
  readonly exclusiveGroup?: string | null;
}

/** A kind's setlist, in the order the case works through it. A claim's identity comes from its
 * type's contribution, never from the booking. */
export interface KindOutput {
  readonly claims: readonly KindClaim[];
}
