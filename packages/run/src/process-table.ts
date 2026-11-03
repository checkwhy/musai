import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KernelError } from "@musai/records";
import { execaSync } from "execa";

/** Where this platform's processes are listed: Linux's `/proc`, which needs no binary, else the
 * `ps` every macOS and BSD base system installs at `/bin/ps`, so no search path decides it. */
export const PROCESS_TABLE = process.platform === "linux" ? "/proc" : "/bin/ps";

export class ProcessTableError extends KernelError {
  constructor(detail: string) {
    super({ reason: "tool-unavailable", detail });
    this.name = "ProcessTableError";
  }
}

/** A process as a listing saw it; its start time tells it from a later process given its pid. */
export interface ListedProcess {
  readonly pid: number;
  readonly parent: number;
  readonly started: string;
}

/** The start time the process table records for `pid`, or undefined once no process has it. It
 * imports nothing and names no binding outside it, since the detached killer runs its source. */
export function startTimeOf(pid: number): string | undefined {
  try {
    if (process.platform === "linux") {
      const stat = process.getBuiltinModule("node:fs").readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    }
    const listed = process
      .getBuiltinModule("node:child_process")
      .execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { env: {}, encoding: "utf8" })
      .trim();
    return listed === "" ? undefined : listed;
  } catch {
    return undefined;
  }
}

function unreadable(path: string, error: unknown): ProcessTableError {
  return new ProcessTableError(
    `the process table ${path} cannot be read (${(error as NodeJS.ErrnoException).code ?? "no error code"})`,
  );
}

/** A listing without the process reading it is no table, whatever it parsed to. */
function holdingThisProcess(table: Map<number, ListedProcess>, path: string): Map<number, ListedProcess> {
  if (!table.has(process.pid)) {
    throw new ProcessTableError(`the process table ${path} does not list the process reading it`);
  }
  return table;
}

function entryOf(path: string, pid: number, parent: number, started: string | undefined): ListedProcess {
  if (!Number.isInteger(parent) || started === undefined || started === "") {
    throw new ProcessTableError(`the process table ${path} lists process ${pid} in a form it cannot read`);
  }
  return { pid, parent, started };
}

/** Each process with its parent and start time, read from a procfs mounted at `dir`. */
export function procTable(dir: string): Map<number, ListedProcess> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    throw unreadable(dir, error);
  }
  const table = new Map<number, ListedProcess>();
  for (const entry of entries.filter((name) => /^\d+$/.test(name))) {
    const path = join(dir, entry, "stat");
    let stat: string;
    try {
      stat = readFileSync(path, "utf8");
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      // A process can exit between the listing and the read.
      if (code === "ENOENT" || code === "ESRCH") {
        continue;
      }
      throw unreadable(path, error);
    }
    // The command name is parenthesised and may hold spaces; the fields after it are numbered.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    table.set(Number(entry), entryOf(dir, Number(entry), Number(fields[1]), fields[19]));
  }
  return holdingThisProcess(table, dir);
}

/** Each process with its parent and start time, listed by the `ps` at `path`. */
export function psTable(path: string): Map<number, ListedProcess> {
  const listing = execaSync(path, ["-A", "-o", "pid=", "-o", "ppid=", "-o", "lstart="], {
    reject: false,
    env: {},
    extendEnv: false,
  });
  if (listing.failed) {
    throw new ProcessTableError(
      `the process table ${path} could not be listed (${listing.code ?? `exit ${listing.exitCode}`})`,
    );
  }
  const table = new Map<number, ListedProcess>();
  for (const line of listing.stdout.split("\n").filter((row) => row.trim() !== "")) {
    const [, pid, parent, started] = /^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line) ?? [];
    if (pid === undefined) {
      throw new ProcessTableError(`the process table ${path} lists a line it cannot read`);
    }
    table.set(Number(pid), entryOf(path, Number(pid), Number(parent), started));
  }
  return holdingThisProcess(table, path);
}

/** This machine's process table, from `PROCESS_TABLE`. */
export function readProcessTable(): ReadonlyMap<number, ListedProcess> {
  return process.platform === "linux" ? procTable(PROCESS_TABLE) : psTable(PROCESS_TABLE);
}

/** Every process descending from `root` by parent link, which a `setsid` leaves the group but not;
 * one already reparented away is beyond reach. Windows' `taskkill /T` walks the same links. */
export function descendantsOf(root: number): ListedProcess[] {
  if (process.platform === "win32") {
    return [];
  }
  const children = new Map<number, ListedProcess[]>();
  for (const entry of readProcessTable().values()) {
    const siblings = children.get(entry.parent);
    if (siblings === undefined) {
      children.set(entry.parent, [entry]);
    } else {
      siblings.push(entry);
    }
  }
  const found: ListedProcess[] = [];
  for (
    let next = children.get(root) ?? [];
    next.length > 0;
    next = next.flatMap((entry) => children.get(entry.pid) ?? [])
  ) {
    found.push(...next);
  }
  return found;
}

/** A target already gone is ESRCH and another user's is EPERM: neither is the run's to end. */
export function signalIfLive(target: number, signal: NodeJS.Signals): void {
  try {
    process.kill(target, signal);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code !== "ESRCH" && code !== "EPERM") {
      throw error;
    }
  }
}

/** Signals a listed process while it is still the one listed, never a later one given its pid. */
export function signalListed(entry: ListedProcess, signal: NodeJS.Signals): boolean {
  if (startTimeOf(entry.pid) !== entry.started) {
    return false;
  }
  signalIfLive(entry.pid, signal);
  return true;
}
