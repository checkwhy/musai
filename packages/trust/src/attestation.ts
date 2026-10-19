import type { ReleaseGrant, RevocationAttestationRecord, Seal, SealAttestationRecord, Timestamp } from "@musai/records";
import {
  ATTESTATION_PURPOSES,
  type AttestationPurpose,
  type AttestationRecord,
  attestingPrincipalProblem,
  CURRENT_SCHEMA_VERSIONS,
  isPrincipalClass,
  isViaChannel,
  type MadeAttestationRecord,
  type PrincipalClass,
  type RecordId,
  type ReleaseAttestationRecord,
  recordId,
  releaseTermsProblem,
  type ViaChannel,
} from "@musai/records";

export function isAttestationPurpose(value: unknown): value is AttestationPurpose {
  return typeof value === "string" && (ATTESTATION_PURPOSES as readonly string[]).includes(value);
}

/** An attestation record with the id the kernel computed for it. */
export interface Attestation {
  readonly id: RecordId;
  readonly record: AttestationRecord;
}

export interface MintAttestationInput {
  readonly subject: RecordId;
  readonly principal: string;
  readonly principalClass: PrincipalClass;
  readonly via: ViaChannel;
  readonly purpose: AttestationPurpose;
  readonly at: Timestamp;
  /** What a release grants; required for `released`, refused for every other purpose. */
  readonly release?: ReleaseGrant;
  /** What a seal hides, and from whom; required for `sealed`, refused for every other purpose. */
  readonly seal?: Seal;
  /** The attestations this one replaces or withdraws; a revocation names at least one. */
  readonly supersedes?: readonly RecordId[];
}

/** Mints an attestation record and its id, refusing a release with no grant, a seal with no
 * audience or a revocation that withdraws nothing. */
export function mintAttestation(input: MintAttestationInput): Attestation {
  if (!isAttestationPurpose(input.purpose)) {
    throw new RangeError(`not an attestation purpose: ${input.purpose}`);
  }
  const principalProblem = attestingPrincipalProblem(input.principal, "an attestation's principal");
  if (principalProblem !== null) {
    throw new RangeError(principalProblem);
  }
  if (!isPrincipalClass(input.principalClass)) {
    throw new RangeError(`not a principal class: ${input.principalClass}`);
  }
  if (!isViaChannel(input.via)) {
    throw new RangeError(`not a via channel: ${String(input.via)}`);
  }
  if ((input.purpose === "released") !== (input.release !== undefined)) {
    throw new RangeError(`a release, and only a release, names what it grants: ${input.purpose}`);
  }
  if ((input.purpose === "sealed") !== (input.seal !== undefined)) {
    throw new RangeError(`a seal, and only a seal, names the audience it seals from: ${input.purpose}`);
  }
  const supersedes = [...(input.supersedes ?? [])];
  if (input.purpose === "revoked" && supersedes.length === 0) {
    throw new RangeError("a revocation names the releases and seals it withdraws");
  }
  const base = {
    kind: "attestation" as const,
    supersedes,
    schemaVersion: CURRENT_SCHEMA_VERSIONS.attestation,
    subject: input.subject,
    principal: input.principal,
    principalClass: input.principalClass,
    via: input.via,
    at: input.at,
  };
  if (input.release !== undefined) {
    const problem = releaseTermsProblem(input.release.terms);
    if (problem !== null) {
      throw new RangeError(problem);
    }
    const { audience, extent, terms } = input.release;
    const record: ReleaseAttestationRecord = {
      ...base,
      purpose: "released",
      audience,
      extent,
      terms: { ...terms, uses: [...terms.uses] },
    };
    return { id: recordId(record), record };
  }
  if (input.seal !== undefined) {
    const { audience, extent } = input.seal;
    const seal = extent === undefined ? { audience } : { audience, extent };
    const record: SealAttestationRecord = { ...base, purpose: "sealed", seal };
    return { id: recordId(record), record };
  }
  if (input.purpose === "revoked") {
    const record: RevocationAttestationRecord = { ...base, purpose: "revoked" };
    return { id: recordId(record), record };
  }
  const record: MadeAttestationRecord = { ...base, purpose: input.purpose as MadeAttestationRecord["purpose"] };
  return { id: recordId(record), record };
}
