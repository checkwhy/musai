import type { Scope } from "@musai/records";
// Not bait: a name records defines, used in a declaration of trust's own and
// never passed on, and an export clause naming only trust's own bindings.

const ROLES = ["owner", "delegate"] as const;

export interface RoleGrant {
  readonly role: (typeof ROLES)[number];
  readonly scope: Scope;
}

export { ROLES };
