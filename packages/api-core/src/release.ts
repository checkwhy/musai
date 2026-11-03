import type { IndexDb } from "@musai/fold";
import {
  ANY_SCOPE,
  type AttestationRecord,
  type FixedAttestation,
  instantOf,
  type RecordId,
  type ReleaseAttestationRecord,
  type SealAttestationRecord,
  type Timestamp,
} from "@musai/records";
import { type Attestation, type Audiences, covers, may, type RoleMatrix } from "@musai/trust";
import { signatureCheck } from "./signature-check.js";
import type { Workspace } from "./workspace.js";

/** A release attestation with its id, standing or withdrawn. */
export interface StandingRelease {
  readonly id: RecordId;
  readonly record: ReleaseAttestationRecord;
}

/** A counting revocation that withdrew a release, the principal it names, and whether its
 * signature verified. */
export interface Withdrawal {
  readonly id: RecordId;
  readonly principal: string;
  readonly verified: boolean;
}

/** A withdrawn release, with every counting revocation that withdrew it. */
export interface RevokedRelease extends StandingRelease {
  readonly withdrawnBy: readonly Withdrawal[];
}

/** What stands for a subject, and what a counting revocation withdrew from it. */
export interface ReleaseStanding {
  readonly standing: readonly StandingRelease[];
  readonly revoked: readonly RevokedRelease[];
}

/** A seal attestation with its id, standing or lifted; one whose signature does not verify
 * withholds all the same, since a sidecar lies outside the id and stripping it must not unseal. */
export interface StandingSeal {
  readonly id: RecordId;
  readonly record: SealAttestationRecord;
  readonly verified: boolean;
}

/** What seals a subject, and what a counting revocation lifted from it. */
export interface SealStanding {
  readonly standing: readonly StandingSeal[];
  readonly revoked: readonly StandingSeal[];
}

type Entry<T extends FixedAttestation> = { readonly id: RecordId; readonly record: T };

/** An attestation of any version, read only for what every version fixes. */
type Fixed = Entry<FixedAttestation>;

/** An attestation the fold holds only to withdraw: a later version's it refused, or one a cleared
 * fold withholds, read only for what every version fixes. */
export type Withdrawing = Fixed;

type Counted<T extends AttestationRecord> = Entry<T> & { readonly verified: boolean };

type Standing<T extends AttestationRecord> = {
  readonly standing: Counted<T>[];
  readonly revoked: (Counted<T> & { readonly withdrawnBy: Withdrawal[] })[];
};

/** No attestation's `at` is read: what supersedes what decides, so no forward date outruns a
 * revocation and no two instants tie; only an attestation `landed` answers for counts. */
export async function releaseStanding(
  opened: Workspace,
  subject: RecordId,
  author: IndexDb = opened.index,
  landed: (id: RecordId) => boolean = () => true,
): Promise<ReleaseStanding> {
  const own = author.attestationsBySubject(subject);
  const released = own.filter((entry) => entry.record.purpose === "released").map((entry) => entry.id);
  const attestations = distinct([...own, ...released.flatMap((id) => author.attestationsSuperseding(id))]);
  const withdrawing = distinct([
    ...author.withdrawingBySubject(subject),
    ...released.flatMap((id) => author.withdrawingSuperseding(id)),
  ]);
  const landedAttestations = attestations.filter((entry) => landed(entry.id));
  const landedWithdrawing = withdrawing.filter((entry) => landed(entry.id));
  const unjudged = landedWithdrawing.filter((entry) => entry.verified === null);
  const verified = await verifiedAmong(opened, [...landedAttestations, ...unjudged], "released");
  for (const entry of landedWithdrawing.filter((each) => each.verified === true)) {
    verified.add(entry.id);
  }
  const among = releaseStandingAmong(subject, landedAttestations, landedWithdrawing, opened.matrix, verified);
  return { ...among, standing: among.standing.filter((release) => !author.replacedWithheld(release.id)) };
}

/** What a withdrawal reads of each release and revocation, judged against `author` where its bytes
 * are read, so a cleared fold carries the verdict and a station reads no bytes. */
export interface WithdrawalVerdicts {
  readonly verified: ReadonlySet<RecordId>;
  /** Verified releases by a holder of `publish` through no model, which replace what they name. */
  readonly replacing: ReadonlySet<RecordId>;
}

