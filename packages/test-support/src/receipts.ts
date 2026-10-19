import { isComputedRun, type RecordId, type RunRecord } from "@musai/records";
import type { Store } from "@musai/store";

/** The receipts a store holds: every run but the ones the kernel computed. */
export async function receiptIds(store: Pick<Store, "list" | "read">): Promise<RecordId[]> {
  const ids = await store.list("run");
  const runs = await Promise.all(ids.map(async (id) => ({ id, run: (await store.read(id, "run")) as RunRecord })));
  return runs.filter(({ run }) => !isComputedRun(run)).map(({ id }) => id);
}
