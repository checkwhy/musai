import { rm } from "node:fs/promises";
import { KernelError } from "@musai/records";
import { type GitContext, gitDeleteRefCas, gitForEachRef, gitRevParse, gitUpdateRefCas } from "./git.js";
import { scopeLocalDir } from "./init.js";
import { scopeRefName } from "./store.js";

const SCOPE_REF_PREFIX = "refs/heads/scope/";

export interface ScopeTip {
  readonly scope: string;
  readonly tip: string;
}

/** Every scope holding a ref, by name. */
export async function listScopes(ctx: GitContext): Promise<ScopeTip[]> {
  return (await gitForEachRef(ctx, SCOPE_REF_PREFIX))
    .map(({ ref, sha }) => ({ scope: ref.slice(SCOPE_REF_PREFIX.length), tip: sha }))
    .sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0));
}

function held(scope: string, tip: string | null): KernelError {
  return new KernelError({
    reason: "invalid-input",
    about: [scope],
    detail: `scope ${scope} already holds a ref, at ${tip}; drop it or name another scope`,
  });
}

/** Refuses a name some ref already holds, as `createScope` would. */
export async function assertScopeFree(ctx: GitContext, scope: string): Promise<void> {
  const tip = await gitRevParse(ctx, scopeRefName(scope));
  if (tip !== null) {
    throw held(scope, tip);
  }
}

/** Claims the scope's ref at `at`, only where no ref holds the name. */
export async function createScope(ctx: GitContext, scope: string, at: string): Promise<void> {
  const ref = scopeRefName(scope);
  if (!(await gitUpdateRefCas(ctx, ref, at, null))) {
    throw held(scope, await gitRevParse(ctx, ref));
  }
}

function moved(scope: string, expected: string, held: string | null): KernelError {
  return new KernelError({
    reason: "head-moved",
    about: [scope],
    detail: `scope ${scope} is at ${held ?? "no commit"}, not ${expected}; read it again before dropping it`,
  });
}

/** Refuses a scope that is not at `expectedTip`, as `dropScope` would. */
export async function assertScopeAt(ctx: GitContext, scope: string, expectedTip: string): Promise<void> {
  const tip = await gitRevParse(ctx, scopeRefName(scope));
  if (tip !== expectedTip) {
    throw moved(scope, expectedTip, tip);
  }
}

/** The fold goes before the ref: a fold left without its ref would still answer its old records,
 * while a ref left without its fold refolds on open. The scope's objects stay. */
export async function dropScope(ctx: GitContext, scope: string, expectedTip: string): Promise<void> {
  await assertScopeAt(ctx, scope, expectedTip);
  const ref = scopeRefName(scope);
  await rm(scopeLocalDir(ctx.gitDir, scope), { recursive: true, force: true });
  if (!(await gitDeleteRefCas(ctx, ref, expectedTip))) {
    throw moved(scope, expectedTip, await gitRevParse(ctx, ref));
  }
}
