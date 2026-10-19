import {
  type Audience,
  type Clock,
  clearanceSaltKey,
  KernelError,
  type MusaiRecord,
  SALTABLE_KINDS,
  saltFor,
} from "@musai/records";
import { keyMaterial, workspaceKey } from "./keys.js";

/** The record salted under the workspace's current key, or the key it derives for a clearance. */
export async function salted(
  localDir: string,
  record: MusaiRecord,
  options: { readonly now: Clock; readonly clearance: Audience | undefined },
): Promise<MusaiRecord> {
  if (!SALTABLE_KINDS.includes(record.kind)) {
    throw new KernelError({
      reason: "invalid-input",
      about: [record.kind],
      detail: `refusing to salt a ${record.kind}: a ${record.kind} is never salted, and only ${SALTABLE_KINDS.join(", ")} records are`,
    });
  }
  if ("salt" in record) {
    throw new KernelError({
      reason: "invalid-input",
      about: [record.kind],
      detail: `refusing a ${record.kind} that names a salt: a salt is one only the kernel mints, under the workspace key, so a draft asks for one and names none`,
    });
  }
  const key = keyMaterial(await workspaceKey(localDir, options));
  const saltingKey = options.clearance === undefined ? key : clearanceSaltKey(key, options.clearance);
  return { ...record, salt: saltFor(saltingKey, record) } as MusaiRecord;
}
