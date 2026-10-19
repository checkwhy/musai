import { type AttestationPurpose, isKeyPrincipal } from "@musai/records";
import { type Attestation, keyPrincipalAt, requireSignature, resolveSigningKey, signAttestation } from "@musai/trust";
import { OperationError } from "./errors.js";
import type { Workspace } from "./workspace.js";

/** What each purpose signed at every signing level decides. */
const ALWAYS_SIGNED: Readonly<Partial<Record<AttestationPurpose, string>>> = {
  "re-shared": "what leaves the machine",
  released: "what leaves the machine",
  revoked: "what leaves the machine",
  sealed: "what a station sees",
};

/** Signs whenever a key is found, even where the level does not require it: an attestation
 * stored unsigned can never be signed later. A key signs only as itself. */
export async function signatureFor(
  opened: Workspace,
  attestation: Attestation,
  named: string | undefined,
): Promise<string | undefined> {
  const { principal } = attestation.record;
  const key = await resolveSigningKey({
    named,
    localDir: opened.localDir,
    principal,
    allowedSigners: opened.allowedSigners,
  });

  if (key === null) {
    const decides = ALWAYS_SIGNED[attestation.record.purpose];
    if (decides === undefined && !requireSignature(opened.signingLevel, attestation.record.principalClass)) {
      return undefined;
    }
    const demand =
      decides === undefined
        ? `the signing level ${opened.signingLevel} requires a signature from ${principal}`
        : `a ${attestation.record.purpose} attestation decides ${decides} and is always signed, since an unsigned one counts for nothing`;
    throw new OperationError({
      reason: "invalid-input",
      about: [principal],
      detail:
        `${demand}, and no key was named ` +
        `at the invocation, configured in ${opened.localDir}/signer.json, or registered for ${principal} in this workspace's allowed signers`,
    });
  }

  const signingAs = await keyPrincipalAt(key.path);
  if (isKeyPrincipal(principal) && signingAs !== principal) {
    throw new OperationError({
      reason: "invalid-input",
      about: [principal, key.path],
      detail: `attestation ${attestation.id} names ${principal}, and the key at ${key.path} is ${signingAs ?? "no key whose public half is beside it"}: a key signs only as itself`,
    });
  }
  return signAttestation({ attestation, keyPath: key.path });
}
