import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { KernelError } from "@musai/records";
import { isToolName } from "./binaries.js";

/** In the workspace's local directory, never committed: what a program needs varies with how it
 * was installed, so one machine's launcher helpers are no other machine's. */
export const MACHINE_TOOLS_FILE = "tools.json";

/** The programs this machine adds to every run's PATH; absent, none. */
export async function readMachineTools(localDir: string): Promise<readonly string[]> {
  let raw: string;
  try {
    raw = await readFile(join(localDir, MACHINE_TOOLS_FILE), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return [];
    }
    throw refusal(`it could not be read (${code ?? "unknown error"})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw refusal("it is not JSON");
  }
  if (!Array.isArray(parsed) || !parsed.every(isToolName)) {
    throw refusal("it must be a list of program names, each without a path separator");
  }
  return parsed;
}

/** Names the file alone: the system's own message, and the directory, carry this machine's path. */
function refusal(reason: string): KernelError {
  return new KernelError({
    reason: "workspace-incomplete",
    detail: `refusing ${MACHINE_TOOLS_FILE}: ${reason}`,
    about: [MACHINE_TOOLS_FILE],
  });
}
