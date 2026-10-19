#!/usr/bin/env node
import { exitCodeForClass } from "@musai/records";
import { oldNodeRefusal } from "../node-version.js";

// Loaded only once the version is known, since an older Node fails linking them.
const refusal = oldNodeRefusal(process.versions.node);
if (refusal === null) {
  const [{ runCli }, { MUSAI }] = await Promise.all([import("@musai/cli"), import("../musai.js")]);
  await runCli(MUSAI, process.argv);
} else {
  process.stderr.write(`${refusal}\n`);
  process.exitCode = exitCodeForClass("requirement");
}
