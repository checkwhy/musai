import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario } from "@musai/test-support";
import { expect, test } from "vitest";

interface Status {
  readonly label: string;
}

test("arguing: a challenge attacking a check's receipt takes the claim from holds to open, and why shows the attack", async () => {
  const run = await runScenario(dirname(fileURLToPath(import.meta.url)));

  const before = JSON.parse(run.outputs.get("status-1")!) as Status;
  const after = JSON.parse(run.outputs.get("status-2")!) as Status;
  expect(before.label).toBe("holds");
  expect(after.label).toBe("open");
});
