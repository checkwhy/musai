#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { codeOnly, commentsIn } from "./source-text.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scanRoot = process.argv[2] ? resolve(process.argv[2]) : repoRoot;

const SCANNED_ROOTS = ["packages", "scripts"];
const SOURCE_EXTENSIONS = [".ts", ".mjs", ".js"];
const EXCLUDED_DIRECTORY_NAMES = new Set(["node_modules", "dist"]);
// The lint fixtures are other scans' deliberate inputs; only their test file is scanned.
const FIXTURE_ROOT = "packages/lint-fixtures";

const MAX_BLOCK_LINES = 2;
const MAX_LINE_RUN = 1;
const MAX_LINE_LENGTH = 100;
const DIRECTIVE = /^\/\/\s*(?:biome-ignore|@ts-(?:expect-error|ignore|nocheck))\b/;
const URL_ONLY = /^(?:\/\/|\/?\*+)\s*https?:\/\/\S+\s*(?:\*\/)?$/;

function displayPath(path) {
  return relative(scanRoot, path).split(sep).join("/");
}

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
      const inFixture = displayPath(dir) === FIXTURE_ROOT;
      if (!EXCLUDED_DIRECTORY_NAMES.has(entry.name) && !inFixture) {
        files.push(...(await sourceFilesUnder(path)));
      }
    } else if (entry.isFile() && SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      if (!entry.name.endsWith(".d.ts")) {
        files.push(path);
      }
    }
  }
  return files;
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

function blockContentLines(body) {
  const lines = body.split("\n");
  return lines.filter((line, i) => {
    const stripped = line.trim();
    if (i === 0 && /^\/\*+$/.test(stripped)) return false;
    if (i === lines.length - 1 && /^\*+\/$/.test(stripped)) return false;
    return true;
  }).length;
}

function violationsIn(file, text) {
  const found = [];
  const lines = text.split("\n");
  const code = codeOnly(text.startsWith("#!") ? text.replace(/^#![^\n]*/, (m) => " ".repeat(m.length)) : text);
  const firstCode = code.search(/\S/);
  const comments = commentsIn(text);
  const standalone = (comment) =>
    /^\s*$/.test(lines[lineOf(text, comment.start) - 1].slice(0, column(text, comment.start)));
  const isDirective = (comment) => comment.kind === "line" && DIRECTIVE.test(text.slice(comment.start, comment.end));

  let run = [];
  const closeRun = () => {
    if (run.length > MAX_LINE_RUN) {
      found.push({ rule: "line-comment-over-one-line", file, line: run[0], detail: `${run.length} lines` });
    }
    run = [];
  };

  for (const comment of comments) {
    const line = lineOf(text, comment.start);
    const body = text.slice(comment.start, comment.end);
    if (isDirective(comment)) {
      closeRun();
      continue;
    }
    if (firstCode !== -1 && comment.start < firstCode) {
      found.push({ rule: "comment-before-first-statement", file, line, detail: "" });
    }
    if (comment.kind === "block") {
      closeRun();
      const count = blockContentLines(body);
      if (count > MAX_BLOCK_LINES) {
        found.push({ rule: "doc-comment-over-two-lines", file, line, detail: `${count} lines` });
      }
    } else if (standalone(comment) && run.at(-1) === line - 1) {
      run.push(line);
    } else {
      closeRun();
      if (standalone(comment)) run = [line];
    }
    const endLine = lineOf(text, comment.end);
    for (let n = line; n <= endLine; n++) {
      const source = lines[n - 1];
      if (source.length > MAX_LINE_LENGTH && !URL_ONLY.test(source.trim())) {
        found.push({ rule: "comment-line-over-100-chars", file, line: n, detail: `${source.length} chars` });
      }
    }
  }
  closeRun();
  return found;
}

function column(text, index) {
  return index - (text.lastIndexOf("\n", index - 1) + 1);
}

const violations = [];
for (const root of SCANNED_ROOTS) {
  for (const path of (await sourceFilesUnder(join(scanRoot, root))).sort()) {
    violations.push(...violationsIn(displayPath(path), await readFile(path, "utf8")));
  }
}

if (violations.length > 0) {
  const byRule = Map.groupBy(violations, (v) => v.rule);
  for (const [rule, rows] of byRule) {
    console.error(`error ${rule}: a comment says why, in one sentence, only where the code cannot.`);
    for (const row of rows) {
      console.error(`  ${row.file}:${row.line}${row.detail ? ` (${row.detail})` : ""}`);
    }
  }
  process.exit(1);
}

console.log("every comment is within its limits");
