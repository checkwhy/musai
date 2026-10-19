import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OperationContext, runHandler } from "@musai/api-core";
import type { DerivationJson } from "@musai/evaluate";
import { timestamp } from "@musai/records";
import { fixedClock, generateTestKey, type TestKey } from "@musai/test-support";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { briefRender } from "../src/ops/brief.js";
import { caseBook } from "../src/ops/case.js";
import { rulingMake } from "../src/ops/ruling.js";
import { claimWhy } from "../src/ops/why.js";
import { workspaceInit } from "../src/ops/workspace.js";

const now = fixedClock(timestamp("2026-09-29T00:00:00.000Z"));

function hops(node: DerivationJson): DerivationJson[] {
  return [node, ...node.children.flatMap(hops)];
}

describe("why names a signer by the alias allowed-signers lists beside its key", () => {
  let key: TestKey;
  let workspace: string;

  beforeAll(async () => {
    key = await generateTestKey("operator");
    workspace = await mkdtemp(join(tmpdir(), "musai-why-signer-"));
  }, 60_000);

  afterAll(async () => {
    await rm(key.dir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  test("a ruling made with the registered key reads as its alias beside the key, which the record alone names", async () => {
    const context: OperationContext = { workspace, scope: "default", now, via: "tty", principalName: "operator" };
    await runHandler(workspaceInit, { workspace, key: key.keyPath }, context);
    const booked = await runHandler(caseBook, { slug: "signed", about: ["https://example.test/signed"] }, context);
    const claim = booked.minted.find((item) => item.kind === "claim")!.id;
    const { brief } = await runHandler(briefRender, { claim }, context);
    const ruled = await runHandler(rulingMake, { claim, verdict: "holds", reason: "the key decides", brief }, context);

    const attestation = ruled.minted.find((item) => item.kind === "attestation")!.record as { principal: string };
    expect(attestation.principal).toBe(key.principal);
    const why = await runHandler(claimWhy, { claim, full: true }, context);
    const ruling = hops(why.derivation!).find((hop) => hop.label === "ruling")!;
    expect(ruling.decidedBy).toBe(`person ruling by operator (${key.principal})`);
  }, 120_000);

  test("an open claim lists each live ruling by its signer's alias beside the key, keeping the key itself", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "musai-why-signer-"));
    try {
      const context: OperationContext = {
        workspace: elsewhere,
        scope: "default",
        now,
        via: "tty",
        principalName: "operator",
      };
      await runHandler(workspaceInit, { workspace: elsewhere, key: key.keyPath }, context);
      const booked = await runHandler(
        caseBook,
        { slug: "contested", about: ["https://example.test/contested"] },
        context,
      );
      const claim = booked.minted.find((item) => item.kind === "claim")!.id;
      for (const verdict of ["holds", "fails"] as const) {
        const { brief } = await runHandler(briefRender, { claim }, context);
        await runHandler(rulingMake, { claim, verdict, reason: `the key says ${verdict}`, brief }, context);
      }

      const why = await runHandler(claimWhy, { claim, full: true }, context);

      expect(why).toMatchObject({ label: "open", reason: "contested-authority" });
      expect(why.rulings?.map(({ principals, names }) => ({ principals, names }))).toEqual([
        { principals: [key.principal], names: [`operator (${key.principal})`] },
        { principals: [key.principal], names: [`operator (${key.principal})`] },
      ]);
      expect(claimWhy.renderText!(why)).toContain(`ruling by operator (${key.principal})`);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  }, 120_000);
});
