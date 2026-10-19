import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** Runs the real script on one tree. Asserted line numbers are pinned: where a check reports is
 * part of what it says. */
function runCheck(script: string, fixture: string): { status: number | null; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL(`../../scripts/${script}`, import.meta.url)),
      fileURLToPath(new URL(fixture, import.meta.url)),
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return { status: result.status, stderr: result.stderr };
}

describe("the boundary check", () => {
  it("fails on a file importing from a directory above its own layer in its package", () => {
    const { status, stderr } = runCheck("check-package-boundaries.mjs", "./upward-import");

    expect(status).not.toBe(0);
    expect(stderr).toContain("directories-form-one-layered-graph");
    expect(stderr).toContain("packages/records/src/reason/parse.ts:4 imports ../record/render.js");
    expect(stderr.match(/^error /gm)).toHaveLength(1);
  });

  it("fails on a source file importing a workspace package its package does not declare", () => {
    const { status, stderr } = runCheck("check-package-boundaries.mjs", "./undeclared-import");

    expect(status).not.toBe(0);
    expect(stderr).toContain("imports-are-declared");
    expect(stderr).toContain(
      "packages/distribution/src/index.ts:1 imports @musai/records (not declared in distribution/package.json)",
    );
    expect(stderr.match(/^error /gm)).toHaveLength(1);
  });

  it("fails on an import, a require and a resolve of a third-party package its package does not declare", () => {
    const { status, stderr } = runCheck("check-package-boundaries.mjs", "./undeclared-third-party");

    expect(status).not.toBe(0);
    expect(stderr).toContain("imports-are-declared");
    expect(stderr.match(/packages\/records\/\S+:\d+ imports .*$/gm)?.sort()).toEqual([
      "packages/records/src/index.ts:1 imports left-pad (not declared in records/package.json)",
      "packages/records/src/packages/pad.ts:1 imports left-pad (not declared in records/package.json)",
      "packages/records/src/resolve.ts:1 imports esbuild (not declared in records/package.json)",
      "packages/records/test/load.test.ts:1 imports ajv (not declared in records/package.json)",
    ]);
    expect(stderr).not.toContain("canonicalize");
    expect(stderr.match(/^error /gm)).toHaveLength(1);
  });

  it("fails on a relative import that resolves outside its own package", () => {
    const { status, stderr } = runCheck("check-package-boundaries.mjs", "./relative-import-leaves-its-package");

    expect(status).not.toBe(0);
    expect(stderr).toContain("relative-imports-stay-in-their-package");
    expect(stderr.match(/packages\/cli\/\S+:\d+ imports .*$/gm)).toEqual([
      "packages/cli/test/reach.test.ts:1 imports ../../distribution/src/index.js (outside packages/cli)",
      "packages/cli/test/reach.test.ts:3 imports ../../cli-next/src/index.js (outside packages/cli)",
    ]);
    expect(stderr.match(/^error /gm)).toHaveLength(1);
  });

  it("fails on declared dependencies that close a cycle, a devDependency among them", () => {
    const { status, stderr } = runCheck("check-package-boundaries.mjs", "./declared-cycle");

    expect(status).not.toBe(0);
    expect(stderr).toContain("declared-graph-is-acyclic");
    expect(stderr).toContain("cli > mcp > cli");
    expect(stderr.match(/^error /gm)).toHaveLength(1);
  });

  it("fails on a package declaring one its row in EXCLUDED names, a devDependency among them", () => {
    const { status, stderr } = runCheck("check-package-boundaries.mjs", "./api-core-declares-devkit");

    expect(status).not.toBe(0);
    expect(stderr).toContain("excluded-edges-stay-undeclared");
    expect(stderr).toContain("packages/api-core/package.json declares @musai/devkit in devDependencies (excluded)");
    expect(stderr.match(/^error /gm)).toHaveLength(1);
  });

  it("fails on a shipped package declaring a test helper, a scenario or content", () => {
    const { status, stderr } = runCheck("check-package-boundaries.mjs", "./shipped-declares-never-shipped");

    expect(status).not.toBe(0);
    expect(stderr).toContain("error never-shipped-packages-stay-undeclared: ");
    expect(stderr.match(/(?<=^ {2})\S.*$/gm)?.sort()).toEqual([
      "packages/api-core/package.json declares @musai/test-support in devDependencies (test)",
      "packages/distribution/package.json declares @musai/scenarios in dependencies (scenarios)",
      "packages/records/package.json declares musai.core in dependencies (content)",
    ]);
    expect(stderr.match(/^error /gm)).toHaveLength(1);
  });

  it("fails on a kernel-side package reaching a surface", () => {
    const { status, stderr } = runCheck("check-package-boundaries.mjs", "./kernel-reaches-a-surface");

    expect(status).not.toBe(0);
    expect(stderr).toContain("kernel-side-reaches-no-distribution-or-surface");
    expect(stderr).toContain("packages/records/package.json declares @musai/cli in dependencies (surface)");
    expect(stderr).toContain("packages/records/src/index.ts:1 imports @musai/cli");
    expect(stderr.match(/^error /gm)).toHaveLength(1);
  });

  it("follows an aliased workspace dependency to the package it names", () => {
    const { status, stderr } = runCheck("check-package-boundaries.mjs", "./aliased-workspace-dependency");

    expect(status).not.toBe(0);
    expect(stderr.match(/^error [\w-]+/gm)).toEqual([
      "error kernel-side-reaches-no-distribution-or-surface",
      "error barrels-carry-only-their-own-names",
    ]);
    expect(stderr.match(/packages\/records\/.*$/gm)).toEqual([
      "packages/records/package.json declares @musai/distribution in dependencies (distribution)",
      "packages/records/src/index.ts:1 imports dist-alias",
      "packages/records/src/index.ts:1 re-exports * from dist-alias",
    ]);
  });

  it("reads a template-literal import and a source file under src/dist", () => {
    const { status, stderr } = runCheck("check-package-boundaries.mjs", "./computed-forms");

    expect(status).not.toBe(0);
    expect(stderr).toContain("kernel-side-reaches-no-distribution-or-surface");
    expect(stderr.match(/packages\/records\/.*$/gm)?.sort()).toEqual([
      "packages/records/package.json declares @musai/cli in dependencies (surface)",
      "packages/records/src/dist/leak.ts:1 imports @musai/cli",
      "packages/records/src/index.ts:1 imports @musai/cli",
    ]);
    expect(stderr.match(/^error /gm)).toHaveLength(1);
  });

  it("fails on a surface package reaching a distribution", () => {
    const { status, stderr } = runCheck("check-package-boundaries.mjs", "./surface-reaches-a-distribution");

    expect(status).not.toBe(0);
    expect(stderr).toContain("surfaces-reach-no-distribution");
    expect(stderr).toContain("packages/cli/package.json declares @musai/distribution in dependencies (distribution)");
    expect(stderr).toContain("packages/cli/src/index.ts:1 imports @musai/distribution");
    expect(stderr.match(/^error /gm)).toHaveLength(1);
  });

  it("fails on a surface package declaring a kernel-side package its own source does not import", () => {
    const { status, stderr } = runCheck("check-package-boundaries.mjs", "./surface-declares-kernel");

    expect(status).not.toBe(0);
    expect(stderr).toContain("surfaces-declare-only-the-kernel-side-packages-they-import");
    expect(stderr).toContain(
      "packages/cli/package.json declares @musai/records in dependencies, which nothing under packages/cli/src imports",
    );
    expect(stderr).toContain(
      "packages/mcp/package.json declares @musai/records in peerDependencies, which nothing under packages/mcp/src imports",
    );
    expect(stderr.match(/^error /gm)).toHaveLength(1);
  });

  it("fails on a surface declaring a kernel-side package that only a comment or a string in its source names", () => {
    const { status, stderr } = runCheck("check-package-boundaries.mjs", "./comment-names-a-package");

    expect(status).not.toBe(0);
    expect(stderr).toContain("surfaces-declare-only-the-kernel-side-packages-they-import");
    expect(stderr).toContain(
      "packages/cli/package.json declares @musai/records in dependencies, which nothing under packages/cli/src imports",
    );
    expect(stderr.match(/^error /gm)).toHaveLength(1);
  });

  it("fails on a surface package declaring in dependencies a kernel-side package only its tests import", () => {
    const { status, stderr } = runCheck("check-package-boundaries.mjs", "./surface-declares-a-test-dependency");

    expect(status).not.toBe(0);
    expect(stderr).toContain("surfaces-declare-only-the-kernel-side-packages-they-import");
    expect(stderr).toContain(
      "packages/cli/package.json declares @musai/records in dependencies, which nothing under packages/cli/src imports",
    );
    expect(stderr.match(/^error /gm)).toHaveLength(1);
  });

  it("fails on a scenario importing a kernel-side package", () => {
    const { status, stderr } = runCheck("check-package-boundaries.mjs", "./scenario-imports-the-kernel");

    expect(status).not.toBe(0);
    expect(stderr).toContain("error scenarios-reach-the-kernel-only-by-spawning-it: ");
    expect(stderr.match(/(?<=^ {2})\S.*$/gm)).toEqual(["packages/scenarios/journey.test.ts:1 imports @musai/records"]);
    expect(stderr.match(/^error /gm)).toHaveLength(1);
  });

  it("fails on a type-only edge carrying an import that loads the module", () => {
    const { status, stderr } = runCheck("check-package-boundaries.mjs", "./type-only-edge");

    expect(status).not.toBe(0);
    expect(stderr).toContain("type-only-edges-carry-only-types");
    expect(stderr).toContain("packages/fold/src/index.ts:1 imports @musai/store for more than its types");
    expect(stderr.match(/^error /gm)).toHaveLength(1);
  });

  it("reports each statement importing a type-only edge for more than its types at the line it starts", () => {
    const { status, stderr } = runCheck("check-package-boundaries.mjs", "./multi-line-type-only-edge");

    expect(status).not.toBe(0);
    expect(stderr).toContain("type-only-edges-carry-only-types");
    expect(stderr.match(/packages\/fold\/src\/index\.ts:\d+ .*$/gm)).toEqual([
      "packages/fold/src/index.ts:1 imports @musai/store for more than its types",
      "packages/fold/src/index.ts:6 imports @musai/store for more than its types",
    ]);
    expect(stderr.match(/^error /gm)).toHaveLength(1);
  });

  it("holds trust's edge to the store and the MCP server's to the module host to types", () => {
    const { status, stderr } = runCheck("check-package-boundaries.mjs", "./type-only-rows");

    expect(status).not.toBe(0);
    expect(stderr).toContain("error type-only-edges-carry-only-types: ");
    expect(stderr.match(/(?<=^ {2})\S.*$/gm)?.sort()).toEqual([
      "packages/mcp/src/index.ts:1 imports @musai/modules for more than its types",
      "packages/trust/src/index.ts:1 imports @musai/store for more than its types",
    ]);
    expect(stderr.match(/^error /gm)).toHaveLength(1);
  });

  it("fails on a kernel-side package or a surface re-exporting a name another workspace package defines", () => {
    const { status, stderr } = runCheck("check-package-boundaries.mjs", "./re-export-of-another-package");

    expect(status).not.toBe(0);
    expect(stderr).toContain("error barrels-carry-only-their-own-names: ");
    expect(stderr.match(/(?<=^ {2})\S.*$/gm)?.sort()).toEqual([
      "packages/mcp/src/index.ts:2 re-exports point as at from @musai/records",
      "packages/trust/src/index.ts:1 re-exports ACTIONS from @musai/records",
      "packages/trust/src/index.ts:14 re-exports records from @musai/records",
      "packages/trust/src/index.ts:3 re-exports point from @musai/records",
      "packages/trust/src/index.ts:5 re-exports Scope from @musai/records",
      "packages/trust/src/same-line.ts:1 re-exports ACTIONS from @musai/records",
    ]);
    expect(stderr.match(/^error /gm)).toHaveLength(1);
  });

  it("fails on a package the role table does not name", () => {
    const { status, stderr } = runCheck("check-package-boundaries.mjs", "./unroled-package");

    expect(status).not.toBe(0);
    expect(stderr).toContain("every-package-has-a-role");
    expect(stderr).toContain("packages/stray");
    expect(stderr.match(/^error /gm)).toHaveLength(1);
  });

  it("fails on a directory under packages/ that holds source and no package.json", () => {
    const { status, stderr } = runCheck("check-package-boundaries.mjs", "./unroled-source");

    expect(status).not.toBe(0);
    expect(stderr).toContain("every-package-has-a-role");
    expect(stderr).toContain("packages/stray");
    expect(stderr.match(/^error /gm)).toHaveLength(1);
  });

  it("passes over a directory under packages/ that holds neither a package.json nor source", () => {
    const { status, stderr } = runCheck("check-package-boundaries.mjs", "./leftover-directory");

    expect(status).toBe(0);
    expect(stderr).toBe("");
  });

  it("passes over a directory under packages/ that holds only build output and installed dependencies", async () => {
    const root = await mkdtemp(join(tmpdir(), "musai-leftover-directory-"));
    try {
      const tree = {
        "packages/records/package.json": '{ "name": "@musai/records" }\n',
        "packages/records/src/index.ts": "export const value = 1;\n",
        "packages/api/dist/index.d.ts": 'export { value } from "@musai/records";\n',
        "packages/api/node_modules/dep/index.ts": "export const dep = 1;\n",
      };
      for (const [path, text] of Object.entries(tree)) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), text);
      }

      const { status, stderr } = runCheck("check-package-boundaries.mjs", pathToFileURL(root).href);

      expect(stderr).toBe("");
      expect(status).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the cycle check", () => {
  it("fails on two files that each need the other loaded first", () => {
    const { status, stderr } = runCheck("check-cycles.mjs", "./import-cycle");

    expect(status).not.toBe(0);
    expect(stderr).toContain("error import cycles in packages/records/src:");
    expect(stderr).toContain("store/left.ts");
    expect(stderr).toContain("store/right.ts");
  });

  it("fails on an import madge cannot resolve", () => {
    const { status, stderr } = runCheck("check-cycles.mjs", "./cycle-scan-unresolved");

    expect(status).not.toBe(0);
    expect(stderr).toContain("error imports madge could not resolve in packages/records/src:");
    expect(stderr.match(/(?<=^ {2})\S.*$/gm)).toEqual(["./missing.js"]);
    expect(stderr.match(/^error /gm)).toHaveLength(1);
  });

  it("fails on a package whose source has no import edges, and passes over one holding a single file", () => {
    const { status, stderr } = runCheck("check-cycles.mjs", "./cycle-scan-empty-graph");

    expect(status).not.toBe(0);
    expect(stderr.match(/^error .*$/gm)).toEqual([
      "error packages/records/src has no import edges; the graph is empty",
    ]);
  });
});

