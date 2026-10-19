import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", "sqlite-provider": "src/sqlite-provider.ts" },
  format: ["esm"],
  dts: false,
  clean: true,
  target: "node24",
  external: ["node:sqlite", "bun:sqlite"],
});
