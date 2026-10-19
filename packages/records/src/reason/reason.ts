export const STATUS_REASONS = [
  "cycle",
  "no-evidence",
  "contested-authority",
  "over-budget",
  "stale",
  "inapplicable",
] as const;

/** A claim's open-status reason, a subset of `REASONS`. */
export type ReasonClass = (typeof STATUS_REASONS)[number];

/** The one closed reason vocabulary; a reason is deprecated, never removed or renumbered. */
export const REASONS = [
  ...STATUS_REASONS,
  "undeclared-binary",
  "sibling-conflict",
  "unknown-operation",
  "invalid-input",
  "invalid-output",
  "head-moved",
  "not-authorised",
  "no-such-record",
  "unsupported-format",
  "recipe-changed",
  "render-edited",
  "workspace-incomplete",
  "tool-unavailable",
  "record-corrupted",
  "declaration-conflict",
] as const;

export type Reason = (typeof REASONS)[number];

export function isReason(value: unknown): value is Reason {
  return typeof value === "string" && (REASONS as readonly string[]).includes(value);
}

/** Reasons still resolved when read back, but not declarable by a new operation. */
export const DEPRECATED_REASONS: ReadonlySet<Reason> = new Set();

/** The exit-code classes, one per next move of the caller. */
export const CODE_CLASSES = ["bug", "invocation", "workspace", "refold", "authority", "requirement", "unheld"] as const;

export type CodeClass = (typeof CODE_CLASSES)[number];

/** A class's position in the closed set, with 0 kept for success. */
export function exitCodeForClass(codeClass: CodeClass): number {
  return CODE_CLASSES.indexOf(codeClass) + 1;
}

/** A claim verb succeeds only when the claim holds, so a script gates on it. */
export function exitCodeForLabel(label: "holds" | "fails" | "open"): number {
  return label === "holds" ? 0 : exitCodeForClass("unheld");
}

/** Total by type, so a reason added without an entry does not compile. */
export const REASON_CODES: Record<Reason, CodeClass> = {
  // A claim's open reasons.
  cycle: "workspace",
  "no-evidence": "workspace",
  "contested-authority": "authority",
  "over-budget": "workspace",
  stale: "refold",
  inapplicable: "workspace",
  // Operation refusal reasons.
  "undeclared-binary": "requirement",
  "sibling-conflict": "invocation",
  "unknown-operation": "invocation",
  "invalid-input": "invocation",
  "invalid-output": "bug",
  "head-moved": "refold",
  "not-authorised": "authority",
  "no-such-record": "invocation",
  "unsupported-format": "invocation",
  "recipe-changed": "invocation",
  "render-edited": "invocation",
  // Something the workspace must hold is absent or unusable.
  "workspace-incomplete": "workspace",
  // A tool this machine must have is missing or will not run.
  "tool-unavailable": "requirement",
  // Told apart from a missing record: the caller restores the bytes, not the input.
  "record-corrupted": "workspace",
  // Two installed things declare one name incompatibly.
  "declaration-conflict": "workspace",
};

export function codeForReason(reason: Reason): CodeClass {
  return REASON_CODES[reason];
}

/** Which reason an open status records when several apply: `inapplicable` first, since nothing
 * was attempted, and `no-evidence` last, as the residual. */
export const REASON_PRECEDENCE: readonly ReasonClass[] = [
  "inapplicable",
  "over-budget",
  "cycle",
  "contested-authority",
  "stale",
  "no-evidence",
];

export function reasonPrecedence(applicable: ReadonlySet<ReasonClass> | readonly ReasonClass[]): ReasonClass {
  const set = applicable instanceof Set ? applicable : new Set(applicable);
  for (const candidate of REASON_PRECEDENCE) {
    if (set.has(candidate)) {
      return candidate;
    }
  }
  throw new RangeError("no reason class applies; an open status requires at least one");
}

/** Every claim holds, fails or is open. */
export type Status = "holds" | "fails" | "open";
