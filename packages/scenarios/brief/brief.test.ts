import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario } from "@musai/test-support";
import { expect, test } from "vitest";

test("brief: a brief's rendered text agrees with itself after another case has landed, though the minted run it comes wrapped in does not, since that run's own id is a hash of the head it was rendered against", async () => {
  const run = await runScenario(dirname(fileURLToPath(import.meta.url)));
  const first = JSON.parse(run.outputs.get("brief-1")!) as { output: string };
  const second = JSON.parse(run.outputs.get("brief-2")!) as { output: string };
  expect(second.output).toBe(first.output);
});
