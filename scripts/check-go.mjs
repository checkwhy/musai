#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const verify = join(root, "verify");

/** The verifier's own CI checks but its linter, which CI pins and downloads. */
const STEPS = [
  ["go", ["vet", "./..."]],
  ["go", ["test", "-count=1", "./..."]],
  ["go", ["run", "./cmd/musai-verify", "conformance", join(root, "conformance")]],
];

for (const [command, args] of STEPS) {
  const run = spawnSync(command, args, { cwd: verify, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
  if (run.status !== 0) {
    process.stdout.write(run.stdout ?? "");
    process.stderr.write(`check-go: ${command} ${args.join(" ")} failed\n`);
    process.exit(1);
  }
}

const embedded = readFileSync(join(verify, "internal", "refs", "references.json"));
if (!embedded.equals(readFileSync(join(root, "conformance", "references.json")))) {
  process.stderr.write("check-go: the verifier embeds a reference table other than conformance/references.json\n");
  process.exit(1);
}
process.stdout.write("the verifier vets, passes its tests and every conformance case, and embeds the table\n");
