import type { Store } from "@musai/store";
import { OperationError } from "./errors.js";

export class HeadMovedError extends OperationError {
  constructor(expectHead: string, foundHead: string | null) {
    super({
      reason: "head-moved",
      about: [`expected:${expectHead}`, `found:${foundHead ?? "none"}`],
      detail: `refusing to write: expected head ${expectHead}, found ${foundHead ?? "none"}`,
    });
    this.name = "HeadMovedError";
  }
}

/** Reads the tip once and never retries: a retry would apply a decision to data it never saw. */
export async function assertHeadUnmoved(store: Pick<Store, "tip">, expectHead: string): Promise<void> {
  const tip = await store.tip();
  if (tip !== expectHead) {
    throw new HeadMovedError(expectHead, tip);
  }
}
