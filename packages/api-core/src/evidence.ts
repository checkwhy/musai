import { type AdmissionWorkspace, admitEvidenceEdge, evidenceKindOf, SelectorRefusedError } from "@musai/evaluate";
import {
  type EvidenceEdge,
  isKernelError,
  type RecordId,
  type RunRecord,
  renderSelector,
  type Selector,
} from "@musai/records";
import { OperationError } from "./errors.js";
import { verifiedAttestationFor } from "./open-workspace.js";
import type { Workspace } from "./workspace.js";

/** Admits an evidence edge whole: its run, attestation, evidence kind and selector. Every verb
 * minting an edge calls this, since `admitEvidenceEdge` alone never checks the run. */
export async function verifiedEvidenceEdge(
  opened: Workspace,
  admissionWorkspace: AdmissionWorkspace,
  run: RecordId,
  selector: Selector,
): Promise<EvidenceEdge> {
  const cited = opened.read(run);
  if (cited.kind !== "run") {
    throw new OperationError({
      reason: "no-such-record",
      about: [run],
      detail: `${run} is a ${cited.kind} record, and evidence cites a run`,
    });
  }
  const attestation = await verifiedAttestationFor(opened, run);
  try {
    evidenceKindOf(cited as RunRecord, attestation);
  } catch (error) {
    throw new OperationError({
      reason: "invalid-input",
      about: [run],
      detail: `${run} cannot back evidence: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  try {
    return (await admitEvidenceEdge(selector, run, admissionWorkspace)).edge;
  } catch (error) {
    if (isKernelError(error) && !(error instanceof SelectorRefusedError)) {
      throw error;
    }
    throw new OperationError({
      reason: "invalid-input",
      about: [renderSelector(selector), run],
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}
