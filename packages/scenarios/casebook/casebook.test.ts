import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario } from "@musai/test-support";
import { expect, test } from "vitest";

interface Progress {
  readonly done: boolean;
  readonly next: { readonly class: string; readonly gate: string } | null;
}

test("casebook: a report booked from a kind is checked by a run, judged at two gates, and walked to its receipt", async () => {
  const run = await runScenario(dirname(fileURLToPath(import.meta.url)));

  const firstGate = JSON.parse(run.outputs.get("progress-1")!) as Progress;
  const secondGate = JSON.parse(run.outputs.get("progress-2")!) as Progress;
  const settled = JSON.parse(run.outputs.get("progress-3")!) as Progress;

  expect(firstGate.next?.class).toBe("judgment");
  expect(secondGate.next?.class).toBe("intent");
  expect(settled.done).toBe(true);
  expect(settled.next).toBeNull();
});
