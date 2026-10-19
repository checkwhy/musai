import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "@musai/mcp";
import { initWorkspace } from "@musai/store";
import { fixedClock, makeCheckout } from "@musai/test-support";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, onTestFinished, test } from "vitest";
import { MUSAI_MCP } from "../../src/mcp/extension.js";
import { MUSAI } from "../../src/musai.js";

const CLI_PATH = fileURLToPath(new URL("../../dist/bin/cli.js", import.meta.url));

const PUBLIC_VERBS = ["check", "doctor", "export", "init", "render", "rerun", "status", "why"];

const START_LINE = MUSAI.startHere ?? "";

/** A command line's arguments as a shell splits them, double quotes holding one together. */
function argumentsOf(line: string): string[] {
  return [...line.replace(/, then\s*$/, "").matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2]!);
}

/** The command names a help text lists under its `Commands:` heading. */
function commandsListed(help: string): string[] {
  const listed = help.split("Commands:")[1] ?? "";
  return listed
    .split("\n")
    .map((line) => /^ {2}(\S+)/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined && name !== "help");
}

describe("the surface a stranger meets first", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-cli-surface-"));
    await initWorkspace(workspace, { now: fixedClock("2026-10-01T00:00:00.000Z") });
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("the bare CLI lists the public verbs, lab and a start line", async () => {
    const { stdout, stderr } = await execa("node", [CLI_PATH], { reject: false });
    const help = stdout + stderr;

    expect(commandsListed(help).sort()).toEqual([...PUBLIC_VERBS, "lab"].sort());
    expect(help).toContain(START_LINE);
  });

  test("the CLI names itself by the binary a stranger types, and its start line uses that name", async () => {
    const { stdout, stderr } = await execa("node", [CLI_PATH], { reject: false });

    expect(stdout + stderr).toMatch(/^Usage: musai /m);
    expect(START_LINE).toMatch(/^Start here: musai init, then musai check /);
  });

  test("check's help says what a tool is", async () => {
    const { stdout } = await execa("node", [CLI_PATH, "check", "--help"]);

    expect(stdout).toMatch(/--tool <value> +a program the command reaches for by name/);
  });

  test("the start line holds in a fresh project whose tests pass", async () => {
    const project = await mkdtemp(join(tmpdir(), "musai-start-line-"));
    onTestFinished(() => rm(project, { recursive: true, force: true }));
    await execa("git", ["init", "--quiet", project]);
    await writeFile(join(project, "passes.test.mjs"), 'import test from "node:test";\ntest("passes", () => {});\n');
    await execa("git", ["-C", project, "add", "-A"]);
    await execa("git", ["-C", project, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "t"]);
    const musai = (args: string[]) => execa("node", [CLI_PATH, ...args], { cwd: project, reject: false });

    const [init, check] = START_LINE.split("musai ").slice(1).map(argumentsOf);

    await musai(init!);
    const checked = await musai(check!);

    expect(checked.exitCode, checked.stdout + checked.stderr).toBe(0);
  }, 120_000);

  test("a lab verb answers under lab, nested groups included", async () => {
    const listed = await execa("node", [CLI_PATH, "lab", "key", "list", "--workspace", workspace]);
    const help = await execa("node", [CLI_PATH, "lab", "--help"]);

    expect(listed.exitCode).toBe(0);
    expect(commandsListed(help.stdout)).toEqual(expect.arrayContaining(["book", "module", "key", "soundcheck"]));
  });

  test("--version prints the distribution's version", async () => {
    const { stdout } = await execa("node", [CLI_PATH, "--version"]);

    expect(stdout.trim()).toBe(MUSAI.version);
  });

  test("help names each argument once", async () => {
    const { stdout } = await execa("node", [CLI_PATH, "status", "--help"]);

    expect(stdout).not.toMatch(/claim\s+claim/);
  });

  test("MCP lists the public verbs by default, and every tool when started for lab", async () => {
    const context = { workspace, scope: "default", now: fixedClock("2026-10-01T00:00:00.000Z") };
    const listed = async (lab: boolean): Promise<string[]> => {
      const server = createMcpServer(MUSAI_MCP, context, { lab });
      const client = new Client({ name: "surface-client", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        return (await client.listTools()).tools.map((tool) => tool.name);
      } finally {
        await client.close();
      }
    };

    const publicTools = await listed(false);
    const labTools = await listed(true);

    expect(publicTools.sort()).toEqual(
      [
        "bundle_export",
        "bundle_rerun",
        "check_run",
        "claim_status",
        "claim_why",
        "doctor_run",
        "render_markdown",
        "workspace_init",
      ].sort(),
    );
    expect(labTools).toEqual(expect.arrayContaining([...publicTools, "case_book", "gate_answer"]));
  });

  test("a verb that runs a module prints no warning about the type stripping it compiles with", async () => {
    const checkout = await makeCheckout("hello");
    onTestFinished(() => checkout.cleanup());
    await execa("node", [CLI_PATH, "init", checkout.dir]);
    const { stderr } = await execa("node", [
      CLI_PATH,
      "check",
      "--workspace",
      checkout.dir,
      "node runs",
      "--",
      "node",
      "-e",
      "",
    ]);

    expect(stderr).not.toContain("ExperimentalWarning");
  });

  test("check takes a rule in place of a command, and names the rules there are when none answers", async () => {
    const checkout = await makeCheckout("hello");
    onTestFinished(() => checkout.cleanup());
    await execa("node", [CLI_PATH, "init", checkout.dir]);

    const { stderr, exitCode } = await execa(
      "node",
      [CLI_PATH, "check", "--workspace", checkout.dir, "x", "--rule", "nobody/ships-this"],
      { reject: false },
    );

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("no installed module contributes nobody/ships-this");
    expect(stderr).toContain("the rules installed here: none");
  });

  test("why --plan names the tree that moved and runs nothing", async () => {
    const checkout = await makeCheckout("hello");
    onTestFinished(() => checkout.cleanup());
    const cli = (args: readonly string[]) => execa("node", [CLI_PATH, ...args, "--workspace", checkout.dir]);
    await cli(["init", checkout.dir]);
    await execa("node", [CLI_PATH, "check", "--workspace", checkout.dir, "node runs", "--", "node", "-e", ""]);
    const runs = (
      await execa("git", ["--git-dir", join(checkout.dir, ".musai"), "rev-parse", "refs/heads/scope/default"])
    ).stdout;

    await writeFile(join(checkout.dir, "tracked.txt"), "moved");
    const { stdout } = await cli(["why", "node runs", "--plan"]);
    const after = (
      await execa("git", ["--git-dir", join(checkout.dir, ".musai"), "rev-parse", "refs/heads/scope/default"])
    ).stdout;

    expect(stdout).toContain("the working tree `tree` moved");
    expect(after).toBe(runs);
  });
});
