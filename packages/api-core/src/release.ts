import type { IndexDb } from "@musai/fold";
import {
  ANY_SCOPE,
  type AttestationRecord,
  instantOf,
  type RecordId,
  type ReleaseAttestationRecord,
  type RevocationAttestationRecord,
  type SealAttestationRecord,
  type Timestamp,
} from "@musai/records";
import { type Audiences, covers, may } from "@musai/trust";
import { signatureCheck } from "./signature-check.js";
import type { Workspace } from "./workspace.js";

/** A release attestation with its id, standing or withdrawn. */
export interface StandingRelease {
  readonly id: RecordId;
  readonly record: ReleaseAttestationRecord;
}

/** What stands for a subject, and what a counting revocation withdrew from it. */
export interface ReleaseStanding {
  readonly standing: readonly StandingRelease[];
  readonly revoked: readonly StandingRelease[];
}

/** A seal attestation with its id, standing or lifted. */
export interface StandingSeal {
  readonly id: RecordId;
  readonly record: SealAttestationRecord;
}

/** What seals a subject, and what a counting revocation lifted from it. */
export interface SealStanding {
  readonly standing: readonly StandingSeal[];
  readonly revoked: readonly StandingSeal[];
}

type Entry<T extends AttestationRecord> = { readonly id: RecordId; readonly record: T };

type Standing<T extends AttestationRecord> = { readonly standing: Entry<T>[]; readonly revoked: Entry<T>[] };

/** No attestation's `at` is read: what supersedes what decides, so no forward date outruns a
 * revocation and no two instants tie; only an attestation `landed` answers for counts. */
export function releaseStanding(
  opened: Workspace,
  subject: RecordId,
  author: IndexDb = opened.index,
  landed: (id: RecordId) => boolean = () => true,
): Promise<ReleaseStanding> {
  return standingOf<ReleaseAttestationRecord>(opened, author, subject, "released", landed);
}

/** Decided as a release's standing is: signed by a holder of `publish`, lifted by a revocation. */
export function sealStanding(
  opened: Workspace,
  subject: RecordId,
  author: IndexDb = opened.index,
  landed: (id: RecordId) => boolean = () => true,
): Promise<SealStanding> {
  return standingOf<SealAttestationRecord>(opened, author, subject, "sealed", landed);
}

async function standingOf<T extends ReleaseAttestationRecord | SealAttestationRecord>(
  opened: Workspace,
  author: IndexDb,
  subject: RecordId,
  purpose: T["purpose"],
  landed: (id: RecordId) => boolean,
): Promise<Standing<T>> {
  const attestations = author.attestationsBySubject(subject).filter((entry) => landed(entry.id));
  const named = attestations.filter((entry): entry is Entry<T> => entry.record.purpose === purpose);
  const counting: Entry<T>[] = [];
  for (const entry of named) {
    if (await grantCounts(opened, entry)) {
      counting.push(entry);
    }
  }
  const revokedIds = new Set<RecordId>();
  for (const entry of attestations) {
    // A seal is never lifted through a model, as the record contract refuses one made through it.
    if (entry.record.purpose === "revoked" && !(purpose === "sealed" && entry.record.via === "model")) {
      const revocation = entry as Entry<RevocationAttestationRecord>;
      if (await revocationCounts(opened, revocation, named)) {
        for (const id of revocation.record.supersedes) {
          revokedIds.add(id);
        }
      }
    }
  }
  const replacedIds = new Set(counting.flatMap((entry) => entry.record.supersedes));
  return {
    standing: counting.filter((entry) => !revokedIds.has(entry.id) && !replacedIds.has(entry.id)),
    revoked: counting.filter((entry) => revokedIds.has(entry.id)),
  };
}

/** Either end of the window open when `null`; `now` is the operation's recorded clock. */
export function windowHolds(release: StandingRelease, now: Timestamp): boolean {
  const { from, until } = release.record.terms;
  const at = instantOf(now);
  return (from === null || instantOf(from) <= at) && (until === null || at < instantOf(until));
}

/** An exact audience first, then the smaller id, so the choice is the same on every machine. */
export function coveringRelease(
  standing: readonly StandingRelease[],
  target: string,
  audiences: Audiences,
  now: Timestamp,
): StandingRelease | undefined {
  const covering = standing.filter(
    (release) => covers(audiences, release.record.audience, target) && windowHolds(release, now),
  );
  const rank = (release: StandingRelease) => (release.record.audience === target ? 0 : 1);
  return [...covering].sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
}

/** A release relayed through a model never counts, as admission refuses one made through it. */
async function grantCounts(opened: Workspace, entry: Entry<AttestationRecord>): Promise<boolean> {
  return (
    entry.record.via !== "model" &&
    may(opened.matrix, entry.record.principal, "publish", ANY_SCOPE) &&
    (await signatureCheck(opened, entry)).good
  );
}

/** Signed, and by a principal holding `publish` or by the one who signed every release, or every
 * seal, it names. */
async function revocationCounts(
  opened: Workspace,
  entry: Entry<RevocationAttestationRecord>,
  granted: readonly Entry<AttestationRecord>[],
): Promise<boolean> {
  if (!(await signatureCheck(opened, entry)).good) {
    return false;
  }
  if (may(opened.matrix, entry.record.principal, "publish", ANY_SCOPE)) {
    return true;
  }
  const withdrawn = granted.filter((grant) => entry.record.supersedes.includes(grant.id));
  return withdrawn.length > 0 && withdrawn.every((grant) => grant.record.principal === entry.record.principal);
}
