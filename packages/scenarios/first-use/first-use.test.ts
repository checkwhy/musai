import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario } from "@musai/test-support";
import { expect, test } from "vitest";

interface Checked {
  readonly label: string;
  readonly slot: string;
  readonly claim: string;
}

interface Rendered {
  readonly markdown: string;
}

test("first use: a sentence checked, gone stale on an edit, failing, restored, and walked to its receipt", async () => {
  const run = await runScenario(dirname(fileURLToPath(import.meta.url)));
  const parsed = <T>(id: string): T => JSON.parse(run.raw.get(id)!) as T;

  const checked = parsed<Checked>("check");
  expect(checked.label).toBe("holds");
  expect(parsed<Rendered>("render").markdown).toMatch(
    /^- \[x\] ✓ the greeting says hello · `node check.js` — `musai why [0-9a-f]{12}`$/,
  );
  expect(parsed<Rendered>("render-moved").markdown).toContain("◌ the greeting says hello (stale)");
  expect(parsed<{ readonly label: string }>("status-moved").label).toBe("fails");

  const restored = parsed<Checked>("check-restored");
  expect(restored.label).toBe("holds");
  expect(restored.claim).toBe(checked.claim);
});
