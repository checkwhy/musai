import { isRecordId, type RecordId } from "../canonical/canonicalize.js";
import { isPlainObject } from "../canonical/plain-object.js";
import type { SchemaNormalizer } from "./contract.js";
import type { RecordKind } from "./kinds.js";

export function invalid(message: string): { readonly ok: false; readonly error: string } {
  return { ok: false, error: message };
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isRecordIdArray(value: unknown): value is RecordId[] {
  return Array.isArray(value) && value.every(isRecordId);
}

export function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainObject(value) && Object.values(value).every((entry) => typeof entry === "string");
}

/** A list of record ids one record names. Whether each exists, or is of the expected kind, is the
 * fold's question, not the bytes'. */
export function parseRecordIdList(
  value: unknown,
  kind: RecordKind,
  field: string,
  whenEmpty: string,
): { readonly ok: true; readonly ids: RecordId[] } | { readonly ok: false; readonly error: string } {
  if (!isRecordIdArray(value)) {
    return { ok: false, error: `${kind}.${field} must be an array of record ids, ${whenEmpty}` };
  }
  return { ok: true, ids: [...value] };
}

/** A record a writer may salt. */
export interface Salted {
  /** Minted by the kernel under the workspace key when its writer asks, never named by a caller,
   * so whoever lacks the key cannot confirm a guess at the record by hashing it. */
  salt?: string;
}

const SALT_PATTERN = /^[0-9a-f]{64}$/;

/** The salt a record carries, as a field to spread into the rebuilt record. */
export function parseSalt(
  fields: Record<string, unknown>,
  kind: RecordKind,
): { readonly ok: true; readonly field: Salted } | { readonly ok: false; readonly error: string } {
  if (!("salt" in fields)) {
    return { ok: true, field: {} };
  }
  const salt = fields["salt"];
  if (typeof salt !== "string" || !SALT_PATTERN.test(salt)) {
    return invalid(`${kind}.salt must be 64 lowercase hex digits, the keyed hash its workspace minted`);
  }
  return { ok: true, field: { salt } };
}

/** An older version knew no salt, so a salt its bytes carry is a field outside its contract. */
export const withoutSalt: SchemaNormalizer = ({ salt: _salt, ...fields }) => fields;
