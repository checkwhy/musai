#!/usr/bin/env node
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The Check Run for a commit from `musai render --json`; it fails when a claim does not hold. */
export function checkRunOf(rendered, headSha) {
  const holding = rendered.claims.filter((claim) => claim.label === "holds").length;
  const conclusion =
    rendered.claims.length === 0 ? "neutral" : holding === rendered.claims.length ? "success" : "failure";
  return {
    name: "musai",
    head_sha: headSha,
    status: "completed",
    conclusion,
    output: { title: `${holding} of ${rendered.claims.length} claims hold`, summary: rendered.markdown },
  };
}

/** A refusal names the status alone, since a body may echo the request and its token. */
export async function postCheckRun(checkRun, { token, repository, apiUrl }, fetcher = fetch) {
  const response = await fetcher(`${apiUrl}/repos/${repository}/check-runs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
    },
    body: JSON.stringify(checkRun),
  });
  if (!response.ok) {
    throw new Error(`posting the Check Run was refused with ${response.status}`);
  }
}

async function musai(args, cwd) {
  const { stdout } = await run("musai", [...args, "--json"], { cwd, maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(stdout);
}

/** Each claim re-checked here first, so the Check Run reads this commit's tree, not the receipts'. */
async function main() {
  const cwd = process.env.WORKSPACE ?? ".";
  for (const claim of (await musai(["render"], cwd)).claims) {
    await run("musai", ["status", claim.short], { cwd }).catch(() => undefined);
  }
  const checkRun = checkRunOf(await musai(["render"], cwd), process.env.GITHUB_SHA);
  await postCheckRun(checkRun, {
    token: process.env.GITHUB_TOKEN,
    repository: process.env.GITHUB_REPOSITORY,
    apiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
  });
  process.stdout.write(`${checkRun.output.title}\n`);
  process.exitCode = checkRun.conclusion === "failure" ? 7 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
