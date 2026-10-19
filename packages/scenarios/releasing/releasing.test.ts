import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario } from "@musai/test-support";
import { expect, test } from "vitest";

interface Rerun {
  readonly release: { readonly audience: string; readonly covered: boolean };
  readonly performed: boolean;
  readonly claims: readonly { readonly verdict: string }[];
}

test("releasing: a checked claim exported to the public, signed by a committed key, and rerun as a stranger would", async () => {
  const run = await runScenario(dirname(fileURLToPath(import.meta.url)));
  const parsed = <T>(id: string): T => JSON.parse(run.raw.get(id)!) as T;

  expect(parsed<Rerun>("rerun-shown")).toMatchObject({
    release: { audience: "public", covered: true },
    performed: false,
  });
  const rerun = parsed<Rerun>("rerun");
  expect(rerun.performed).toBe(true);
  expect(rerun.claims.map((claim) => claim.verdict)).toEqual(["matches"]);
});
