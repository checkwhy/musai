import type { IndexDb, IndexedContribution, IndexedReceipt } from "@musai/fold";
import {
  type ClaimRecord,
  type Conditions,
  isPlainObject,
  type RecordId,
  type RunRecipe,
  recipeOfReadKey,
  recordId,
  slotReadKey,
} from "@musai/records";
import { OperationError } from "./errors.js";

/** The core interpreter reads its parameters from the condition named for its contribution id. */
export const DECLARATIVE_RULE = "musai.core/declarative";

/** The literal an evaluation's recipe names as its command: `["evaluate", <rule>, <slot>]`, and the
 * clearance it ran under last where it ran under one. */
export const EVALUATE_COMMAND = "evaluate";

export interface DeclarativeParameters {
  readonly recipes: readonly { readonly name?: unknown; readonly recipe: RunRecipe }[];
  readonly expectations: readonly { readonly kind: string; readonly recipe?: unknown; readonly value?: unknown }[];
}

/** The interpreter's condition parsed, or `null` where it holds no text. */
function parsedCondition(conditions: Conditions): unknown {
  const parameters = conditions[DECLARATIVE_RULE];
  return typeof parameters === "string" ? JSON.parse(parameters) : null;
}

/** The interpreter's parameters where both lists are present, each entry naming a recipe with an
 * RFC 8785 form and each expectation a kind, else `null`. */
export function readDeclarativeParameters(conditions: Conditions): DeclarativeParameters | null {
  let parsed: unknown;
  try {
    parsed = parsedCondition(conditions);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) {
    return null;
  }
  const { recipes, expectations } = parsed;
  const readable =
    Array.isArray(recipes) &&
    recipes.every(
      (entry) => isPlainObject(entry) && isPlainObject(entry.recipe) && recipeIdOf(entry.recipe) !== null,
    ) &&
    Array.isArray(expectations) &&
    expectations.every((entry) => isPlainObject(entry) && typeof entry.kind === "string" && entry.kind.length > 0);
  return readable ? ({ recipes, expectations } as DeclarativeParameters) : null;
}

/** The interpreter's parameters as it reads them, or `null` where no condition names it. */
export function declarativeParametersOf(claim: RecordId, conditions: Conditions): DeclarativeParameters | null {
  if (!Object.hasOwn(conditions, DECLARATIVE_RULE)) {
    return null;
  }
  const parameters = readDeclarativeParameters(conditions);
  if (parameters === null) {
    throw new OperationError({
      reason: "invalid-input",
      about: [claim],
      detail: `refusing ${claim}: its ${DECLARATIVE_RULE} condition does not read as the interpreter's parameters`,
    });
  }
  return parameters;
}

/** Every recipe the interpreter runs for a claim, in the order its conditions declare them. */
export function checkRecipesOf(parameters: DeclarativeParameters | null): RunRecipe[] {
  return (parameters?.recipes ?? []).map(({ recipe }) => recipe);
}

/** The exit code the interpreter asks of a claim's one recipe, as a check does, or `null` where it
 * asks for anything more. */
export function expectedExitCodeOf(parameters: DeclarativeParameters | null): number | null {
  const [recipe, ...otherRecipes] = parameters?.recipes ?? [];
  const [expectation, ...otherExpectations] = parameters?.expectations ?? [];
  return recipe !== undefined &&
    otherRecipes.length === 0 &&
    otherExpectations.length === 0 &&
    expectation?.kind === "exitCodeIs" &&
    expectation.recipe === recipe.name &&
    typeof expectation.value === "number"
    ? expectation.value
    : null;
}

/** The condition keys naming a contribution, installed here or not: a contribution's id is
 * namespaced by its module, where a dimension is a bare key. */
export function contributionKeysOf(conditions: Conditions): string[] {
  return Object.keys(conditions).filter((key) => key.includes("/"));
}

/** The installed rules a claim's conditions name as keys; naming one makes the claim a check. */
export function rulesNamedBy(index: IndexDb, conditions: Conditions): IndexedContribution[] {
  return contributionKeysOf(conditions)
    .map((key) => index.contributionById(key))
    .filter((found): found is IndexedContribution => found !== undefined && found.entry.kind === "rule");
}

/** The installed expectations the interpreter invokes for a claim, by the kinds it names. */
export function expectationsNamedBy(index: IndexDb, parameters: DeclarativeParameters | null): IndexedContribution[] {
  return [...new Set((parameters?.expectations ?? []).map(({ kind }) => kind))]
    .map((kind) => index.contributionById(kind))
    .filter((found): found is IndexedContribution => found !== undefined && found.entry.kind === "expectation");
}

/** Each recipe an evaluation of the claim at `slot` by a rule its conditions name has read, with
 * every such evaluation that read it. */
