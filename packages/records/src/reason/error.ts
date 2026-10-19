import { type CodeClass, codeForReason, type Reason } from "./reason.js";

/** A refusal's reason, what it is about, and a message. The code class is derived from the reason,
 * never accepted, so the two cannot disagree. */
export interface KernelErrorShape {
  readonly reason: Reason;
  readonly detail: string;
  readonly about?: readonly string[];
  /** The lower-level failure this refusal was raised over. */
  readonly cause?: unknown;
}

/** The base of every refusal the kernel raises. A kernel defect no reason names throws a bare
 * `Error` instead, reported as class `bug`. */
export class KernelError extends Error {
  readonly reason: Reason;
  readonly code: CodeClass;
  readonly about: readonly string[];
  readonly detail: string;

  constructor(shape: KernelErrorShape) {
    super(shape.detail, shape.cause === undefined ? undefined : { cause: shape.cause });
    this.name = "KernelError";
    this.reason = shape.reason;
    this.code = codeForReason(shape.reason);
    this.about = shape.about ?? [];
    this.detail = shape.detail;
  }
}

export function isKernelError(value: unknown): value is KernelError {
  return value instanceof KernelError;
}
