// Bait for the cycle check, with `b.ts` beside it: two files and no import
// between them, so the package's graph has no edge and no cycle it could find.
export const a = 1;
