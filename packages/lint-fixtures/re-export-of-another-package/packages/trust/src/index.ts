export { ACTIONS } from "@musai/records";
import { point } from "@musai/records";
export { point };
import type { Scope } from "@musai/records";
export type { Scope };
// Bait for the boundary check: a kernel-side barrel passing on names records
// defines, once by re-exporting from records, once by exporting a value it
// imported from records, once by exporting a type it imported, and last by
// exporting the namespace it imported. The re-export of ./roles.js passes on
// names trust defines itself, and passes.

export { ROLES, type RoleGrant } from "./roles.js";
import * as records from "@musai/records";
export { records };
