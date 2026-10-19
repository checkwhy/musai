import { keyedHash } from "../canonical/canonicalize.js";

export const PSEUDONYM_PREFIX = "pseudonym:";

/** `pseudonym:<key id>:<64 hex>`. OpenSSH accepts a colon in a signer identity, so the record and
 * the allowed-signers file spell it alike. */
export const PSEUDONYM_PATTERN = /^pseudonym:[^:]+:[0-9a-f]{64}$/;

export function isPseudonym(principal: string): boolean {
  return PSEUDONYM_PATTERN.test(principal);
}

/** Why a principal misuses the reserved prefix, else null. Every principal position asks, since a
 * prefix reserved on one kind only is not reserved. */
export function misusedPseudonymPrefix(principal: string, where: string): string | null {
  if (!principal.startsWith(PSEUDONYM_PREFIX) || isPseudonym(principal)) {
    return null;
  }
  return `${where} reserves the ${PSEUDONYM_PREFIX} prefix for ${PSEUDONYM_PREFIX}<key id>:<64 hex>`;
}

/** Hashed into every pseudonym, so a pseudonym never equals a salt or a receipt's keyed hash. */
const PSEUDONYM_PURPOSE = "musai/pseudonym/v1";

/** The pseudonym a name takes under a workspace key; without the key, a guess cannot be tested. */
export function pseudonymFor(key: { readonly id: string; readonly material: string }, name: string): string {
  const hash = keyedHash(Buffer.from(key.material, "hex"), PSEUDONYM_PURPOSE, "principal", name);
  return `${PSEUDONYM_PREFIX}${key.id}:${hash}`;
}
