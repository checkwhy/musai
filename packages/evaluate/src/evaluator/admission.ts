import type { IndexDb } from "@musai/fold";
import type { InvocationLimits } from "@musai/modules";
import { ENVELOPE_PROTOCOL, type EnvelopeRequest, invokeThroughHost, pointFor } from "@musai/modules";
import type { EvidenceEdge, RunObservation, RunRecord, Selector } from "@musai/records";
import { KernelError, performedRun, type RecordId, recordId, textOf } from "@musai/records";
import type { Store } from "@musai/store";

/** A selector no held parser answers; the edge is never stored, since nobody could re-derive it. */
export class SelectorRefusedError extends KernelError {
  constructor(message: string) {
    super({ reason: "invalid-input", detail: message });
    this.name = "SelectorRefusedError";
  }
}

/** `modulePath` resolves a module's name to the file a host loads it from. */
export interface AdmissionWorkspace {
  readonly index: IndexDb;
  readonly store: Store;
  readonly modulePath: (moduleName: string) => string;
  /** Absent, a host takes the invocation-limits slot's declared default. */
  readonly invocationLimits?: InvocationLimits;
}

/** `moduleRecord` sits beside the edge because the edge's schema has no field for it. */
export interface AdmissionResult {
  readonly edge: EvidenceEdge;
  readonly moduleRecord: RecordId;
}

/** A parser sees output and exit code only, so its item cannot depend on where the run happened. */
export function reducedParserInput(observation: RunObservation): {
  readonly output: string;
  readonly exitCode: number;
} {
  return { output: textOf(observation.output, "a run's output"), exitCode: observation.exitCode };
}

/** The selector's half of admission; api-core's `verifiedEvidenceEdge` adds the checks on the
 * cited run, its attestation and its evidence kind. */
export async function admitEvidenceEdge(
  selector: Selector,
  run: RecordId,
  workspace: AdmissionWorkspace,
): Promise<AdmissionResult> {
  const contributionId = `${selector.module}/${selector.parser}`;
  const contribution = workspace.index.contributionById(contributionId);
  const point = contribution?.entry.kind === "parser" ? pointFor(contribution.entry.kind, workspace.index) : undefined;
  if (contribution === undefined || point === undefined || contribution.entry.version !== selector.version) {
    throw new SelectorRefusedError(
      "refusing to admit an evidence edge: the workspace does not hold " +
        selector.module +
        "/" +
        selector.parser +
        "@" +
        selector.version,
    );
  }

  // The store, not the fold: the cited run may be minted this restart round and not yet folded.
  const runRecord = performedRun(run, (await workspace.store.read(run, "run")) as RunRecord);
  const parserInput = reducedParserInput(runRecord.observation);

  const request: EnvelopeRequest = {
    protocol: ENVELOPE_PROTOCOL,
    contribution: "parser",
    id: contributionId,
    version: selector.version,
    input: parserInput,
  };
  const response = await invokeThroughHost(
    workspace.modulePath(selector.module),
    request,
    { entry: contribution.entry, point },
    workspace.invocationLimits,
  );
  if (response === undefined) {
    throw new SelectorRefusedError(
      "refusing to admit an evidence edge: this machine provides no host this kernel can invoke a parser through",
    );
  }
  if (!response.ok) {
    throw new SelectorRefusedError(
      "refusing to admit an evidence edge: " +
        contributionId +
        "@" +
        selector.version +
        " refused to run: " +
        response.error.code +
        ": " +
        response.error.message,
    );
  }
  const produced = response.output as Record<string, unknown>;
  if (!Object.hasOwn(produced, selector.key)) {
    throw new SelectorRefusedError(
      "refusing to admit an evidence edge: " +
        contributionId +
        "@" +
        selector.version +
        " does not produce the key " +
        selector.key,
    );
  }
  const item = recordId(produced[selector.key]);
  const edge: EvidenceEdge = { run, selector, item };
  return { edge, moduleRecord: contribution.moduleRecord };
}
