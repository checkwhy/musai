import { KernelError, type KernelErrorShape } from "@musai/records";

/** An operation's refusal: a kernel refusal's shape under its own name. */
export class OperationError extends KernelError {
  constructor(shape: KernelErrorShape) {
    super(shape);
    this.name = "OperationError";
  }
}

export function isOperationError(value: unknown): value is OperationError {
  return value instanceof OperationError;
}
