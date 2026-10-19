import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { recordId } from "@musai/records";
import { scopeIndexPath, scopeVerificationCachePath } from "@musai/store";
import { makeFixtureRepo } from "@musai/test-support";
import { AttestationVerificationCache, type VerifyResult } from "@musai/trust";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Workspace } from "../src/workspace.js";

const SIGNERS = new TextEncoder().encode("alice@example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIalice\n");
const ROTATED_SIGNERS = new TextEncoder().encode("alice@example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIrotated\n");
const GOOD: VerifyResult = { principal: "alice@example.com", good: true };
const FAILED: VerifyResult = { principal: "alice@example.com", good: false, failureReason: "signature-invalid" };

const attestationId = (label: string) => recordId({ example: `an attestation ${label}` });

describe("the attestation verification cache", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "musai-verification-cache-"));
    path = join(dir, "attestation-verification.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("an id recorded under one signers digest is found again by a cache opened later over the same signers", async () => {
    const id = attestationId("verified good");
    const cache = await AttestationVerificationCache.open(path, SIGNERS);
    expect(cache.has(id)).toBe(false);

    await cache.record(id, GOOD);

    expect(cache.has(id)).toBe(true);
    expect((await AttestationVerificationCache.open(path, SIGNERS)).has(id)).toBe(true);
  });

  test("the same id is not found once the signers file's bytes change, and returning to the old bytes does not bring it back", async () => {
    const id = attestationId("verified under the old signers");
    await (await AttestationVerificationCache.open(path, SIGNERS)).record(id, GOOD);

    const rotated = await AttestationVerificationCache.open(path, ROTATED_SIGNERS);
    expect(rotated.has(id)).toBe(false);

    await rotated.record(attestationId("verified under the rotated signers"), GOOD);
    expect((await AttestationVerificationCache.open(path, SIGNERS)).has(id)).toBe(false);
  });

  test("a failed verification is not recorded, in memory or on disk", async () => {
    const id = attestationId("that failed to verify");
    const cache = await AttestationVerificationCache.open(path, SIGNERS);

    await cache.record(id, FAILED);

    expect(cache.has(id)).toBe(false);
    expect((await AttestationVerificationCache.open(path, SIGNERS)).has(id)).toBe(false);
  });

  test("a file that does not parse as a cache is discarded rather than trusted or refused", async () => {
    await writeFile(path, '{"allowedSigners": "sha256:');
    const cache = await AttestationVerificationCache.open(path, SIGNERS);
    expect(cache.has(attestationId("never recorded"))).toBe(false);
  });

  test("two caches recording at once over one file leave a whole file and nothing staged beside it", async () => {
    const left = await AttestationVerificationCache.open(path, SIGNERS);
    const right = await AttestationVerificationCache.open(path, SIGNERS);
    const ids = Array.from({ length: 24 }, (_, index) => attestationId(`recorded concurrently ${index}`));

    await Promise.all(ids.map((id, index) => (index % 2 === 0 ? left : right).record(id, GOOD)));

    const stored = JSON.parse(await readFile(path, "utf8")) as { verified: string[] };
    expect(stored.verified.length).toBeGreaterThan(0);
    expect(ids).toEqual(expect.arrayContaining(stored.verified));
    expect(await readdir(dir)).toEqual(["attestation-verification.json"]);
  });
});

describe("a workspace's attestation verification cache", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  test("sits in the scope's own local directory beside its index, and is not the index", async () => {
    const repo = await makeFixtureRepo("verification-cache-home");
    cleanup = repo.cleanup;
    const opened = await Workspace.open({ dir: repo.workspace, scope: repo.scope, now: repo.now });
    const id = attestationId("recorded through a workspace");

    await opened.attestationVerification.record(id, GOOD);

    const cachePath = scopeVerificationCachePath(repo.ctx.gitDir, repo.scope);
    const indexPath = scopeIndexPath(repo.ctx.gitDir, repo.scope);
    expect((await stat(cachePath)).isFile()).toBe(true);
    expect(dirname(cachePath)).toBe(dirname(indexPath));
    expect(cachePath).not.toBe(indexPath);
    const reopened = await Workspace.open({ dir: repo.workspace, scope: repo.scope, now: repo.now });
    expect(reopened.attestationVerification.has(id)).toBe(true);
  });
});
