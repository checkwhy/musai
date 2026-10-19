import {
  type RecordStore,
  openStore,
} from "@musai/store";
import type { Lane } from "@musai/store";
/* the store's own */ import { openLane } from "@musai/store";
// Bait for the boundary check: the fold may import the store for its types
// only. The first statement marks one name `type` inside its braces and
// still loads the store; the second is erased whole and passes; the third
// loads the store behind a block comment, on the line after a type-only
// statement. Each statement that loads the store is reported at the line
// where it starts.

export function laneOf(store: RecordStore = openStore()): Lane {
  return { name: `${store.head()}:${openLane().name}` };
}
