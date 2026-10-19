import { value } from "@musai/distribution";
// Bait for the boundary check: a surface reaching for a distribution,
// declared in its manifest and imported here, so the rule's two violation
// shapes both fire. A surface is handed its distribution; the binding that
// hands it one lives in the distribution.

export const doubled = value * 2;
