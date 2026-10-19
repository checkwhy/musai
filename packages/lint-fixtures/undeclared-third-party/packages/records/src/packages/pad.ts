import { left } from "left-pad";
// Bait for the boundary check: a directory named packages under src/ holds
// source the build compiles like any other, not a fixture tree to pass over,
// and the manifest never lists left-pad.

export const padded = left("y", 2);
