const insidePackages = (/** @type {string} */ path) => path.startsWith("packages/");
// The records suite scans every package's source for bare throws and crypto imports.
const scannedByRecords = (/** @type {string} */ path) => /^packages\/[^/]+\/src\//.test(path);
const prose = (/** @type {string} */ path) => path.endsWith(".md");

// The root depends on a package, so a change there would select the root's own gate scripts.
const everythingButTheRoot = ["--filter", "!musai-workspace"];

const GO = ["node", "scripts/check-go.mjs"];
const VERIFIER_PAGE = ["node", "--test", "verify/web/test/page.test.mjs"];
const ROOT_TESTS = ["node", "--test", "action/check-run.test.mjs", "scripts/*.test.mjs"];
const PLUGIN_SHELL = ["node", "scripts/validate-plugin-shell.mjs"];
const INDEX_PROVIDER = ["node", "scripts/check-index-provider.mjs"];
const SMOKE_PACK = ["node", "scripts/smoke-pack.mjs"];
const UNPRIVILEGED = ["node", "scripts/test-unprivileged.mjs"];
const LINT = ["pnpm", "lint:checks"];

// The lint fixtures' typecheck covers every root and action script.
const SCRIPT_TYPES = ["@musai/lint-fixtures"];
const SCRIPTS_REACH = ["@musai/lint-fixtures", "@musai/records", "@musai/distribution"];
const LINT_HELPERS = ["scripts/package-roles.mjs", "scripts/source-text.mjs", "scripts/orphan-allowlist.md"];
// Its fixtures show a check bites; only the lint itself runs it over the repository's own code.
/** @param {string} path */
const readByTheLint = (path) => /^scripts\/check-[^/]+\.mjs$/.test(path) || LINT_HELPERS.includes(path);

/** @typedef {{ matches: (path: string) => boolean, packages: string[], checks: string[][] }} Row */

/** What a path outside `packages/` reaches, first match winning: the packages whose build or tests
 * read it and the root checks it feeds. A path no row matches reaches every package. */
const OUTSIDE = /** @type {Row[]} */ ([
  {
    matches: (path) => path.startsWith("conformance/"),
    packages: ["@musai/records", "@musai/run", "@musai/trust", "@musai/api-core", "@musai/distribution"],
    checks: [GO, VERIFIER_PAGE],
  },
  {
    matches: (path) => path.startsWith("verify/"),
    packages: ["@musai/records"],
    checks: [GO, VERIFIER_PAGE, SMOKE_PACK],
  },
  { matches: (path) => path.startsWith("corpus/"), packages: ["@musai/distribution"], checks: [] },
  { matches: (path) => path.startsWith("plugin/"), packages: ["@musai/distribution"], checks: [PLUGIN_SHELL] },
  { matches: (path) => path === "README.md" || path === "LICENSE", packages: ["checkwhy"], checks: [] },
  { matches: (path) => path === "scripts/check-go.mjs", packages: SCRIPT_TYPES, checks: [GO] },
  { matches: (path) => path === "scripts/validate-plugin-shell.mjs", packages: SCRIPT_TYPES, checks: [PLUGIN_SHELL] },
  { matches: (path) => path === "scripts/check-index-provider.mjs", packages: SCRIPT_TYPES, checks: [INDEX_PROVIDER] },
  { matches: (path) => path === "scripts/smoke-pack.mjs", packages: SCRIPT_TYPES, checks: [SMOKE_PACK] },
  { matches: (path) => path === "scripts/test-unprivileged.mjs", packages: SCRIPT_TYPES, checks: [UNPRIVILEGED] },
  { matches: readByTheLint, packages: SCRIPTS_REACH, checks: [ROOT_TESTS, LINT] },
  { matches: (path) => path.startsWith("scripts/"), packages: SCRIPTS_REACH, checks: [ROOT_TESTS] },
  { matches: (path) => path === "biome.jsonc", packages: [], checks: [LINT] },
  { matches: (path) => path.startsWith("action/"), packages: SCRIPT_TYPES, checks: [ROOT_TESTS] },
  { matches: (path) => path.startsWith(".github/"), packages: [], checks: [] },
  { matches: prose, packages: [], checks: [] },
]);

/** The pnpm filters of the packages a diff reaches, or none, and the root checks it feeds.
 * @param {string[]} changed @param {string} base */
export function selectionFor(changed, base) {
  const packages = new Set();
  const checks = new Map();
  let everything = false;
  let insideAPackage = false;
  for (const path of changed) {
    if (insidePackages(path)) {
      insideAPackage = true;
      if (scannedByRecords(path)) {
        packages.add("@musai/records");
      }
      continue;
    }
    const row = OUTSIDE.find(({ matches }) => matches(path));
    if (row === undefined) {
      everything = true;
      continue;
    }
    for (const name of row.packages) {
      packages.add(name);
    }
    for (const check of row.checks) {
      checks.set(check.join(" "), check);
    }
  }
  const filters = everything
    ? everythingButTheRoot
    : [...(insideAPackage ? ["--filter", `...[${base}]`] : []), ...[...packages].flatMap((name) => ["--filter", name])];
  return {
    filters: filters.length === 0 || everything ? filters : [...filters, ...everythingButTheRoot, "--fail-if-no-match"],
    checks: [...checks.values()],
  };
}
