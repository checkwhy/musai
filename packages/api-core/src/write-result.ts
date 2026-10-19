import type { RecordId, RecordKind } from "@musai/records";

/** A record a write minted, body included, so a caller never re-reads the store. */
export interface MintedRecord {
  readonly id: RecordId;
  readonly kind: RecordKind;
  readonly record: unknown;
}

export interface WriteResult {
  readonly minted: readonly MintedRecord[];
}

/** The JSON Schema of `WriteResult.minted`, shared by every writing operation's output. */
export const MINTED_ARRAY_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["id", "kind", "record"],
    properties: {
      id: { type: "string" },
      kind: { type: "string" },
      record: true,
    },
  },
};

/** The JSON Schema of a writing verb's `salt` input. */
export const SALT_INPUT_SCHEMA = {
  type: "boolean",
  description: "salt what this mints under the workspace key, so whoever lacks the key cannot confirm a guess at it",
};

/** What a put entry spreads in to ask the kernel for a salt where its caller asked for one. */
export function saltAsked(salt: boolean | undefined): { readonly salt?: true } {
  return salt === true ? { salt: true } : {};
}
