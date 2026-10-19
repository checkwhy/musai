import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario } from "@musai/test-support";
import { test } from "vitest";

test("template-module: a scaffolded module builds and passes its own fixtures through the dev-kit verbs", async () => {
  await runScenario(dirname(fileURLToPath(import.meta.url)));
});
