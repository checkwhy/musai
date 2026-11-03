import { execa } from "execa";

/** The arguments bash splits `line` into, pasted after `set --`, running none of them; bash, as the
 * dash many systems link as `sh` may predate POSIX.1-2024's `$'…'`. */
export async function splitByShell(line: string): Promise<string[]> {
  const { stdout } = await execa("bash", ["-c", `set -- ${line}; printf '%s\\0' "$@"`], { stripFinalNewline: false });
  return stdout.split("\0").slice(0, -1);
}
