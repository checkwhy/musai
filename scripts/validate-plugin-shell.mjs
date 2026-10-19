#!/usr/bin/env node
import { access, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const pluginDir = join(repoRoot, "plugin");

const failures = [];

function fail(message) {
  failures.push(message);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function checkManifest() {
  const manifestPath = join(pluginDir, ".claude-plugin", "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const field of ["name", "version", "description", "author", "repository", "license"]) {
    if (!manifest[field]) {
      fail(`plugin.json is missing its own ${field} field`);
    }
  }
}

/** Resolved as the host does: the plugin's own directory, and the repository a session opens. */
function resolveTemplatedPath(raw) {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a placeholder Claude Code's plugin loader resolves, not a template
  const substituted = raw.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginDir).replaceAll("${CLAUDE_PROJECT_DIR}", repoRoot);
  return substituted.replaceAll(/^"|"$/g, "");
}

async function checkMcpRegistration() {
  const mcpPath = join(pluginDir, ".mcp.json");
  const mcp = JSON.parse(await readFile(mcpPath, "utf8"));
  const servers = mcp.mcpServers ?? {};
  const names = Object.keys(servers);
  if (names.length === 0) {
    fail(".mcp.json declares no server");
    return;
  }
  for (const name of names) {
    const server = servers[name];
    const args = Array.isArray(server.args) ? server.args : [];
    const entryArg = args.find(
      (arg) => typeof arg === "string" && arg.includes("packages/distribution/dist/bin/mcp.js"),
    );
    if (entryArg === undefined) {
      fail(`.mcp.json's own "${name}" server does not name packages/distribution/dist/bin/mcp.js`);
      continue;
    }
    const resolvedPath = resolve(resolveTemplatedPath(entryArg));
    if (!(await exists(resolvedPath))) {
      fail(`.mcp.json's own "${name}" server names ${resolvedPath}, which does not exist after a build`);
    }
  }
}

async function checkSkills() {
  const skillsDir = join(pluginDir, "skills");
  const entries = await readdir(skillsDir, { withFileTypes: true }).catch(() => []);
  const skillNamePattern = /`[a-z][a-z0-9]*(?:_[a-z0-9]+)+`/;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillPath = join(skillsDir, entry.name, "SKILL.md");
    if (!(await exists(skillPath))) {
      fail(`${entry.name} carries no SKILL.md`);
      continue;
    }
    const body = await readFile(skillPath, "utf8");
    if (!skillNamePattern.test(body)) {
      fail(`${entry.name}/SKILL.md names no tool or CLI verb in backticks`);
    }
  }
}

/** A hook command starts with one of the build's own executables or a runtime already required. */
const ALLOWED_HOOK_EXECUTABLES = new Set(["node"]);

async function checkHooks() {
  const hooksPath = join(pluginDir, "hooks", "hooks.json");
  const declared = JSON.parse(await readFile(hooksPath, "utf8"));
  const events = declared.hooks ?? declared;
  const eventNames = Object.keys(events);
  const allowedEvents = new Set(["SessionStart", "PreToolUse", "Stop", "SubagentStop"]);
  for (const eventName of eventNames) {
    if (!allowedEvents.has(eventName)) {
      fail(`hooks.json declares ${eventName}, outside the four events DESIGN.md names`);
    }
  }
  for (const [eventName, matchers] of Object.entries(events)) {
    for (const matcher of matchers) {
      for (const hook of matcher.hooks ?? []) {
        if (hook.type !== "command") {
          continue;
        }
        const command = hook.command;
        if (typeof command !== "string") {
          fail(`${eventName}'s own hook command is not the shell-command string the real host's schema requires`);
          continue;
        }
        if (/&&|;|\||`|\$\(/.test(command)) {
          fail(`${eventName}'s own hook command carries a shell operator: ${command}`);
          continue;
        }
        const firstToken = command.trim().split(/\s+/)[0];
        if (!ALLOWED_HOOK_EXECUTABLES.has(firstToken)) {
          fail(
            `${eventName}'s own hook command's first token is ${firstToken}, outside this repository's built executables or required runtimes`,
          );
        }
      }
    }
  }
}

async function checkNoScaffoldDirectories() {
  for (const name of ["agents", "commands"]) {
    if (await exists(join(pluginDir, name))) {
      fail(`plugin/${name} exists — a directory with nothing behind it is a scaffold, not shipped`);
    }
  }
}

await checkManifest();
await checkMcpRegistration();
await checkSkills();
await checkHooks();
await checkNoScaffoldDirectories();

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`plugin shell: ${failure}`);
  }
  process.exit(1);
}
console.log("plugin shell: manifest, registration, skills, hooks and directory shape all ok");
