#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** A test skipped under root runs again as this user, where the machine has one. */
const USER = "musai-test";
const root = dirname(dirname(fileURLToPath(import.meta.url)));

if (process.getuid?.() !== 0) {
  process.stdout.write("not root: every uid-sensitive test ran in the suites above\n");
  process.exit(0);
}
if (spawnSync("id", [USER]).status !== 0) {
  process.stdout.write(`no ${USER} user: the tests skipped under root did not run; create that user to run them\n`);
  process.exit(0);
}

/** Every test file asking for the uid, by package and by whether it asks the container engine, so
 * a new guarded test joins without a list. */
function guardedFiles() {
  const byPackage = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "fixtures") {
        walk(path);
      } else if (entry.name.endsWith(".test.ts")) {
        const source = readFileSync(path, "utf8");
        if (source.includes("getuid")) {
          const pkg = join(root, "packages", relative(join(root, "packages"), path).split("/")[0]);
          const key = JSON.stringify({ pkg, asksEngine: /containerEngineAvailable|localImageRunning/.test(source) });
          byPackage.set(key, [...(byPackage.get(key) ?? []), relative(pkg, path)]);
        }
      }
    }
  };
  for (const pkg of readdirSync(join(root, "packages"))) {
    const tests = join(root, "packages", pkg, "test");
    try {
      walk(tests);
    } catch {
      // A package without tests holds no guarded file.
    }
  }
  return byPackage;
}

// The docker group is the engine's daemon, root-equivalent: only a test asking the engine has it.
const engineGroup = spawnSync("getent", ["group", "docker"]).status === 0 ? ["-g", USER, "-G", "docker"] : [];

// Vite's default config loader writes beside the config, in a tree this user cannot write.
const home = mkdtempSync(join(tmpdir(), `${USER}-`));
execFileSync("chown", [USER, home]);
let failed = false;
try {
  for (const [key, files] of guardedFiles()) {
    const { pkg, asksEngine } = JSON.parse(key);
    const vitest = join(pkg, "node_modules", ".bin", "vitest");
    const run = spawnSync(
      "runuser",
      [
        "-u",
        USER,
        ...(asksEngine ? engineGroup : []),
        "--",
        "env",
        `HOME=${home}`,
        `PATH=${process.env.PATH}`,
        vitest,
        "run",
        "--configLoader",
        "runner",
        ...files,
      ],
      { cwd: pkg, stdio: "inherit" },
    );
    failed ||= run.status !== 0;
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
