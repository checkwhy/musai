#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { codeOnly } from "./source-text.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scanRoot = process.argv[2] ? resolve(process.argv[2]) : repoRoot;

// Loaded by no production caller by design, or orphaned on purpose to make the check bite.
const EXCLUDED_PACKAGES = new Set(["core-module", "lint-fixtures", "scenarios", "test-support"]);
const EXCLUDED_DIRECTORIES = ["devkit/src/templates"];

const ALLOWLIST_PATH = join("scripts", "orphan-allowlist.md");
const SYMBOL_TABLE_HEADING = "## Symbols";
const FILE_TABLE_HEADING = "## Files";

function counted(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Relative to the scan root, with forward slashes on every platform, as allowlist rows name it. */
function displayPath(path) {
  return relative(scanRoot, path).split(sep).join("/");
}

async function packageSourceRoots() {
  const packagesDir = join(scanRoot, "packages");
  const roots = [];
  for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
    if (entry.isDirectory() && !EXCLUDED_PACKAGES.has(entry.name)) {
      roots.push(join(packagesDir, entry.name, "src"));
    }
  }
  return roots.sort();
}

async function productionFilesUnder(dir) {
  const files = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await productionFilesUnder(path)));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files.filter((path) => !EXCLUDED_DIRECTORIES.some((excluded) => displayPath(path).includes(`/${excluded}/`)));
}

/** A name an `export { … }` clause passes on is not a use of it, so a barrel hides no orphan. */
function withoutExportClauses(code) {
  const out = code.split("");
  for (const match of code.matchAll(/\bexport\s*(?:type\s+)?\{/g)) {
    const close = code.indexOf("}", match.index);
    if (close === -1) {
      continue;
    }
    const rest = code.slice(close + 1);
    const tail = /^\s*(?:from\s*["'][^"']*["'])?\s*;?/.exec(rest)[0];
    for (let i = match.index; i < close + 1 + tail.length; i += 1) {
      if (out[i] !== "\n") {
        out[i] = " ";
      }
    }
  }
  return out.join("");
}

const DECLARATIONS = [
  { kind: "value", pattern: /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm },
  { kind: "value", pattern: /^export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm },
  { kind: "value", pattern: /^export\s+const\s+([A-Za-z_$][\w$]*)/gm },
  { kind: "type", pattern: /^export\s+(?:type|interface)\s+([A-Za-z_$][\w$]*)/gm },
];

const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

/** `.set(` names a member, not the exported `set`. It also hides `ns.foo()` under
 * `import * as ns`, which no production file writes. */
function readsAMember(code, index) {
  let back = index - 1;
  while (back >= 0 && /\s/.test(code[back])) {
    back -= 1;
  }
  return code[back] === "." && code[back - 1] !== ".";
}

/** The `from` of an import or export statement, not an exported constructor named `from`. */
function isModuleFrom(code, name, index) {
  return name === "from" && /^\s*["'`]/.test(code.slice(index + name.length));
}

async function scan() {
  const files = [];
  for (const root of await packageSourceRoots()) {
    files.push(...(await productionFilesUnder(root)));
  }

  const exports = [];
  const occurrencesByFile = new Map();
  const totalOccurrences = new Map();

  for (const path of files.sort()) {
    const code = codeOnly(await readFile(path, "utf8"));
    const references = withoutExportClauses(code);
    for (const { kind, pattern } of DECLARATIONS) {
      for (const match of references.matchAll(pattern)) {
        exports.push({
          name: match[1],
          kind,
          path,
          line: references.slice(0, match.index).split("\n").length,
        });
      }
    }
    const names = new Map();
    for (const match of references.matchAll(IDENTIFIER)) {
      if (readsAMember(references, match.index) || isModuleFrom(references, match[0], match.index)) {
        continue;
      }
      names.set(match[0], (names.get(match[0]) ?? 0) + 1);
    }
    occurrencesByFile.set(path, names);
    for (const [name, count] of names) {
      totalOccurrences.set(name, (totalOccurrences.get(name) ?? 0) + count);
    }
  }

  // Text cannot tell two declarations of one name apart, so each is discounted from its count.
  const declarationCounts = new Map();
  for (const declared of exports) {
    declarationCounts.set(declared.name, (declarationCounts.get(declared.name) ?? 0) + 1);
  }

  // A type is surface, not machinery: it can reach a file but is never an orphan itself.
  const orphanSymbols = exports.filter(
    (declared) =>
      declared.kind === "value" && totalOccurrences.get(declared.name) - declarationCounts.get(declared.name) === 0,
  );

  const exportedNamesByFile = new Map();
  for (const declared of exports) {
    const names = exportedNamesByFile.get(declared.path);
    if (names === undefined) {
      exportedNamesByFile.set(declared.path, new Set([declared.name]));
    } else {
      names.add(declared.name);
    }
  }

  const orphanFiles = [];
  for (const [path, names] of exportedNamesByFile) {
    const reached = [...occurrencesByFile].some(
      ([other, occurrences]) => other !== path && [...names].some((name) => occurrences.has(name)),
    );
    if (!reached) {
      orphanFiles.push(path);
    }
  }

  return { exportCount: exports.length, orphanSymbols, orphanFiles: orphanFiles.sort() };
}

function rowsUnder(text, heading) {
  const start = text.indexOf(heading);
  if (start === -1) {
    return [];
  }
  const after = text.slice(start + heading.length);
  const end = after.indexOf("\n## ");
  const section = end === -1 ? after : after.slice(0, end);
  const rows = [];
  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || /^\|[\s:|-]*\|$/.test(trimmed)) {
      continue;
    }
    const cells = trimmed
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim().replace(/^`|`$/g, ""));
    if (cells[0] !== "Symbol" && cells[0] !== "File") {
      rows.push(cells);
    }
  }
  return rows;
}

