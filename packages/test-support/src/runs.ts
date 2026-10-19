import {
  type ComputedRecipe,
  type ComputedRunRecord,
  CURRENT_SCHEMA_VERSIONS,
  EVALUATOR_VERSION,
  type PerformedRunRecord,
  type RecordId,
  type RunPerformer,
  timestamp,
} from "@musai/records";
import { SCENARIO_INSTANT } from "./clock.js";

const RUNNER: RunPerformer = { kind: "runner", version: EVALUATOR_VERSION };

/** A command run, the kernel's own kind, valid with no claim type, case or installed module. */
export function fixtureRunRecord(output: string): PerformedRunRecord {
  const at = timestamp(SCENARIO_INSTANT);
  return {
    kind: "run",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
    runKind: "run",
    determinism: "nondeterministic",
    performer: RUNNER,
    recipe: { command: [], workingDirectory: "/", environment: {}, declared: [], substrates: [], isolation: "hygiene" },
    observation: {
      resolved: [],
      isolationHeld: "hygiene",
      binaries: [],
      bindings: [],
      output,
      outputLossy: false,
      exitCode: 0,
      scrubbed: [],
      startedAt: at,
      finishedAt: at,
      reads: [],
      cost: {},
    },
  };
}

export interface FixtureBriefOptions {
  readonly recipe?: ComputedRecipe;
  /** Each record read whole, consumed at its own digest. */
  readonly reads?: readonly RecordId[];
}

/** A brief run, which a ruling cites as what it was decided against. */
export function fixtureBrief(output: string, options: FixtureBriefOptions = {}): ComputedRunRecord {
  return {
    kind: "run",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
    runKind: "brief",
    performer: RUNNER,
    determinism: "deterministic",
    recipe: options.recipe ?? { command: ["brief"], substrates: [] },
    observation: {
      output,
      reads: (options.reads ?? []).map((id) => ({ key: id, consumed: { sha256: id.slice("sha256:".length) } })),
      cost: {},
    },
  };
}
