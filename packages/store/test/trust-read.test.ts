import { rm } from "node:fs/promises";
import { join } from "node:path";
import { type FixtureRepo, makeFixtureRepo, removeTrustFile, writeTrustFile } from "@musai/test-support";
import { execa } from "execa";
import { afterEach, expect, test } from "vitest";
import { readTrustBranch } from "../src/config.js";

let repos: FixtureRepo[] = [];

afterEach(async () => {
  await Promise.all(repos.map((repo) => repo.cleanup()));
  repos = [];
});

async function freshRepo(scope: string): Promise<FixtureRepo> {
  const repo = await makeFixtureRepo(scope);
  repos.push(repo);
  return repo;
}

test("a trust branch reads each file's text at one commit, and a file it lacks as empty", async () => {
  const repo = await freshRepo("trust-read-absent");
  await writeTrustFile(repo.ctx, "audiences", "peer\nboard\n");
  await removeTrustFile(repo.ctx, "roles");

  const trust = await readTrustBranch(repo.ctx);

  expect(trust.roles).toBe("");
  expect(trust.audiences).toBe("peer\nboard\n");
  expect(trust.allowedSigners).toBe("");
  expect(trust.config.values).toEqual({});
});

test("a trust file the branch names but the repository no longer holds is refused, never read as empty", async () => {
  const repo = await freshRepo("trust-read-lost-object");
  await writeTrustFile(repo.ctx, "roles", "a role no other file holds\n");
  const { stdout: sha } = await execa("git", ["--git-dir", repo.ctx.gitDir, "rev-parse", "refs/heads/main:roles"]);
  await rm(join(repo.ctx.gitDir, "objects", sha.slice(0, 2), sha.slice(2)));

  await expect(readTrustBranch(repo.ctx)).rejects.toMatchObject({ reason: "workspace-incomplete", about: ["roles"] });
});

test("a trust branch without its configuration file is refused", async () => {
  const repo = await freshRepo("trust-read-no-config");
  await removeTrustFile(repo.ctx, "config.json");

  await expect(readTrustBranch(repo.ctx)).rejects.toMatchObject({
    reason: "workspace-incomplete",
    about: ["config.json"],
  });
});
