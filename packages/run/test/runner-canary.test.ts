import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, test } from "vitest";
import { CANARY_CHANNELS, runCanary } from "../src/canary.js";
import { performRecipe } from "../src/spawn.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
  delete process.env["HOME"];
});

describe("runCanary: one status per channel, in a fixed order, through the shared spawn path", () => {
  test("with nothing planted, the canary still reports a status for every channel it probes", async () => {
    const report = await runCanary();
    expect(report.channels).toHaveLength(CANARY_CHANNELS.length);
    expect(report.channels.map((entry) => entry.channel)).toEqual([...CANARY_CHANNELS]);
    for (const entry of report.channels) {
      expect(["absent", "denied", "present"]).toContain(entry.status);
    }
  });

  test("the probe reports only channels it can tell apart from what its own interpreter opened", async () => {
    const report = await runCanary();
    expect(report.channels.map((entry) => entry.channel)).toEqual([
      "home",
      "git-global-config",
      "git-config-value",
      "ssh-agent",
    ]);
  });
});

describe("each ambient channel is planted in the parent and reached for by the child on the real spawn path", () => {
  test("a home directory holding a readable per-user git configuration is not seen by the child", async () => {
    const home = await mkdtemp(join(tmpdir(), "musai-canary-home-"));
    cleanups.push(async () => rm(home, { recursive: true, force: true }));
    await writeFile(join(home, ".gitconfig"), "[user]\n\tname = leaked\n");
    process.env["HOME"] = home;

    const report = await runCanary();
    const homeChannel = report.channels.find((entry) => entry.channel === "home")!;
    const gitGlobalConfigChannel = report.channels.find((entry) => entry.channel === "git-global-config")!;
    expect(homeChannel.status).toBe("absent");
    expect(gitGlobalConfigChannel.status).toBe("absent");
  });

  test("a value set in the invoking process's own global git configuration is not seen by the child", async () => {
    const home = await mkdtemp(join(tmpdir(), "musai-canary-gitconfig-"));
    cleanups.push(async () => rm(home, { recursive: true, force: true }));
    process.env["HOME"] = home;
    await execa("git", ["config", "--global", "user.name", "leaked-value"], {
      env: { ...process.env, HOME: home },
    });

    const report = await runCanary();
    const channel = report.channels.find((entry) => entry.channel === "git-config-value")!;
    expect(channel.status).toBe("absent");
  });

  test("an agent socket named by the invoking process's own environment is not reachable by the child", async () => {
    // A Unix socket path is capped near 104 bytes, and a hygienic TMPDIR can take most of that.
    const socketRoot = process.platform === "win32" ? tmpdir() : "/tmp";
    const socketDir = await mkdtemp(join(socketRoot, "musai-canary-ssh-"));
    cleanups.push(async () => rm(socketDir, { recursive: true, force: true }));
    const socketPath = join(socketDir, "agent.sock");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    cleanups.push(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const previous = process.env["SSH_AUTH_SOCK"];
    process.env["SSH_AUTH_SOCK"] = socketPath;
    cleanups.push(async () => {
      if (previous === undefined) {
        delete process.env["SSH_AUTH_SOCK"];
      } else {
        process.env["SSH_AUTH_SOCK"] = previous;
      }
    });

    const report = await runCanary();
    const channel = report.channels.find((entry) => entry.channel === "ssh-agent")!;
    expect(channel.status).toBe("absent");
  });
});

describe("a receipt's isolationHeld reads from what the canary proved, not from what was declared", () => {
  const recipe = {
    command: ["true"],
    workingDirectory: "/",
    environment: {},
    declared: [],
    substrates: [],
    isolation: "hygiene" as const,
  };

  test("every channel nulled: isolationHeld matches the declared level", async () => {
    const { observation } = await performRecipe(recipe, {
      hygieneProof: { channels: [{ status: "absent" }, { status: "absent" }] },
    });
    expect(observation.isolationHeld).toBe("hygiene");
  });

  test("a channel that answered present: isolationHeld reads none while the recipe still declares hygiene", async () => {
    const { recipe: recordedRecipe, observation } = await performRecipe(recipe, {
      hygieneProof: { channels: [{ status: "absent" }, { status: "present" }] },
    });
    expect(recordedRecipe.isolation).toBe("hygiene");
    expect(observation.isolationHeld).toBe("none");
  });
});
