import { KernelError } from "@musai/records";
import { type GitContext, gitRevParse, gitUpdateRefCas } from "./git.js";

/** Bounded exponential backoff, jittered so lanes that collide once do not collide in lockstep. */
export interface RetryPolicy {
  baseDelayMs: number;
  growthFactor: number;
  jitterFraction: number;
  maxAttempts: number;
}

/** `growthFactor` exceeds `1 + jitterFraction`, so each delay exceeds the last for any draw. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  baseDelayMs: 20,
  growthFactor: 2,
  jitterFraction: 0.5,
  maxAttempts: 8,
};

export class CasExhaustedError extends KernelError {
  readonly ref: string;
  readonly attempts: number;

  constructor(ref: string, attempts: number) {
    super({
      reason: "head-moved",
      detail: `compare-and-swap of ${ref} did not land after ${attempts} attempt${attempts === 1 ? "" : "s"}`,
      about: [ref],
    });
    this.name = "CasExhaustedError";
    this.ref = ref;
    this.attempts = attempts;
  }
}

export interface CasAttemptResult<T> {
  commitSha: string;
  value: T;
}

export interface CasRetryHooks {
  policy?: RetryPolicy;
  random?: () => number;
  sleep?: (durationMs: number) => Promise<void>;
  onRetry?: (attemptNumber: number, delayMs: number) => void;
  /** Runs between building a commit and swapping it in, so a test can force lanes to collide. */
  beforeSwap?: (tip: string | null, attemptNumber: number) => Promise<void>;
}

export interface CasRetryOptions extends CasRetryHooks {
  ctx: GitContext;
  ref: string;
}

function defaultSleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function jitteredDelay(policy: RetryPolicy, attemptNumber: number, random: () => number): number {
  const base = policy.baseDelayMs * policy.growthFactor ** (attemptNumber - 1);
  return base + base * policy.jitterFraction * random();
}

/** Swaps in the commit `attempt` builds, re-running it against the new tip after a lost swap. It
 * orders commits and never arbitrates what two writers each checked against an older tip. */
export async function withCasRetry<T>(
  options: CasRetryOptions,
  attempt: (tip: string | null, attemptNumber: number) => Promise<CasAttemptResult<T>>,
): Promise<T> {
  const { ctx, ref } = options;
  const policy = options.policy ?? DEFAULT_RETRY_POLICY;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;

  let tip = await gitRevParse(ctx, ref);

  for (let attemptNumber = 1; attemptNumber <= policy.maxAttempts; attemptNumber++) {
    const { commitSha, value } = await attempt(tip, attemptNumber);
    if (options.beforeSwap) {
      await options.beforeSwap(tip, attemptNumber);
    }
    const swapped = await gitUpdateRefCas(ctx, ref, commitSha, tip);
    if (swapped) {
      return value;
    }
    if (attemptNumber === policy.maxAttempts) {
      throw new CasExhaustedError(ref, attemptNumber);
    }
    const delayMs = jitteredDelay(policy, attemptNumber, random);
    options.onRetry?.(attemptNumber, delayMs);
    await sleep(delayMs);
    tip = await gitRevParse(ctx, ref);
  }

  throw new CasExhaustedError(ref, policy.maxAttempts);
}
