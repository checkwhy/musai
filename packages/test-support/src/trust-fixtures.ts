import { type Timestamp, timestamp } from "@musai/records";
import { type GitContext, writeMainFiles } from "@musai/store";
import { fixedClock, SCENARIO_INSTANT } from "./clock.js";

/** Writes the file flat at the repository root, as the initialiser seeds it. */
export async function writeTrustFile(ctx: GitContext, filename: string, content: string): Promise<void> {
  await writeMainFiles(ctx, { [filename]: content }, fixedClock(SCENARIO_INSTANT));
}

/** Distinct from rewriting it empty: a reader may need to tell the two apart. */
export async function removeTrustFile(ctx: GitContext, filename: string): Promise<void> {
  await writeMainFiles(ctx, { [filename]: null }, fixedClock(SCENARIO_INSTANT));
}

/** The first record `mint` gives, a minute apart, whose id sorts before `rival`'s, for a test
 * that needs a hash order it cannot choose. */
export function mintedSortingBefore<T extends { readonly id: string }>(
  rival: { readonly id: string },
  mint: (at: Timestamp) => T,
): T {
  for (let minute = 0; minute < 60; minute += 1) {
    const minted = mint(timestamp(`2026-01-10T00:${String(minute).padStart(2, "0")}:00.000Z`));
    if (minted.id < rival.id) {
      return minted;
    }
  }
  throw new RangeError(`no record minted within the hour sorts before ${rival.id}`);
}
