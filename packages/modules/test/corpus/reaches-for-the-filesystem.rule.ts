import { readFileSync } from 'node:fs';
import type { Rule } from '../../src/rule/contract.js';

/** Set when this module's body runs, telling a refusal before evaluation from a module let in. */
export const EVALUATION_WITNESS_KEY = "__musaiReachesForTheFilesystemRuleEvaluated";

readFileSync(new URL(import.meta.url));
(globalThis as unknown as Record<string, boolean>)[EVALUATION_WITNESS_KEY] = true;

/** A rule reaching for the filesystem at module scope, which no host could grant it. */
export const reachesForTheFilesystemRule: Rule = (_input) => ({
  kind: "verdict",
  label: "open",
  reason: "this rule exists to prove that reaching for the filesystem gets a module refused before it runs",
});
