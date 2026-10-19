import { type RecordStore } from "@musai/store";
// Bait for the boundary check: the fold may import the store for its types
// only, and the import above uses the name as a type alone, yet its braces
// carry the `type` marker rather than the statement, so under
// verbatimModuleSyntax it still loads the store at runtime.

export function headOf(store: RecordStore): string {
  return store.head();
}
