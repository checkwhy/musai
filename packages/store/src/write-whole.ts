import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Staged beside `path` and renamed over it, so no reader, in this process or another, meets half a
 * file. */
export async function writeWhole(path: string, bytes: Uint8Array | string): Promise<void> {
  const staging = await mkdtemp(join(dirname(path), `.${basename(path)}.partial-`));
  try {
    const staged = join(staging, basename(path));
    await writeFile(staged, bytes);
    await rename(staged, path);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