export async function withdrawalVerdicts(
  opened: Workspace,
  author: IndexDb,
  landed: (id: RecordId) => boolean,
): Promise<WithdrawalVerdicts> {
  const subjects = new Set([...author.subjectsAttested("released"), ...author.subjectsAttested("revoked")]);
  const held = [...subjects].flatMap((subject) => author.attestationsBySubject(subject));
  const withdrawing = distinct([...held, ...author.withdrawingAttestations()]).filter(
    (entry) => landed(entry.id) && (entry.record.purpose === "released" || entry.record.purpose === "revoked"),
  );
  const verified = await verifiedAmong(opened, withdrawing, "released");
  const replacing = withdrawing.filter(
    (entry) => entry.record.purpose === "released" && grantedBy(opened.matrix, entry) && verified.has(entry.id),
  );
  return { verified, replacing: new Set(replacing.map((entry) => entry.id)) };
}

function distinct<T extends Fixed>(entries: readonly T[]): T[] {
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()];
}

/** Decided as a release's standing is, by a holder of `publish` and lifted by a signed revocation,
 * save that a seal whose signature does not verify stands unverified. */
export async function sealStanding(
  opened: Workspace,
  subject: RecordId,
  author: IndexDb = opened.index,
  landed: (id: RecordId) => boolean = () => true,
): Promise<SealStanding> {
  const attestations = author.attestationsBySubject(subject).filter((entry) => landed(entry.id));
  const verified = await verifiedAmong(opened, attestations, "sealed");
  // What the fold holds only to withdraw may only narrow what leaves, so none lifts a seal.
  return standingAmong<SealAttestationRecord>(subject, attestations, [], "sealed", opened.matrix, verified);
}

/** The attestations whose signature verifies, of those the standing of `purpose` reads one of. */
async function verifiedAmong(
  opened: Workspace,
  attestations: readonly Fixed[],
  purpose: "released" | "sealed",
): Promise<Set<RecordId>> {
  const verified = new Set<RecordId>();
  for (const { id, record } of attestations.filter((each) => signatureCounts(opened.matrix, each, purpose))) {
    // An attestation naming no principal or time has no signature a check can read.
    if (record.principal !== null && record.at !== null) {
      if ((await signatureCheck(opened, { id, record: { principal: record.principal, at: record.at } })).good) {
        verified.add(id);
      }
    }
  }
  return verified;
}

/** What stands for `subject` among attestations on any subject, given which verified: a withdrawing
 * one withdraws as it would held whole, and grants nothing. */
export function releaseStandingAmong(
  subject: RecordId,
  attestations: readonly Attestation[],
  withdrawing: readonly Withdrawing[],
  matrix: RoleMatrix,
  verified: ReadonlySet<RecordId>,
): ReleaseStanding {
  return standingAmong<ReleaseAttestationRecord>(subject, attestations, withdrawing, "released", matrix, verified);
}

/** Whether the standing of `purpose` reads this attestation's signature at all. */
function signatureCounts(matrix: RoleMatrix, entry: Fixed, purpose: string): boolean {
  return entry.record.purpose === purpose ? grantedBy(matrix, entry) : revokesFor(entry, purpose);
}

/** A seal is never lifted through a model, as the record contract refuses one made through it. */
function revokesFor(entry: Fixed, purpose: string): boolean {
  return entry.record.purpose === "revoked" && !(purpose === "sealed" && entry.record.via === "model");
}

/** A revocation withdraws on its own subject alone; a replacement from any, as it only narrows. */
function standingAmong<T extends ReleaseAttestationRecord | SealAttestationRecord>(
  subject: RecordId,
  attestations: readonly Entry<AttestationRecord>[],
  withdrawing: readonly Withdrawing[],
  purpose: T["purpose"],
  matrix: RoleMatrix,
  verifiedIds: ReadonlySet<RecordId>,
): Standing<T> {
  const named = attestations.filter(
    (entry): entry is Entry<T> => entry.record.purpose === purpose && entry.record.subject === subject,
  );
  const counting: Counted<T>[] = [];
  for (const entry of named) {
    if (grantedBy(matrix, entry)) {
      const verified = verifiedIds.has(entry.id);
      // Failing closed withholds: an unverified seal hides, an unverified release grants nothing.
      if (verified || purpose === "sealed") {
        counting.push({ ...entry, verified });
      }
    }
  }
  const withdrawals = new Map<RecordId, Withdrawal[]>();
  for (const entry of [...attestations, ...withdrawing]) {
    const { id, record } = entry;
    const { principal, supersedes } = record;
    if (record.subject === subject && principal !== null && revokesFor(entry, purpose)) {
      const verified = verifiedIds.has(id);
      // Lifting a seal shows what it hid, so only there does an unverified revocation not count.
      if ((verified || purpose === "released") && revocationNamesItsOwn(matrix, principal, supersedes, named)) {
        for (const withdrawn of supersedes) {
          withdrawals.set(withdrawn, [...(withdrawals.get(withdrawn) ?? []), { id, principal, verified }]);
        }
      }
    }
  }
  // An unverified seal replaces nothing, so a forged one cannot narrow the seal it supersedes.
  const replacing = [...attestations, ...withdrawing].filter(
    (entry) => entry.record.purpose === purpose && grantedBy(matrix, entry) && verifiedIds.has(entry.id),
  );
  const replacedIds = new Set(replacing.flatMap((entry) => entry.record.supersedes));
  return {
    standing: counting.filter((entry) => !withdrawals.has(entry.id) && !replacedIds.has(entry.id)),
    revoked: counting.flatMap((entry) => {
      const withdrawnBy = withdrawals.get(entry.id);
      return withdrawnBy === undefined ? [] : [{ ...entry, withdrawnBy }];
    }),
  };
}

