import { DEFAULT_SIGNING_LEVEL } from "@musai/store";
// Bait for the boundary check: trust may import the store for its types only,
// and this statement loads a value from it at runtime.

export const level = DEFAULT_SIGNING_LEVEL;
