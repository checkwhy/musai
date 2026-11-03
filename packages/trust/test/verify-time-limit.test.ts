import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { canonicalBytes, recordId, timestamp } from "@musai/records";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { mintAttestation } from "../src/attestation.js";
import { verifyAttestation } from "../src/verify.js";

const SHORTENED_MS = 200;

// Shortens whatever limit the kernel sets, so a run outliving it ends within the test.
vi.mock("execa", async (importOriginal) => {
  const original = await importOriginal<typeof import("execa")>();
  return {
    ...original,
    execa: (file: string, args: readonly string[], options: { readonly timeout?: number }) =>
      original.execa(file, args, options.timeout === undefined ? options : { ...options, timeout: SHORTENED_MS }),
  };
});

describe("an ssh-keygen that outlives its time limit", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "musai-verify-time-limit-"));
    // `exec`, so the limit's signal ends the sleep itself and no child holds the pipes open.
    await writeFile(join(dir, "ssh-keygen"), "#!/bin/sh\nexec sleep 30\n");
    await chmod(join(dir, "ssh-keygen"), 0o755);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  test("is ended and refuses, never judging the signature", async () => {
    const attestation = mintAttestation({
      subject: recordId({ example: "a record whose verifier hangs" }),
      principal: `key:SHA256:${"a".repeat(43)}`,
      principalClass: "person",
      via: "signature",
      purpose: "asserted",
      at: timestamp("2026-01-01T00:00:00Z"),
    });
    const allowedSignersPath = join(dir, "allowed_signers");
    await writeFile(allowedSignersPath, "");
    vi.stubEnv("PATH", `${dir}${delimiter}${process.env["PATH"] ?? ""}`);

    await expect(
      verifyAttestation({
        attestation,
        signedBytes: canonicalBytes(attestation.record),
        signature: "not a signature",
        allowedSignersPath,
      }),
    ).rejects.toMatchObject({
      reason: "tool-unavailable",
      about: [attestation.id],
      detail: expect.stringContaining("ran past its"),
    });
  });
});
