import { emptyPlan } from "@musai/modules";
// Bait for the boundary check: the MCP server may import the module host for
// its types only, and this statement loads a value from it at runtime.

export const plan = emptyPlan;
