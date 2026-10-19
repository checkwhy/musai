export const ROLES = new Map([
  ["records", "kernel-side"],
  ["store", "kernel-side"],
  ["fold", "kernel-side"],
  ["trust", "kernel-side"],
  ["run", "kernel-side"],
  ["modules", "kernel-side"],
  ["evaluate", "kernel-side"],
  ["devkit", "kernel-side"],
  ["api-core", "kernel-side"],
  ["distribution", "distribution"],
  ["cli", "surface"],
  ["mcp", "surface"],
  ["musai", "package"],
  ["core-module", "content"],
  ["test-support", "test"],
  ["lint-fixtures", "test"],
  ["scenarios", "scenarios"],
]);

/** Directory layers inside a package, bottom up: a file imports its own layer or one below. */
export const LAYERS = new Map([
  ["records", [["reason"], ["canonical"], ["conditions"], ["record"]]],
  ["modules", [["rule"], ["module"]]],
  ["evaluate", [["evaluator"], ["why"]]],
]);

/** Edges a package may take only through `import type` or `export type`, by directory. */
export const TYPE_ONLY = new Map([
  // The fold walks a store it is handed and never opens one.
  ["fold", ["store"]],
  // The runner reads a receipt through a fold it is handed and never builds one.
  ["run", ["fold"]],
  // The evaluator reads an index through a fold it is handed and never builds one.
  ["evaluate", ["fold"]],
  // Trust reads the workspace configuration's type from a store it is handed and opens none.
  ["trust", ["store"]],
  // The server names the plan a contributed operation answers with and loads no module host.
  ["mcp", ["modules"]],
]);

/** Edges a package never declares in any dependency field, by directory. */
export const EXCLUDED = new Map([
  // A consumer running operations installs no bundler, and the devkit's module build needs esbuild.
  ["api-core", ["devkit"]],
]);
