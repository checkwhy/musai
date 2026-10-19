import type { NumberPolicyShape } from "../canonical/numbers.js";
import type { ClaimTypes } from "./claim-types.js";
import type { RecordKind } from "./kinds.js";

/** A validator's draft, every field but the schema version, or its refusal. Each kind exports its
 * draft alias: an unexported one puts the schema declaration in an import cycle. */
export type DraftResult<T> = { readonly ok: true; readonly record: T } | { readonly ok: false; readonly error: string };

/** An unregistered claim type is refused on a record about to be written, and admitted on one read
 * back from git, whose bytes are what they are. */
export interface ValidationOptions {
  readonly unregisteredClaimTypes: "refuse" | "admit";
  readonly claimTypes: ClaimTypes;
}

/** Maps an older version's fields into the current shape, for one kind at one version. */
export type SchemaNormalizer = (fields: Record<string, unknown>) => Record<string, unknown>;

/** Everything one record kind declares. Generic over the draft, since `Omit` over a union would
 * drop a field only one branch carries. */
export interface KindContract<K extends RecordKind, Draft extends { readonly kind: K }> {
  readonly kind: K;
  readonly version: number;
  /** Keyed by the version each maps from, straight to the current shape. Shipped entries win over
   * a test's registry. */
  readonly normalizers: Readonly<Record<number, SchemaNormalizer>>;
  /** What a record declaring the current version is refused for, and one minted earlier holds as
   * it was minted; null where nothing. */
  readonly currentRefusal?: (fields: Record<string, unknown>) => string | null;
  /** Which fields are exact and which measured; declared by every kind, numeric or not. */
  readonly numberPolicy: NumberPolicyShape;
  /** Where a sealed value may stand; the reserved key is refused everywhere else. */
  readonly sealedPaths: ReadonlySet<string>;
  /** Whether a pack's plan may put this kind; a pack writing runs or attestations would vouch for
   * itself. */
  readonly packMayDraft: boolean;
  /** Whether a writer may ask the kernel to salt a record of this kind. */
  readonly saltable: boolean;
  readonly validate: (fields: Record<string, unknown>, options: ValidationOptions) => DraftResult<Draft>;
}
