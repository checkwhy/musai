import type { RunPerformer } from "@musai/records";
import { EVALUATOR_VERSION } from "@musai/records";

/** Musai's runner as a receipt names it. The version is the evaluator's: the package version is
 * `0.0.0` and never enters a record. */
export const RUNNER_PERFORMER: RunPerformer = { kind: "runner", version: EVALUATOR_VERSION };
