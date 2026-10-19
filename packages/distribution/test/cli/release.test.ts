import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RecordId, recordPath } from "@musai/records";
import { generateTestKey, pseudonymOf, type TestKey } from "@musai/test-support";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { bookAndRule, musai, musaiJson, type SignedWorkspace, signedWorkspace } from "./signed-workspace.js";

interface Released {
  readonly minted: { id: string; kind: string }[];
  readonly unchanged: number;
}

const BYSTANDER = "bystander@example.test";
const KEYLESS_OWNER = "keyless-owner@example.test";

describe("a release is a signed attestation that a record may leave the machine", () => {
  let key: TestKey;
  const workspaces: SignedWorkspace[] = [];

  async function fresh(name: string, signing = "person"): Promise<SignedWorkspace> {
    const workspace = await signedWorkspace(
      name,
      key,
      `${key.principal} owner any\n${pseudonymOf(KEYLESS_OWNER)} owner any\n${pseudonymOf(BYSTANDER)} delegate any\n`,
      signing,
    );
    workspaces.push(workspace);
    return workspace;
  }

  async function sidecars(workspace: SignedWorkspace): Promise<number> {
    const { stdout } = await execa("git", [
      "--git-dir",
      workspace.gitDir,
      "ls-tree",
      "-r",
      "--name-only",
      "refs/heads/scope/default",
    ]);
    return stdout.split("\n").filter((path) => path.endsWith(".sig")).length;
  }

  beforeAll(async () => {
    key = await generateTestKey("operator");
  }, 60_000);

  afterAll(async () => {
    await rm(key.dir, { recursive: true, force: true });
    for (const workspace of workspaces) {
      await rm(workspace.dir, { recursive: true, force: true });
    }
  });

  async function attestationOf(workspace: SignedWorkspace, id: string): Promise<Record<string, unknown>> {
    const { stdout } = await execa("git", [
      "--git-dir",
      workspace.gitDir,
      "show",
      `refs/heads/scope/default:${recordPath("attestation", id as RecordId)}`,
    ]);
    return JSON.parse(stdout) as Record<string, unknown>;
  }

  test("a closure release mints one attestation whatever the closure's size", async () => {
    const workspace = await fresh("release-closure");
    const { ruling } = await bookAndRule(workspace, "release-closure", key);
    const signedBefore = await sidecars(workspace);

    const released = await musaiJson<Released>(workspace, [
      "lab",
      "release",
      ruling,
      "--to",
      "known",
      "--closure",
      "--key",
      key.keyPath,
    ]);

    expect(released.minted).toHaveLength(1);
    expect(await sidecars(workspace)).toBe(signedBefore + 1);
    expect(await attestationOf(workspace, released.minted[0]!.id)).toMatchObject({
      subject: ruling,
      purpose: "released",
      audience: "known",
      extent: "closure",
      terms: { form: "bytes", uses: ["review", "cite"], from: null, until: null, marking: null },
    });
  }, 120_000);

  test("releasing twice to one audience with the same terms mints nothing the second time", async () => {
    const workspace = await fresh("release-once");
    const { ruling } = await bookAndRule(workspace, "release-once", key);
    const args = ["lab", "release", ruling, "--to", "public", "--for", "cite,review", "--key", key.keyPath];

    expect((await musaiJson<Released>(workspace, args)).minted).toHaveLength(1);
    expect(await musaiJson<Released>(workspace, args)).toEqual({ minted: [], unchanged: 1 });
  }, 120_000);

  test("releasing to one audience with new terms supersedes the standing release", async () => {
    const workspace = await fresh("release-terms");
    const { ruling } = await bookAndRule(workspace, "release-terms", key);
    const first = await musaiJson<Released>(workspace, [
      "lab",
      "release",
      ruling,
      "--to",
      "public",
      "--key",
      key.keyPath,
    ]);

    const widened = await musaiJson<Released>(workspace, [
      "lab",
      "release",
      ruling,
      "--to",
      "public",
      "--for",
      "review,cite,republish",
      "--marking",
      "spdx:CC-BY-4.0",
      "--key",
      key.keyPath,
    ]);

    expect(await attestationOf(workspace, widened.minted[0]!.id)).toMatchObject({
      supersedes: [first.minted[0]!.id],
      terms: { uses: ["review", "cite", "republish"], marking: "spdx:CC-BY-4.0" },
    });
  }, 120_000);

  test("revoking one audience leaves a release to a wider audience standing", async () => {
    const workspace = await fresh("release-revoke");
    const { ruling } = await bookAndRule(workspace, "release-revoke", key);
    await musaiJson(workspace, ["lab", "release", ruling, "--to", "known", "--closure", "--key", key.keyPath]);
    const peer = await musaiJson<Released>(workspace, [
      "lab",
      "release",
      ruling,
      "--to",
      "peer",
      "--closure",
      "--key",
      key.keyPath,
    ]);

    const revoked = await musaiJson<Released>(workspace, [
      "lab",
      "revoke",
      ruling,
      "--to",
      "peer",
      "--key",
      key.keyPath,
    ]);
    expect(await attestationOf(workspace, revoked.minted[0]!.id)).toMatchObject({
      purpose: "revoked",
      supersedes: [peer.minted[0]!.id],
    });
    expect(
      await musaiJson<Released>(workspace, ["lab", "revoke", ruling, "--to", "peer", "--key", key.keyPath]),
    ).toEqual({ minted: [], unchanged: 1 });

    const out = join(tmpdir(), `musai-release-revoke-${process.pid}.tar.gz`);
    const exported = await musaiJson<{ released: string | null }>(workspace, [
      "export",
      ruling,
      "--to",
      "peer",
      "--out",
      out,
    ]);
    expect(exported.released).toBeNull();
    await rm(out, { force: true });
  }, 120_000);

  test("a seal is signed and names the audience it hides the record from, its closure on asking, and revoking from it lifts it", async () => {
    const workspace = await fresh("seal");
    const { ruling } = await bookAndRule(workspace, "seal", key);
    const signedBefore = await sidecars(workspace);

    const sealed = await musaiJson<Released>(workspace, [
      "lab",
      "seal",
      ruling,
      "--from",
      "peer",
      "--key",
      key.keyPath,
    ]);
    expect(await sidecars(workspace)).toBe(signedBefore + 1);
    expect(await attestationOf(workspace, sealed.minted[0]!.id)).toMatchObject({
      subject: ruling,
      purpose: "sealed",
      seal: { audience: "peer" },
    });

    const widened = await musaiJson<Released>(workspace, [
      "lab",
      "seal",
      ruling,
      "--from",
      "peer",
      "--closure",
      "--key",
      key.keyPath,
    ]);
    expect(await attestationOf(workspace, widened.minted[0]!.id)).toMatchObject({
      seal: { audience: "peer", extent: "closure" },
      supersedes: [sealed.minted[0]!.id],
    });

    const lifted = await musaiJson<Released>(workspace, [
      "lab",
      "revoke",
      ruling,
      "--from",
      "peer",
      "--key",
      key.keyPath,
    ]);
    expect(await attestationOf(workspace, lifted.minted[0]!.id)).toMatchObject({
      purpose: "revoked",
      supersedes: [widened.minted[0]!.id],
    });
  }, 120_000);

  test("refuses an unknown use, or republish without an spdx marking, before anything is signed", async () => {
    const workspace = await fresh("release-uses");
    const { ruling } = await bookAndRule(workspace, "release-uses", key);
    const before = await sidecars(workspace);

    const unknown = await musai(workspace, [
      "lab",
      "release",
      ruling,
      "--to",
      "public",
      "--for",
      "sell",
      "--key",
      key.keyPath,
    ]);
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stderr).toContain("sell is not a use: a release grants review, cite, republish");

    const unmarked = await musai(workspace, [
      "lab",
      "release",
      ruling,
      "--to",
      "public",
      "--for",
      "republish",
      "--key",
      key.keyPath,
    ]);
    expect(unmarked.exitCode).not.toBe(0);
    expect(unmarked.stderr).toContain("spdx:");
    expect(await sidecars(workspace)).toBe(before);
  }, 120_000);

  test("refuses an audience name the audiences file does not declare", async () => {
    const workspace = await fresh("release-audience");
    const { ruling } = await bookAndRule(workspace, "release-audience", key);

    const refused = await musai(workspace, ["lab", "release", ruling, "--to", "everyone", "--key", key.keyPath]);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("everyone is not an audience the workspace's audiences file declares");
  }, 120_000);

  test("refuses a principal the role matrix does not grant publish", async () => {
    const workspace = await fresh("release-bystander");
    const { ruling } = await bookAndRule(workspace, "release-bystander", key);

    const refused = await musai(workspace, ["lab", "release", ruling, "--to", "public"], { principal: BYSTANDER });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain(
      `release.grant@2 needs publish, and the role matrix does not grant it to ${pseudonymOf(BYSTANDER)}`,
    );
  }, 120_000);

  test("refuses a release no key can sign before anything is written, whatever the signing level", async () => {
    const workspace = await fresh("release-keyless", "off");
    const { ruling } = await bookAndRule(workspace, "release-keyless", key);
    const before = await execa("git", ["--git-dir", workspace.gitDir, "rev-parse", "refs/heads/scope/default"]);

    const refused = await musai(workspace, ["lab", "release", ruling, "--to", "public"], {
      principal: KEYLESS_OWNER,
    });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("a released attestation decides what leaves the machine and is always signed");

    const after = await execa("git", ["--git-dir", workspace.gitDir, "rev-parse", "refs/heads/scope/default"]);
    expect(after.stdout).toBe(before.stdout);
  }, 120_000);

  test("refuses a seal no key can sign before anything is written, whatever the signing level", async () => {
    const workspace = await fresh("seal-keyless", "off");
    const { ruling } = await bookAndRule(workspace, "seal-keyless", key);
    const before = await execa("git", ["--git-dir", workspace.gitDir, "rev-parse", "refs/heads/scope/default"]);

    const refused = await musai(workspace, ["lab", "seal", ruling, "--from", "public"], { principal: KEYLESS_OWNER });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("a sealed attestation decides what a station sees and is always signed");

    const after = await execa("git", ["--git-dir", workspace.gitDir, "rev-parse", "refs/heads/scope/default"]);
    expect(after.stdout).toBe(before.stdout);
  }, 120_000);

  test("refuses a revocation no key can sign before anything is written", async () => {
    const workspace = await fresh("revoke-keyless", "off");
    const { ruling } = await bookAndRule(workspace, "revoke-keyless", key);
    await musaiJson(workspace, ["lab", "release", ruling, "--to", "public", "--key", key.keyPath]);
    const before = await execa("git", ["--git-dir", workspace.gitDir, "rev-parse", "refs/heads/scope/default"]);

    const refused = await musai(workspace, ["lab", "revoke", ruling, "--to", "public"], { principal: KEYLESS_OWNER });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("a revoked attestation decides what leaves the machine and is always signed");

    const after = await execa("git", ["--git-dir", workspace.gitDir, "rev-parse", "refs/heads/scope/default"]);
    expect(after.stdout).toBe(before.stdout);
  }, 120_000);
});
