import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalBytes, KernelError } from "@musai/records";
import { execa } from "execa";
import type { Attestation } from "./attestation.js";

/** The namespace every attestation is signed and verified under, so a signature made for another
 * purpose cannot verify here. */
export const SIGNATURE_NAMESPACE = "musai" as const;

/** A minimal environment for ssh-keygen, inheriting nothing a verifier elsewhere would lack. */
export function opensshEnv(): Record<string, string> {
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: process.env["HOME"] ?? "",
  };
}

function buildSignArgs(keyPath: string, messagePath: string): string[] {
  return ["-Y", "sign", "-f", keyPath, "-n", SIGNATURE_NAMESPACE, messagePath];
}

export interface SignAttestationInput {
  readonly attestation: Attestation;
  readonly keyPath: string;
}

/** Signs an attestation's canonical bytes with ssh-keygen and returns the sidecar's text. */
export async function signAttestation(input: SignAttestationInput): Promise<string> {
  const bytes = canonicalBytes(input.attestation.record);
  const tmpDir = await mkdtemp(join(tmpdir(), "musai-sign-"));
  try {
    const messagePath = join(tmpDir, "attestation.json");
    await writeFile(messagePath, bytes);
    const args = buildSignArgs(input.keyPath, messagePath);
    try {
      await execa("ssh-keygen", args, { env: opensshEnv(), extendEnv: false });
    } catch {
      throw new KernelError({ reason: "tool-unavailable", detail: "signing an attestation failed" });
    }
    const sigBytes = await readFile(`${messagePath}.sig`);
    return sigBytes.toString("utf8");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
