import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processEndedWithin, processRunning } from "@musai/test-support";
import { execa } from "execa";
import { afterEach, describe, expect, test } from "vitest";
import {
  type ListedProcess,
  ProcessTableError,
  procTable,
  psTable,
  readProcessTable,
  signalListed,
} from "../src/process-table.js";
import { treeKillerScript } from "../src/spawn.js";

describe.skipIf(process.platform === "win32")("the process table a run's descendants are listed from", () => {
  const started: number[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const pid of started.splice(0)) {
      if (await processRunning(pid)) {
        process.kill(pid, "SIGKILL");
      }
    }
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /** A process waiting forever, as the table lists it. */
  function lingering(): ListedProcess {
    const { pid } = execa(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { reject: false, env: {} });
    started.push(pid!);
    return readProcessTable().get(pid!)!;
  }

  async function exitedPid(): Promise<number> {
    const done = execa(process.execPath, ["-e", ""], { env: {} });
    await done;
    return done.pid!;
  }

  test("lists this process under its parent", () => {
    expect(readProcessTable().get(process.pid)?.parent).toBe(process.ppid);
  });

  test("ps at its fixed path lists this process under its parent, with no PATH to search", () => {
    expect(psTable("/bin/ps").get(process.pid)?.parent).toBe(process.ppid);
  });

  test.skipIf(process.platform !== "linux")("/proc lists this process under its parent", () => {
    expect(procTable("/proc").get(process.pid)?.parent).toBe(process.ppid);
  });

  test("a ps that cannot be run is refused by its path, never read as an empty table", () => {
    expect(() => psTable("/nonexistent/ps")).toThrow(ProcessTableError);
    expect(() => psTable("/nonexistent/ps")).toThrow("/nonexistent/ps");
  });

  test("a process directory that cannot be read is refused by its path, never read as an empty table", () => {
    expect(() => procTable("/nonexistent/proc")).toThrow(ProcessTableError);
    expect(() => procTable("/nonexistent/proc")).toThrow("/nonexistent/proc");
  });

  test("a process directory that lists no process is refused, since it holds no table", () => {
    expect(() => procTable("/")).toThrow(ProcessTableError);
  });

  test("a process entry whose stat cannot be read is refused as the table's, whatever the read error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "musai-proc-"));
    dirs.push(dir);
    await mkdir(join(dir, String(process.pid), "stat"), { recursive: true });

    expect(() => procTable(dir)).toThrow(ProcessTableError);
    expect(() => procTable(dir)).toThrow(join(dir, String(process.pid), "stat"));
  });

  test("a listed process is signalled only while its start time is the one listed", async () => {
    const entry = lingering();

    expect(signalListed({ ...entry, started: "0" }, "SIGKILL")).toBe(false);
    expect(await processRunning(entry.pid)).toBe(true);
    expect(signalListed(entry, "SIGKILL")).toBe(true);
    expect(await processEndedWithin(entry.pid, 2000)).toBe(true);
  });

  test("the detached killer leaves a listed pid whose start time is no longer the one listed", async () => {
    const entry = lingering();
    const script = treeKillerScript(await exitedPid(), [{ ...entry, started: "0" }], 200);
    await execa(process.execPath, ["-e", script], { env: {}, timeout: 5000 });

    expect(await processRunning(entry.pid)).toBe(true);
  });

  test("the detached killer ends a listed pid whose start time is still the one listed", async () => {
    const entry = lingering();
    const script = treeKillerScript(await exitedPid(), [entry], 200);
    await execa(process.execPath, ["-e", script], { env: {}, timeout: 5000 });

    expect(await processEndedWithin(entry.pid, 2000)).toBe(true);
  });
});
