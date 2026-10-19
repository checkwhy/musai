// Bait for the cycle check, one half: `left` needs `right` loaded and `right`
// needs `left`. Both sit in one directory, so the boundary check's directory
// order has nothing to say about the pair.
import { right } from "./right.js";

export function left(depth: number): number {
  return depth > 0 ? right(depth - 1) : 0;
}
