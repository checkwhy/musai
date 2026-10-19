import { type Clock, pseudonymFor } from "@musai/records";
import { workspaceKey } from "@musai/store";
import { type AllowedSigner, keyPrincipalAt, lineLackingKeyForm, resolveSigningKey } from "@musai/trust";
import { OperationError } from "./errors.js";

/** What a principal is resolved from: files only, so a preview names who performing would. */
export interface PrincipalSources {
  readonly localDir: string;
  readonly allowedSigners: readonly AllowedSigner[];
  readonly now: Clock;
}

/** The key a call signs with, else the pseudonym `name` takes under the workspace key; undefined
 * where neither is there. */
export async function actingPrincipal(
  sources: PrincipalSources,
  name: string | undefined,
  named: string | undefined,
): Promise<string | undefined> {
  const key = await resolveSigningKey({
    named,
    localDir: sources.localDir,
    principal: name,
    allowedSigners: sources.allowedSigners,
  });
  if (key !== null) {
    return principalOfKey(key.path, sources.allowedSigners);
  }
  if (name === undefined) {
    return undefined;
  }
  return pseudonymFor(await workspaceKey(sources.localDir, { now: sources.now }), name);
}

/** A trust file binding the key under a name alone is never rewritten from here. */
async function principalOfKey(keyPath: string, signers: readonly AllowedSigner[]): Promise<string> {
  const principal = await keyPrincipalAt(keyPath);
  if (principal === null) {
    throw new OperationError({
      reason: "workspace-incomplete",
      about: [keyPath],
      detail: `the signing key ${keyPath} has no public half ssh-keygen reads at ${keyPath}.pub, which names the key a record attests under`,
    });
  }
  const lacking = lineLackingKeyForm(signers, principal);
  if (lacking !== null) {
    throw new OperationError({
      reason: "workspace-incomplete",
      about: [principal],
      detail: `allowed-signers binds the signing key ${principal} under a name alone, and a record names the key itself: replace its line on main with\n${lacking}`,
    });
  }
  return principal;
}

export const NO_PRINCIPAL_REMEDY =
  "register a signing key with `musai init --key <private key>`, or set MUSAI_PRINCIPAL to a name to attest under as a pseudonym";

/** The refusal of an attesting call that has neither a key nor a name to attest under. */
export function noPrincipal(about: string): OperationError {
  return new OperationError({
    reason: "invalid-input",
    about: [about],
    detail: `this call asks for an attestation, and it has no principal to attest under: ${NO_PRINCIPAL_REMEDY}`,
  });
}
