import type { IndexDb, IndexedContribution } from "@musai/fold";
import { type RequirementRegistry, requirementsFromModules } from "@musai/run";
import { isWellFormedRequirementInput } from "../rule/envelope.js";

/** A module record can reach the fold without install, so a row is asked of its point's schema
 * where it is read; one that fails declares no binary and authorises nothing. */
export function partitionRequirementRows(rows: readonly IndexedContribution[]): {
  readonly wellFormed: readonly IndexedContribution[];
  readonly malformed: readonly IndexedContribution[];
} {
  return {
    wellFormed: rows.filter(({ entry }) => isWellFormedRequirementInput(entry.input)),
    malformed: rows.filter(({ entry }) => !isWellFormedRequirementInput(entry.input)),
  };
}

/** The tooling the installed modules declare, read from the fold without loading module code,
 * beside the workspace's `tools`. Two modules disagreeing on a binary conflict on it alone. */
export function readRequirementDeclarations(index: IndexDb, tools: readonly string[]): RequirementRegistry {
  const { wellFormed } = partitionRequirementRows(index.contributionsOf("requirement"));
  return requirementsFromModules(wellFormed, tools);
}
