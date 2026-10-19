import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const PACKAGES_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// A static import of an untyped .mjs does not compile under strict, so it is read at runtime.
const { ROLES } = (await import(new URL("../../../scripts/package-roles.mjs", import.meta.url).href)) as {
  ROLES: ReadonlyMap<string, string>;
};

const KERNEL_SIDE_SRC_ROOTS: ReadonlyMap<string, string> = new Map(
  [...ROLES].filter(([, role]) => role === "kernel-side").map(([dir]) => [dir, join(PACKAGES_ROOT, dir, "src")]),
);

const ERROR_SUBCLASS = /\bclass\s+\w+\s+extends\s+Error\b/;

const BARE_THROW = /throw new Error\(/;

/** Files allowed a class extending `Error` directly; every other extends `KernelError`. */
const ERROR_SUBCLASS_ALLOWLIST: ReadonlyMap<string, string> = new Map([
  ["records/reason/error.ts", "the base every refusal carries"],
  ["api-core/registry.ts", "two descriptors sharing one key, a defect in how a registry was built, class bug"],
]);

/** Files allowed a bare `Error` throw, a defect no caller can act on. The count keeps a new throw
 * from passing under another's argument. */
const BARE_THROW_ALLOWLIST: ReadonlyMap<string, { readonly throws: number; readonly argument: string }> = new Map([
  [
    "modules/module/host-child.ts",
    { throws: 3, argument: "clock and randomness denials a module meets inside the sandbox" },
  ],
  [
    "modules/rule/sandbox-worker.ts",
    { throws: 4, argument: "sandbox denials, and the worker entry point run outside a worker thread" },
  ],
  [
    "devkit/manifest.ts",
    { throws: 3, argument: "clock and randomness denials a contribution meets while it is described" },
  ],
  [
    "fold/index-db.ts",
    {
      throws: 1,
      argument:
        "a fold built under an admission, folded without it: a defect in how a workspace bound its index, class bug",
    },
  ],
  [
    "store/paths.ts",
    { throws: 1, argument: "this package cannot locate its own root, which is a defect in the installation" },
  ],
  [
    "api-core/registry.ts",
    {
      throws: 4,
      argument:
        "descriptors sharing a key, carrying no CLI projection or declaring a reason no operation may, and a lookup of an operation the registry does not hold: each a defect in how a registry was built or bound, class bug",
    },
  ],
]);

async function kernelSideSources(): Promise<readonly string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        found.push(path);
      }
    }
  }
  for (const root of KERNEL_SIDE_SRC_ROOTS.values()) {
    await walk(root);
  }
  return found;
}

/** A file's allowlist path: its package directory and path under src, with forward slashes. */
function kernelPath(file: string): string {
  const [dir, root] = [...KERNEL_SIDE_SRC_ROOTS].find(([, candidate]) => !relative(candidate, file).startsWith(".."))!;
  return `${dir}/${relative(root, file).split(sep).join("/")}`;
}

async function matchingLines(pattern: RegExp): Promise<readonly { path: string; line: number; text: string }[]> {
  const hits: { path: string; line: number; text: string }[] = [];
  for (const file of await kernelSideSources()) {
    const lines = (await readFile(file, "utf8")).split("\n");
    lines.forEach((text, index) => {
      if (pattern.test(text)) {
        hits.push({ path: kernelPath(file), line: index + 1, text: text.trim() });
      }
    });
  }
  return hits;
}

test("a class extends Error directly only where argued", async () => {
  const declarations = await matchingLines(ERROR_SUBCLASS);
  const stray = declarations.filter((hit) => !ERROR_SUBCLASS_ALLOWLIST.has(hit.path));

  expect(
    stray,
    stray.length === 0
      ? ""
      : `these classes extend Error directly:\n${stray
          .map((hit) => `  ${hit.path}:${hit.line} — ${hit.text}`)
          .join(
            "\n",
          )}\nExtend KernelError and declare the reason naming what the caller does next, or argue the file onto the allowlist.`,
  ).toEqual([]);
});

test("no file sits on the Error-subclass allowlist without declaring one", async () => {
  const declaring = new Set((await matchingLines(ERROR_SUBCLASS)).map((hit) => hit.path));
  const idle = [...ERROR_SUBCLASS_ALLOWLIST.keys()].filter((path) => !declaring.has(path));

  expect(
    idle,
    `these files no longer declare a class extending Error directly and leave the allowlist: ${idle.join(", ")}`,
  ).toEqual([]);
});

test("a bare Error is thrown only where argued", async () => {
  const throws = await matchingLines(BARE_THROW);
  const unlisted = throws.filter((hit) => !BARE_THROW_ALLOWLIST.has(hit.path));

  expect(
    unlisted,
    unlisted.length === 0
      ? ""
      : `these bare throws are on no allowlist:\n${unlisted
          .map((hit) => `  ${hit.path}:${hit.line} — ${hit.text}`)
          .join(
            "\n",
          )}\nThrow a KernelError with the reason naming what the caller does next, or argue the file onto the allowlist.`,
  ).toEqual([]);
});

test("every file on the bare-throw allowlist throws as many bare Errors as its row counts", async () => {
  const counted = new Map<string, number>();
  for (const hit of await matchingLines(BARE_THROW)) {
    counted.set(hit.path, (counted.get(hit.path) ?? 0) + 1);
  }
  const drifted = [...BARE_THROW_ALLOWLIST]
    .filter(([path, row]) => (counted.get(path) ?? 0) !== row.throws)
    .map(([path, row]) => `  ${path} — the row counts ${row.throws}, the file throws ${counted.get(path) ?? 0}`);

  expect(
    drifted,
    drifted.length === 0
      ? ""
      : `these allowlisted files throw a different number of bare Errors than their rows count:\n${drifted.join(
          "\n",
        )}\nThrow a KernelError with the reason naming what the caller does next, or argue the change into the row and correct its count; a file that throws none leaves the allowlist.`,
  ).toEqual([]);
});
