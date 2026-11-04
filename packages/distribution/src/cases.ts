import { isDeepStrictEqual } from "node:util";
import type { Workspace } from "@musai/api-core";
import { OperationError } from "@musai/api-core";
import { type CaseRecord, isRecordId, type MusaiRecord, type RecordId } from "@musai/records";
import { printable } from "@musai/run";
import { RecordNotFoundError } from "@musai/store";
import { forkRemedy, onlyMatch, shortIdHex } from "./claim-ref.js";

export interface FoundCase {
  readonly id: RecordId;
  readonly record: CaseRecord;
}

function slugForked(opened: Workspace, slug: string, live: readonly FoundCase[], until: string): OperationError {
  const ids = opened.index.inLandingOrder(live).map(({ id }) => id);
  return new OperationError({
    reason: "invalid-input",
    about: [slug, ...ids],
    detail: `the slug ${printable(slug)} is forked between the live cases ${ids.join(", ")}: ${forkRemedy("case")}; until then, ${until}`,
  });
}

/** The one live case under `slug`, refused by name where two fork it. */
function liveCaseAt(opened: Workspace, slug: string): FoundCase | null {
  const live = opened.index.casesAtSlug(slug);
  if (live.length > 1) {
    throw slugForked(opened, slug, live, "name one by its id");
  }
  return live[0] ?? null;
}

/** Refuses work in the view of a forked slug: the view belongs to the slug, never to one case. */
export function refuseForkedView(opened: Workspace, slug: string): void {
  const live = opened.index.casesAtSlug(slug);
  if (live.length > 1) {
    throw slugForked(opened, slug, live, "no case under it opens or saves its view");
  }
}

/** The case at a slug, named by the slug or by any case id `book` printed for it; a live case
 * answers by its own id even where its slug is forked. */
export async function findCaseRecord(opened: Workspace, named: string): Promise<FoundCase | null> {
  if (!isRecordId(named)) {
    return liveCaseAt(opened, named);
  }
  try {
    const record = (await opened.store.read(named, "case")) as CaseRecord;
    return opened.index.casesAtSlug(record.slug).find(({ id }) => id === named) ?? liveCaseAt(opened, record.slug);
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
    throw new OperationError({
      reason: "no-such-record",
      about: [named],
      detail: `no case found named ${printable(named)}`,
    });
  }
  return found.record;
}

function listed(cases: readonly FoundCase[]): string {
  return [...cases]
    .sort((a, b) => (a.record.slug === b.record.slug ? 0 : a.record.slug < b.record.slug ? -1 : 1))
    .map(({ id, record }) => `${id} (${printable(record.slug)})`)
    .join(", ");
}

/** The one of the cases citing `claimId` that `named` spells, by slug, by id or by a short id;
 * refused where it spells none of them, or one of a forked slug. */
function citingCaseNamed(opened: Workspace, claimId: RecordId, named: string, citing: readonly FoundCase[]): FoundCase {
  const hex = citing.some(({ record }) => record.slug === named) ? undefined : shortIdHex(named);
  const byId =
    hex === undefined ? undefined : onlyMatch(opened.index, named, hex, opened.index.casesWithHexPrefix(hex), "case");
  const found = citing.find(({ id, record }) => record.slug === named || id === byId?.id);
  if (found === undefined && byId === undefined && opened.index.casesAtSlug(named).length === 0) {
    throw new OperationError({
      reason: "no-such-record",
      about: [named],
      detail: `no case found named ${printable(named)}`,
    });
  }
  if (found === undefined) {
    throw new OperationError({
      reason: "invalid-input",
      about: [named, claimId],
      detail: `${printable(named)} names no live case citing claim ${claimId}; the cases citing it are ${listed(citing)}`,
    });
  }
  const forked = citing.filter(({ record }) => record.slug === found.record.slug);
  if (forked.length > 1) {
    throw slugForked(opened, found.record.slug, forked, "no brief reads the claim under any of them");
  }
  return found;
}

/** The case citing `claimId` or a record it descends from: the one `named` spells, else the only
 * one, refused where cases under two slugs or two live cases under one slug cite it. */
export async function findCaseForClaim(opened: Workspace, claimId: RecordId, named?: string): Promise<FoundCase> {
  const citing = opened.index.casesForClaim(claimId);
  const [first] = citing;
  if (first === undefined) {
    throw new OperationError({ reason: "no-such-record", about: [claimId], detail: `no case cites claim ${claimId}` });
  }
  if (named !== undefined) {
    return citingCaseNamed(opened, claimId, named, citing);
  }
  if (citing.some(({ record }) => record.slug !== first.record.slug)) {
    throw new OperationError({
      reason: "invalid-input",
      about: [claimId, ...citing.map(({ id }) => id)],
      detail: `the cases ${listed(citing)}, under different slugs, each cite claim ${claimId}; name one as \`case\`, by its slug, its id or a short id`,
    });
  }
  if (citing.length > 1) {
    const ids = citing.map(({ id }) => id);
    throw new OperationError({
      reason: "invalid-input",
      about: [claimId, ...ids],
      detail: `the live cases ${ids.join(", ")} under the slug ${printable(first.record.slug)} each cite claim ${claimId}, and nothing says which is current; ${forkRemedy("case")}`,
    });
  }
  return first;
}

/** What a case holds, apart from its succession, its version and its salt. */
function caseContent({ supersedes, schemaVersion, salt, ...content }: CaseRecord) {
  return content;
}

/** The case among `read` that `live` descends from carrying all it held, as `keep` mints one,
 * so keeping it moves nothing a brief read; else `live` itself. */
function caseReadNow(opened: Workspace, live: FoundCase, read: readonly string[]): string {
  const reaches = (from: RecordId): boolean =>
    opened.index.successorsOf(from).some(({ successor }) => successor === live.id || reaches(successor));
  // A fold holds a succession from a predecessor withheld from it, which it cannot compare.
  const carried = read.find((id) => {
    const held = opened.index.recordById(id as RecordId)?.record;
    return (
      held?.kind === "case" && reaches(id as RecordId) && isDeepStrictEqual(caseContent(held), caseContent(live.record))
    );
  });
  return carried ?? live.id;
}

/** The case in a brief's `reads` still standing for `claimId`: a live case citing it, or the case a
 * live keep citing it carries, where no other live case under that slug cites the claim. */
export function standingCase(opened: Workspace, claimId: RecordId, reads: readonly string[]): string | null {
  const citing = opened.index.casesForClaim(claimId);
  const unforked = citing.filter(
    ({ record }) => citing.filter((other) => other.record.slug === record.slug).length === 1,
  );
  return unforked.map((live) => caseReadNow(opened, live, reads)).find((id) => reads.includes(id)) ?? null;
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
