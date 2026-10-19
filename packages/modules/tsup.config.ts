import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "rule/sandbox-worker": "src/rule/sandbox-worker.ts",
    "module/host-child": "src/module/host-child.ts",
  },
  format: ["esm"],
  dts: false,
  clean: true,
  target: "node24",
});