/** Withdrawn by no revocation whose signature verifies, so its writer may be anyone. */
export function withdrawnUnverified(release: RevokedRelease): boolean {
  return release.withdrawnBy.every((withdrawal) => !withdrawal.verified);
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

/** A record a coverage judges, with the records it cites. */
export interface CoverageMember {
  readonly id: RecordId;
  readonly cites: readonly RecordId[];
}

/** What keeps an uncovered member home: a revocation of its release, or the release's window. */
export type Withholding =
  | { readonly because: "revoked"; readonly release: RevokedRelease }
  | { readonly because: "window"; readonly release: StandingRelease };

export interface ReleaseCoverage {
  readonly covering: ReadonlyMap<RecordId, StandingRelease>;
  readonly uncovered: readonly { readonly id: RecordId; readonly withheld: Withholding | null }[];
}

/** The members of `members` each member reaches through what it cites, itself included. */
function reachOf(members: readonly CoverageMember[]): ReadonlyMap<RecordId, ReadonlySet<RecordId>> {
  const byId = new Map(members.map((member) => [member.id, member]));
  return new Map(
    members.map((member) => {
      const reached = new Set<RecordId>();
      const pending = [member.id];
      for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
        if (!reached.has(next) && byId.has(next)) {
          reached.add(next);
          pending.push(...byId.get(next)!.cites);
        }
      }
      return [member.id, reached];
    }),
  );
}

/** A member is covered for `to` at `now` by a release of its own, or by a closure release of a
 * member that reaches it; `standing` holds each member's release standing. */
export function releaseCoverage(
  members: readonly CoverageMember[],
  standing: ReadonlyMap<RecordId, ReleaseStanding>,
  to: string,
  audiences: Audiences,
  now: Timestamp,
): ReleaseCoverage {
  const reach = reachOf(members);
  const reaching = <T extends StandingRelease>(id: RecordId, pick: (of: ReleaseStanding) => readonly T[]): T[] =>
    members.flatMap((member) =>
      pick(standing.get(member.id)!).filter(
        (release) => member.id === id || (release.record.extent === "closure" && reach.get(member.id)!.has(id)),
      ),
    );
  const covering = new Map<RecordId, StandingRelease>();
  const uncovered: { id: RecordId; withheld: Withholding | null }[] = [];
  for (const member of members) {
    const candidates = reaching(member.id, (of) => of.standing);
    const release = coveringRelease(candidates, to, audiences, now);
    if (release !== undefined) {
      covering.set(member.id, release);
      continue;
    }
    const revoked = reaching(member.id, (of) => of.revoked).find((r) => covers(audiences, r.record.audience, to));
    const lapsed = candidates.find((r) => covers(audiences, r.record.audience, to));
    const withheld: Withholding | null =
      revoked !== undefined
        ? { because: "revoked", release: revoked }
        : lapsed !== undefined
          ? { because: "window", release: lapsed }
          : null;
    uncovered.push({ id: member.id, withheld });
  }
  return { covering, uncovered };
}

/** A release or seal relayed through a model never counts, as admission refuses one so made. */
function grantedBy(matrix: RoleMatrix, { record }: Fixed): boolean {
  return record.via !== "model" && record.principal !== null && may(matrix, record.principal, "publish", ANY_SCOPE);
}

/** By a principal holding `publish` or the principal of every release, or every seal, it names. */
function revocationNamesItsOwn(
  matrix: RoleMatrix,
  principal: string,
  supersedes: readonly RecordId[],
  granted: readonly Entry<AttestationRecord>[],
): boolean {
  if (may(matrix, principal, "publish", ANY_SCOPE)) {
    return true;
  }
  const withdrawn = granted.filter((grant) => supersedes.includes(grant.id));
  return withdrawn.length > 0 && withdrawn.every((grant) => grant.record.principal === principal);
}
