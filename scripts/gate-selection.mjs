const insidePackages = (path) => path.startsWith("packages/");
// The corpus reports and the README are read by package tests.
const readByATest = (path) => path === "README.md" || path.startsWith("corpus/");
const prose = (path) => path.endsWith(".md") && !insidePackages(path) && !readByATest(path);

// The root depends on a package, so a change there would select the root's own gate scripts.
const everythingButTheRoot = ["--filter", "!musai-workspace"];

export function selectionFor(changed, base) {
  const built = changed.filter((path) => !prose(path));
  if (changed.length > 0 && built.length === 0) {
    return null;
  }
  // A root file such as a pin or a tsconfig reaches every package, and no package lists it.
  if (built.some((path) => !insidePackages(path))) {
    return everythingButTheRoot;
  }
  return ["--filter", `...[${base}]`, ...everythingButTheRoot, "--fail-if-no-match"];
}
