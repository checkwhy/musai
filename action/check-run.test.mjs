import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { checkRunOf, postCheckRun } from "./check-run.mjs";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../packages/distribution/dist/bin/cli.js", import.meta.url));
const COMMITTER = {
  GIT_AUTHOR_NAME: "musai",
  GIT_AUTHOR_EMAIL: "musai@example.invalid",
  GIT_COMMITTER_NAME: "musai",
  GIT_COMMITTER_EMAIL: "musai@example.invalid",
};

const HOLDS = { statement: "tests pass", label: "holds", reason: null, short: "aaaaaaaaaaaa" };
const STALE = { statement: "lint passes", label: "open", reason: "stale", short: "bbbbbbbbbbbb" };
const MARKDOWN =
  "- [x] ✓ tests pass · `true` — `musai why aaaaaaaaaaaa`\n- [ ] ◌ lint passes (stale) · `biome ci .` — `musai why bbbbbbbbbbbb`";

test("a Check Run fails when one claim does not hold, and lists each claim with its why", () => {
  const run = checkRunOf({ markdown: MARKDOWN, claims: [HOLDS, STALE] }, "c0ffee");

  assert.equal(run.name, "musai");
  assert.equal(run.head_sha, "c0ffee");
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "failure");
  assert.equal(run.output.title, "1 of 2 claims hold");
  assert.equal(run.output.summary, MARKDOWN);
});

test("a Check Run succeeds when every claim holds", () => {
  assert.equal(checkRunOf({ markdown: MARKDOWN, claims: [HOLDS] }, "c0ffee").conclusion, "success");
});

test("a Check Run names beside each checked claim's verdict the command that settled it", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "musai-check-run-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, ...COMMITTER };
  await writeFile(join(dir, "README.md"), "hello\n");
  await run("git", ["init", "--quiet", dir], { env });
  await run("git", ["-C", dir, "add", "README.md"], { env });
  await run("git", ["-C", dir, "commit", "--quiet", "--message", "hello"], { env });
  await run("node", [CLI, "init"], { cwd: dir, env });
  await run("node", [CLI, "check", "tests pass", "--", "true"], { cwd: dir, env });

  const { stdout } = await run("node", [CLI, "render", "--json"], { cwd: dir, env });
  const checkRun = checkRunOf(JSON.parse(stdout), "c0ffee");

  assert.match(checkRun.output.summary, /^- \[x\] ✓ tests pass · `true` — `musai why [0-9a-f]{12}`$/);
});

test("a workspace with no checked claim posts a neutral Check Run", () => {
  assert.equal(checkRunOf({ markdown: "No checked claims here yet", claims: [] }, "c0ffee").conclusion, "neutral");
});

test("posts to the repository's check runs with the token as a header, and never prints the token", async () => {
  const token = "ghs_secretsecretsecret";
  const sent = [];
  const fetcher = async (url, init) => {
    sent.push({ url, init });
    return new Response(JSON.stringify({ message: `Resource not accessible by integration ${token}` }), {
      status: 403,
    });
  };

  const refusal = await postCheckRun(
    checkRunOf({ markdown: MARKDOWN, claims: [HOLDS] }, "c0ffee"),
    { token, repository: "owner/repo", apiUrl: "https://api.github.test" },
    fetcher,
  ).then(
    () => assert.fail("a refused post resolved"),
    (error) => error,
  );

  assert.equal(sent[0].url, "https://api.github.test/repos/owner/repo/check-runs");
  assert.equal(sent[0].init.headers.authorization, `Bearer ${token}`);
  assert.match(refusal.message, /403/);
  assert.doesNotMatch(refusal.message, /ghs_secret/);
});
