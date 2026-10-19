import type { FoldRefusal, IndexDb, IndexedContribution } from "@musai/fold";
import type { ClaimTypeDeclaration, ContributionEntry } from "@musai/records";
import { KernelError, SchemaCompiler } from "@musai/records";
import type { AnySchema } from "ajv";
import { kernelPoint } from "../rule/envelope.js";
import { onFirstUse } from "./on-first-use.js";

/** Raised when a `claim-type` contribution cannot become a declaration. */
export class ClaimTypeRefusedError extends KernelError {
  constructor(message: string, about?: readonly string[]) {
    super({ reason: "invalid-input", detail: message, about });
    this.name = "ClaimTypeRefusedError";
  }
}

const schemas = new SchemaCompiler();

const claimTypeOperand = onFirstUse(() =>
  schemas.compile<{
    readonly identityDimensions: readonly string[];
    readonly canonical?: unknown;
  }>(kernelPoint("claim-type")!.input as Record<string, unknown> | boolean),
);

/** A schema that does not compile is one refused row, never an error at every booking. */
function refuseUncompilableCanonical(id: string, canonical: AnySchema): void {
  try {
    schemas.compile(canonical);
  } catch (error) {
    throw new ClaimTypeRefusedError(
      `refusing to register ${id}: the schema its canonical payload satisfies does not compile: ${(error as Error).message}`,
      [id],
    );
  }
}

/** A claim type's id is its contribution id, already namespaced by its module. */
export function claimTypeDeclarationFromEntry(entry: ContributionEntry): ClaimTypeDeclaration {
  const validateClaimTypeOperand = claimTypeOperand();
  if (!validateClaimTypeOperand(entry.input)) {
    throw new ClaimTypeRefusedError(
      `refusing to register ${entry.id}: a claim type's input must declare the identity dimensions a claim of it is identified by, ` +
        `and the schema its canonical payload satisfies where it constrains one: ` +
        `${schemas.errorsText(validateClaimTypeOperand.errors ?? [], { dataVar: "declaration" })}`,
      [entry.id],
    );
  }
  const { identityDimensions, canonical } = entry.input;
  if (canonical !== undefined) {
    refuseUncompilableCanonical(entry.id, canonical as AnySchema);
  }
  return { type: entry.id, identityDimensions, ...(canonical === undefined ? {} : { canonical }) };
}

/** One entry, parsed or refused; a collision is decided over the whole set. */
type ReadClaimType =
  | { readonly row: IndexedContribution; readonly declaration: ClaimTypeDeclaration; readonly reason?: undefined }
  | { readonly row: IndexedContribution; readonly declaration?: undefined; readonly reason: string };

/** The claim types that stand, and one refusal per declaration that cannot. */
export interface ClaimTypeDeclarations {
  readonly declarations: readonly ClaimTypeDeclaration[];
  readonly refused: readonly FoldRefusal[];
}

/** Every declared claim type, read from the fold. Nothing is thrown for the set: a bad entry
 * costs its own type, and a type declared twice refuses every declaration of it. */
export function readClaimTypeDeclarations(index: IndexDb): ClaimTypeDeclarations {
  const read: ReadClaimType[] = index.contributionsOf("claim-type").map((row) => {
    try {
      return { row, declaration: claimTypeDeclarationFromEntry(row.entry) };
    } catch (error) {
      if (!(error instanceof ClaimTypeRefusedError)) {
        throw error;
      }
      return { row, reason: error.detail };
    }
  });
  const declaredBy = new Map<string, ReadClaimType[]>();
  for (const each of read) {
    if (each.declaration !== undefined) {
      declaredBy.set(each.declaration.type, [...(declaredBy.get(each.declaration.type) ?? []), each]);
    }
  }
  const declarations: ClaimTypeDeclaration[] = [];
  const refused: FoldRefusal[] = [];
  for (const each of read) {
    const { entry, moduleRecord } = each.row;
    if (each.declaration === undefined) {
      refused.push({
        name: entry.id,
        contributionId: entry.id,
        moduleRecord,
        version: entry.version,
        reason: each.reason,
        settled: true,
      });
      continue;
    }
    const others = declaredBy
      .get(each.declaration.type)!
      .filter((other) => other !== each)
      .map((other) => `${other.row.moduleName} at version ${other.row.entry.version}`);
    if (others.length === 0) {
      declarations.push(each.declaration);
      continue;
    }
    refused.push({
      name: entry.id,
      contributionId: entry.id,
      moduleRecord,
      version: entry.version,
      reason:
        `refusing to register ${entry.id} at version ${entry.version}: it declares the claim type ` +
        `${each.declaration.type}, which is also declared by ${others.join(", ")}, and two declarations could name ` +
        `different identity dimensions, so a claim of that type has no one slot to be computed into; every declaration ` +
        `of it is refused until the collision is resolved`,
      settled: true,
    });
  }
  return { declarations, refused };
}
