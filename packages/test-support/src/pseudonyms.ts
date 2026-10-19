import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pseudonymFor, type ViaChannel } from "@musai/records";
import { LOCAL_DIR, MUSAI_DIR } from "@musai/store";
import { SCENARIO_INSTANT } from "./clock.js";

/** A workspace key fixed across tests, so a name's pseudonym is known before a workspace opens. */
const FIXED_WORKSPACE_KEY = {
  id: "8d0f4c62-5a1e-4b7a-9c3d-2e6f1a0b9c71",
  status: "current",
  createdAt: SCENARIO_INSTANT,
  material: "5e".repeat(32),
} as const;

/** Gives the workspace at `dir` the fixed key, before anything mints one of its own. */
export async function fixWorkspaceKey(dir: string): Promise<void> {
  const path = join(dir, MUSAI_DIR, LOCAL_DIR, "keys.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ keys: [FIXED_WORKSPACE_KEY] }), { mode: 0o600 });
  await chmod(path, 0o600);
}

/** The principal a call naming `name` and signing with no key attests under, in a workspace whose
 * key `fixWorkspaceKey` fixed. */
export function pseudonymOf(name: string): string {
  return pseudonymFor(FIXED_WORKSPACE_KEY, name);
}

/** A surface's channel and name, with the pseudonym a record names it by. */
export interface NamedCaller {
  readonly via: ViaChannel;
  readonly principalName: string;
  readonly principal: string;
}

export function namedCaller(via: ViaChannel, principalName: string): NamedCaller {
  return { via, principalName, principal: pseudonymOf(principalName) };
}
