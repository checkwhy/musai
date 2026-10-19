import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MUSAI_DIR } from "@musai/store";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const CLI_PATH = fileURLToPath(new URL("../../dist/bin/cli.js", import.meta.url));

const ABSENT_RECORD = `sha256:${"0".repeat(64)}`;

interface Outcome {
  readonly exitCode: number;
  readonly stderr: string;
}

async function run(args: readonly string[], env: Record<string, string> = {}): Promise<Outcome> {
  const result = await execa("node", [CLI_PATH, ...args], { reject: false, env });
  return { exitCode: result.exitCode ?? -1, stderr: result.stderr };
}

describe("what a refusal exits with — against the built binary", () => {
  let workspace: string;
  let unconfigured: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-cli-exit-codes-"));
    await execa("node", [CLI_PATH, "init", workspace]);

    unconfigured = await mkdtemp(join(tmpdir(), "musai-cli-exit-codes-bare-"));
    await execa("node", [CLI_PATH, "init", unconfigured]);
    await execa("git", ["--git-dir", join(unconfigured, MUSAI_DIR), "update-ref", "-d", "refs/heads/main"]);
  }, 60_000);

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(unconfigured, { recursive: true, force: true });
  });

  test("a record the scope does not hold exits with the code that says to fix the invocation", async () => {
    const { exitCode, stderr } = await run(["--workspace", workspace, "why", ABSENT_RECORD]);

    expect(exitCode).toBe(2);
    expect(stderr).not.toContain("    at ");
  });

  test("a workspace whose trust branch is gone exits with the code that says to fix the workspace", async () => {
    const { exitCode, stderr } = await run(["--workspace", unconfigured, "lab", "book", "probe"]);

    expect(exitCode).toBe(3);
    expect(stderr).toContain("refusing to read workspace configuration");
    expect(stderr).not.toContain("    at ");
  });

  test("a write decided against a head the store never held exits with the code that says to re-fold and retry", async () => {
    const { exitCode } = await run(["--workspace", workspace, "--expect-head", "0".repeat(40), "lab", "book", "probe"]);

    expect(exitCode).toBe(4);
  });

  test("a refusal shows no stack even when a stack is asked for, since it names the next move itself", async () => {
    const quiet = await run(["--workspace", unconfigured, "lab", "book", "probe"]);
    const asked = await run(["--workspace", unconfigured, "lab", "book", "probe"], { MUSAI_DEBUG: "1" });

    expect(asked.stderr).toBe(quiet.stderr);
  });

  test("a directory holding no workspace exits with the code that says to fix the workspace", async () => {
    const nowhere = join(workspace, "not-a-workspace");
    const { exitCode, stderr } = await run(["--workspace", nowhere, "status", "x/y=1"]);

    expect(exitCode).toBe(3);
    expect(stderr).toContain(`\`init ${nowhere}\``);
    expect(stderr).not.toContain("    at ");
  });
});
