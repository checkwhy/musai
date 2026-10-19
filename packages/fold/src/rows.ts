import type {
  ArgumentRecord,
  ArtifactRecord,
  AttestationRecord,
  CaseRecord,
  ContributionEntry,
  DigestSet,
  EventKind,
  ModuleRecord,
  MusaiRecord,
  RecordId,
  RecordKind,
  RuleRecord,
  RulingRecord,
  RunRecord,
  Selector,
  Timestamp,
} from "@musai/records";
import type { FoldRow, FoldTable } from "./fold-extension.js";

export interface IndexedClaim {
  slot: string;
  id: RecordId;
  type: string;
  rendering: string;
  record: MusaiRecord;
}

export interface IndexedRecord {
  id: RecordId;
  record: MusaiRecord;
}

export interface IndexedEvidenceEdge {
  run: RecordId;
  selector: Selector;
  item: RecordId;
}

/** A contribution as the module's manifest declares it, never as its bundle does. */
export interface IndexedContribution {
  moduleRecord: RecordId;
  moduleName: string;
  moduleVersion: string;
  entry: ContributionEntry;
}

export interface DeclaredQuery {
  readonly id: string;
  readonly version: string;
  readonly statement: string;
  readonly tables: readonly string[];
  readonly parameters: Record<string, unknown>;
  readonly rows: Record<string, unknown>;
}

/** A declared query with the module record that tells it from another pack's of the same id. */
export interface QueryDeclaration extends DeclaredQuery {
  readonly moduleRecord: RecordId;
}

/** The module record a name resolves to. */
export interface IndexedModuleInstall {
  id: RecordId;
  name: string;
  version: ModuleRecord["version"];
}

export interface IndexedRule {
  id: RecordId;
  record: RuleRecord;
}

export interface IndexedRuling {
  id: RecordId;
  record: RulingRecord;
}

export interface IndexedRulingOnSlot extends IndexedRuling {
  successors: IndexedSuccessor[];
}

export interface IndexedArgument {
  id: RecordId;
  record: ArgumentRecord;
}

export interface IndexedCase {
  id: RecordId;
  record: CaseRecord;
}

export interface IndexedArtifact {
  id: RecordId;
  record: ArtifactRecord;
}

export interface IndexedAttestation {
  id: RecordId;
  record: AttestationRecord;
}

export interface IndexedSuccessor {
  successor: RecordId;
  kind: RecordKind;
}

/** A label an artifact's receipts section resolves, derived from its content and never stored. */
export interface IndexedAnchor {
  label: string;
  fullId: RecordId;
}

/** A run keyed by its recipe id, so one run per recipe id per evaluation is a lookup. */
/** A run that read a key, and the digest of what it consumed there. */
export interface IndexedRead {
  reader: RecordId;
  consumed: DigestSet;
}

export interface IndexedReceipt {
  recipeId: RecordId;
  recordId: RecordId;
  startedAt: Timestamp;
  record: RunRecord;
}

/** `about` is the record's id, except for a module event: its name outlives the record a pin
 * change moves it off. */
export interface IndexedEvent {
  kind: EventKind;
  about: string;
  recordId: RecordId;
  commit: string;
  seq: number;
}

/** A place in event order to read past; with no position, the whole commit is behind it. */
export interface EventCursor {
  commit: string;
  position?: number;
}

/** A path under `records/` a fold found in a commit and left out of the index. */
export interface IndexedRefusal {
  id: RecordId | null;
  commit: string;
  path: string;
  reason: string;
}

export interface RefusedRecordPath {
  id: RecordId | null;
  path: string;
  reason: string;
}

/** `position` is the record's index among its commit's record paths in byte order. */
export interface FoldedRecord {
  id: RecordId;
  record: MusaiRecord;
  position: number;
}

export interface ContributedRows {
  table: FoldTable;
  record: RecordId;
  rows: readonly FoldRow[];
}

/** Where a fold was interrupted, for a test to force deterministically. */
export type FoldInterruptPhase =
  /** Between two commits: the prior commit's transaction has committed. */
  | "before-commit"
  /** Inside a commit's own transaction, before it commits. */
  | "mid-transaction";

export interface FoldInterruptEvent {
  commit: string;
  phase: FoldInterruptPhase;
}
