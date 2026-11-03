#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { selectionFor } from "./gate-selection.mjs";

const base = process.argv[2];
if (base === undefined) {
  process.stderr.write("usage: pnpm gate:affected <base>\n");
  process.exit(2);
}

const shell = process.platform === "win32";

/** @param {string} command @param {string[]} args */
function run(command, args, options = {}) {
  return spawnSync(command, args, { stdio: "inherit", shell, ...options });
}

const diff = spawnSync("git", ["diff", "--name-only", "--no-renames", base], { encoding: "utf8", shell });
if (diff.status !== 0) {
  process.stderr.write(diff.stderr);
  process.exit(diff.status ?? 1);
}
const changed = diff.stdout.split("\n").filter((path) => path !== "");

const { filters, checks } = selectionFor(changed, base);
if (filters.length === 0 && checks.length === 0) {
  process.stdout.write(`gate:affected: ${base} reaches no package and no check, nothing to gate\n`);
  process.exit(0);
}
// The scenarios take minutes and exercise every package, so they run on their own.
const selection = [...filters, "--filter", "!@musai/scenarios"];

// A package resolves its siblings through their built output, which the selection does not cover.
const steps = [
  ["pnpm", "-r", "build"],
  ...(filters.length === 0
    ? []
    : [
        ["pnpm", "-r", ...selection, "typecheck"],
        ["pnpm", "-r", "--no-bail", ...selection, "test"],
      ]),
  ...checks,
];
for (const [command, ...args] of steps) {
  const { status } = run(command, args);
  if (status !== 0) {
    process.exit(status ?? 1);
  }
}
