import { workspaceSourceAliases } from "@musai/test-support/workspace-sources";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: workspaceSourceAliases() },
  test: {
    // Tests and their hooks start processes, drive git and open SQLite files on disk.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["test/**/*.test.ts"],
  },
});
