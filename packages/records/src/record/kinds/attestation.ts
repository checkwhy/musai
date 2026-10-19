import { isRecordId, type RecordId } from "../../canonical/canonicalize.js";
import { instantOf, isTimestamp, type Timestamp } from "../../canonical/numbers.js";
import { isPlainObject } from "../../canonical/plain-object.js";
import { type Audience, isAudience } from "../audience.js";
import type { DraftResult, KindContract } from "../contract.js";
import { invalid, parseRecordIdList } from "../fields.js";
import { attestingPrincipalProblem } from "../principal.js";
import { misusedPseudonymPrefix } from "../pseudonym.js";

/** Whether the principal is a person or an agent acting for one. */
export type PrincipalClass = "person" | "agent";

export const PRINCIPAL_CLASSES: readonly PrincipalClass[] = ["person", "agent"];

export function isPrincipalClass(value: unknown): value is PrincipalClass {
  return typeof value === "string" && (PRINCIPAL_CLASSES as readonly string[]).includes(value);
}

export const ATTESTATION_PURPOSES = ["made", "asserted", "re-shared", "released", "revoked", "sealed"] as const;

export type AttestationPurpose = (typeof ATTESTATION_PURPOSES)[number];

/** The purposes a pack's plan may ask for. The others decide what leaves the machine or what a
 * station sees, which `publish` governs, and a pack's plan runs under authority it declares. */
export const PACK_ATTEST_PURPOSES = ["made", "asserted"] as const satisfies readonly AttestationPurpose[];

/** A release of the record alone, or of everything its id fixes as cited. */
export const RELEASE_EXTENTS = ["record", "closure"] as const;

export type ReleaseExtent = (typeof RELEASE_EXTENTS)[number];

/** `id` leaves a signed hole where the bytes would be. */
export const RELEASE_FORMS = ["bytes", "id"] as const;

export type ReleaseForm = (typeof RELEASE_FORMS)[number];

/** In the order a release lists them. */
export const RELEASE_USES = ["review", "cite", "republish"] as const;

export type ReleaseUse = (typeof RELEASE_USES)[number];

export interface ReleaseTerms {
  readonly form: ReleaseForm;
  readonly uses: readonly ReleaseUse[];
  readonly from: Timestamp | null;
  readonly until: Timestamp | null;
  readonly marking: string | null;
}

/** What a release grants: the fields beyond those every attestation carries. */
export interface ReleaseGrant {
  readonly audience: Audience;
  readonly extent: ReleaseExtent;
  readonly terms: ReleaseTerms;
}

/** What a seal names: the audience the record is hidden from; with no extent, the record alone. */
export interface Seal {
  readonly audience: Audience;
  readonly extent?: "closure";
}

const MARKING = /^[a-z][a-z0-9+.-]*:\S+$/;

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

/** What is wrong with a release's terms, or `null`; a verb asks before anything is signed. */
export function releaseTermsProblem(terms: unknown): string | null {
  if (typeof terms !== "object" || terms === null || Array.isArray(terms)) {
    return "a release's terms are an object naming form, uses, from, until and marking";
  }
  const { form, uses, from, until, marking } = terms as Record<string, unknown>;
  if (!oneOf(RELEASE_FORMS, form)) {
    return `a release's terms.form is one of ${RELEASE_FORMS.join(", ")}, got ${String(form)}`;
  }
  if (
    !Array.isArray(uses) ||
    uses.length === 0 ||
    !uses.every((use) => oneOf(RELEASE_USES, use)) ||
    uses.some((use, index) => index > 0 && RELEASE_USES.indexOf(use) <= RELEASE_USES.indexOf(uses[index - 1]))
  ) {
    return `a release's terms.uses grants at least one of ${RELEASE_USES.join(", ")}, each once and in that order`;
  }
  for (const [field, value] of [
    ["from", from],
    ["until", until],
  ] as const) {
    if (value !== null && !isTimestamp(value)) {
      return `a release's terms.${field} is an RFC 3339 timestamp or null`;
    }
  }
  if (from !== null && until !== null && instantOf(from as Timestamp) >= instantOf(until as Timestamp)) {
    return "a release's terms.from comes before its terms.until";
  }
  if (marking !== null && (typeof marking !== "string" || !MARKING.test(marking))) {
    return "a release's terms.marking is null or <scheme>:<value>, the scheme in lowercase";
  }
  if (uses.includes("republish") && (typeof marking !== "string" || !marking.startsWith("spdx:"))) {
    return "a release granting republish names its licence as an spdx: marking";
  }
  return null;
}

