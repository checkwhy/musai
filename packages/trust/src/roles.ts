import { ANY_SCOPE, point, type Scope } from "@musai/records";

/** The shipped roles; a delegate is an agent ruling on the owner's behalf. */
export const ROLES = ["owner", "maintainer", "arbiter", "delegate"] as const;

export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export interface RoleGrant {
  readonly principal: string;
  readonly role: Role;
  readonly scope: Scope;
}

function parseScopeText(text: string): Scope {
  return text === "any" ? ANY_SCOPE : point(text);
}

/** Parses the roles file, one principal, role and scope per line; empty forms yield no grants. */
export function parseRoles(content: string): RoleGrant[] {
  const grants: RoleGrant[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const fields = line.split(/\s+/);
    if (fields.length !== 3) {
      throw new RangeError(`not a roles file line: ${rawLine}`);
    }
    const [principal, roleText, scopeText] = fields as [string, string, string];
    if (!isRole(roleText)) {
      throw new RangeError(`not a shipped role: ${roleText}`);
    }
    grants.push({ principal, role: roleText, scope: parseScopeText(scopeText) });
  }
  return grants;
}
