import { point } from "@musai/records"; export {
  ACTIONS,
} from "@musai/records";
// Bait for the boundary check: two statements naming records share the first
// line, and the re-export whose `from` sits two lines below is read as its
// own statement rather than as the import ahead of it.

export function at(value: string): string {
  return point(value);
}
