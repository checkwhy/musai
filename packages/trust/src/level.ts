import type { PrincipalClass } from "@musai/records";
import { ANY_SCOPE, KernelError } from "@musai/records";
import type { WorkspaceConfig } from "@musai/store";
import { may, type RoleMatrix } from "./authority.js";

function holdsConfigureFloor(matrix: RoleMatrix, principal: string | undefined): boolean {
  return principal === undefined ? matrix.emptyDefault : may(matrix, principal, "configure-floor", ANY_SCOPE);
}

/** Refuses to change a configuration value unless the matrix grants `configure-floor` anywhere. */
export function assertMayConfigure(matrix: RoleMatrix, principal: string | undefined, key: string): void {
  if (!holdsConfigureFloor(matrix, principal)) {
    throw new KernelError({
      reason: "not-authorised",
      about: [key],
      detail: `refusing to set ${key} in the workspace's configuration: ${principal ?? "no principal"} holds no configure-floor grant; an owner sets it, or edits config.json on the trust branch`,
    });
  }
}

/** Refuses to widen what a check may spawn unless the matrix grants `configure-floor` anywhere. */
export function assertMayAdmitTools(matrix: RoleMatrix, principal: string | undefined, tools: readonly string[]): void {
  if (!holdsConfigureFloor(matrix, principal)) {
    throw new KernelError({
      reason: "not-authorised",
      about: [...tools],
      detail: `refusing to add ${tools.join(", ")} to the workspace's toolset: ${principal ?? "no principal"} holds no configure-floor grant; an owner adds it, or writes "tools": ${JSON.stringify(tools)} into config.json on the trust branch`,
    });
  }
}

/** The trust-branch configuration key holding the signing level; absent means `off`. */
export const SIGNING_LEVEL_CONFIG_KEY = "signing";

export const SIGNING_LEVELS = ["off", "person", "all"] as const;

export type SigningLevel = (typeof SIGNING_LEVELS)[number];

export function isSigningLevel(value: unknown): value is SigningLevel {
  return typeof value === "string" && (SIGNING_LEVELS as readonly string[]).includes(value);
}

/** The configured signing level: `off` when absent, refused when it is not a known level. */
export function signingLevelOf(config: WorkspaceConfig): SigningLevel {
  const declared = config.values[SIGNING_LEVEL_CONFIG_KEY];
  if (declared === undefined) {
    return "off";
  }
  if (!isSigningLevel(declared)) {
    throw new RangeError(
      `refusing to read the signing level from ${SIGNING_LEVEL_CONFIG_KEY} at ${config.commit}: expected one of ${SIGNING_LEVELS.join(", ")}, got ${JSON.stringify(declared)}`,
    );
  }
  return declared;
}

/** Whether an attestation from this principal class must be verified at this level. */
export function requireSignature(level: string | undefined, principalClass: PrincipalClass): boolean {
  const resolved = level ?? "off";
  if (!isSigningLevel(resolved)) {
    throw new RangeError(`not a signing level: ${resolved}`);
  }
  if (resolved === "off") {
    return false;
  }
  if (resolved === "all") {
    return true;
  }
  return principalClass === "person";
}
