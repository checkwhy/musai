import { recordId } from "../canonical/canonicalize.js";
import type { Slot } from "../conditions/slot.js";
import { KernelError } from "../reason/error.js";

/** A claim type as a module declares it: data, since no function crosses a module's boundary. */
export interface ClaimTypeDeclaration {
  readonly type: string;
  readonly identityDimensions: readonly string[];
  /** The JSON Schema of the type's `canonical` payload; absent leaves the payload unchecked. */
  readonly canonical?: unknown;
}

/** The claim types one call validates against: what the caller knows, not what is loaded. */
export type ClaimTypes = ReadonlyMap<string, ClaimTypeDeclaration>;

/** Refuses a second declaration of one type id, which would shadow another pack's, and a type
 * with no identity dimensions, on which every record would collide. */
export function claimTypesFrom(declarations: readonly ClaimTypeDeclaration[]): ClaimTypes {
  const types = new Map<string, ClaimTypeDeclaration>();
  for (const declaration of declarations) {
    if (types.has(declaration.type)) {
      throw new KernelError({
        reason: "declaration-conflict",
        detail: `claim type already registered: ${declaration.type}`,
        about: [declaration.type],
      });
    }
    if (declaration.identityDimensions.length === 0) {
      throw new RangeError(`claim type declares no identity dimensions: ${declaration.type}`);
    }
    types.set(declaration.type, declaration);
  }
  return types;
}

export const NO_CLAIM_TYPES: ClaimTypes = new Map<string, ClaimTypeDeclaration>();

/** The base type every claim satisfies trivially, identified by subject, predicate and object. */
export const TRIPLE_CLAIM_TYPE = "triple@1";

export interface TripleCanonical {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
}

export const TRIPLE_DECLARATION: ClaimTypeDeclaration = {
  type: TRIPLE_CLAIM_TYPE,
  identityDimensions: ["subject", "predicate", "object"],
};

/** A claim's slot, digested from its declared identity dimensions alone. */
export function slotFor(declaration: ClaimTypeDeclaration, conditions: Readonly<Record<string, unknown>>): Slot {
  const identity: Record<string, unknown> = {};
  for (const dimension of declaration.identityDimensions) {
    identity[dimension] = conditions[dimension] ?? null;
  }
  return recordId({ claimType: declaration.type, identity }) as unknown as Slot;
}
