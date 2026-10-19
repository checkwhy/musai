import { createHash, createHmac } from "node:crypto";
import canonicalize from "canonicalize";

/** SHA-256 of a value's RFC 8785 canonical bytes; the prefix keeps a future algorithm distinct. */
export type RecordId = `sha256:${string}`;

export const RECORD_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function isRecordId(value: unknown): value is RecordId {
  return typeof value === "string" && RECORD_ID_PATTERN.test(value);
}

export function hexOfRecordId(id: RecordId): string {
  return id.slice("sha256:".length);
}

function canonicalText(value: unknown): string {
  const text = canonicalize(value);
  if (text === undefined) {
    throw new TypeError("value has no canonical JSON representation");
  }
  return text;
}

/** The UTF-8 bytes of a value's RFC 8785 canonical JSON. */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalText(value));
}

function digestId(bytes: Uint8Array): RecordId {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return `sha256:${digest}`;
}

/** The only function that mints a record id from JSON. */
export function recordId(value: unknown): RecordId {
  return digestId(canonicalBytes(value));
}

/** The id of bytes already final as they stand, such as a blob's payload. */
export function rawId(bytes: Uint8Array): RecordId {
  return digestId(bytes);
}

/** `ssh-keygen -l`'s fingerprint of a public key blob: SHA-256 in unpadded base64. */
export function sshKeyFingerprint(blob: Uint8Array): string {
  const digest = Buffer.from(hexOfRecordId(rawId(blob)), "hex");
  return `SHA256:${digest.toString("base64").replace(/=+$/, "")}`;
}

/** Hashed into every run-environment keyed hash; changing it orphans every hash minted. */
export const RUN_ENV_HASH_PURPOSE = "musai/run-env/v1";

/** HMAC-SHA256 of canonical `{ purpose, name, value }` under a workspace key, so a peer holding
 * the hash cannot confirm a guess at the value. */
export function keyedHash(key: Uint8Array, purpose: string, name: string, value: string): string {
  const bytes = canonicalBytes({ purpose, name, value });
  return createHmac("sha256", key).update(bytes).digest("hex");
}

/** Hashed into every record's salt, so a salt never equals a receipt's keyed hash. */
const RECORD_SALT_PURPOSE = "musai/record-salt/v1";

/** The salt a workspace key gives an unsalted record, one salt for one record under one key. */
export function saltFor(key: Uint8Array, record: { readonly kind: string }): string {
  return keyedHash(key, RECORD_SALT_PURPOSE, record.kind, canonicalText(record));
}

/** Hashed into a clearance's salting key, so it is neither a salt nor a receipt's keyed hash. */
const CLEARANCE_SALT_KEY_PURPOSE = "musai/clearance-salt-key/v1";

/** The key a station cleared to `clearance` salts under, so its guess takes no author's id. */
export function clearanceSaltKey(key: Uint8Array, clearance: string): Uint8Array {
  return Buffer.from(keyedHash(key, CLEARANCE_SALT_KEY_PURPOSE, "clearance", clearance), "hex");
}
