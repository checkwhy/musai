import { type Attestation, verifyAttestation } from "@musai/trust";
import type { Workspace } from "./workspace.js";

/** `failure` is null where the attestation has no sidecar at all. */
export type SignatureCheck = { readonly good: true } | { readonly good: false; readonly failure: string | null };

/** Answered from the cache where the same allowed-signers bytes verified it before, so nothing is
 * read or spawned. */
export async function signatureCheck(opened: Workspace, attestation: Attestation): Promise<SignatureCheck> {
  if (opened.attestationVerification.has(attestation.id)) {
    return { good: true };
  }
  const signature = await opened.store.readSidecar(attestation.id);
  if (signature === null) {
    return { good: false, failure: null };
  }
  const signedBytes = await opened.store.readBytes(attestation.id, "attestation");
  const result = await verifyAttestation({
    attestation,
    signedBytes,
    signature,
    allowedSignersPath: opened.allowedSignersPath,
  });
  await opened.attestationVerification.record(attestation.id, result);
  return result.good ? { good: true } : { good: false, failure: `${result.failureReason}` };
}
