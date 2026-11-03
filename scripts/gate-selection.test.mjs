import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { selectionFor } from "./gate-selection.mjs";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const LINT = "pnpm lint:checks";

/** The root checks a diff of `changed` alone runs, each as its command line. */
function checksFor(/** @type {string[]} */ ...changed) {
  return selectionFor(changed, "origin/dev").checks.map((check) => check.join(" "));
}

describe("the gate a diff outside packages/ selects", () => {
  const { scripts } = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  const lintChecks = [...scripts["lint:checks"].matchAll(/node (scripts\/check-[^ ]+\.mjs)/g)].map(([, path]) => path);

  test("a change to any lint check runs the lint over the repository's own code", () => {
    assert.ok(lintChecks.length > 0);
    for (const path of lintChecks) {
      assert.ok(checksFor(path).includes(LINT), `${path} does not run the lint`);
    }
  });

  test("a change to what the lint checks share, or to the formatter's configuration, runs the lint", () => {
    for (const path of ["scripts/source-text.mjs", "scripts/orphan-allowlist.md", "biome.jsonc"]) {
      assert.ok(checksFor(path).includes(LINT), `${path} does not run the lint`);
    }
  });

  test("a change to a script the lint does not read leaves the lint out", () => {
    assert.ok(!checksFor("scripts/gate-affected.mjs").includes(LINT));
  });

  test("a change to any script the typecheck covers selects the package that typechecks it", () => {
    const typechecker = "@musai/lint-fixtures";
    const { include } = JSON.parse(readFileSync(join(repo, "packages/lint-fixtures/tsconfig.json"), "utf8"));
    /** @type {string[]} */
    const outside = include.filter((/** @type {string} */ glob) => glob.startsWith("../../"));
    const covered = outside.flatMap((glob) => globSync(glob.slice("../../".length), { cwd: repo }));
    assert.ok(covered.length > 0);
    for (const path of covered) {
      const { filters } = selectionFor([path], "origin/dev");
      assert.ok(filters.includes(typechecker), `${path} does not typecheck`);
    }
  });
});
