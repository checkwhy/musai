import {
  declaresClearance,
  type OperationContext,
  OperationError,
  openWorkspace,
  type Workspace,
} from "@musai/api-core";
import type { Audience, ComputedRunRecord, RecordId } from "@musai/records";
import { briefClearanceOf, parseBriefSubstrates } from "../brief/recipe.js";
import { fullReadIds } from "../brief/render.js";

/** One read that differs between a brief's head and the store's tip. */
export interface MovedRead {
  readonly id: RecordId;
  readonly before: "unread" | "read";
  readonly after: "unread" | "read";
}

/** What moved between a brief's head and the tip over the untrimmed read set, each head read as the
 * brief's clearance reads it, through one the author's `context` opens where `view` is not it. */
export async function movedReadsDiff(
  view: Workspace,
  brief: ComputedRunRecord,
  context: OperationContext,
  briefId: RecordId,
): Promise<readonly MovedRead[]> {
  const clearance = briefClearanceOf(brief.recipe);
  // A station's fold may miss what another clearance reads, so it rules only over its own briefs.
  if (view.clearance !== undefined && clearance !== view.clearance) {
    const under = clearance === undefined ? "without a clearance" : `under the clearance ${clearance}`;
    throw new OperationError({
      reason: "invalid-input",
      about: [briefId],
      detail: `refusing to rule over the brief ${briefId}: it was rendered ${under}; render a brief under the clearance ${view.clearance} and rule over that`,
    });
  }
  const gateClaimId = brief.recipe.command[1] as RecordId | undefined;
  if (gateClaimId === undefined) {
    return [];
  }
  const { head: renderedHead, caseId } = parseBriefSubstrates(brief.recipe);

  const currentHead = view.index.watermark();
  if (currentHead === null || currentHead === renderedHead) {
    return [];
  }

  if (clearance === undefined || clearance === view.clearance) {
    return movedBetween(view, clearance, caseId, gateClaimId, renderedHead, currentHead);
  }
  if (!declaresClearance(view.audiences, clearance)) {
    throw new OperationError({
      reason: "invalid-input",
      about: [clearance],
      detail: `refusing to rule over a brief rendered under the clearance ${clearance}: the audiences file no longer declares it, so what that brief could pack cannot be read again; declare ${clearance} there again, or render a brief without a clearance and rule over that`,
    });
  }
  const cleared = await openWorkspace({ ...context, clearance, reportRefusal: undefined });
  try {
    return await movedBetween(cleared, clearance, caseId, gateClaimId, renderedHead, currentHead);
  } finally {
    cleared.close();
  }
}

async function movedBetween(
  view: Workspace,
  clearance: Audience | undefined,
  caseId: RecordId,
  gateClaimId: RecordId,
  renderedHead: string,
  currentHead: string,
): Promise<readonly MovedRead[]> {
  const renderTimeIds = await fullReadIds(view, caseId, gateClaimId, renderedHead, clearance);
  const currentIds = await fullReadIds(view, caseId, gateClaimId, currentHead, clearance);

  const renderTimeSet = new Set<string>(renderTimeIds);
  const currentSet = new Set<string>(currentIds);

  const moved = new Set<string>();
  for (const id of currentIds) {
    if (!renderTimeSet.has(id)) {
      moved.add(id);
    }
  }
  for (const id of renderTimeIds) {
    if (!currentSet.has(id)) {
      moved.add(id);
    }
  }
  return [...moved].sort().map(
    (id): MovedRead => ({
      id: id as RecordId,
      before: renderTimeSet.has(id) ? "read" : "unread",
      after: currentSet.has(id) ? "read" : "unread",
    }),
  );
}

export function movedReadLine(moved: MovedRead): string {
  return `- ${moved.id}: was ${moved.before}, now ${moved.after}`;
}
