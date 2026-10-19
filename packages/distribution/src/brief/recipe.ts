import {
  type Audience,
  type ComputedRecipe,
  hexOfRecordId,
  type RecordId,
  type ResourceDescriptor,
  type VersionString,
} from "@musai/records";

/** The literal a brief's recipe names as its command: `["brief", <gate claim id>]`, then the
 * clearance it was rendered under where one is set. */
export const BRIEF_COMMAND = "brief";

/** The slot a brief's budget is read from, declared by the core module. */
export const BRIEF_BUDGET_SLOT_ID = "musai.core/brief-budget";

const HEAD_SUBSTRATE_NAME = "scope-head";
const CASE_SUBSTRATE_NAME = "case";
const KERNEL_VERSION_SUBSTRATE_NAME = "kernel-version";

/** The inputs a brief's render is deterministic under. */
export interface BriefRecipeParams {
  readonly head: string;
  readonly caseId: RecordId;
  readonly budget: number;
  readonly kernelVersion: VersionString;
  /** A station's brief packs only what its clearance reads, so its recipe is its own. */
  readonly clearance?: Audience | undefined;
}

/** The budget as a slot read, annotated with its resolved value so a re-run need not re-layer. */
function budgetSubstrate(budget: number): ResourceDescriptor {
  return {
    name: BRIEF_BUDGET_SLOT_ID,
    uri: `musai:slot/${BRIEF_BUDGET_SLOT_ID}`,
    annotations: { value: String(budget) },
  };
}

function kernelVersionSubstrate(kernelVersion: VersionString): ResourceDescriptor {
  return {
    name: KERNEL_VERSION_SUBSTRATE_NAME,
    uri: `musai:${KERNEL_VERSION_SUBSTRATE_NAME}`,
    annotations: { version: kernelVersion },
  };
}

/** A brief's recipe: its substrates are the only inputs the render reads. */
export function briefRecipe(gateClaimId: RecordId, params: BriefRecipeParams): ComputedRecipe {
  const substrates: ResourceDescriptor[] = [
    { name: HEAD_SUBSTRATE_NAME, digest: { gitCommit: params.head } },
    { name: CASE_SUBSTRATE_NAME, digest: { sha256: hexOfRecordId(params.caseId) } },
    budgetSubstrate(params.budget),
    kernelVersionSubstrate(params.kernelVersion),
  ];
  const cleared = params.clearance === undefined ? [] : [params.clearance];
  return { command: [BRIEF_COMMAND, gateClaimId, ...cleared], substrates };
}

/** A substrate by name; a recipe `briefRecipe` did not build is not one `renderBrief` trusts. */
export function substrateNamed(recipe: ComputedRecipe, name: string): ResourceDescriptor {
  const found = recipe.substrates.find((substrate) => substrate.name === name);
  if (found === undefined) {
    throw new RangeError(`a brief's recipe carries no substrate named ${name}`);
  }
  return found;
}

export interface ParsedBriefSubstrates {
  readonly head: string;
  readonly caseId: RecordId;
  readonly budget: number;
  readonly kernelVersion: VersionString;
}

export function parseBriefSubstrates(recipe: ComputedRecipe): ParsedBriefSubstrates {
  const head = substrateNamed(recipe, HEAD_SUBSTRATE_NAME).digest?.gitCommit;
  if (head === undefined) {
    throw new RangeError("a brief's scope-head substrate carries no gitCommit digest");
  }
  const caseDigest = substrateNamed(recipe, CASE_SUBSTRATE_NAME).digest?.sha256;
  if (caseDigest === undefined) {
    throw new RangeError("a brief's case substrate carries no sha256 digest");
  }
  const budgetValue = substrateNamed(recipe, BRIEF_BUDGET_SLOT_ID).annotations?.["value"];
  if (budgetValue === undefined || !/^\d+$/.test(budgetValue)) {
    throw new RangeError("a brief's budget substrate carries no non-negative integer value annotation");
  }
  const kernelVersion = substrateNamed(recipe, KERNEL_VERSION_SUBSTRATE_NAME).annotations?.["version"];
  if (kernelVersion === undefined) {
    throw new RangeError("a brief's kernel-version substrate carries no version annotation");
  }
  return {
    head,
    caseId: `sha256:${caseDigest}`,
    budget: Number(budgetValue),
    kernelVersion: kernelVersion as VersionString,
  };
}