describe("the orphan check", () => {
  it("fails on an export no production file outside its own reaches", () => {
    const { status, stderr } = runCheck("check-orphans.mjs", "./orphan");

    expect(status).not.toBe(0);
    expect(stderr).toContain("every-export-has-a-production-caller");
    expect(stderr).toContain("packages/records/src/reached.ts:8 strayHelper");
  });

  it("fails on a file no production file reaches", () => {
    const { status, stderr } = runCheck("check-orphans.mjs", "./orphan-file");

    expect(status).not.toBe(0);
    expect(stderr).toContain("error every-file-is-reached: ");
    expect(stderr.match(/(?<=^ {2})\S.*$/gm)).toEqual(["packages/records/src/unreached.ts"]);
    expect(stderr.match(/^error /gm)).toHaveLength(1);
  });

  it("fails on an allowlist row whose symbol or file is no longer an orphan", () => {
    const { status, stderr } = runCheck("check-orphans.mjs", "./orphan-spent-row");

    expect(status).not.toBe(0);
    expect(stderr).toContain("error every-allowlist-row-is-still-an-orphan: ");
    expect(stderr.match(/(?<=^ {2})\S.*$/gm)).toEqual([
      "packages/records/src/reached.ts reached",
      "packages/records/src/reached.ts",
    ]);
    expect(stderr.match(/^error /gm)).toHaveLength(1);
  });

  it("fails on a tree in which it matches no exported declaration", () => {
    const { status, stderr } = runCheck("check-orphans.mjs", "./orphan-scan-empty");

    expect(status).not.toBe(0);
    expect(stderr.match(/^error .*$/gm)).toEqual([
      "error the-scan-matched-something: no exported declarations found under packages; the scan matched nothing and proves nothing.",
    ]);
    expect(stderr.match(/(?<=^ {2})\S.*$/gm)).toBeNull();
  });
});

