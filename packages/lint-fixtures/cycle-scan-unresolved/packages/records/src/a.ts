import { b } from "./b.js";
import { missing } from "./missing.js";
// Bait for the cycle check: `./missing.js` names no file, so madge cannot
// resolve it, and an edge it cannot resolve never reaches a cycle it is part
// of. The import of `./b.js` resolves, so the graph is not empty.

export const a = b + missing;
