#!/usr/bin/env node
import { exitCodeForClass } from "@musai/records";
import { oldNodeRefusal } from "../node-version.js";

// Loaded only once the version is known, since an older Node fails linking them.
const refusal = oldNodeRefusal(process.versions.node);
if (refusal === null) {
  const [{ runMcpServer }, { MUSAI_MCP }] = await Promise.all([import("@musai/mcp"), import("../mcp/extension.js")]);
  await runMcpServer(MUSAI_MCP, process.argv.slice(2));
} else {
  process.stderr.write(`${refusal}\n`);
  process.exitCode = exitCodeForClass("requirement");
}
