import { access, rm } from "node:fs/promises";
import { join } from "node:path";
import { recordId, timestamp } from "@musai/records";
import {
  allowedSignersLine,
  type FixtureRepo,
  generateTestKey,
  makeFixtureRepo,
  type TestKey,
  writeFixtureRecords,
  writeTrustFile,
} from "@musai/test-support";
import { type Attestation, mintAttestation, signAttestation } from "@musai/trust";
import { execa } from "execa";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { openWorkspace, verifiedAttestationFor } from "../src/open-workspace.js";

const NAME = "alice";

function personAttestation(example: string, principal: string): Attestation {
  return mintAttestation({
    subject: recordId({ example }),
    principal,
    principalClass: "person",
    via: "signature",
    purpose: "made",
    at: timestamp("2026-01-01T00:00:00.000Z"),
  });
}

/** Git's exec path lacks `ssh-keygen`, so a verification succeeding there came from the cache. */
async function pathWithoutSshKeygen(): Promise<string> {
  const { stdout } = await execa("git", ["--exec-path"]);
  const execPath = stdout.trim();
  await expect(access(join(execPath, "ssh-keygen"))).rejects.toThrow();
  return execPath;
}

describe("attestation verification at signing level person", () => {
  let verifiedTwice: Attestation;
  let neverVerified: Attestation;
  let repo: FixtureRepo;
  let key: TestKey;
  let searchPath: string;

  beforeAll(async () => {
    repo = await makeFixtureRepo("attestation-verification");
    key = await generateTestKey(NAME);
    verifiedTwice = personAttestation("a record verified once and asked for again", key.principal);
    neverVerified = personAttestation("a record whose attestation nobody has verified yet", key.principal);
    searchPath = await pathWithoutSshKeygen();
    const items = [];
    for (const attestation of [verifiedTwice, neverVerified]) {
      const signature = await signAttestation({ attestation, keyPath: key.keyPath });
      items.push({ kind: "attestation" as const, value: attestation.record, signature });
    }
    await writeFixtureRecords(repo, items);
    await writeTrustFile(repo.ctx, "allowed-signers", allowedSignersLine(key));
    await writeTrustFile(repo.ctx, "config.json", JSON.stringify({ signing: "person" }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await repo.cleanup();
    await rm(key.dir, { recursive: true, force: true });
  });

  test("an attestation nobody has verified is checked by the OpenSSH binary, and refused where the binary cannot run", async () => {
    const opened = await openWorkspace({ workspace: repo.workspace, scope: repo.scope, now: repo.now });
    expect(opened.signingLevel).toBe("person");

    vi.stubEnv("PATH", searchPath);

    await expect(verifiedAttestationFor(opened, neverVerified.record.subject)).rejects.toMatchObject({
      reason: "tool-unavailable",
    });
  });

  test("a second verification of the same attestation under the same allowed signers runs no OpenSSH binary", async () => {
    const first = await openWorkspace({ workspace: repo.workspace, scope: repo.scope, now: repo.now });
    expect(await verifiedAttestationFor(first, verifiedTwice.record.subject)).toEqual(verifiedTwice.record);

    const second = await openWorkspace({ workspace: repo.workspace, scope: repo.scope, now: repo.now });
    vi.stubEnv("PATH", searchPath);

    expect(await verifiedAttestationFor(second, verifiedTwice.record.subject)).toEqual(verifiedTwice.record);
  });
});
