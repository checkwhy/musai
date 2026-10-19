import type { Conditions, RecordId } from "@musai/records";
import type { EnvelopeError, Need } from "./envelope.js";

/** One receipt, reduced to what a pure rule may read from it. */
export interface RuleEvidence {
  readonly runId: RecordId;
  readonly exitCode: number;
  readonly output: string;
}

/** A need the kernel could not satisfy, carried into the next invocation as an envelope error. */
export interface RuleRefusal {
  readonly need: Need;
  readonly error: EnvelopeError;
}

/** One contribution's answer to another's ask; the asker matches it to its ask by the need. */
export interface RuleInvocation {
  readonly need: Need;
  readonly moduleRecord: RecordId;
  readonly output: unknown;
}

/** What a rule receives on every invocation, plain values a byte-only host can carry. An invoked
 * answer never goes in `evidence`, whose order ties each item to the recipe that asked for it. */
export interface RuleInput {
  readonly claimId: string;
  readonly conditions: Readonly<Conditions>;
  readonly evidence: readonly RuleEvidence[];
  readonly refusals?: readonly RuleRefusal[];
  readonly invocations?: readonly RuleInvocation[];
  readonly records?: readonly RuleRecord[];
}

/** A record a rule's `record` need asked for, handed back whole on the next invocation. */
export interface RuleRecord {
  readonly id: RecordId;
  readonly record: unknown;
}

/** What a rule needs before it can decide; the kernel performs each need at most once. */
export interface RuleRequestOutput {
  readonly kind: "request";
  readonly needs: readonly Need[];
}

export interface RuleVerdictOutput {
  readonly kind: "verdict";
  readonly label: "holds" | "fails" | "open";
  readonly reason: string;
}

/** A rule's conclusive failure, shaped like a refused need so both sides compare equal. */
export interface RuleErrorOutput {
  readonly kind: "error";
  readonly error: EnvelopeError;
}

export type RuleOutput = RuleVerdictOutput | RuleRequestOutput | RuleErrorOutput;

/** A pure function with no filesystem, network, clock or environment; `context` is empty. */
export type Rule = (input: RuleInput, context: Record<string, never>) => RuleOutput;