async function allowlist() {
  const path = join(scanRoot, ALLOWLIST_PATH);
  const text = await readFile(path, "utf8").catch(() => "");
  return {
    symbols: rowsUnder(text, SYMBOL_TABLE_HEADING).map(([name, file, reason]) => ({ name, file, reason })),
    files: rowsUnder(text, FILE_TABLE_HEADING).map(([file, reason]) => ({ file, reason })),
  };
}

const { exportCount, orphanSymbols, orphanFiles } = await scan();
const listed = await allowlist();

const failures = [];

if (exportCount === 0) {
  failures.push({
    name: "the-scan-matched-something",
    comment: `no exported declarations found under ${displayPath(join(scanRoot, "packages"))}; the scan matched nothing and proves nothing.`,
    rows: [],
  });
}

const listedSymbols = new Set(listed.symbols.map((row) => `${row.name} ${row.file}`));
const listedFiles = new Set(listed.files.map((row) => row.file));

const unlistedSymbols = orphanSymbols.filter(
  (declared) => !listedSymbols.has(`${declared.name} ${displayPath(declared.path)}`),
);
if (unlistedSymbols.length > 0) {
  failures.push({
    name: "every-export-has-a-production-caller",
    comment:
      "these exports have no production caller. Wire each one, delete it, un-export it, or put it on the allowlist with the phase that will call it.",
    rows: unlistedSymbols.map((declared) => `${displayPath(declared.path)}:${declared.line} ${declared.name}`),
  });
}

const unlistedFiles = orphanFiles.filter((path) => !listedFiles.has(displayPath(path)));
if (unlistedFiles.length > 0) {
  failures.push({
    name: "every-file-is-reached",
    comment:
      "no production file reaches anything these files export. Wire each one, delete it, or put it on the allowlist with the phase that will reach it.",
    rows: unlistedFiles.map((path) => displayPath(path)),
  });
}

const orphanedSymbolKeys = new Set(orphanSymbols.map((declared) => `${declared.name} ${displayPath(declared.path)}`));
const spentSymbolRows = listed.symbols.filter((row) => !orphanedSymbolKeys.has(`${row.name} ${row.file}`));
const orphanedFileKeys = new Set(orphanFiles.map((path) => displayPath(path)));
const spentFileRows = listed.files.filter((row) => !orphanedFileKeys.has(row.file));

if (spentSymbolRows.length + spentFileRows.length > 0) {
  failures.push({
    name: "every-allowlist-row-is-still-an-orphan",
    comment:
      "these allowlist rows name something that is no longer an orphan, or no longer exists. Take the row off; the list grants permission nobody is using.",
    rows: [...spentSymbolRows.map((row) => `${row.file} ${row.name}`), ...spentFileRows.map((row) => row.file)],
  });
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`error ${failure.name}: ${failure.comment}`);
    for (const row of failure.rows) {
      console.error(`  ${row}`);
    }
  }
  process.exit(1);
}

console.log(
  `${counted(orphanSymbols.length, "orphaned symbol")} and ${counted(orphanFiles.length, "orphaned file")}, ` +
    `all on an allowlist of ${counted(listed.symbols.length, "symbol row")} and ${counted(listed.files.length, "file row")}`,
);
