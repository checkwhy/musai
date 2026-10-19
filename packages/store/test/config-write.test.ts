import { type FixtureRepo, fixedClock, makeFixtureRepo } from "@musai/test-support";
import { execaSync } from "execa";
import { afterEach, expect, test } from "vitest";
import { readTrustBranch, writeMainFiles } from "../src/config.js";

const now = fixedClock("2026-10-01T00:00:00.000Z");
let repos: FixtureRepo[] = [];

afterEach(async () => {
  await Promise.all(repos.map((repo) => repo.cleanup()));
  repos = [];
});

test("a trust file rebuilt from the tip keeps what another writer wrote between the read and the swap", async () => {
  const repo = await makeFixtureRepo("config-write-race");
  repos.push(repo);
  const read = await writeMainFiles(repo.ctx, { "config.json": `${JSON.stringify({ tools: ["a"] })}\n` }, now);
  const other = await writeMainFiles(repo.ctx, { "config.json": `${JSON.stringify({ tools: ["a", "b"] })}\n` }, now);
  const git = (...args: string[]) => execaSync("git", ["--git-dir", repo.ctx.gitDir, ...args]);
  git("update-ref", "refs/heads/main", read);
  let calls = 0;

  await writeMainFiles(
    repo.ctx,
    {
      "config.json": (current) => {
        calls += 1;
        if (calls === 1) {
          git("update-ref", "refs/heads/main", other);
        }
        const tools = (JSON.parse(current ?? "{}") as { tools: string[] }).tools;
        return `${JSON.stringify({ tools: [...tools, "c"] })}\n`;
      },
    },
    now,
  );

  expect((await readTrustBranch(repo.ctx)).config.values["tools"]).toEqual(["a", "b", "c"]);
});
