import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const HEX_PAIR = /^[0-9a-f]{2}$/;
const BLOB_NAME = /^[0-9a-f]{64}$/;

export interface BlobDirectory {
  /** Each file at `<xx>/<hex>`, named by the digest its bytes claim. */
  readonly files: readonly { readonly path: string; readonly hex: string }[];
  /** Each entry outside that layout. */
  readonly strays: readonly string[];
}

/** A directory laid out as a blob store, as `.musai/blobs/` and `blobs/` once were; `null` where
 * it does not exist. */
export async function readBlobDirectory(dir: string): Promise<BlobDirectory | null> {
  let shards: Dirent[];
  try {
    shards = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const files: { path: string; hex: string }[] = [];
  const strays: string[] = [];
  for (const shard of shards) {
    const shardPath = join(dir, shard.name);
    if (!shard.isDirectory() || !HEX_PAIR.test(shard.name)) {
      strays.push(shardPath);
      continue;
    }
    for (const entry of await readdir(shardPath, { withFileTypes: true })) {
      const path = join(shardPath, entry.name);
      if (entry.isFile() && BLOB_NAME.test(entry.name) && entry.name.startsWith(shard.name)) {
        files.push({ path, hex: entry.name });
      } else {
        strays.push(path);
      }
    }
  }
  return { files, strays };
}

/** Holds blobs and nothing else, so a project's own `blobs/` is never taken for one. */
export function isBlobStore(directory: BlobDirectory | null): directory is BlobDirectory {
  return directory !== null && directory.files.length > 0 && directory.strays.length === 0;
}
