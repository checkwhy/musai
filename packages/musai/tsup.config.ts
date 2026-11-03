import { defineConfig } from "tsup";

/** Workspace output, bundled whole: the package installs only the esbuild a module builds with. */
const BUILT = "node_modules/@musai";

export default defineConfig({
  entry: {
    "bin/cli": `${BUILT}/distribution/dist/bin/cli.js`,
    "bin/mcp": `${BUILT}/distribution/dist/bin/mcp.js`,
    "module/host-child": `${BUILT}/modules/dist/module/host-child.js`,
    "rule/sandbox-worker": `${BUILT}/modules/dist/rule/sandbox-worker.js`,
  },
  format: ["esm"],
  platform: "node",
  target: "node24",
  dts: false,
  sourcemap: false,
  clean: true,
  // The assemble reads from it which third-party packages the bundle carries, for their notices.
  metafile: true,
  // A bundled CommonJS dependency calls `require`, which an ES module has only through this.
  banner: {
    js: "import { createRequire as __musaiRequire } from 'node:module'; const require = __musaiRequire(import.meta.url);",
  },
});
