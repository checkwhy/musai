import { workspaceSourceAliases } from "@musai/test-support/workspace-sources";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: workspaceSourceAliases() },
  test: {
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/modules/**"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
