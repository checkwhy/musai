import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateRecord } from "@musai/records";
import { splitByShell } from "@musai/test-support";
import { describe, expect, it } from "vitest";
import { CONFORMANCE_DIR, RECIPE_CASES, receiptOf, recipesTable } from "../scripts/conformance.js";
import { commandLine } from "../src/shell.js";

describe("the engine lines a verifier in another language prints as the kernel's runner builds them", () => {
  it("hold byte for byte what the generator derives from the runner", () => {
    expect(readFileSync(join(CONFORMANCE_DIR, "recipes.json"), "utf8")).toBe(recipesTable());
  });

  it.each(RECIPE_CASES)("$name is a run record the kernel would store", ({ recipe, held }) => {
    expect(validateRecord(receiptOf(recipe, held))).toMatchObject({ ok: true });
  });

  it.each(RECIPE_CASES)("$name prints a command line that pastes back as its command", async ({ recipe }) => {
    expect(await splitByShell(commandLine(recipe.command))).toEqual(recipe.command);
  });
});
