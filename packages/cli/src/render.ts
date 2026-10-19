import type { Event, OperationDescriptor } from "@musai/api-core";
import { canonicalBytes, isKernelError, type KernelError } from "@musai/records";

/** The parsed `--json` flag alone picks the form, never whether stdout is a terminal. */
export function renderProjection(descriptor: OperationDescriptor, output: unknown, json: boolean): string {
  if (json) {
    return new TextDecoder().decode(canonicalBytes(output));
  }
  return descriptor.renderText(output);
}

/** Under `--json`, one closed shape a hook parses whether the call succeeded or refused. */
export function renderRefusalProjection(error: unknown, json: boolean): string {
  if (!isKernelError(error)) {
    throw error;
  }
  const shape: Pick<KernelError, "reason" | "about" | "detail"> = {
    reason: error.reason,
    about: error.about,
    detail: error.detail,
  };
  if (json) {
    return new TextDecoder().decode(canonicalBytes({ code: error.code, ...shape }));
  }
  return error.detail;
}

export function renderEventLine(event: Event): string {
  return new TextDecoder().decode(canonicalBytes(event));
}
