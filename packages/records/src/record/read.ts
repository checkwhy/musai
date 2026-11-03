import { canonicalBytes, isRecordId, type RecordId, rawId, recordId } from "../canonical/canonicalize.js";
import { isTimestamp, type Timestamp } from "../canonical/numbers.js";
import { isPlainObject } from "../canonical/plain-object.js";
import { KernelError } from "../reason/error.js";
import { NO_CLAIM_TYPES } from "./claim-types.js";
import type { ValidationOptions } from "./contract.js";
import type { RecordKind } from "./kinds.js";
import { CURRENT_SCHEMA_VERSIONS, holdsOnlyItsContract, type MusaiRecord, validateRecord } from "./schema.js";

/** A claim of a type the reader was not handed is admitted, and left for the evaluator. */
const READ_VALIDATION: ValidationOptions = { unregisteredClaimTypes: "admit", claimTypes: NO_CLAIM_TYPES };

/** Raised when the bytes under a record's path are not a record the store would have written. */
export class RecordRefusedError extends KernelError {
  readonly id: RecordId;
  readonly because: string;

  constructor(id: RecordId, because: string) {
    super({ reason: "record-corrupted", detail: `refusing the record stored as ${id}: ${because}`, about: [id] });
    this.name = "RecordRefusedError";
    this.id = id;
    this.because = because;
  }
}

/** The one reader of stored record bytes. A record at the current version must digest back to its
 * id; an older one is normalised, keeps its bytes' id and loses unknown fields. */
export function readStoredRecord(bytes: Uint8Array, id: RecordId, kind: RecordKind): MusaiRecord {
  const actualId = rawId(bytes);
  if (actualId !== id) {
    throw new RecordRefusedError(id, `its bytes digest to ${actualId}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    // The parser's message quotes the bytes it met, so the reason is the same for all of them.
    throw new RecordRefusedError(id, "its bytes are not a JSON document");
  }
  const validation = validateRecord(parsed, READ_VALIDATION);
  if (!validation.ok) {
    throw new RecordRefusedError(id, validation.error);
  }
  if (validation.record.kind !== kind) {
    throw new RecordRefusedError(id, `it is a ${validation.record.kind} record stored under records/${kind}`);
  }
  let rebuiltId: RecordId;
  try {
    rebuiltId = recordId(validation.record);
  } catch {
    // One reason for every such value, so the refusal repeats nothing of what the bytes hold.
    throw new RecordRefusedError(id, "it holds a value with no RFC 8785 canonical form");
  }
  const declared = (parsed as { schemaVersion?: unknown }).schemaVersion;
  if (declared === CURRENT_SCHEMA_VERSIONS[kind]) {
    if (rebuiltId !== id) {
      throw new RecordRefusedError(
        id,
        `its validated form digests to ${rebuiltId}, so the bytes carried something the ${kind} contract does not allow`,
      );
    }
  }
  return validation.record;
}

/** A record arriving whole, read as the fold reads it and refused where its bytes carry a field its
 * kind's contract did not allow at the version they declare, or are not the canonical form. */
export function readArrivingRecord(bytes: Uint8Array, id: RecordId, kind: RecordKind): MusaiRecord {
  const record = readStoredRecord(bytes, id, kind);
  const value = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  if (!holdsOnlyItsContract(value, record)) {
    throw new RecordRefusedError(
      id,
      `its bytes carry a field the ${kind} contract does not allow at schemaVersion ${String(value["schemaVersion"])}`,
    );
  }
  if (!Buffer.from(canonicalBytes(value)).equals(bytes)) {
    throw new RecordRefusedError(id, `its bytes are not the canonical form of the ${record.kind} they hold`);
  }
  return record;
}

/** What every attestation version fixes, read alike from any: a later version only adds a field or
 * a value, so these keep their meaning there; `null` where a later one's field lacks its form. */
export interface FixedAttestation {
  readonly schemaVersion: number;
  readonly subject: RecordId;
  readonly principal: string | null;
  readonly via: string | null;
  readonly purpose: string;
  readonly at: Timestamp | null;
  readonly supersedes: readonly RecordId[];
}

/** `null` unless the bytes are the canonical form of an attestation at a later version, digesting
 * to `id`, naming its subject and purpose; a malformed field costs itself, never a withdrawal. */
export function readLaterAttestation(bytes: Uint8Array, id: RecordId): FixedAttestation | null {
  if (rawId(bytes) !== id) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!isPlainObject(value) || !Buffer.from(canonicalBytes(value)).equals(bytes)) {
      return null;
    }
  } catch {
    return null;
  }
  const { kind, schemaVersion, subject, principal, via, purpose, at, supersedes } = value;
  if (
    kind !== "attestation" ||
    typeof schemaVersion !== "number" ||
    schemaVersion <= CURRENT_SCHEMA_VERSIONS.attestation ||
    !isRecordId(subject) ||
    typeof purpose !== "string"
  ) {
    return null;
  }
  return {
    schemaVersion,
    subject,
    principal: typeof principal === "string" ? principal : null,
    via: typeof via === "string" ? via : null,
    purpose,
    at: isTimestamp(at) ? at : null,
    supersedes: Array.isArray(supersedes) ? supersedes.filter(isRecordId) : [],
  };
}
