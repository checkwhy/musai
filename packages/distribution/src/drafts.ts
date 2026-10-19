import type { Workspace } from "@musai/api-core";
import { type AppliedPlan, draftRefusal, OperationError } from "@musai/api-core";
import type { OperationPlan } from "@musai/modules";
import type {
  ArgumentRecord,
  ArtifactRecord,
  CaseRecord,
  ClaimRecord,
  MusaiRecord,
  RecordId,
  RecordKind,
} from "@musai/records";
import { UngrammaredFormatError } from "./anchor/formats.js";
import { admitDraftedCase, admitExclusiveGroup, admittedClaimType, type PlannedClaim } from "./ops/case.js";
import { assertChallengeable } from "./ops/challenge.js";
import { unresolvedAnchor } from "./ops/save.js";

/** One record a plan puts, as `realisePlan` hashed it; a case keeps its booking's `about`. */
interface Draft {
  readonly id: RecordId;
  readonly kind: RecordKind;
  readonly record: MusaiRecord;
  readonly about: readonly string[] | undefined;
}

function admitArgument(draft: ArgumentRecord, kindOf: (id: RecordId) => RecordKind): void {
  if (draft.evidence.length === 0) {
    throw new OperationError({
      reason: "invalid-input",
      about: [draft.target],
      detail: "an argument rests on evidence, and this one cites none",
    });
  }
  assertChallengeable(draft.target, kindOf(draft.target));
}

/** Admits a pack's claim through the functions `case.book` mints through, so a drafted claim of a
 * type means what a booked one does. */
function admitClaim(
  claim: PlannedClaim,
  siblings: readonly PlannedClaim[],
  operation: string,
  opened: Workspace,
): void {
  admittedClaimType(claim.record, operation, opened.claimTypes);
  admitExclusiveGroup(claim, siblings, operation, opened);
}

/** Admits a pack's artifact through `case.save`'s anchor check. Only `drafted` is admitted: later
 * states come from the verbs that rule on an artifact. */
function admitArtifact(draft: ArtifactRecord, kindOf: (id: RecordId) => RecordKind, known: (id: RecordId) => boolean) {
  const caseKind = kindOf(draft.case);
  if (caseKind !== "case") {
    throw new OperationError({
      reason: "no-such-record",
      about: [draft.case],
      detail: `an artifact belongs to a case, and ${draft.case} is a ${caseKind} record`,
    });
  }
  if (draft.lifecycle !== "drafted") {
    throw new OperationError({
      reason: "invalid-input",
      about: [draft.case],
      detail: `an artifact is drafted before it is anything else, and this one is ${draft.lifecycle}`,
    });
  }
  try {
    const refusal = unresolvedAnchor(
      "the drafted artifact",
      new TextEncoder().encode(draft.content as string),
      draft.format,
      known,
    );
    if (refusal !== null) {
      throw new OperationError({ reason: refusal.reason, about: [draft.case], detail: refusal.detail });
    }
  } catch (error) {
    if (!(error instanceof UngrammaredFormatError)) {
      throw error;
    }
  }
}

/** Refuses a plan whose drafts the matching verb would refuse, so a field has one way in whoever
 * drafts it. It only reads, so a preview is refused exactly where the call would be. */
export async function admitDrafts(
  plan: OperationPlan,
  realised: AppliedPlan,
  operation: string,
  opened: Workspace,
): Promise<void> {
  const drafts: Draft[] = plan.put.map((entry, index) => ({
    id: realised.minted[index]!.id,
    kind: entry.kind,
    record: realised.minted[index]!.record as MusaiRecord,
    about: entry.about,
  }));
  const inPlan = new Map(drafts.map((draft) => [draft.id, draft]));
  const claims: PlannedClaim[] = drafts
    .filter((draft) => draft.kind === "claim")
    .map((draft) => ({ id: draft.id, record: draft.record as ClaimRecord }));
  const kindOf = (id: RecordId): RecordKind => inPlan.get(id)?.kind ?? opened.read(id).kind;
  const known = (id: RecordId): boolean => {
    try {
      kindOf(id);
      return true;
    } catch {
      return false;
    }
  };

  for (const [index, draft] of drafts.entries()) {
    try {
      if (draft.kind === "argument") {
        const argument = draft.record as ArgumentRecord;
        if (argument.premises.length > 0) {
          throw new OperationError({
            reason: "invalid-input",
            about: [...argument.premises],
            detail: "an argument rests on the evidence it cites, and no verb lets its maker name premises beside it",
          });
        }
        admitArgument(argument, kindOf);
      } else if (draft.kind === "claim") {
        admitClaim({ id: draft.id, record: draft.record as ClaimRecord }, claims, operation, opened);
      } else if (draft.kind === "case") {
        await admitDraftedCase(draft.id, draft.record as CaseRecord, draft.about ?? [], known, opened);
      } else if (draft.kind === "artifact") {
        admitArtifact(draft.record as ArtifactRecord, kindOf, known);
      } else {
        throw new OperationError({
          reason: "invalid-output",
          about: [draft.id],
          detail: `there is no admission for a ${draft.kind}, and a kind a pack may mint has one`,
        });
      }
    } catch (error) {
      throw draftRefusal(error, operation, index, draft.kind, "its kind's admission refuses");
    }
  }
}
