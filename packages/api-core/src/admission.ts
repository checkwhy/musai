import type { AdmissionWorkspace } from "@musai/evaluate";
import {
  INVOCATION_LIMITS_SLOT_ID,
  type InstalledModules,
  invocationLimitsFromSlots,
  readSlotDeclarations,
} from "@musai/modules";
import { KernelError, type ModuleRecord } from "@musai/records";
import type { Workspace } from "./workspace.js";

/** Admits each installed bundle by materialising it up front, since a host's `modulePath` is a
 * synchronous lookup that cannot await the digest check. */
export async function buildAdmissionWorkspace(
  opened: Workspace,
  installed: InstalledModules,
): Promise<AdmissionWorkspace> {
  const paths = new Map<string, string>();
  for (const [name, entry] of installed.byName) {
    const record = opened.read(entry.moduleRecordId) as ModuleRecord;
    if (record.bundle !== null) {
      paths.set(name, await opened.blobs.materialise(record.bundle));
    }
  }
  const slotRegistry = readSlotDeclarations(opened.index);
  return {
    index: opened.index,
    store: opened.store,
    // A fold with no core module declares no limits slot, and the host takes the slot's default.
    invocationLimits: slotRegistry.has(INVOCATION_LIMITS_SLOT_ID)
      ? invocationLimitsFromSlots(slotRegistry, { project: opened.projectSlots })
      : undefined,
    modulePath(moduleName: string): string {
      const path = paths.get(moduleName);
      if (path === undefined) {
        throw new KernelError({
          reason: "workspace-incomplete",
          about: [moduleName],
          detail: `${moduleName} is installed with no bundle to load; install its build`,
        });
      }
      return path;
    },
  };
}
