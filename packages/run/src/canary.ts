import { KernelError, textOf } from "@musai/records";
import { performRecipe } from "./spawn.js";

/** Channels in report order. Descriptor inheritance is not one: the interpreter opens descriptors
 * of its own, so a leaked one cannot be told apart. */
export const CANARY_CHANNELS = ["home", "git-global-config", "git-config-value", "ssh-agent"] as const;

export type CanaryChannel = (typeof CANARY_CHANNELS)[number];

/** Distinct so a channel merely unreachable is never recorded as one the runner nulled. */
export const CHANNEL_STATUSES = ["absent", "denied", "present"] as const;

export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

export interface CanaryChannelResult {
  readonly channel: CanaryChannel;
  readonly status: ChannelStatus;
  /** What the probe saw, for a failure message; the golden never compares it. */
  readonly detail: string;
}

export interface CanaryReport {
  readonly channels: readonly CanaryChannelResult[];
}

/** Inline rather than a file beside this module, so the probe survives bundling unchanged. */
const PROBE_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { execFileSync } = require("node:child_process");

function classify(error) {
  if (!error) return "absent";
  if (error.code === "ENOENT") return "absent";
  return "denied";
}

function probeHome() {
  const home = process.env.HOME;
  if (!home) return { status: "absent", detail: "HOME is not set" };
  try {
    fs.readFileSync(path.join(home, ".gitconfig"), "utf8");
    return { status: "present", detail: "read a per-user git configuration file" };
  } catch (error) {
    return { status: classify(error), detail: String((error && error.message) || error) };
  }
}

function probeGitGlobalConfig() {
  const configPath = process.env.GIT_CONFIG_GLOBAL;
  if (!configPath) return { status: "absent", detail: "GIT_CONFIG_GLOBAL is not set" };
  try {
    fs.readFileSync(configPath, "utf8");
    return { status: "present", detail: "read the file GIT_CONFIG_GLOBAL names" };
  } catch (error) {
    return { status: classify(error), detail: String((error && error.message) || error) };
  }
}

function probeGitConfigValue() {
  try {
    const out = execFileSync("git", ["config", "--get", "user.name"], {
      env: process.env,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (out.length > 0) return { status: "present", detail: out };
    return { status: "absent", detail: "git reported no value" };
  } catch (error) {
    return { status: "absent", detail: "git config reported no value" };
  }
}

function probeSshAgent() {
  const sock = process.env.SSH_AUTH_SOCK;
  if (!sock) return Promise.resolve({ status: "absent", detail: "SSH_AUTH_SOCK is not set" });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (status, detail) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve({ status, detail });
    };
    const socket = net.createConnection(sock);
    socket.setTimeout(200);
    socket.on("connect", () => finish("present", "connected to the agent socket"));
    socket.on("timeout", () => finish("denied", "connection to the agent socket timed out"));
    socket.on("error", (error) => finish(classify(error), String((error && error.message) || error)));
  });
}

Promise.resolve(probeSshAgent()).then((sshAgent) => {
  const report = {
    home: probeHome(),
    "git-global-config": probeGitGlobalConfig(),
    "git-config-value": probeGitConfigValue(),
    "ssh-agent": sshAgent,
  };
  process.stdout.write(JSON.stringify(report));
});
`;

interface ProbeChannelResult {
  readonly status: ChannelStatus;
  readonly detail: string;
}

/** Runs the probe on the ordinary spawn path, so the canary proves the path callers use. */
export async function runCanary(): Promise<CanaryReport> {
  // Only the parsed output is read and it becomes no record, so no clock is passed.
  const { observation } = await performRecipe({
    command: ["node", "-e", PROBE_SCRIPT],
    workingDirectory: "/",
    environment: {},
    declared: [],
    substrates: [],
    isolation: "hygiene",
  });

  let parsed: Record<string, ProbeChannelResult>;
  try {
    parsed = JSON.parse(textOf(observation.output, "the canary's probe output")) as Record<string, ProbeChannelResult>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new KernelError({
      reason: "invalid-output",
      detail: `the canary's probe did not print a parseable report: ${detail}`,
    });
  }

  const channels: CanaryChannelResult[] = CANARY_CHANNELS.map((channel) => {
    const result = parsed[channel];
    if (result === undefined) {
      throw new KernelError({
        reason: "invalid-output",
        detail: `the canary's probe reported nothing for channel ${channel}`,
        about: [channel],
      });
    }
    return { channel, status: result.status, detail: result.detail };
  });

  return { channels };
}
