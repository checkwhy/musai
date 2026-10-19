import type { MusaiRecord, RecordId, RecordKind } from "@musai/records";
import type { CasRetryHooks } from "./retry.js";

/** A record to write; a signed attestation's signature lands in the same commit as it. */
export interface PutItem {
  kind: RecordKind;
  value: unknown;
  signature?: string;
  /** Asks the store to mint the record's salt, where a salted value without it arrives whole. */
  salt?: true;
}

/** Where a record is written and read back: the scope itself, or writes held for one commit. */
export interface RecordWriter {
  readonly scope: string;
  put(kind: RecordKind, value: unknown): Promise<RecordId>;
  read(id: RecordId, kind: RecordKind): Promise<MusaiRecord>;
}

/** Writes no commit holds yet; `land` writes them with `more` in one, answering `more`'s ids. */
export interface HeldWrites extends RecordWriter {
  land(more: readonly PutItem[]): Promise<RecordId[]>;
}

/** A record arriving whole, as its stored bytes, with an attestation's signature beside it. */
export interface PlacedItem {
  kind: RecordKind;
  bytes: Uint8Array;
  signature?: string;
}

/** A path a commit changed, with `null` bytes when the commit deleted it. */
export interface ChangedPath {
  readonly path: string;
  readonly bytes: Uint8Array | null;
}

export interface CommitChanges {
  readonly commit: string;
  /** An ISO instant in UTC to the millisecond, so two readers hold the same string. */
  readonly committedAt: string;
  /** The record ids its writer named in the order it wrote them; empty when it named none. */
  readonly order: readonly RecordId[];
  readonly changed: readonly ChangedPath[];
}

/** A scope's records as an append-only log: what the fold reads and a non-git backend serves. */
export interface RecordStore {
  /** `null` before the scope's first write. */
  tip(): Promise<string | null>;

  /** Writes every record in one commit, returning their ids in order. */
  putMany(items: readonly PutItem[], hooks?: CasRetryHooks): Promise<RecordId[]>;

  /** The bytes as written, never normalised: a signature covers exactly these. */
  readBytes(id: RecordId, kind: RecordKind): Promise<Uint8Array>;

  /** The detached signature beside an attestation, or `null` when the scope holds none. */
  readSidecar(attestationId: RecordId): Promise<string | null>;

  /** Advances the tip by compare-and-swap to the commit `build` answers for the current tip. */
  swapRef<T>(
    build: (tip: string | null) => Promise<{ commitSha: string; value: T }>,
    hooks?: CasRetryHooks,
  ): Promise<T>;

  /** Whether `to` is `from` or reaches it through its parents. */
  descends(from: string, to: string): Promise<boolean>;

  /** Every commit after `cursor`, oldest first, each diffed against its parent, unfiltered. */
  changesSince(cursor: string | null): AsyncIterable<CommitChanges>;
}
