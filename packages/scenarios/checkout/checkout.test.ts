import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { derivationNodes, runScenario } from "@musai/test-support";
import { expect, test } from "vitest";

interface Status {
  readonly label: string;
  readonly reason: string | null;
  readonly detail?: string;
}

interface Committed {
  readonly commit: string;
  readonly tree: string;
}

interface Log {
  readonly events: readonly { readonly kind: string; readonly about: string }[];
}

interface Booked {
  readonly minted: readonly { readonly id: string }[];
}

interface Hop {
  readonly label: string;
  readonly id?: string;
  readonly children: readonly unknown[];
}

function evidence(text: string): readonly string[] {
  const hops = derivationNodes((JSON.parse(text) as { derivation: Hop }).derivation) as Hop[];
  return hops.filter((hop) => hop.label === "evidence").map((hop) => JSON.stringify(hop));
}

test("checkout: a check names its commit and its tooling, is reused for its commit after the checkout moves on, and spawns nothing on a dirty checkout", async () => {
  const run = await runScenario(dirname(fileURLToPath(import.meta.url)));
  const status = (id: string): Status => JSON.parse(run.outputs.get(id)!) as Status;

  expect(status("status-1").label).toBe("holds");
  expect(status("status-2").label).toBe("holds");
  expect(status("status-1-moved").label).toBe("holds");

  const first = evidence(run.outputs.get("why-1")!);
  const second = evidence(run.outputs.get("why-2")!);
  expect(first.length).toBeGreaterThan(0);
  expect(second.some((hop) => first.includes(hop))).toBe(false);

  const dirty = JSON.parse(run.raw.get("status-3-dirty")!) as Status;
  const third = JSON.parse(run.raw.get("checkout-3")!) as Committed;
  expect(dirty.label).toBe("open");
  expect(dirty.reason).toBe("no-evidence");
  expect(dirty.detail).toContain(`substrate checkout is not at commit ${third.commit}`);
  expect(dirty.detail).toContain(`the commit's tree is ${third.tree}`);
  expect(dirty.detail).toMatch(/its tree is [0-9a-f]{40}/);
  expect(dirty.detail).not.toContain(`its tree is ${third.tree}`);
  for (const id of ["status-1", "status-2", "status-1-moved"]) {
    expect(status(id).detail, id).toBeUndefined();
  }

  const events = (JSON.parse(run.outputs.get("log")!) as Log).events;
  const runsAfter = (book: string): number => {
    const claim = (JSON.parse(run.outputs.get(book)!) as Booked).minted[1]!.id;
    const put = events.findIndex((event) => event.kind === "claim.put" && event.about === claim);
    const next = events.findIndex((event, index) => index > put && event.kind === "claim.put");
    return events
      .slice(put, next === -1 ? undefined : next)
      .filter((event) => event.kind === "run.recorded" && run.receipts.has(event.about)).length;
  };
  expect(runsAfter("book-1")).toBe(1);
  expect(runsAfter("book-2")).toBe(1);
  expect(runsAfter("book-3")).toBe(0);

  for (const [id, text] of run.outputs) {
    expect(text, id).not.toContain("<workspace>/checkout");
  }
  const realWorkspace = join(await realpath(dirname(run.workspace)), basename(run.workspace));
  for (const [id, text] of run.raw) {
    expect(text, id).not.toContain(join(realWorkspace, "checkout"));
    expect(text, id).not.toContain(join(run.workspace, "checkout"));
  }
});
