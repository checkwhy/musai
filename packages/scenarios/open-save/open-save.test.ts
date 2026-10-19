import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario } from "@musai/test-support";
import { expect, test } from "vitest";

interface SaveOutput {
  readonly minted: ReadonlyArray<{ readonly id: string }>;
}

test("open-save: an edit to the draft a preset's template rendered saves back as an artifact naming what it was edited from, and saving the unchanged worktree again mints nothing", async () => {
  const run = await runScenario(dirname(fileURLToPath(import.meta.url)));

  const save = JSON.parse(run.outputs.get("save")!) as SaveOutput;
  const saveAgain = JSON.parse(run.outputs.get("save-again")!) as SaveOutput;

  expect(save.minted).toHaveLength(1);
  expect(saveAgain.minted).toEqual([]);
});
