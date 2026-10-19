import { parseAudience } from "./audience.js";
import { isPseudonym } from "./pseudonym.js";

export const KEY_PRINCIPAL_PREFIX = "key:";

/** A key named as an audience names one, so a principal and an audience spell a key alike. */
export function isKeyPrincipal(principal: string): boolean {
  try {
    return parseAudience(principal).form === "key";
  } catch {
    return false;
  }
}

/** `key:<fingerprint>` for the fingerprint `ssh-keygen -l` prints. */
export function keyPrincipal(fingerprint: string): string {
  const principal = `${KEY_PRINCIPAL_PREFIX}${fingerprint}`;
  if (!isKeyPrincipal(principal)) {
    throw new RangeError(`not an SSH SHA256 fingerprint: ${JSON.stringify(fingerprint)}`);
  }
  return principal;
}

/** Whether an attestation at the current version may name the principal. */
export function isAttestingPrincipal(principal: string): boolean {
  return isKeyPrincipal(principal) || isPseudonym(principal);
}

/** Why an attestation at the current version may not name the principal, else null. */
export function attestingPrincipalProblem(principal: string, where: string): string | null {
  return isAttestingPrincipal(principal)
    ? null
    : `${where} is key:SHA256:<fingerprint> or pseudonym:<key id>:<64 hex>, never a bare name, got ${JSON.stringify(principal)}`;
}
