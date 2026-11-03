import { workspaceSourceAliases } from "@musai/test-support/workspace-sources";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: workspaceSourceAliases() },
  test: {
    include: ["**/*.test.ts"],
    setupFiles: ["@musai/test-support/index-guard"],
    exclude: ["**/node_modules/**", "**/modules/**"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
