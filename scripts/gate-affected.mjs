#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { selectionFor } from "./gate-selection.mjs";

const base = process.argv[2];
if (base === undefined) {
  process.stderr.write("usage: pnpm gate:affected <base>\n");
  process.exit(2);
}

const shell = process.platform === "win32";

function run(command, args, options = {}) {
  return spawnSync(command, args, { stdio: "inherit", shell, ...options });
}

const diff = spawnSync("git", ["diff", "--name-only", "--no-renames", base], { encoding: "utf8", shell });
if (diff.status !== 0) {
  process.stderr.write(diff.stderr);
  process.exit(diff.status ?? 1);
}
const changed = diff.stdout.split("\n").filter((path) => path !== "");

const selected = selectionFor(changed, base);
if (selected === null) {
  process.stdout.write(`gate:affected: ${base} differs only in prose outside packages/, nothing to gate\n`);
  process.exit(0);
}
// The scenarios take minutes and exercise every package, so they run on their own.
const selection = [...selected, "--filter", "!@musai/scenarios"];

// A package resolves its siblings through their built output, which the selection does not cover.
const steps = [
  ["-r", "build"],
  ["-r", ...selection, "typecheck"],
  ["-r", "--no-bail", ...selection, "test"],
];
for (const args of steps) {
  const { status } = run("pnpm", args);
  if (status !== 0) {
    process.exit(status ?? 1);
  }
}
