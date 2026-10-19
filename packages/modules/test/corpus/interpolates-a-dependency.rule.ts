import type { Rule } from '../../src/rule/contract.js';

/** Set when this module's body runs, telling a refusal before evaluation from a module let in. */
export const EVALUATION_WITNESS_KEY = "__musaiInterpolatesADependencyRuleEvaluated";

(globalThis as unknown as Record<string, boolean>)[EVALUATION_WITNESS_KEY] = true;

/** The one reach for the platform, inside an interpolation a scan masking literals whole skips. */
const reached = `${String(import("node:fs"))}`;

/** A rule whose module scope reached for the filesystem through the interpolation above. */
export const interpolatesADependencyRule: Rule = (_input) => ({
  kind: "verdict",
  label: "open",
  reason: reached,
});
