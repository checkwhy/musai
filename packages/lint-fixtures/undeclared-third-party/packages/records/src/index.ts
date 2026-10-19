import { left } from "left-pad";
export { canonicalize } from "canonicalize";
// Bait for the boundary check: the manifest's dependencies hold canonicalize
// alone, so the import on the first line names a package it never lists,
// while the re-export of canonicalize on the second is declared and passes.

export const padded = left("x", 2);