describe("the clock check", () => {
  it("fails on a read of the machine's clock in a file the allowlist does not name, and on nothing that only mentions one", () => {
    const { status, stderr } = runCheck("check-clock-reads.mjs", "./clock-read");
    // The repository's allowlist rows are spent here too; only the fixture's own file is read.

    expect(status).not.toBe(0);
    expect(stderr).toContain("every-clock-is-handed");
    expect(stderr).toContain("packages/records/src/clock-reads.ts:5 Date.now()");
    expect(stderr).toContain("packages/records/src/clock-reads.ts:21 Date.now()");
    expect(stderr).toContain("packages/records/src/clock-reads.ts:24 Date.now()");
    expect(stderr.match(/packages\/records\/src\/clock-reads\.ts:\d+/g)).toEqual([
      "packages/records/src/clock-reads.ts:5",
      "packages/records/src/clock-reads.ts:21",
      "packages/records/src/clock-reads.ts:24",
    ]);
  });

  it("fails on an allowlist row whose file no longer reads the machine's clock", () => {
    const { status, stderr } = runCheck("check-clock-reads.mjs", "./clock-spent-row");

    expect(status).not.toBe(0);
    expect(stderr).toContain("error every-allowlist-row-still-reads: ");
    expect(stderr.match(/(?<=^ {2})\S.*$/gm)).toEqual(["packages/mcp/src/call-log.ts"]);
    expect(stderr.match(/^error /gm)).toHaveLength(1);
  });

  it("fails on a tree in which it matches no read of the machine's clock", () => {
    const { status, stderr } = runCheck("check-clock-reads.mjs", "./clock-scan-empty");
    // The repository's allowlist rows are spent here too; only this rule's line is read.

    expect(status).not.toBe(0);
    expect(stderr.match(/^error the-scan-matched-something: .*$/gm)).toEqual([
      "error the-scan-matched-something: no read of the machine's clock found under packages; the scan matched nothing and proves nothing.",
    ]);
  });
});

