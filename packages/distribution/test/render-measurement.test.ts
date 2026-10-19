import { type OperationContext, runHandler } from "@musai/api-core";
import type { ResourceDescriptor } from "@musai/records";
import { fixedClock, makeCheckout } from "@musai/test-support";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { checkRun } from "../src/ops/check.js";
import { renderMarkdown } from "../src/ops/render.js";
import { workspaceInit } from "../src/ops/workspace.js";

const treeMeasurements = vi.hoisted(() => ({ count: 0 }));

vi.mock("@musai/run", async (importOriginal) => {
  const original = await importOriginal<typeof import("@musai/run")>();
  return {
    ...original,
    resolveSubstrates: (declared: readonly ResourceDescriptor[], ...rest: [never, (readonly string[])?]) => {
      treeMeasurements.count += declared.filter(original.namesTree).length;
      return original.resolveSubstrates(declared, ...rest);
    },
  };
});

describe("render over many checks", () => {
  test("measures the working tree once, however many checks read it", async () => {
    const checkout = await makeCheckout("hello");
    onTestFinished(() => checkout.cleanup());
    const now = fixedClock("2026-10-01T00:00:00.000Z");
    const context: OperationContext = { workspace: checkout.dir, scope: "default", now, principalName: "operator" };
    await runHandler(workspaceInit, { workspace: checkout.dir }, context);
    for (const statement of ["node runs once", "node runs twice", "node runs thrice"]) {
      await runHandler(checkRun, { statement, command: ["node", "-e", ""] }, context);
    }

    treeMeasurements.count = 0;
    const { markdown } = await runHandler(renderMarkdown, {}, context);

    expect(markdown.split("\n").filter((line) => line.startsWith("- [x]"))).toHaveLength(3);
    expect(treeMeasurements.count).toBe(1);
  }, 120_000);
});
