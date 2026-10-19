import { ACTIONS, type Action, canonicalBytes, contains, type Scope } from "@musai/records";
import type { AllowedSigner } from "./allowed-signers.js";
import type { Role, RoleGrant } from "./roles.js";

/** With no signers and no grants, the workspace's own operator holds every action. */
export const EMPTY_TRUST_DEFAULT: readonly Action[] = ACTIONS;

/** The actions each shipped role grants. */
const ROLE_ACTIONS: Readonly<Record<Role, readonly Action[]>> = {
  owner: ACTIONS,
  maintainer: ["rule", "set-aside", "publish"],
  arbiter: ["rule", "set-aside", "override-person"],
  delegate: ["rule"],
};

export interface RoleMatrixEntry {
  readonly principal: string;
  readonly scope: Scope;
  readonly actions: ReadonlySet<Action>;
}

export interface RoleMatrix {
  readonly commit: string;
  readonly emptyDefault: boolean;
  readonly asymmetric: boolean;
  readonly entries: readonly RoleMatrixEntry[];
}

/** A sort key for a scope; a coded scope's key includes its arguments. */
function scopeSortKey(scope: Scope): string {
  switch (scope.kind) {
    case "any":
      return "";
    case "point":
    case "from":
    case "until":
      return `${scope.kind}:${String(scope.value)}`;
    case "range":
      return `range:${String(scope.from)}..${String(scope.to)}`;
    case "set":
      return `set:${scope.values.map(String).sort().join(",")}`;
    case "except":
      return `except:(${scopeSortKey(scope.base)})-(${scopeSortKey(scope.excluded)})`;
    case "coded":
      return `coded:${scope.module}/${scope.name}@${scope.version}:${new TextDecoder().decode(canonicalBytes(scope.args))}`;
  }
}

interface MutableEntry {
  principal: string;
  scope: Scope;
  actions: Set<Action>;
}

/** Builds the role matrix from the trust files read at one commit. Grants with no signers are
 * reported as asymmetric: no signature under them could verify. */
export function roleMatrix(
  signers: readonly AllowedSigner[],
  grants: readonly RoleGrant[],
  commit: string,
): RoleMatrix {
  const emptyDefault = signers.length === 0 && grants.length === 0;
  const asymmetric = signers.length === 0 && grants.length > 0;

  const grouped = new Map<string, MutableEntry>();
  for (const grant of grants) {
    const key = `${grant.principal} ${scopeSortKey(grant.scope)}`;
    const existing = grouped.get(key);
    const actionsToAdd = ROLE_ACTIONS[grant.role];
    if (existing) {
      for (const action of actionsToAdd) {
        existing.actions.add(action);
      }
    } else {
      grouped.set(key, { principal: grant.principal, scope: grant.scope, actions: new Set(actionsToAdd) });
    }
  }

  const entries: RoleMatrixEntry[] = [...grouped.values()].sort((a, b) => {
    if (a.principal !== b.principal) {
      return a.principal < b.principal ? -1 : 1;
    }
    const aKey = scopeSortKey(a.scope);
    const bKey = scopeSortKey(b.scope);
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });

  return { commit, emptyDefault, asymmetric, entries };
}

/** Whether `principal` may perform `action` at `scope`, per the matrix. */
export function may(matrix: RoleMatrix, principal: string, action: Action, scope: Scope): boolean {
  if (matrix.emptyDefault) {
    return (EMPTY_TRUST_DEFAULT as readonly string[]).includes(action);
  }
  return matrix.entries.some(
    (entry) => entry.principal === principal && entry.actions.has(action) && contains(entry.scope, scope),
  );
}