describe("the comment check", () => {
  it("fails once per rule on the violations and passes every near miss", () => {
    const { status, stderr } = runCheck("check-comments.mjs", "./comment-too-long");

    expect(status).not.toBe(0);
    expect(stderr.match(/^error [\w-]+/gm)).toEqual([
      "error comment-before-first-statement",
      "error doc-comment-over-two-lines",
      "error line-comment-over-one-line",
      "error comment-line-over-100-chars",
    ]);
    expect(stderr.match(/(?<=^ {2})\S.*$/gm)).toEqual([
      "packages/records/src/violations.ts:1",
      "packages/records/src/violations.ts:4 (3 lines)",
      "packages/records/src/violations.ts:13 (2 lines)",
      "packages/records/src/violations.ts:17 (106 chars)",
    ]);
  });
});

describe("the affected-package selection", () => {
  const select = async (changed: string[]): Promise<string[] | null> => {
    const { selectionFor } = await import(pathToFileURL(join(repoRoot, "scripts/gate-selection.mjs")).href);
    return selectionFor(changed, "abc123");
  };

  it("selects nothing for a diff of Markdown outside the packages", async () => {
    expect(await select(["DESIGN.md", "docs/notes.md"])).toBeNull();
  });

  it("selects every package for the Markdown a package test reads", async () => {
    const everything = ["--filter", "!musai-workspace"];

    expect(await select(["README.md"])).toEqual(everything);
    expect(await select(["corpus/report.md"])).toEqual(everything);
  });

  it("selects every package for a non-Markdown path outside the packages", async () => {
    expect(await select(["DESIGN.md", "tsconfig.base.json"])).toEqual(["--filter", "!musai-workspace"]);
  });

  it("selects the changed packages when Markdown rides with a package change", async () => {
    expect(await select(["DESIGN.md", "packages/mcp/src/server.ts"])).toEqual([
      "--filter",
      "...[abc123]",
      "--filter",
      "!musai-workspace",
      "--fail-if-no-match",
    ]);
  });
});
