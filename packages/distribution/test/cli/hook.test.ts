import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const CLI_PATH = fileURLToPath(new URL("../../dist/bin/cli.js", import.meta.url));

describe("lab hook stop — against the built binary, as Claude Code calls it", () => {
  let workspace: string;
  let transcript: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-cli-hook-"));
    await execa("node", [CLI_PATH, "init", workspace]);
    transcript = join(workspace, "transcript.jsonl");
    await writeFile(
      transcript,
      [
        { type: "user", timestamp: "2026-10-05T12:00:00.000Z", message: { role: "user", content: "go" } },
        {
          type: "assistant",
          timestamp: "2026-10-05T12:01:00.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "All tests pass." }] },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
    );
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  function stop(payload: string): ReturnType<typeof execa> {
    return execa("node", [CLI_PATH, "lab", "hook", "stop", "--workspace", workspace, "--input", "-", "--json"], {
      input: payload,
      reject: false,
    });
  }

  test("reads the hook's payload on standard input and prints the block decision, exiting 0", async () => {
    const result = await stop(JSON.stringify({ transcript_path: transcript, stop_hook_active: false }));

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(String(result.stdout))).toMatchObject({ decision: "block" });
  });

  test("prints an empty decision with stop_hook_active", async () => {
    const result = await stop(JSON.stringify({ transcript_path: transcript, stop_hook_active: true }));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("{}");
  });

  test("refuses a payload that is not JSON as the caller's to fix", async () => {
    const result = await stop("not json");

    expect(result.exitCode).toBe(2);
    expect(String(result.stderr)).toContain("standard input is not JSON");
  });
});
