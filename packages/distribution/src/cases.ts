import type { Workspace } from "@musai/api-core";
import { OperationError } from "@musai/api-core";
import { type CaseRecord, isRecordId, type MusaiRecord, type RecordId } from "@musai/records";
import { RecordNotFoundError } from "@musai/store";

export interface FoundCase {
  readonly id: RecordId;
  readonly record: CaseRecord;
}

/** The case at a slug, named by the slug or by any case id `book` printed for it. */
export async function findCaseRecord(opened: Workspace, named: string): Promise<FoundCase | null> {
  if (!isRecordId(named)) {
    return opened.index.caseBySlug(named) ?? null;
  }
  try {
    const record = (await opened.store.read(named, "case")) as CaseRecord;
    return opened.index.caseBySlug(record.slug) ?? null;
  } catch (error) {
    if (error instanceof RecordNotFoundError) {
      return null;
    }
    throw error;
  }
}

export async function findCase(opened: Workspace, named: string): Promise<CaseRecord> {
  const found = await findCaseRecord(opened, named);
  if (found === null) {
    throw new OperationError({ reason: "no-such-record", about: [named], detail: `no case found named ${named}` });
  }
  return found.record;
}

/** The case citing `claimId` or a record it descends from, refused by name when none does. */
export async function findCaseForClaim(opened: Workspace, claimId: RecordId): Promise<FoundCase> {
  const found = opened.index.caseForClaim(claimId);
  if (found === undefined) {
    throw new OperationError({ reason: "no-such-record", about: [claimId], detail: `no case cites claim ${claimId}` });
  }
  return found;
}

/** Under a clearance a cited record the fold neither holds nor refused is absent, as if never
 * cited; the fold's refusal, like a missing record for the author, is the reader's to meet. */
export function cited(opened: Workspace, id: RecordId): boolean {
  return opened.clearance === undefined || opened.index.holds(id) || opened.index.refusalFor(id) !== undefined;
}

/** The claims a case cites in its order, each as the record governing its slot; under a clearance
 * a withheld one is absent, while for the author a missing one is refused. */
export function citedClaims(
  opened: Workspace,
  caseRecord: CaseRecord,
): readonly { readonly id: RecordId; readonly record: MusaiRecord }[] {
  return caseRecord.claims
    .filter((id) => cited(opened, id))
    .map((id) => {
      const pinned = opened.read(id);
      const governing = pinned.kind === "claim" ? opened.index.claimAtSlot(pinned.slot) : undefined;
      return governing ?? { id, record: pinned };
    });
}

/** The evidence a claim cites, in its order, a withheld run absent under a clearance, so the claim
 * is judged on what the station reads. */
export function citedEvidence<E extends { readonly run: RecordId }>(opened: Workspace, edges: readonly E[]): E[] {
  return edges.filter((edge) => cited(opened, edge.run));
}
