import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario } from "@musai/test-support";
import { expect, test } from "vitest";

interface Status {
  readonly label: string;
}

interface Minted {
  readonly minted: readonly { readonly id: string; readonly record: { readonly supersedes: readonly string[] } }[];
}

interface Hop {
  readonly id: string;
  readonly label: string;
  readonly children: readonly Hop[];
}

interface Refusal {
  readonly reason: string;
  readonly detail: string;
}

test("correcting: a ruling corrected by a later one decides the claim, and why reaches both", async () => {
  const run = await runScenario(dirname(fileURLToPath(import.meta.url)));
  const parsed = <T>(id: string): T => JSON.parse(run.outputs.get(id)!) as T;

  const mistaken = parsed<Minted>("answer-1").minted[0]!;
  const correction = parsed<Minted>("correct").minted[0]!;
  expect(correction.record.supersedes).toEqual([mistaken.id]);

  expect(parsed<Status>("status-1").label).toBe("holds");
  expect(parsed<Status>("status-2").label).toBe("fails");

  const ruling = parsed<{ derivation: Hop }>("why-2").derivation.children.find((hop) => hop.label === "ruling");
  expect(ruling?.id).toBe(correction.id);
  expect(ruling?.children.filter((hop) => hop.label === "superseded").map((hop) => hop.id)).toEqual([mistaken.id]);

  const again = parsed<Refusal>("again");
  expect(again.reason).toBe("invalid-input");
  expect(again.detail).toContain(correction.id);
});
