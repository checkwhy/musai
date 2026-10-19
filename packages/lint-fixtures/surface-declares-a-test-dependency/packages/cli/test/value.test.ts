import { value } from "@musai/records";
// Bait for the boundary check: the surface's manifest declares records in
// dependencies, what ships, while only this test imports it and nothing under
// the surface's src/ does. A package only a surface's tests need is a
// devDependency, so this import must not count toward what the surface's own
// source names.

export const doubled = value * 2;
