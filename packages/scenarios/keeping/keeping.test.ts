import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario } from "@musai/test-support";
import { expect, test } from "vitest";

interface Status {
  readonly label: string;
  readonly reason: string | null;
  readonly detail?: string;
}

interface Booked {
  readonly case: string;
  readonly minted: readonly { readonly id: string }[];
}

interface Kept {
  readonly successor: string;
  readonly supersedes: readonly string[];
}

interface Refusal {
  readonly reason: string;
  readonly detail: string;
}

test("keeping: the forks two scopes' bookings open at a slug and a pack's slot are closed by the author's keeps", async () => {
  const run = await runScenario(dirname(fileURLToPath(import.meta.url)));
  const parsed = <T>(id: string): T => JSON.parse(run.outputs.get(id)!) as T;

  const cases = [parsed<Booked>("book-here").case, parsed<Booked>("book-elsewhere").case];
  const refused = parsed<Refusal>("progress-forked");
  expect(refused.reason).toBe("invalid-input");
  for (const id of cases) {
    expect(refused.detail).toContain(id);
  }
  expect(refused.detail).toContain("`lab keep <case>`");
  expect([...parsed<Kept>("keep-case").supersedes].sort()).toEqual([...cases].sort());

  const here = parsed<Booked>("book-here").minted[1]!.id;
  const elsewhere = parsed<Booked>("book-elsewhere").minted[1]!.id;
  const forked = parsed<Status>("status-forked");
  expect([forked.label, forked.reason]).toEqual(["open", "forked-slot"]);
  expect(forked.detail).toContain("`lab keep <claim>`");

  const kept = parsed<Kept>("keep");
  expect([...kept.supersedes].sort()).toEqual([here, elsewhere].sort());
  expect(parsed<Status>("status-kept").label).toBe("holds");
});
