import type { AdmissionWorkspace } from "@musai/evaluate";
import type { OperationPlan, PlannedRecord } from "@musai/modules";
import { type EvidenceEdge, isPlainObject, isSealedValue, KIND_CONTRACTS, type MusaiRecord } from "@musai/records";
import { RecordNotFoundError } from "@musai/store";
import { buildAdmissionWorkspace } from "./admission.js";
import type { OperationContext } from "./context.js";
import { OperationError } from "./errors.js";
import { installedModules } from "./events.js";
import { verifiedEvidenceEdge } from "./evidence.js";
import {
  type AdmittedDeclaration,
  type AppliedPlan,
  admitPlan,
  draftRefusal,
  invalidDraft,
  perform,
  planPrincipal,
  realisePlan,
} from "./plan.js";
import type { Workspace } from "./workspace.js";
import type { MintedRecord } from "./write-result.js";

/** A distribution's admission of a pack's drafts, run after the kernel's own pass. It must refuse
 * a case re-pinning a booked slug and a claim at a slot another exclusive group holds. */
export type DraftAdmission = (
  plan: OperationPlan,
  realised: AppliedPlan,
  operation: string,
  opened: Workspace,
) => Promise<void>;

/** Repeats the module boundary's refusal for a plan that never crossed a host. */
function kindRefusal(draft: MintedRecord): string | undefined {
  return KIND_CONTRACTS[draft.kind].packMayDraft
    ? undefined
    : `a pack drafts no ${draft.kind}, since its kind's contract lets no pack draft one`;
}

function successionRefusal(draft: MintedRecord, opened: Workspace): string | undefined {
  const record = draft.record as MusaiRecord;
  const { supersedes } = record;
  if (supersedes.length === 0) {
    return undefined;
  }
  if (record.kind !== "artifact") {
    return `a ${record.kind} that supersedes a record retires it, and that is an act its own verb asks authority for`;
  }
  if (supersedes.length > 1) {
    return `an artifact stands in for one artifact, and this one names ${supersedes.length}`;
  }
  const predecessorId = supersedes[0]!;
  let predecessor: MusaiRecord;
  try {
    predecessor = opened.read(predecessorId);
  } catch (error) {
    if (error instanceof RecordNotFoundError) {
      return error.detail;
    }
    throw error;
  }
  if (predecessor.kind !== "artifact") {
    return `an artifact stands in for an artifact of its own case, and ${predecessorId} is a ${predecessor.kind} record`;
  }
  if (predecessor.case !== record.case) {
    return `an artifact stands in for an artifact of its own case, and ${predecessorId} belongs to case ${predecessor.case}`;
  }
  return undefined;
}

function sealedValueRefusal(draft: MintedRecord): string | undefined {
  for (const path of KIND_CONTRACTS[draft.kind].sealedPaths) {
    const fields = path.split(".").slice(1);
    let value: unknown = draft.record;
    for (const field of fields) {
      value = isPlainObject(value) ? value[field] : undefined;
    }
    if (isSealedValue(value)) {
      return `its ${fields.join(".")} is sealed, and a value a pack hands over was sealed under no key this workspace holds`;
    }
  }
  return undefined;
}

function saltRefusal(entry: PlannedRecord): string | undefined {
  return isPlainObject(entry.value) && Object.hasOwn(entry.value, "salt")
    ? "a pack names no salt: the kernel mints one where a draft asks for it"
    : undefined;
}

function citedEdges(draft: MintedRecord): readonly EvidenceEdge[] {
  const record = draft.record as MusaiRecord;
  return "evidence" in record ? record.evidence : [];
}

async function admitCitedEdge(
  edge: EvidenceEdge,
  opened: Workspace,
  admissionWorkspace: AdmissionWorkspace,
): Promise<void> {
  const admitted = await verifiedEvidenceEdge(opened, admissionWorkspace, edge.run, edge.selector);
  if (admitted.item !== edge.item) {
    throw new OperationError({
      reason: "invalid-input",
      about: [edge.run, edge.item],
      detail: `the edge on ${edge.run} names item ${edge.item}, and its selector admits ${admitted.item}`,
    });
  }
}

const REFUSED_BY_THE_KERNEL = "the kernel refuses of every draft";

async function admitAnyDraft(
  plan: OperationPlan,
  realised: AppliedPlan,
  operation: string,
  opened: Workspace,
): Promise<void> {
  // Built at the first cited edge, so a plan citing none loads no bundle.
  let admissionWorkspace: AdmissionWorkspace | undefined;
  for (const [index, draft] of realised.minted.slice(0, plan.put.length).entries()) {
    const refusal =
      kindRefusal(draft) ??
      saltRefusal(plan.put[index]!) ??
      successionRefusal(draft, opened) ??
      sealedValueRefusal(draft);
    if (refusal !== undefined) {
      throw invalidDraft(operation, index, draft.kind, `${REFUSED_BY_THE_KERNEL}: ${refusal}`);
    }
    try {
      for (const edge of citedEdges(draft)) {
        admissionWorkspace ??= await buildAdmissionWorkspace(opened, await installedModules(opened));
        await admitCitedEdge(edge, opened, admissionWorkspace);
      }
    } catch (error) {
      throw draftRefusal(error, operation, index, draft.kind, REFUSED_BY_THE_KERNEL);
    }
  }
}

/** Runs a pack's plan through every gate in the one order that holds; a pack cannot declare
 * away the gates it alone faces. */
export async function applyContributedOperation(
  plan: OperationPlan,
  declaration: Omit<AdmittedDeclaration, "contributed">,
  opened: Workspace,
  context: OperationContext,
  admitDrafts: DraftAdmission,
): Promise<AppliedPlan> {
  const operation = `${declaration.id}@${declaration.version}`;
  const principal = await planPrincipal(plan, declaration, opened, context, undefined);
  admitPlan(plan, { ...declaration, contributed: true }, opened, context, principal);
  const realised = await realisePlan(plan, opened, context, operation, principal);
  await admitAnyDraft(plan, realised, operation, opened);
  await admitDrafts(plan, realised, operation, opened);
  return context.mode === "plan" ? realised : await perform(realised, plan.needs, opened);
}
