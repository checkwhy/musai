import { workspaceSourceAliases } from "@musai/test-support/workspace-sources";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: workspaceSourceAliases() },
  test: {
    // Each test spawns a lint script, and the cycle check loads madge and the compiler.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ["*.test.ts"],
  },
});
