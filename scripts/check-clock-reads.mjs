#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ROLES } from "./package-roles.mjs";
import { codeOnly } from "./source-text.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scanRoot = process.argv[2] ? resolve(process.argv[2]) : repoRoot;

const PRODUCTION_ROLES = new Set(["kernel-side", "distribution", "surface"]);

/** Production paths by role: `src` of every shipped package, and a content package's root. */
const SCANNED_ROOTS = [...ROLES].flatMap(([dir, role]) => {
  if (PRODUCTION_ROLES.has(role)) {
    return [`packages/${dir}/src`];
  }
  if (role === "content") {
    return [`packages/${dir}`];
  }
  return [];
});

const EXCLUDED_DIRECTORY_NAMES = new Set(["node_modules", "test"]);

/** Template sources are copied into a new module, never run from here. */
const EXCLUDED_PATHS = ["packages/devkit/src/templates"];

// A `Date` built from a value parses it rather than reading the clock.
const READS = [
  { spelled: "Date.now()", pattern: /(?<![\w$])Date\s*\.\s*now\b/g },
  { spelled: "performance.now()", pattern: /(?<![\w$])performance\s*\.\s*now\b/g },
  { spelled: "process.hrtime()", pattern: /(?<![\w$])process\s*\.\s*hrtime\b/g },
  { spelled: "Date()", pattern: /(?<![\w$.])(?<!\bnew\s+)Date\s*\(/g },
  { spelled: "new Date()", pattern: /\bnew\s+Date\s*\(\s*\)|\bnew\s+Date\b(?!\s*\()/g },
];

const ALLOWLIST = [
  {
    file: "packages/api-core/src/context.ts",
    reads: "the instant `clockFromEnvironment`'s clock answers with when `MUSAI_NOW` is unset",
    argument:
      "`clockFromEnvironment` is the one place the machine's clock is read for an operation: both surfaces call it " +
      "to build the context every operation is handed, and every seam below takes its clock from that context.",
  },
  {
    file: "packages/run/src/spawn.ts",
    reads: "a run's start and finish when `performRecipe` is handed no clock",
    argument:
      "the three callers that hand `performRecipe` no clock are capability probes — the module host list's own " +
      "runtime-availability probe, the subprocess host's own child invocation, and the canary — and none of their " +
      "observations ever becomes a `RunRecord`; every caller whose observation does become one supplies a clock " +
      "one level up instead.",
  },
  {
    file: "packages/mcp/src/call-log.ts",
    reads: "the instant `openCallLog` names a session's call log file after",
    argument:
      "the read names a file, beside eight random bytes that already make the name unique; it stamps no fact, " +
      "enters no record, and is never read back as a time.",
  },
];

function counted(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Relative to the scan root, with forward slashes on every platform, as allowlist rows name it. */
function displayPath(path) {
  return relative(scanRoot, path).split(sep).join("/");
}

/** Walked by directory entry, so a symbolic link is never followed. */
async function sourceFilesUnder(dir) {
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
      if (!EXCLUDED_DIRECTORY_NAMES.has(entry.name) && !EXCLUDED_PATHS.includes(displayPath(path))) {
        files.push(...(await sourceFilesUnder(path)));
      }
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

async function scan() {
  const reads = [];
  for (const root of SCANNED_ROOTS) {
    for (const path of (await sourceFilesUnder(join(scanRoot, root))).sort()) {
      const code = codeOnly(await readFile(path, "utf8"));
      const found = [];
      for (const { spelled, pattern } of READS) {
        for (const match of code.matchAll(pattern)) {
          found.push({ file: displayPath(path), index: match.index, spelled });
        }
      }
      found.sort((a, b) => a.index - b.index);
      for (const { file, index, spelled } of found) {
        reads.push({ file, line: code.slice(0, index).split("\n").length, spelled });
      }
    }
  }
  return reads;
}

const reads = await scan();
const failures = [];

if (reads.length === 0) {
  failures.push({
    name: "the-scan-matched-something",
    comment: `no read of the machine's clock found under ${displayPath(join(scanRoot, "packages"))}; the scan matched nothing and proves nothing.`,
    rows: [],
  });
}

const listedFiles = new Set(ALLOWLIST.map((row) => row.file));
const unlisted = reads.filter((read) => !listedFiles.has(read.file));
if (unlisted.length > 0) {
  failures.push({
    name: "every-clock-is-handed",
    comment:
      "these reads of the machine's clock sit in files the allowlist does not name. Take the clock from what handed it to you, or argue the file onto the allowlist in scripts/check-clock-reads.mjs.",
    rows: unlisted.map((read) => `${read.file}:${read.line} ${read.spelled}`),
  });
}

const readingFiles = new Set(reads.map((read) => read.file));
const spent = ALLOWLIST.filter((row) => !readingFiles.has(row.file));
if (spent.length > 0) {
  failures.push({
    name: "every-allowlist-row-still-reads",
    comment:
      "these allowlist rows name a file with no read of the machine's clock left in it. Take the row off; the list grants permission nobody is using.",
    rows: spent.map((row) => `${row.file}\n    reads: ${row.reads}\n    argument: ${row.argument}`),
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
  `${counted(reads.length, "read")} of the machine's clock in ${counted(readingFiles.size, "file")}, ` +
    `all on an allowlist of ${counted(ALLOWLIST.length, "row")}`,
);
