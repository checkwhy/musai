import { splitByShell } from "@musai/test-support";
import { describe, expect, test } from "vitest";
import { moduleNew } from "../src/ops/module.js";

describe("module new's text", () => {
  test("the build it suggests pastes back as one command under a path holding a space and a $", async () => {
    const targetDir = "/work/a b$HOME";
    const text = moduleNew.renderText({ targetDir, created: true, testReport: null });

    const suggested = text.split("\n")[2]!.slice("install it in this workspace: ".length);
    expect(await splitByShell(suggested)).toEqual(["musai", "lab", "module", "build", targetDir]);
  });
});
