import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario } from "@musai/test-support";
import { test } from "vitest";

test("core-module-devkit: the core module builds against this repository's own tree and its recorded fixtures replay clean through the dev-kit verbs", async () => {
  await runScenario(dirname(fileURLToPath(import.meta.url)));
});
