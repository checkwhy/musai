import { readFile } from "node:fs/promises";
import { type RecordId, rawId } from "@musai/records";
import type { VerifyResult } from "./verify.js";

/** Verified attestation ids, and the digest of the allowed-signers bytes they verified under. */
interface StoredVerification {
  readonly allowedSigners: RecordId;
  readonly verified: readonly RecordId[];
}

/** Writes a file whole, so two processes recording at once leave one file, never a mix. */
type WholeWriter = (path: string, text: string) => Promise<void>;

/** The ids stored under this digest; a file written under any other digest yields none. */
async function verifiedUnder(path: string, allowedSigners: RecordId): Promise<Set<RecordId>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new Set();
    }
    throw error;
  }
  let stored: Partial<StoredVerification> | null;
  try {
    stored = JSON.parse(text) as Partial<StoredVerification> | null;
  } catch {
    return new Set();
  }
  if (stored?.allowedSigners !== allowedSigners || !Array.isArray(stored.verified)) {
    return new Set();
  }
  return new Set(stored.verified);
}

/** Attestations one scope has seen verify, keyed by id and allowed-signers digest. It sits beside
 * the fold, not in it: what a key file grants is not in the log. */
export class AttestationVerificationCache {
  private readonly path: string;
  private readonly allowedSigners: RecordId;
  private readonly verified: Set<RecordId>;
  private readonly writeWhole: WholeWriter;

  private constructor(path: string, allowedSigners: RecordId, verified: Set<RecordId>, writeWhole: WholeWriter) {
    this.path = path;
    this.allowedSigners = allowedSigners;
    this.verified = verified;
    this.writeWhole = writeWhole;
  }

  /** Opens the cache at `path` under these allowed-signers bytes; the file need not exist. */
  static async open(
    path: string,
    allowedSigners: Uint8Array,
    writeWhole: WholeWriter,
  ): Promise<AttestationVerificationCache> {
    const digest = rawId(allowedSigners);
    return new AttestationVerificationCache(path, digest, await verifiedUnder(path, digest), writeWhole);
  }

  /** Whether `id` verified under this cache's allowed-signers bytes. */
  has(id: RecordId): boolean {
    return this.verified.has(id);
  }

  /** Persists `id` when `result` is good; a failure is never cached, since it can be transient. */
  async record(id: RecordId, result: VerifyResult): Promise<void> {
    if (!result.good) {
      return;
    }
    this.verified.add(id);
    const stored: StoredVerification = { allowedSigners: this.allowedSigners, verified: [...this.verified].sort() };
    await this.writeWhole(this.path, `${JSON.stringify(stored)}\n`);
  }
}