function evaluationsReading(
  index: IndexDb,
  { slot, conditions }: Pick<ClaimRecord, "slot" | "conditions">,
  landed: (id: RecordId) => boolean,
): Map<RecordId, RecordId[]> {
  const recipes = new Map<RecordId, RecordId[]>();
  for (const { reader } of index.readersOf(slotReadKey(slot)).filter((read) => landed(read.reader))) {
    const run = index.recordById(reader)?.record;
    if (run?.kind !== "run" || run.runKind !== "evaluation") {
      continue;
    }
    const [command, rule, evaluated] = run.recipe.command;
    if (command !== EVALUATE_COMMAND || evaluated !== slot || rule === undefined || !Object.hasOwn(conditions, rule)) {
      continue;
    }
    for (const read of run.observation.reads) {
      const recipe = recipeOfReadKey(read.key);
      if (recipe !== undefined) {
        recipes.set(recipe, [...(recipes.get(recipe) ?? []), reader]);
      }
    }
  }
  return recipes;
}

/** A recipe's id, or `null` where it has no RFC 8785 form, as `1e999` or a lone surrogate. */
function recipeIdOf(recipe: unknown): RecordId | null {
  try {
    return recordId(recipe);
  } catch {
    return null;
  }
}

/** Each recipe an entry of the interpreter's condition names, and whether every entry named one;
 * a condition that does not parse names none. */
function declaredRecipes(conditions: Conditions): { readonly ids: RecordId[]; readonly whole: boolean } {
  // Read apart from `readDeclarativeParameters` so a cleared fold's withheld set does not move.
  let recipes: unknown;
  try {
    recipes = (parsedCondition(conditions) as { readonly recipes?: unknown } | null)?.recipes ?? [];
  } catch {
    return { ids: [], whole: false };
  }
  const entries: unknown[] = Array.isArray(recipes) ? recipes : [];
  const ids = entries.flatMap((entry) => {
    const id = typeof entry === "object" && entry !== null && "recipe" in entry ? recipeIdOf(entry.recipe) : null;
    return id === null ? [] : [id];
  });
  return { ids, whole: Array.isArray(recipes) && ids.length === entries.length };
}

/** The recipe of each run a claim cites as evidence, landed by the position judged at. */
function citedRecipes(
  index: IndexDb,
  { evidence }: Pick<ClaimRecord, "evidence">,
  landed: (id: RecordId) => boolean,
): RecordId[] {
  return evidence.flatMap(({ run }) => {
    const record = landed(run) ? index.recordById(run)?.record : undefined;
    return record?.kind === "run" ? [recordId(record.recipe)] : [];
  });
}

/** Whether the interpreter's condition names, in a form it reads, every recipe its rule runs. */
function namesEveryRecipe(declared: { readonly ids: readonly RecordId[]; readonly whole: boolean }): boolean {
  return declared.whole && declared.ids.length > 0;
}

/** The runs a check claim rests on and never cites: every receipt of each recipe its rule runs,
 * the interpreter's from its conditions and a module rule's from what its `evaluated` runs read. */
export function checkReceiptsOf(
  index: IndexDb,
  claim: Pick<ClaimRecord, "slot" | "conditions" | "evidence">,
  landed: (id: RecordId) => boolean = () => true,
  evaluated: (id: RecordId) => boolean = landed,
): IndexedReceipt[] {
  const declared = declaredRecipes(claim.conditions);
  // A condition that does not read is held to its cited runs' recipes as well, failing closed.
  const cited = declared.whole ? [] : citedRecipes(index, claim, landed);
  const recipes = namesEveryRecipe(declared)
    ? declared.ids
    : [...new Set([...declared.ids, ...cited, ...evaluationsReading(index, claim, evaluated).keys()])];
  return recipes.flatMap((id) => index.receiptsByRecipe(id)).filter((receipt) => landed(receipt.recordId));
}

/** Whether a claim names a rule beside the interpreter, whose loop can fail after paid runs. */
export function namesModuleRule(claim: Pick<ClaimRecord, "conditions">): boolean {
  return contributionKeysOf(claim.conditions).some((key) => key !== DECLARATIVE_RULE);
}

/** Each recipe a check claim rests on only because an evaluation read it, with the evaluations that
 * read it; none where its condition names every recipe. */
export function evaluatedRecipesOf(
  index: IndexDb,
  claim: Pick<ClaimRecord, "slot" | "conditions">,
  landed: (id: RecordId) => boolean,
): ReadonlyMap<RecordId, readonly RecordId[]> {
  return namesEveryRecipe(declaredRecipes(claim.conditions)) ? new Map() : evaluationsReading(index, claim, landed);
}
