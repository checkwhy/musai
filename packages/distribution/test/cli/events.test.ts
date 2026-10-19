import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixedClock, installEmptyModule, SCENARIO_INSTANT } from "@musai/test-support";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const CLI_PATH = fileURLToPath(new URL("../../dist/bin/cli.js", import.meta.url));
const now = fixedClock(SCENARIO_INSTANT);

const WIRE_EVENT_KINDS = [
  "claim.put",
  "case.booked",
  "ruling.made",
  "run.recorded",
  "attestation.made",
  "module.installed",
  "pin.changed",
];

describe("--events — against the built binary", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-cli-events-"));
    await execa("node", [CLI_PATH, "init", workspace]);
    await execa("node", [CLI_PATH, "lab", "book", "events-case", "--workspace", workspace]);
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("--events writes event lines to stderr and leaves stdout byte-identical to a run without the flag", async () => {
    const plain = await execa("node", [CLI_PATH, "lab", "progress", "events-case", "--workspace", workspace]);
    const withEvents = await execa("node", [
      CLI_PATH,
      "lab",

      "progress",
      "events-case",
      "--workspace",
      workspace,
      "--events",
    ]);

    expect(withEvents.stdout).toBe(plain.stdout);
    const lines = withEvents.stderr
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const event = JSON.parse(line) as { kind: string; about: string; at: string };
      expect(WIRE_EVENT_KINDS).toContain(event.kind);
      expect(typeof event.about).toBe("string");
      expect(typeof event.at).toBe("string");
    }
  });

  test("under --json and --events together, stdout holds only the operation's own canonical bytes and stderr holds the event lines", async () => {
    await installEmptyModule(workspace, "default", "events-cli-fixture", now);

    const { stdout, stderr } = await execa("node", [
      CLI_PATH,
      "lab",

      "progress",
      "events-case",
      "--workspace",
      workspace,
      "--events",
      "--json",
    ]);

    expect(() => JSON.parse(stdout)).not.toThrow();
    const parsedStdout = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsedStdout).not.toHaveProperty("events");

    const lines = stderr
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const event = JSON.parse(line) as { kind: string; about: string; at: string };
      expect(WIRE_EVENT_KINDS).toContain(event.kind);
    }
    expect(lines.some((line) => (JSON.parse(line) as { about: string }).about === "events-cli-fixture")).toBe(true);
  });

  test("musai lab log renders the same events under --json as a fresh events.since read", async () => {
    const { stdout } = await execa("node", [CLI_PATH, "lab", "log", "--workspace", workspace, "--json"]);
    const parsed = JSON.parse(stdout) as { events: readonly { kind: string; about: string }[] };
    expect(parsed.events.some((event) => event.about === "events-cli-fixture")).toBe(true);
  });
});
