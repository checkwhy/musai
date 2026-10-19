#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = fileURLToPath(new URL("..", import.meta.url));
const windows = process.platform === "win32";
/** Run through a shell on Windows, where each is a `.cmd` shim rather than an executable. */
const SHIMS = new Set(["pnpm", "npm", "musai"]);
const STEP_TIMEOUT_MS = 180_000;
const STATEMENT = "the greeting says hello";
const COMMITTER = {
  GIT_AUTHOR_NAME: "Smoke",
  GIT_AUTHOR_EMAIL: "smoke@musai.invalid",
  GIT_COMMITTER_NAME: "Smoke",
  GIT_COMMITTER_EMAIL: "smoke@musai.invalid",
};

class SmokeFailure extends Error {}

function fail(reason) {
  throw new SmokeFailure(reason);
}

function run(command, args, options, expected = (status) => status === 0) {
  const ran = spawnSync(command, args, {
    encoding: "utf8",
    timeout: STEP_TIMEOUT_MS,
    shell: windows && SHIMS.has(command),
    ...options,
  });
  if (ran.error !== undefined) {
    fail(`${command} ${args[0]}: ${ran.error.message}`);
  }
  if (!expected(ran.status)) {
    const said = `${ran.stderr}${ran.stdout}`.trim().split("\n").at(-1);
    fail(`${command} ${args[0]} exited ${ran.status ?? ran.signal}: ${said}`);
  }
  return ran;
}

function expectOutput(ran, pattern, what) {
  if (!pattern.test(ran.stdout)) {
    fail(`${what} printed no ${pattern}: ${ran.stdout.trim().split("\n")[0]}`);
  }
}

function locate(program) {
  const name = windows ? `${program}.exe` : program;
  const dir = (process.env.PATH ?? "").split(delimiter).find((entry) => existsSync(join(entry, name)));
  return dir ?? fail(`${program} is not on PATH`);
}

/** A gzipped ustar's regular files; npm's own tarballs hold nothing else. */
function tarFiles(gzipped) {
  const tar = gunzipSync(gzipped);
  const text = (from, to) => tar.toString("utf8", from, to).replace(/\0.*$/s, "");
  const files = [];
  for (let at = 0; at + 512 <= tar.length && tar[at] !== 0; ) {
    const size = Number.parseInt(text(at + 124, at + 136).trim(), 8);
    const prefix = text(at + 345, at + 500);
    const name = text(at, at + 100);
    if (tar[at + 156] === 0x30 || tar[at + 156] === 0) {
      files.push({ path: prefix === "" ? name : `${prefix}/${name}`, body: tar.subarray(at + 512, at + 512 + size) });
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** The bundle is built inside the clone, so a path of it or of the builder's home is a leak. */
function inspect(tarball) {
  const files = tarFiles(readFileSync(tarball));
  if (!files.some((file) => file.path === "package/dist/bin/cli.js")) {
    fail("the tarball holds no package/dist/bin/cli.js");
  }
  const leaks = [root.replace(/[\\/]$/, ""), join(homedir(), "/"), "sourceMappingURL"];
  for (const { path, body } of files) {
    const leaked = leaks.find((needle) => body.includes(needle));
    if (leaked !== undefined) {
      fail(`${path} in the tarball names ${leaked}`);
    }
  }
}

function pack(scratch) {
  const pkg = join(root, "packages", "musai");
  if (!existsSync(join(pkg, "pack", "package.json"))) {
    fail("packages/musai/pack is not staged: run pnpm build first");
  }
  const destination = join(scratch, "tarball");
  run("pnpm", ["pack", "--pack-destination", destination], { cwd: pkg });
  const [packed] = readdirSync(destination).filter((file) => file.endsWith(".tgz"));
  return packed === undefined ? fail("pnpm pack wrote no tarball") : join(destination, packed);
}

function smoke(scratch) {
  const tarball = pack(scratch);
  inspect(tarball);

  const bin = join(scratch, "bin");
  run("go", ["build", "-o", join(bin, windows ? "musai-verify.exe" : "musai-verify"), "./cmd/musai-verify"], {
    cwd: join(root, "verify"),
  });

  const home = join(scratch, "home");
  const install = join(scratch, "install");
  const project = join(scratch, "project");
  for (const dir of [home, install, project]) {
    mkdirSync(dir);
  }
  const passed = windows ? ["SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP"] : [];
  // A stranger's machine: a home of its own, and no registry, since the package depends on nothing.
  const env = {
    ...Object.fromEntries(passed.map((name) => [name, process.env[name]])),
    PATH: [
      join(install, "node_modules", ".bin"),
      bin,
      dirname(process.execPath),
      locate("git"),
      locate("ssh-keygen"),
    ].join(delimiter),
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_NOSYSTEM: "1",
    npm_config_cache: join(home, "npm-cache"),
    npm_config_userconfig: join(home, ".npmrc"),
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
  };
  const stranger = (command, args, extra = {}, expected = undefined) =>
    run(command, args, { cwd: project, env: { ...env, ...extra } }, expected);

  const published = stranger("npm", ["publish", "--dry-run", tarball]);
  const corrected = published.stderr.split("\n").find((line) => /^npm warn publish (?!.*logged in)/.test(line));
  if (corrected !== undefined) {
    fail(`npm publish --dry-run: ${corrected}`);
  }
  stranger("npm", ["install", "--prefix", install, "--no-audit", "--no-fund", tarball]);

  stranger("git", ["init", "--quiet", "--initial-branch", "main"]);
  writeFileSync(join(project, "greeting.txt"), "hello\n");
  writeFileSync(
    join(project, "check.js"),
    'if (!require("node:fs").readFileSync("greeting.txt", "utf8").includes("hello")) process.exit(1);\n',
  );
  stranger("git", ["add", "."]);
  stranger("git", ["commit", "--quiet", "-m", "a project with one check"], COMMITTER);
  const key = join(scratch, "key");
  stranger("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "smoke", "-f", key]);

  stranger("musai", ["init", "--key", key]);
  const checked = JSON.parse(stranger("musai", ["check", STATEMENT, "--json", "--", "node", "check.js"]).stdout);
  if (checked.label !== "holds") {
    fail(`musai check judged the claim ${checked.label}: ${checked.reason}`);
  }
  expectOutput(stranger("musai", ["status", checked.short]), /holds/, "musai status");
  expectOutput(stranger("musai", ["why", checked.short]), /node check\.js · exit 0/, "musai why");
  const bundle = join(scratch, "bundle.tar.gz");
  stranger("musai", ["export", checked.short, "--to", "public", "--out", bundle, "--key", key]);
  expectOutput(stranger("musai-verify", ["verify", bundle]), / 0 errors/, "musai-verify verify");

  writeFileSync(join(project, "greeting.txt"), "goodbye\n");
  stranger("git", ["commit", "--quiet", "-am", "say goodbye"], COMMITTER);
  const moved = stranger("musai", ["status", checked.short, "--plan"], {}, (status) => status !== 0);
  expectOutput(moved, /stale/, "musai status --plan on a moved tree");
}

const scratch = mkdtempSync(join(tmpdir(), "musai-smoke-pack-"));
const started = Date.now();
try {
  smoke(scratch);
  const seconds = Math.round((Date.now() - started) / 1000);
  process.stdout.write(`smoke-pack: packed, installed, checked, exported and verified in ${seconds}s\n`);
} catch (error) {
  process.stderr.write(`smoke-pack: ${error instanceof SmokeFailure ? error.message : error}\n`);
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
