import type { DeclaredName, RunRecipe } from "./kinds/run.js";

/** The portable half of a fetch: declared headers and names, and no local path. */
export interface FetchRecipe {
  readonly locator: string;
  readonly headers: readonly DeclaredName[];
  readonly names: readonly DeclaredName[];
}

/** A citation's recipe for a fetch, so the id a fetch need is satisfied on is the id the stored
 * citation digests to. */
export function citationRecipeFor(recipe: FetchRecipe): RunRecipe {
  return {
    command: ["GET", recipe.locator],
    workingDirectory: "",
    environment: {},
    declared: [...recipe.headers, ...recipe.names],
    substrates: [{ uri: recipe.locator }],
    isolation: "none",
  };
}
