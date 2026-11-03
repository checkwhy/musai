import type { Admission, IndexDb } from "@musai/fold";
import {
  type Audience,
  canonicalBytes,
  hexOfRecordId,
  type MusaiRecord,
  type RecordId,
  rawId,
  recipeReadKey,
  recordId,
  referencesOf,
} from "@musai/records";
import { readTrustTip } from "@musai/store";
import { type Audiences, covers } from "@musai/trust";
import { checkReceiptsOf, evaluatedRecipesOf, namesModuleRule } from "./check-receipts.js";
import { walkCitations } from "./citations.js";
import { releaseStanding, sealStanding, withdrawalVerdicts } from "./release.js";
import type { Workspace } from "./workspace.js";

/** Named in the digest, so a cleared fold built under an earlier rule is refolded from nothing. */
const CLEARANCE_RULE = 9;

/** What `clearance` reads, judged up front against `author`, the fold holding every seal; the
 * digest names what stands, so a seal, release, revocation or trust change refolds the fold. */
export async function clearanceAdmission(opened: Workspace, author: IndexDb, clearance: Audience): Promise<Admission> {
  // Read first: a seal landing while standing is judged lies past it, never folded unjudged.
  const through = author.watermark();
  // Standing is judged as of `through`, so one position always judges to one digest.
  const landed = (id: RecordId) => through !== null && author.landedBy(id, through);
  // A later version's attestation the fold refused still withdraws a release from where it lands.
  const landedOrRefused = (id: RecordId) => landed(id) || (through !== null && author.laterLandedBy(id, through));
  // Each pair is judged from whichever of its two landed later, so neither withdraws what was held.
  const evaluated = new Map<RecordId, Pair[]>();
  const blinding: Pair[] = [];
  const sealed = await subjectsStanding(author, "sealed", async (subject) => {
    const reaching = (await sealStanding(opened, subject, author, landed)).standing.filter((seal) =>
      hides(opened.audiences, seal.record.seal.audience, clearance),
    );
    const closures = reaching.filter((seal) => seal.record.seal.extent === "closure");
    if (closures.length > 0) {
      // What landed by the earliest seal's commit is fixed there; what lands later, in log order.
      const commits = closures.map((seal) => author.commitOf(seal.id)!);
      const bySeal = (id: RecordId) => commits.every((commit) => author.landedBy(id, commit));
      // Nothing landed past `through` is read, so one position always walks to one closure.
      const closure = await walkCitations(
        [subject],
        (id) => id,
        (id) => (landed(id) ? closureNext(author, id, landed, (evaluation) => bySeal(evaluation) && bySeal(id)) : []),
      );
      for (const member of closure) {
        const record = author.recordById(member)?.record;
        if (record?.kind === "claim") {
          for (const [recipe, evaluations] of evaluatedRecipesOf(author, member, record, landed)) {
            evaluated.set(recipe, [
              ...(evaluated.get(recipe) ?? []),
              ...evaluations.map((evaluation) => ({ by: evaluation, member })),
            ]);
          }
          for (const seal of namesModuleRule(record) ? closures : []) {
            blinding.push({ by: seal.id, member });
          }
        }
      }
      return closure;
    }
    return reaching.length > 0 ? [subject] : [];
  });
  // No window is read: a fold whose rows hung on a clock would differ by when it was built.
  const lowered = await subjectsStanding(author, "released", async (subject) =>
    (await releaseStanding(opened, subject, author, landedOrRefused)).standing.some((release) =>
      covers(opened.audiences, release.record.audience, clearance),
    )
      ? [subject]
      : [],
  );
  // Each judged once per admission, since forks and merges of drafts reach one id by many paths.
  const casesJudged = new Map<RecordId, boolean>();
  const draftsJudged = new Map<RecordId, boolean>();
  // Judged in no landing order, which can only find more withheld than the fold withholds.
  const caseWithheld = (id: RecordId): boolean => {
    if (!casesJudged.has(id)) {
      const record = landed(id) ? author.recordById(id)?.record : undefined;
      casesJudged.set(
        id,
        sealed.has(id) || (record?.kind === "case" && !lowered.has(id) && record.supersedes.some(caseWithheld)),
      );
    }
    return casesJudged.get(id)!;
  };
  // A successor withheld for its case folds no succession there, so the draft it replaces goes too.
  const retires = (id: RecordId): boolean => {
    if (!draftsJudged.has(id)) {
      draftsJudged.set(
        id,
        lowered.has(id) &&
          author.successorsOf(id).some(({ successor }) => {
            const record = landed(successor) ? author.recordById(successor)?.record : undefined;
            return (
              record?.kind === "artifact" &&
              caseWithheld(record.case) &&
              (!lowered.has(successor) || retires(successor))
            );
          }),
      );
    }
    return draftsJudged.get(id)!;
  };
  // What a retired draft replaced would read live there in its place, so it goes with it.
  const retired = new Set(
    await walkCitations(
      [...lowered].filter(retires),
      (id) => id,
      (id) => (landed(id) ? (author.recordById(id)?.record.supersedes ?? []) : []),
    ),
  );
  const hidden = (id: RecordId) => sealed.has(id) || retired.has(id);
  // A sealed id withholds whenever it lands; one withheld by derivation only if it landed first.
  const withheld = (id: RecordId, commit: string, admitted: (id: RecordId) => boolean) =>
    hidden(id) || (!admitted(id) && author.landedBy(id, commit));
  const bothBy =
    (commit: string) =>
    ({ by, member }: Pair) =>
      author.landedBy(by, commit) && author.landedBy(member, commit);
  // A receipt is judged at its own landing, so nothing landing later withdraws it once held.
  const readBy = (record: MusaiRecord, commit: string) =>
    record.kind === "run" && evaluated.size > 0 && (evaluated.get(recordId(record.recipe)) ?? []).some(bothBy(commit));
  // A receipt nothing in its own commit read may be one a failed loop paid for.
  const landedApart = (id: RecordId, record: MusaiRecord, commit: string) =>
    record.kind === "run" &&
    record.runKind === "run" &&
    blinding.some(bothBy(commit)) &&
    !author
      .readersOf(recipeReadKey(recordId(record.recipe)))
      .some(({ reader, consumed }) => consumed.sha256 === hexOfRecordId(id) && author.commitOf(reader) === commit);
  // Judged here, where the bytes are read, since a station's store holds none it withholds.
  const { verified, replacing } = await withdrawalVerdicts(opened, author, landedOrRefused);
  return {
    // Sorted, so the digest names the sets and not the order a walk reached them in.
    digest: rawId(
      canonicalBytes({
        rule: CLEARANCE_RULE,
        clearance,
        sealed: [...sealed].sort(),
        lowered: [...lowered].sort(),
        retired: [...retired].sort(),
        blinding: blinding.map(({ by, member }) => `${by} ${member}`).sort(),
        // Named, so a trust move that turns a verdict refolds what a station holds of it.
        verified: [...verified].sort(),
        replacing: [...replacing].sort(),
        members: [...new Set([...blinding, ...[...evaluated.values()].flat()].map(({ member }) => member))]
          .map((member) => `${member} ${author.commitOf(member)}`)
          .sort(),
      }),
    ),
    through,
    trust: opened.matrix.commit,
    trustTip: () => readTrustTip(opened.ctx),
    admits: ({ id, record, commit }, admitted) => {
      const withholds = (other: RecordId) => withheld(other, commit, admitted);
      if (
        hidden(id) ||
        readBy(record, commit) ||
        landedApart(id, record, commit) ||
        (record.kind === "attestation" && withholds(record.subject))
      ) {
        return false;
      }
      const reached =
        record.kind === "run"
          ? record.observation.reads.flatMap(({ consumed }) =>
              consumed.sha256 === undefined ? [] : [`sha256:${consumed.sha256}` as const],
            )
          : record.kind === "artifact"
            ? [record.case]
            : [];
      return lowered.has(id) || ![...record.supersedes, ...reached].some(withholds);
    },
    withholds: withheld,
    verifies: (id) => verified.has(id),
    replaces: (id) => replacing.has(id),
    judgedAgain: async () => clearanceAdmission(await opened.atTrustTip(clearance), author, clearance),
  };
}

