import { canonicalId } from "@musai/records";
// Bait for the boundary check: a scenario reaching into a kernel-side package
// by importing it, where it may reach the kernel only by spawning the built
// binary. The package declares what it imports, so no other rule has cause.

export const id = canonicalId({ kind: "case" });