/** How the answer arrived; a relayed channel, `model` or `process`, never yields a person-class
 * ruling: the channel is the check, the class is the claim. */
export const VIA_CHANNELS = ["elicitation", "tty", "signature", "model", "process"] as const;

export type ViaChannel = (typeof VIA_CHANNELS)[number];

export function isViaChannel(value: unknown): value is ViaChannel {
  return typeof value === "string" && (VIA_CHANNELS as readonly string[]).includes(value);
}

/** A relayed channel's answer is an agent's and provisional, whatever principal it names. */
export function isRelayedChannel(via: ViaChannel): boolean {
  return via === "model" || via === "process";
}

interface AttestationFields {
  kind: "attestation";
  schemaVersion: number;
  subject: RecordId;
  principal: string;
  principalClass: PrincipalClass;
  via: ViaChannel;
  at: Timestamp;
  /** The records this one replaces; a correction is a successor, never an edit. */
  supersedes: RecordId[];
}

export interface MadeAttestationRecord extends AttestationFields {
  purpose: "made" | "asserted" | "re-shared";
}

/** Grants export of a record, or its closure, to an audience under terms; the only place that fact
 * lives. */
export interface ReleaseAttestationRecord extends AttestationFields {
  purpose: "released";
  audience: Audience;
  extent: ReleaseExtent;
  terms: ReleaseTerms;
}

/** Withdraws exactly the releases and seals its `supersedes` names. */
export interface RevocationAttestationRecord extends AttestationFields {
  purpose: "revoked";
}

/** Hides a record, or its closure, from each station cleared for its audience, inside it or
 * containing it; no model relays one. */
export interface SealAttestationRecord extends AttestationFields {
  purpose: "sealed";
  seal: Seal;
}

/** The only kind that puts a signature behind a principal. The class is required, since a
 * testimony run's evidence kind is derived from it. */
export type AttestationRecord =
  | MadeAttestationRecord
  | ReleaseAttestationRecord
  | RevocationAttestationRecord
  | SealAttestationRecord;

type MadeAttestationDraft = Omit<MadeAttestationRecord, "schemaVersion">;
type ReleaseAttestationDraft = Omit<ReleaseAttestationRecord, "schemaVersion">;
type RevocationAttestationDraft = Omit<RevocationAttestationRecord, "schemaVersion">;
type SealAttestationDraft = Omit<SealAttestationRecord, "schemaVersion">;
export type AttestationDraft =
  | MadeAttestationDraft
  | ReleaseAttestationDraft
  | RevocationAttestationDraft
  | SealAttestationDraft;

const RELEASE_FIELDS = ["audience", "extent", "terms"] as const;

