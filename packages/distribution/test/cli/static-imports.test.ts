import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const { codeOnly, importsIn } = (await import(
  new URL("../../../../scripts/source-text.mjs", import.meta.url).href
)) as {
  codeOnly: (text: string) => string;
  importsIn: (text: string) => ReadonlyArray<{ readonly specifier: string; readonly kind: string }>;
};

/** A call to `import(` in code: one `importsIn` cannot read loads a module the walk never names. */
const IMPORT_CALL = /(?<![\w$.])import\s*\(/g;

const CLI_PATH = fileURLToPath(new URL("../../dist/bin/cli.js", import.meta.url));
const MCP_PATH = fileURLToPath(new URL("../../dist/bin/mcp.js", import.meta.url));
const PACKAGES_DIR = fileURLToPath(new URL("../../../", import.meta.url));

/** The built entry of package `name` as Node finds it from `importer`: its `import` export. */
async function builtEntryOf(name: string, importer: string): Promise<string> {
  for (let dir = dirname(importer); ; dir = dirname(dir)) {
    const linked = join(dir, "node_modules", name);
    if (existsSync(linked)) {
      const root = await realpath(linked);
      const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
        exports: { ".": { import: string } };
      };
      return join(root, manifest.exports["."].import);
    }
    if (dirname(dir) === dir) {
      throw new Error(`${name}, imported by ${importer}, is linked under no node_modules above it`);
    }
  }
}

/** The files, specifiers and unnamed `import()` callers reachable from `entry`, following relative
 * and `@musai/*` imports only. */
async function walkStaticImports(entry: string): Promise<{
  readonly files: ReadonlySet<string>;
  readonly specifiers: ReadonlySet<string>;
  readonly importCallers: ReadonlySet<string>;
}> {
  const files = new Set<string>();
  const specifiers = new Set<string>();
  const importCallers = new Set<string>();
  const pending = [await realpath(entry)];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file)) {
      continue;
    }
    files.add(file);
    const text = await readFile(file, "utf8");
    const imports = importsIn(text).filter(({ kind }) => kind === "static" || kind === "dynamic");
    const calls = codeOnly(text).match(IMPORT_CALL)?.length ?? 0;
    if (calls > imports.filter(({ kind }) => kind === "dynamic").length) {
      importCallers.add(file);
    }
    for (const { specifier } of imports) {
      specifiers.add(specifier);
      if (specifier.startsWith(".")) {
        pending.push(resolve(dirname(file), specifier));
      } else if (specifier.startsWith("@musai/")) {
        pending.push(await builtEntryOf(specifier, file));
      }
    }
  }
  return { files, specifiers, importCallers };
}

function namesMcp(specifier: string): boolean {
  return specifier === "@musai/mcp" || specifier.startsWith("@modelcontextprotocol/sdk");
}

describe("the command line's binding, walked through its static imports", () => {
  test("reaches its own chunks, the command line and the kernel beneath it, and nothing of @musai/mcp or the MCP SDK, which the server's binding reaches, through no import() call it cannot name", async () => {
    const cli = await walkStaticImports(CLI_PATH);
    const server = await walkStaticImports(MCP_PATH);
    const distributionDist = await realpath(join(PACKAGES_DIR, "distribution", "dist"));
    const cliEntry = await realpath(CLI_PATH);
    const ownChunks = [...cli.files].filter(
      (file) => file.startsWith(`${distributionDist}${sep}`) && file !== cliEntry,
    );

    expect(ownChunks).not.toEqual([]);
    expect(cli.files).toContain(await realpath(join(PACKAGES_DIR, "cli", "dist", "index.js")));
    expect(cli.files).toContain(await realpath(join(PACKAGES_DIR, "api-core", "dist", "index.js")));
    expect([...server.specifiers].filter(namesMcp)).toContain("@musai/mcp");
    expect([...server.specifiers].some((specifier) => specifier.startsWith("@modelcontextprotocol/sdk"))).toBe(true);
    expect([...cli.specifiers].filter(namesMcp)).toEqual([]);
    expect([...cli.importCallers]).toEqual([]);
  });
});
