import { recordId } from "../canonical/canonicalize.js";
import { assertNumberPolicy } from "../canonical/numbers.js";
import { isPlainObject } from "../canonical/plain-object.js";
import { NO_CLAIM_TYPES } from "./claim-types.js";
import type { DraftResult, KindContract, ValidationOptions } from "./contract.js";
import { invalid } from "./fields.js";
import { type ArgumentRecord, argumentContract } from "./kinds/argument.js";
import { type ArtifactRecord, artifactContract } from "./kinds/artifact.js";
import { type AttestationRecord, attestationContract } from "./kinds/attestation.js";
import { type CaseRecord, caseContract } from "./kinds/case.js";
import { type ClaimRecord, claimContract } from "./kinds/claim.js";
import { type ModuleRecord, moduleContract } from "./kinds/module.js";
import { type RuleRecord, ruleContract } from "./kinds/rule.js";
import { type RulingRecord, rulingContract } from "./kinds/ruling.js";
import { type RunRecord, runContract } from "./kinds/run.js";
import { isRecordKind, RECORD_KINDS, type RecordKind } from "./kinds.js";
import { uncomposedStatement } from "./references.js";
import { misplacedSealedPath, SEALED_KEY } from "./sealed.js";

export type MusaiRecord =
  | ClaimRecord
  | ArgumentRecord
  | RunRecord
  | RulingRecord
  | RuleRecord
  | CaseRecord
  | ArtifactRecord
  | AttestationRecord
  | ModuleRecord;

/** A record rebuilt from its kind's allow-list, so no stray key survives, or the refusal. */
export type ValidationResult =
  | { readonly ok: true; readonly record: MusaiRecord }
  | { readonly ok: false; readonly error: string };

const WRITE_VALIDATION: ValidationOptions = { unregisteredClaimTypes: "refuse", claimTypes: NO_CLAIM_TYPES };

/** Typed over the closed kind list, so a kind with no contract does not compile. */
export const KIND_CONTRACTS = {
  claim: claimContract,
  argument: argumentContract,
  run: runContract,
  ruling: rulingContract,
  rule: ruleContract,
  case: caseContract,
  artifact: artifactContract,
  attestation: attestationContract,
  module: moduleContract,
} satisfies { readonly [K in RecordKind]: KindContract<K, { readonly kind: K }> };

/** The version this kernel writes per kind; a newer record is refused, never reinterpreted. */
export const CURRENT_SCHEMA_VERSIONS: Record<RecordKind, number> = Object.fromEntries(
  RECORD_KINDS.map((kind) => [kind, KIND_CONTRACTS[kind].version] as const),
) as Record<RecordKind, number>;

/** Enforced on a pack's plan at the module boundary; a distribution's own plan is not narrowed. */
export const PACK_MINTABLE_KINDS: readonly RecordKind[] = RECORD_KINDS.filter(
  (kind) => KIND_CONTRACTS[kind].packMayDraft,
);

/** A run's id is its content so a re-run agrees, and no other kind left out holds a guess. */
export const SALTABLE_KINDS: readonly RecordKind[] = RECORD_KINDS.filter((kind) => KIND_CONTRACTS[kind].saltable);

/** The one place a declared schema version is acted on; validators see only the current shape. */
function normalizeSchemaVersion(
  contract: KindContract<RecordKind, { readonly kind: RecordKind }>,
  fields: Record<string, unknown>,
): { readonly ok: true; readonly fields: Record<string, unknown> } | { readonly ok: false; readonly error: string } {
  const { kind, version, normalizers } = contract;
  const declared = fields["schemaVersion"];
  if (typeof declared !== "number") {
    return { ok: false, error: `${kind}.schemaVersion is required` };
  }
  if (declared > version) {
    return {
      ok: false,
      error: `${kind} declares schemaVersion ${declared}, but this kernel writes ${kind} at schemaVersion ${version}`,
    };
  }
  if (declared === version) {
    const refusal = contract.currentRefusal?.(fields) ?? null;
    return refusal === null ? { ok: true, fields } : { ok: false, error: refusal };
  }
  const normalizer = normalizers[declared];
  if (normalizer === undefined) {
    return {
      ok: false,
      error: `${kind} declares schemaVersion ${declared} with no normaliser to schemaVersion ${version}`,
    };
  }
  return { ok: true, fields: { ...normalizer(fields), schemaVersion: version } };
}

/** The only place `schemaVersion` is written onto a constructed record. */
function attachVersion<T extends object>(result: DraftResult<T>, schemaVersion: number): ValidationResult {
  if (!result.ok) {
    return result;
  }
  return { ok: true, record: { ...result.record, schemaVersion } as unknown as MusaiRecord };
}

/** Whether a stored value carries only what its kind's contract allows at the version it declares:
 * a validator rebuilds the fields it knows, and an older version's normaliser drops a salt. */
export function holdsOnlyItsContract(value: Record<string, unknown>, record: MusaiRecord): boolean {
  const versioned = normalizeSchemaVersion(KIND_CONTRACTS[record.kind], value);
  return (
    versioned.ok &&
    !("salt" in value && !("salt" in versioned.fields)) &&
    recordId(versioned.fields) === recordId(record)
  );
}

/** Validates against the closed kinds. The number policy is walked here, the one boundary from
 * JSON to a typed record, so no per-kind validator repeats a numeric test. */
export function validateRecord(value: unknown, options: ValidationOptions = WRITE_VALIDATION): ValidationResult {
  if (!isPlainObject(value)) {
    return invalid("a record must be a JSON object");
  }
  const kind = value["kind"];
  if (!isRecordKind(kind)) {
    return invalid(`not a record kind: ${String(kind)}`);
  }
  const contract = KIND_CONTRACTS[kind];
  const versioned = normalizeSchemaVersion(contract, value);
  if (!versioned.ok) {
    return invalid(versioned.error);
  }
  const normalizedFields = versioned.fields;
  const violations = assertNumberPolicy(normalizedFields, contract.numberPolicy);
  if (violations.length > 0) {
    const detail = violations
      .map((violation) => `${violation.path} must be ${violation.expected}, got ${violation.actualType}`)
      .join("; ");
    return invalid(`${kind} disagrees with its declared number policy: ${detail}`);
  }
  // Before the allow-list rebuild, so a reserved key in a field carried through unread is seen.
  const misplaced = misplacedSealedPath(normalizedFields, contract.sealedPaths);
  if (misplaced !== null) {
    return invalid(
      `${kind} carries a ${SEALED_KEY} value at ${misplaced}, which is malformed or outside the positions a sealed value may take`,
    );
  }
  const uncomposedAt = uncomposedStatement({ ...normalizedFields, kind });
  if (uncomposedAt !== null) {
    return invalid(
      `${kind} states text at ${uncomposedAt} outside Unicode NFC; a statement is composed before it is minted`,
    );
  }
  return attachVersion<{ readonly kind: RecordKind }>(contract.validate(normalizedFields, options), contract.version);
}
