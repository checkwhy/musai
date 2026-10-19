import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KernelError } from "@musai/records";
import { execa } from "execa";
import type { Attestation } from "./attestation.js";
import { opensshEnv, SIGNATURE_NAMESPACE } from "./sign.js";

export type VerifyFailureReason = "signature-invalid" | "not-yet-valid" | "no-longer-valid";

/** A verification's outcome, naming why it failed rather than a bare boolean. */
export interface VerifyResult {
  readonly principal: string;
  readonly good: boolean;
  readonly failureReason?: VerifyFailureReason;
}

export interface VerifyAttestationInput {
  readonly attestation: Attestation;
  /** The attestation's stored bytes, never re-canonicalised: a record normalised from an older
   * schema would differ from what was signed. */
  readonly signedBytes: Uint8Array;
  readonly signature: string;
  readonly allowedSignersPath: string;
}

/** An instant in ssh-keygen's `YYYYMMDDHHMMSSZ` form, always in UTC. */
function verifyTimeOf(claimedAt: string): string {
  const instant = new Date(claimedAt);
  if (Number.isNaN(instant.getTime())) {
    throw new RangeError(`not a timestamp an attestation could claim: ${claimedAt}`);
  }
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${instant.getUTCFullYear()}${pad(instant.getUTCMonth() + 1)}${pad(instant.getUTCDate())}` +
    `${pad(instant.getUTCHours())}${pad(instant.getUTCMinutes())}${pad(instant.getUTCSeconds())}Z`
  );
}

interface BuildVerifyArgsInput {
  readonly allowedSignersPath: string;
  readonly principal: string;
  readonly sigPath: string;
  readonly verifyTime: string;
}

function buildVerifyArgs(input: BuildVerifyArgsInput): string[] {
  return [
    `-Overify-time=${input.verifyTime}`,
    "-Y",
    "verify",
    "-f",
    input.allowedSignersPath,
    "-I",
    input.principal,
    "-n",
    SIGNATURE_NAMESPACE,
    "-s",
    input.sigPath,
  ];
}

function classifyFailure(stderr: string): VerifyFailureReason {
  if (/is not yet valid/.test(stderr)) {
    return "not-yet-valid";
  }
  if (/has expired/.test(stderr)) {
    return "no-longer-valid";
  }
  return "signature-invalid";
}

/** Verifies an attestation's sidecar with ssh-keygen at the attestation's claimed time, so a key
 * rotated out later does not invalidate history signed while it was valid. */
export async function verifyAttestation(input: VerifyAttestationInput): Promise<VerifyResult> {
  const principal = input.attestation.record.principal;
  const verifyTime = verifyTimeOf(input.attestation.record.at);
  const messageBytes = input.signedBytes;

  const tmpDir = await mkdtemp(join(tmpdir(), "musai-verify-"));
  try {
    const sigPath = join(tmpDir, "attestation.sig");
    await writeFile(sigPath, input.signature);

    const args = buildVerifyArgs({
      allowedSignersPath: input.allowedSignersPath,
      principal,
      sigPath,
      verifyTime,
    });

    const result = await execa("ssh-keygen", args, {
      env: opensshEnv(),
      extendEnv: false,
      input: messageBytes,
      reject: false,
    });

    if (result.exitCode === undefined) {
      throw new KernelError({ reason: "tool-unavailable", detail: "ssh-keygen did not run to completion" });
    }

    if (result.exitCode === 0) {
      return { principal, good: true };
    }

    const stderrText = Array.isArray(result.stderr) ? result.stderr.join("\n") : (result.stderr ?? "");
    return { principal, good: false, failureReason: classifyFailure(stderrText) };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