function validateAttestation(fields: Record<string, unknown>): DraftResult<AttestationDraft> {
  const { subject, principal, principalClass, via, purpose, at } = fields;
  const supersedes = parseRecordIdList(
    fields["supersedes"],
    "attestation",
    "supersedes",
    "empty when nothing is replaced",
  );
  if (!supersedes.ok) {
    return invalid(supersedes.error);
  }
  if (!isRecordId(subject)) {
    return invalid("attestation.subject must be a record id");
  }
  if (typeof principal !== "string") {
    return invalid("attestation.principal must be a string");
  }
  const misusedPrefix = misusedPseudonymPrefix(principal, "attestation.principal");
  if (misusedPrefix !== null) {
    return invalid(misusedPrefix);
  }
  if (!isPrincipalClass(principalClass)) {
    return invalid(
      `attestation.principalClass must be one of ${PRINCIPAL_CLASSES.join(", ")}, got ${String(principalClass)}`,
    );
  }
  if (!isViaChannel(via)) {
    return invalid(`attestation.via must be one of ${VIA_CHANNELS.join(", ")}, got ${String(via)}`);
  }
  if (typeof purpose !== "string" || !(ATTESTATION_PURPOSES as readonly string[]).includes(purpose)) {
    return invalid(`attestation.purpose must be one of ${ATTESTATION_PURPOSES.join(", ")}`);
  }
  if (!isTimestamp(at)) {
    return invalid("attestation.at must be an RFC 3339 timestamp");
  }
  if ("class" in fields) {
    return invalid(
      "a release names an audience, an extent and terms; one naming a class was minted at an earlier version and is re-minted, never read",
    );
  }
  if (purpose !== "sealed" && "seal" in fields) {
    return invalid(`only a seal names seal; a ${purpose} attestation carries none`);
  }
  const base = {
    kind: "attestation" as const,
    subject,
    principal,
    principalClass,
    via,
    at,
    supersedes: supersedes.ids,
  };
  if (purpose === "released") {
    const { audience, extent, terms } = fields;
    if (typeof audience !== "string" || !isAudience(audience)) {
      return invalid(
        `a release's audience is public, key:SHA256:<fingerprint>, identity:<issuer>#<subject> or a name, got ${String(audience)}`,
      );
    }
    if (!oneOf(RELEASE_EXTENTS, extent)) {
      return invalid(`a release's extent is one of ${RELEASE_EXTENTS.join(", ")}, got ${String(extent)}`);
    }
    const problem = releaseTermsProblem(terms);
    if (problem !== null) {
      return invalid(problem);
    }
    const { form, uses, from, until, marking } = terms as ReleaseTerms;
    const record: ReleaseAttestationDraft = {
      ...base,
      purpose,
      audience,
      extent,
      terms: { form, uses: [...uses], from, until, marking },
    };
    return { ok: true, record };
  }
  const carried = RELEASE_FIELDS.filter((field) => field in fields);
  if (carried.length > 0) {
    return invalid(`only a release names ${carried.join(", ")}; a ${purpose} attestation carries none of them`);
  }
  if (purpose === "sealed") {
    if (via === "model") {
      return invalid("a seal is signed and never relayed through model");
    }
    const named = isPlainObject(fields["seal"]) ? fields["seal"] : {};
    const { audience, extent } = named;
    if (typeof audience !== "string" || !isAudience(audience)) {
      return invalid(
        `a seal's seal.audience is public, key:SHA256:<fingerprint>, identity:<issuer>#<subject> or a name, got ${String(audience)}`,
      );
    }
    // One meaning, one id: a seal of its record alone names no extent.
    if ("extent" in named && extent !== "closure") {
      return invalid(`a seal's seal.extent is closure where named, and absent for the record, got ${String(extent)}`);
    }
    const seal: Seal = "extent" in named ? { audience, extent: "closure" } : { audience };
    const record: SealAttestationDraft = { ...base, purpose, seal };
    return { ok: true, record };
  }
  if (purpose === "revoked") {
    if (supersedes.ids.length === 0) {
      return invalid("a revocation's supersedes names the releases and seals it withdraws, and is never empty");
    }
    return { ok: true, record: { ...base, purpose } };
  }
  const record: MadeAttestationDraft = {
    kind: "attestation",
    subject,
    principal,
    principalClass,
    via,
    purpose: purpose as MadeAttestationRecord["purpose"],
    at,
    supersedes: supersedes.ids,
  };
  return { ok: true, record };
}

export const attestationContract: KindContract<"attestation", AttestationDraft> = {
  kind: "attestation",
  version: 6,
  normalizers: {
    2: (fields) => ({ ...fields, supersedes: [] }),
    3: (fields) => fields,
    4: (fields) => fields,
    5: (fields) => fields,
  },
  currentRefusal: ({ principal }) =>
    typeof principal === "string" ? attestingPrincipalProblem(principal, "attestation.principal") : null,
  numberPolicy: { schemaVersion: "measured", at: "exact" },
  sealedPaths: new Set(),
  packMayDraft: false,
  saltable: false,
  validate: validateAttestation,
};
