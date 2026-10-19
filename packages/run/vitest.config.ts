import { workspaceSourceAliases } from "@musai/test-support/workspace-sources";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: workspaceSourceAliases() },
  test: {
    // Tests and hooks spawn processes and drive git, so they get more than vitest's unit default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["test/**/*.test.ts"],
  },
});
