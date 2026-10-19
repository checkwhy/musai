import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MUSAI_DIR } from "@musai/store";
import { derivationNodes } from "@musai/test-support";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const CLI_PATH = fileURLToPath(new URL("../../dist/bin/cli.js", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const CORE_MODULE = join(REPO_ROOT, "packages", "core-module");
const CASEBOOK = fileURLToPath(new URL("../../../scenarios/casebook/modules/casebook", import.meta.url));
const INSTANT = "2026-03-04T05:06:07.000Z";

interface Minted {
  readonly minted: readonly {
    readonly id: string;
    readonly kind: string;
    readonly record: { readonly slot?: string };
  }[];
}

interface Derivation {
  readonly label: string;
  readonly id: string;
  readonly decidedBy: string;
  readonly children: readonly Derivation[];
}

async function musai(args: readonly string[], workspace: string): Promise<string> {
  const { stdout } = await execa("node", [CLI_PATH, ...args, "--workspace", workspace, "--json"], {
    env: { ...process.env, MUSAI_NOW: INSTANT },
  });
  return stdout;
}

describe("MUSAI_NOW — against the built binary", () => {
  let first: string;
  let second: string;

  beforeAll(async () => {
    first = await mkdtemp(join(tmpdir(), "musai-clock-a-"));
    second = await mkdtemp(join(tmpdir(), "musai-clock-b-"));
    for (const workspace of [first, second]) {
      await execa("node", [CLI_PATH, "init", workspace], { env: { ...process.env, MUSAI_NOW: INSTANT } });
      await musai(["lab", "module", "build", CORE_MODULE, "--source-git-dir", join(REPO_ROOT, ".git")], workspace);
      await musai(["lab", "module", "build", CASEBOOK, "--source-git-dir", join(REPO_ROOT, ".git")], workspace);
    }
  }, 120_000);

  afterAll(async () => {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  });

  test("two workspaces initialised under one instant carry one scope head, committed at that instant", async () => {
    const parent = await mkdtemp(join(tmpdir(), "musai-clock-init-"));
    try {
      const heads: string[] = [];
      for (const name of ["a", "b"]) {
        const workspace = join(parent, name);
        await execa("node", [CLI_PATH, "init", workspace], { env: { ...process.env, MUSAI_NOW: INSTANT } });
        const { stdout } = await execa("git", [
          "--git-dir",
          join(workspace, MUSAI_DIR),
          "log",
          "-1",
          "--format=%H %cI",
          "refs/heads/scope/default",
        ]);
        const [head, committed] = stdout.trim().split(" ");
        // Git dates commits to the second, so only the date shows the pinned instant was used.
        expect(new Date(committed!).toISOString()).toBe(INSTANT);
        heads.push(head!);
      }
      expect(heads[0]).toBe(heads[1]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }, 120_000);

  test("a check performed in two workspaces under one instant mints the same receipt", async () => {
    const outputs: string[] = [];
    for (const workspace of [first, second]) {
      const booked = JSON.parse(
        await musai(["lab", "book", "clock-case", "--kind", "fixture-casebook/report"], workspace),
      ) as Minted;
      const check = booked.minted.find((item) => item.kind === "claim" && item.record.slot !== undefined);
      if (check === undefined || check.record.slot === undefined) {
        throw new Error("the booking minted no claim");
      }
      await musai(["status", check.record.slot], workspace);
      outputs.push(await musai(["why", check.record.slot, "--full"], workspace));
    }
    expect(outputs[0]).toBe(outputs[1]);
    const evidence = derivationNodes((JSON.parse(outputs[0]!) as { derivation: Derivation }).derivation).filter(
      (node) => node.label === "evidence",
    );
    expect(evidence.length).toBeGreaterThan(0);
  }, 120_000);

  test("a module built and tested in two workspaces under one instant has one module record id and one recorded test receipt", async () => {
    // A build receipt captures its source path, so one scratch directory is reused for both builds.
    const parent = await mkdtemp(join(tmpdir(), "musai-clock-module-"));
    const dir = join(parent, "clock-module");
    try {
      const ids: string[] = [];
      const receiptFiles: string[][] = [];
      for (const workspace of [first, second]) {
        await mkdir(dir, { recursive: true });
        await execa("node", [CLI_PATH, "lab", "module", "new", dir], { env: { ...process.env, MUSAI_NOW: INSTANT } });
        const built = JSON.parse(
          await musai(["lab", "module", "build", dir, "--source-git-dir", join(REPO_ROOT, ".git")], workspace),
        ) as { moduleRecordId: string };
        ids.push(built.moduleRecordId);
        // Deleting the scaffold's receipt makes this run the one that shows which clock reached it.
        await rm(join(dir, "records"), { recursive: true, force: true });
        await musai(["lab", "module", "test", dir, "--record"], workspace);
        const receipts = (await readdir(join(dir, "records", "run"), { recursive: true }))
          .filter((entry) => entry.endsWith(".json"))
          .sort();
        receiptFiles.push(receipts);
        await rm(dir, { recursive: true, force: true });
      }
      expect(ids[0]).toBe(ids[1]);
      expect(receiptFiles[0]!.length).toBeGreaterThan(0);
      expect(receiptFiles[0]).toEqual(receiptFiles[1]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }, 120_000);

  test("a case booked in two workspaces under one instant has one record id", async () => {
    const ids: string[] = [];
    for (const workspace of [first, second]) {
      const booked = JSON.parse(
        await musai(["lab", "book", "clock-case-2", "--kind", "fixture-casebook/report"], workspace),
      ) as Minted;
      const booking = booked.minted.find((item) => item.kind === "case");
      if (booking === undefined) {
        throw new Error("the booking minted no case");
      }
      ids.push(booking.id);
    }
    expect(ids[0]).toBe(ids[1]);
  }, 120_000);

  test("a brief rendered in two workspaces under one instant has one run id", async () => {
    const briefIds: string[] = [];
    for (const workspace of [first, second]) {
      await musai(["lab", "book", "clock-case-3", "--kind", "fixture-casebook/report"], workspace);
      const progress = JSON.parse(await musai(["lab", "progress", "clock-case-3"], workspace)) as {
        readonly next: { readonly gate: string; readonly class: string } | null;
      };
      if (progress.next === null) {
        throw new Error("the case has no gate to ask");
      }
      const asked = JSON.parse(await musai(["lab", "ask", progress.next.gate], workspace)) as {
        readonly brief: string;
      };
      briefIds.push(asked.brief);
    }
    expect(briefIds[0]).toBe(briefIds[1]);
  }, 120_000);
});

describe("a malformed MUSAI_NOW — against the built binary", () => {
  test("refuses `musai init` as a mistake in the invocation, naming the variable, before anything is written", async () => {
    const parent = await mkdtemp(join(tmpdir(), "musai-clock-malformed-"));
    const workspace = join(parent, "w");
    try {
      const result = await execa("node", [CLI_PATH, "init", workspace], {
        env: { ...process.env, MUSAI_NOW: "bogus" },
        reject: false,
      });

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("MUSAI_NOW");
      expect(result.stderr).toContain("bogus");
      await expect(stat(join(workspace, MUSAI_DIR))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }, 120_000);
});
