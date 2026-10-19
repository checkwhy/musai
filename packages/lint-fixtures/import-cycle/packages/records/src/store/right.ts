// Bait for the cycle check, the other half of the pair in `left.ts`.
import { left } from "./left.js";

export function right(depth: number): number {
  return depth > 0 ? left(depth - 1) : 0;
}
