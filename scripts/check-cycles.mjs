#!/usr/bin/env node
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import madge from "madge";
import { ROLES } from "./package-roles.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scanRoot = process.argv[2] ? resolve(process.argv[2]) : repoRoot;
const SCANNED_ROLES = new Set(["kernel-side", "distribution", "surface"]);

async function tsFilesUnder(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await tsFilesUnder(path)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

async function hasDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

const candidates = [...ROLES]
  .filter(([, role]) => SCANNED_ROLES.has(role))
  .map(([dir]) => dir)
  .sort();
const packages = [];
for (const name of candidates) {
  if (await hasDirectory(join(scanRoot, "packages", name, "src"))) {
    packages.push(name);
  }
}

let failed = false;
for (const name of packages) {
  const dir = join(scanRoot, "packages", name);
  const srcFiles = await tsFilesUnder(join(dir, "src"));
  // A lone file has no edge to have, so its empty graph is no failure.
  if (srcFiles.length === 1) {
    continue;
  }
  const graph = await madge(join(dir, "src"), {
    fileExtensions: ["ts"],
    // A type import is an edge: a layered order is about what a file may know, not what it loads.
    detectiveOptions: { ts: { skipTypeImports: false } },
  });
  const cycles = graph.circular();
  if (cycles.length > 0) {
    failed = true;
    console.error(`error import cycles in packages/${name}/src:`);
    for (const cycle of cycles) {
      console.error(`  ${cycle.join(" > ")}`);
    }
  }
  // An import madge cannot resolve hides any cycle it is part of.
  const skipped = graph.warnings().skipped;
  if (skipped.length > 0) {
    failed = true;
    console.error(`error imports madge could not resolve in packages/${name}/src:`);
    for (const path of skipped) {
      console.error(`  ${path}`);
    }
  }
  const edgeCount = Object.values(graph.obj()).reduce((sum, edges) => sum + edges.length, 0);
  if (edgeCount === 0) {
    failed = true;
    console.error(`error packages/${name}/src has no import edges; the graph is empty`);
  }
}

if (failed) {
  process.exit(1);
}
console.log("no import cycles found");
