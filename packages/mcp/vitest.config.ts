import { workspaceSourceAliases } from "@musai/test-support/workspace-sources";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: workspaceSourceAliases() },
  test: {
    // Tests and hooks initialise workspaces through git and install modules, starting processes.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["test/**/*.test.ts"],
  },
});
