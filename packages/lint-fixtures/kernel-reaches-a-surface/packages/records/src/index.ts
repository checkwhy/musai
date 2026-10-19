import { value } from "@musai/cli";
// Bait for the boundary check: a kernel-side package reaching for a surface,
// declared in its manifest and imported here, so the rule's two violation
// shapes both fire.

export const doubled = value * 2;
