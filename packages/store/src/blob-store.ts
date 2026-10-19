import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BLOBS_DIR, BlobCorruptedError, blobPath, type Clock, KernelError, type RecordId, rawId } from "@musai/records";
import {
  type GitContext,
  gitCatFileBatch,
  gitCommitTree,
  gitHashObjectBatch,
  gitRevParse,
  gitSpliceTree,
} from "./git.js";
import { LOCAL_DIR } from "./init.js";
import { type CasRetryHooks, withCasRetry } from "./retry.js";

const BLOBS_REF = "refs/heads/blobs";

/** Payloads too large to inline in a record, held by the raw digest of their bytes. */
export interface BlobStore {
  put(bytes: Uint8Array): Promise<RecordId>;

  /** Refused with `BlobCorruptedError` when the stored bytes no longer digest to `id`. */
  read(id: RecordId): Promise<Uint8Array>;

  /** A file holding `id`'s verified bytes, for a host that loads a module by path. */
  materialise(id: RecordId): Promise<string>;
}

/** The branch's tree is what a bundle holds under `blobs/`, so one layout serves both. */
function branchPathOf(id: RecordId): string {
  return blobPath(id).slice(`${BLOBS_DIR}/`.length);
}

async function digestsTo(path: string, id: RecordId): Promise<boolean> {
  try {
    return rawId(new Uint8Array(await readFile(path))) === id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return false;
  }
}

export interface GitBlobStoreOptions {
  readonly ctx: GitContext;
  readonly now: Clock;
}

/** Each blob a git object on the store's `blobs` branch, so it travels with every clone. */
export class GitBlobStore implements BlobStore {
  private readonly ctx: GitContext;
  private readonly now: Clock;

  constructor(options: GitBlobStoreOptions) {
    this.ctx = options.ctx;
    this.now = options.now;
  }

  async put(bytes: Uint8Array, hooks: CasRetryHooks = {}): Promise<RecordId> {
    const id = rawId(bytes);
    const path = branchPathOf(id);
    const scratch = await mkdtemp(join(tmpdir(), "musai-blob-write-"));
    try {
      const file = join(scratch, "blob");
      await writeFile(file, bytes);
      const [sha] = await gitHashObjectBatch(this.ctx, [file]);
      if ((await gitRevParse(this.ctx, `${BLOBS_REF}:${path}`)) === sha) {
        return id;
      }
      await withCasRetry({ ctx: this.ctx, ref: BLOBS_REF, ...hooks }, async (tip) => {
        const tree = await gitSpliceTree(this.ctx, tip, [{ path, sha: sha! }]);
        const parents = tip === null ? [] : [tip];
        const commitSha = await gitCommitTree(this.ctx, tree, parents, `write blob ${id}\n`, this.now);
        return { commitSha, value: undefined };
      });
      return id;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  async read(id: RecordId): Promise<Uint8Array> {
    const spec = `${BLOBS_REF}:${branchPathOf(id)}`;
    let bytes: Uint8Array | null = null;
    for await (const answer of gitCatFileBatch(this.ctx, [spec])) {
      bytes = answer;
    }
    if (bytes === null) {
      throw new KernelError({ reason: "no-such-record", detail: `blob not found: ${id}`, about: [id] });
    }
    const actualId = rawId(bytes);
    if (actualId !== id) {
      throw new BlobCorruptedError(id, actualId, spec);
    }
    return bytes;
  }

  /** Written under a temporary name and renamed, so no reader meets half a file. */
  async materialise(id: RecordId): Promise<string> {
    const path = join(this.ctx.gitDir, LOCAL_DIR, blobPath(id));
    if (await digestsTo(path, id)) {
      return path;
    }
    const bytes = await this.read(id);
    await mkdir(dirname(path), { recursive: true });
    const partial = await mkdtemp(`${path}.partial-`);
    try {
      await writeFile(join(partial, "blob"), bytes);
      await rename(join(partial, "blob"), path);
    } finally {
      await rm(partial, { recursive: true, force: true });
    }
    return path;
  }
}
