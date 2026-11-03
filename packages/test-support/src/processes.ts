import { readFile } from "node:fs/promises";

/** A zombie has ended: PID 1 in a container may never reap an orphan. */
export async function processRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "linux") {
    return true;
  }
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
  return stat !== "" && stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
}

export async function processEndedWithin(pid: number, ms: number): Promise<boolean> {
  for (const until = Date.now() + ms; Date.now() < until; ) {
    if (!(await processRunning(pid))) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}
