import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "bin/cli": "src/bin/cli.ts",
    "bin/mcp": "src/bin/mcp.ts",
  },
  format: ["esm"],
  dts: false,
  clean: true,
  target: "node24",
});
