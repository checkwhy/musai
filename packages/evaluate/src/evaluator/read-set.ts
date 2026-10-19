import type { IndexDb } from "@musai/fold";
import type { RuleInput } from "@musai/modules";
import { type ReadEntry, type RecordId, readEntryFor, recipeReadKey, slotReadKey } from "@musai/records";

/** What the kernel handed a rule: its claim where named, each evidence run, each record it asked
 * for and each invoked contribution's module; a claim keyed by its slot, a need's run by recipe. */
export function handedReads(
  input: RuleInput,
  recordsAsked: readonly RecordId[],
  recipes: ReadonlyMap<RecordId, RecordId>,
  index: Pick<IndexDb, "recordById" | "claimAtSlot">,
  claim?: RecordId,
): ReadEntry[] {
  const entries = [
    ...(claim === undefined ? [] : [readEntryFor(claim, slotReadKey(input.claimId))]),
    ...input.evidence.map((evidence) => {
      const recipe = recipes.get(evidence.runId);
      return recipe === undefined ? readEntryFor(evidence.runId) : readEntryFor(evidence.runId, recipeReadKey(recipe));
    }),
    ...(input.invocations ?? []).map((invocation) => readEntryFor(invocation.moduleRecord)),
    ...recordsAsked.map((id) => {
      const held = index.recordById(id)?.record;
      return held?.kind === "claim"
        ? readEntryFor(index.claimAtSlot(held.slot)?.id ?? id, slotReadKey(held.slot))
        : readEntryFor(id);
    }),
  ];
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  return [...byKey.keys()].sort().map((key) => byKey.get(key)!);
}

/** A record as a rule is handed it: a claim, named by any id it held, as it stands at its slot. */
export function currentRecord(index: Pick<IndexDb, "recordById" | "claimAtSlot">, id: RecordId): unknown {
  const held = index.recordById(id)?.record;
  return held?.kind === "claim" ? (index.claimAtSlot(held.slot)?.record ?? held) : held;
}
