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
