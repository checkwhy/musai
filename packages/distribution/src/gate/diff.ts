import type { Workspace } from "@musai/api-core";
import type { ComputedRunRecord, RecordId } from "@musai/records";
import { parseBriefSubstrates } from "../brief/recipe.js";
import { fullReadIds } from "../brief/render.js";

/** One read that differs between a brief's head and the store's tip. */
export interface MovedRead {
  readonly id: RecordId;
  readonly before: "unread" | "read";
  readonly after: "unread" | "read";
}

/** What moved between a brief's head and the tip, compared over the untrimmed read set and decided
 * by the kernel's staleness machinery, not a comparison of its own. */
export async function movedReadsDiff(view: Workspace, brief: ComputedRunRecord): Promise<readonly MovedRead[]> {
  const { head: renderedHead, caseId } = parseBriefSubstrates(brief.recipe);
  const gateClaimId = brief.recipe.command[1] as RecordId | undefined;
  if (gateClaimId === undefined) {
    return [];
  }

  const currentHead = view.index.watermark();
  if (currentHead === null || currentHead === renderedHead) {
    return [];
  }

  const renderTimeIds = await fullReadIds(view, caseId, gateClaimId, renderedHead);
  const currentIds = await fullReadIds(view, caseId, gateClaimId, currentHead);

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