/** A seal or an evaluation, beside the closure member that made it count. */
interface Pair {
  readonly by: RecordId;
  readonly member: RecordId;
}

/** A seal reaches its audience, every audience inside it, and every audience containing it. */
function hides(audiences: Audiences, sealedFrom: Audience, clearance: Audience): boolean {
  return covers(audiences, sealedFrom, clearance) || covers(audiences, clearance, sealedFrom);
}

/** What a release's closure carries past a record, as the author's fold holds it: what it cites
 * and, for a check claim, its rule's receipts landed by the position judged at. */
function closureNext(
  author: IndexDb,
  id: RecordId,
  landed: (id: RecordId) => boolean,
  evaluated: (id: RecordId) => boolean,
): readonly RecordId[] {
  const record = author.recordById(id)?.record;
  if (record === undefined) {
    return [];
  }
  const cited = referencesOf({ ...record }).citations.map((citation) => citation.id);
  const receipts = record.kind === "claim" ? checkReceiptsOf(author, id, record, landed, evaluated) : [];
  return [...cited, ...receipts.map((receipt) => receipt.recordId)];
}

async function subjectsStanding(
  author: IndexDb,
  purpose: "sealed" | "released",
  reach: (subject: RecordId) => Promise<readonly RecordId[]>,
): Promise<ReadonlySet<RecordId>> {
  const standing = new Set<RecordId>();
  for (const subject of author.subjectsAttested(purpose)) {
    for (const id of await reach(subject)) {
      standing.add(id);
    }
  }
  return standing;
}
