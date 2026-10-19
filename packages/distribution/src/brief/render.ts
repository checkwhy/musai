import type { Workspace } from "@musai/api-core";
import { OperationError } from "@musai/api-core";
import { type AttestationPrincipalSource, EVIDENCE_ORDER, type EvidenceKind, evidenceKindOf } from "@musai/evaluate";
import {
  type ArgumentRecord,
  type AttestationRecord,
  type CaseRecord,
  type ClaimRecord,
  type ComputedRecipe,
  type EvidenceEdge,
  idFromPath,
  isSidecarPath,
  type MusaiRecord,
  type ReadEntry,
  type RecordId,
  type RecordKind,
  RecordRefusedError,
  type RunRecord,
  readEntryFor,
  readStoredRecord,
  recordPath,
  renderedTextOf,
  renderSelector,
  slotReadKey,
} from "@musai/records";
import { gitCatFile, gitLsTree, isAbsentPathError, type LsTreeEntry } from "@musai/store";
import { cited, citedEvidence } from "../cases.js";
import { inlineText } from "../text.js";
import { parseBriefSubstrates } from "./recipe.js";
import { type Omission, omissionLine, type TrimItem, trimToBudget } from "./trim.js";

/** One record a brief packed. `pinned` is never trimmed; `text` is the line the trim counted. */
export interface PackedRecord {
  readonly id: RecordId;
  readonly kind: "claim" | EvidenceKind;
  readonly pinned: boolean;
  readonly setAside: boolean;
  readonly text: string;
  /** Every record whose bytes `text` carries, so a seal on any of them withholds the brief. */
  readonly reads: readonly RecordId[];
}

/** A line a brief packs: an evidence run, and for an attack the argument whose reason it quotes. */
export interface BriefLine {
  readonly edge: EvidenceEdge;
  readonly attack?: { readonly argument: RecordId; readonly reason: string };
}

/** The lines a brief over `claim` packs before trimming, given the arguments standing against it:
 * the one home for what a brief reads, shared by its render, its staleness and its ruling. */
export function briefLines(
  view: Workspace,
  claim: ClaimRecord,
  standing: readonly { readonly id: RecordId; readonly record: ArgumentRecord }[],
): { readonly direct: readonly BriefLine[]; readonly attacking: readonly BriefLine[] } {
  return {
    direct: citedEvidence(view, claim.evidence).map((edge) => ({ edge })),
    attacking: standing.flatMap(({ id, record }) =>
      record.evidence.map((edge) => ({ edge, attack: { argument: id, reason: renderedTextOf(record.reason) } })),
    ),
  };
}

export function lineReadIds(line: BriefLine): RecordId[] {
  return line.attack === undefined ? [line.edge.run] : [line.edge.run, line.attack.argument];
}

/** A rendered brief: its bytes, the records it read and what the trim omitted. */
export interface BriefRender {
  readonly output: string;
  readonly reads: readonly ReadEntry[];
  readonly omissions: readonly Omission[];
}

/** A reader fixed to one commit, so a receiver's re-render ignores what landed since. */
interface HeadReader {
  read(id: RecordId, kind: RecordKind): Promise<MusaiRecord>;
  list(kind: RecordKind): Promise<RecordId[]>;
}

function unreadableHead(head: string, error: unknown): OperationError {
  const cause = error instanceof Error ? error.message : String(error);
  return new OperationError({
    reason: "no-such-record",
    about: [head],
    detail: `the scope head ${head} could not be read: ${cause}`,
  });
}

function absentAtHead(id: RecordId, head: string): OperationError {
  return new OperationError({
    reason: "no-such-record",
    about: [id],
    detail: `no record ${id} found at head ${head}`,
  });
}

/** Under a clearance a head reads as its fold holds it, so nothing withheld is packed. */
function headReader(view: Workspace, head: string): HeadReader {
  const ctx = view.ctx;
  const held = (id: RecordId) => view.clearance === undefined || view.index.holds(id);
  return {
    async read(id, kind) {
      if (!held(id)) {
        const refusal = view.index.refusalFor(id);
        throw refusal === undefined ? absentAtHead(id, head) : new RecordRefusedError(id, refusal.reason);
      }
      let bytes: Buffer;
      try {
        bytes = await gitCatFile(ctx, `${head}:${recordPath(kind, id)}`);
      } catch (error) {
        throw isAbsentPathError(error) ? absentAtHead(id, head) : unreadableHead(head, error);
      }
      return readStoredRecord(bytes, id, kind);
    },
    async list(kind) {
      let entries: LsTreeEntry[];
      try {
        entries = await gitLsTree(ctx, head);
      } catch (error) {
        throw unreadableHead(head, error);
      }
      const prefix = `records/${kind}/`;
      return entries
        .filter((entry) => entry.path.startsWith(prefix) && !isSidecarPath(entry.path))
        .map((entry) => idFromPath(entry.path))
        .filter((id) => cited(view, id));
    },
  };
}

/** The attestation behind a subject, unverified: a kind needs only the principal's class. */
async function firstAttestation(reader: HeadReader, subject: RecordId): Promise<AttestationPrincipalSource | null> {
  const ids = await reader.list("attestation");
  for (const id of [...ids].sort()) {
    const record = (await reader.read(id, "attestation")) as AttestationRecord;
    if (record.subject === subject && (record.purpose === "made" || record.purpose === "asserted")) {
      return { principalClass: record.principalClass };
    }
  }
  return null;
}

async function evidenceItem(reader: HeadReader, line: BriefLine, pinned: boolean): Promise<PackedRecord> {
  const { edge, attack } = line;
  const run = (await reader.read(edge.run, "run")) as RunRecord;
  const attestation = run.runKind === "testimony" ? await firstAttestation(reader, edge.run) : null;
  const kind = evidenceKindOf(run, attestation);
  const selector = inlineText(renderSelector(edge.selector));
  const suffix = attack !== undefined ? `: ${inlineText(attack.reason)}` : "";
  return {
    id: edge.run,
    kind,
    pinned,
    setAside: false,
    text: `- ${kind} ${edge.run} (${selector})${suffix}`,
    reads: lineReadIds(line),
  };
}

function evidenceRankOf(item: PackedRecord): number {
  return EVIDENCE_ORDER.indexOf(item.kind === "claim" ? "receipt" : item.kind);
}

function sortPacked(items: PackedRecord[]): PackedRecord[] {
  return [...items].sort((a, b) => {
    const rankA = evidenceRankOf(a);
    const rankB = evidenceRankOf(b);
    if (rankA !== rankB) {
      return rankA - rankB;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function toTrimItem(record: PackedRecord): TrimItem {
  return {
    id: record.id,
    evidenceKind: record.kind === "claim" ? "receipt" : record.kind,
    setAside: record.setAside,
    pinned: record.pinned,
    bytes: new TextEncoder().encode(record.text).byteLength,
  };
}

function renderHeader(caseId: RecordId, caseRecord: CaseRecord, gateClaimId: RecordId, kernelVersion: string): string {
  return [
    `# Brief for ${gateClaimId}`,
    "",
    `Case ${caseId} (${inlineText(caseRecord.slug)}) — preset ${inlineText(caseRecord.preset.contribution)}, evaluator version ${inlineText(caseRecord.evaluatorVersion)}, project commit ${inlineText(caseRecord.projectCommit)}, rendered under kernel version ${inlineText(kernelVersion)}`,
  ].join("\n");
}

/** Every evidence item a claim's brief would pack at a head, before trimming: the one home for what
 * a claim's evidence means, shared with the staleness check. */
async function gatherEvidence(
  view: Workspace,
  reader: HeadReader,
  gateClaimId: RecordId,
): Promise<{ direct: PackedRecord[]; attacking: PackedRecord[] }> {
  const claimRecord = (await reader.read(gateClaimId, "claim")) as ClaimRecord;

  // Read off the head, not the fold, so a re-render at an older head packs what stood then.
  const argumentsAtHead: Array<{ id: RecordId; record: ArgumentRecord }> = [];
  const superseded = new Set<RecordId>();
  for (const argumentId of [...(await reader.list("argument"))].sort()) {
    const record = (await reader.read(argumentId, "argument")) as ArgumentRecord;
    argumentsAtHead.push({ id: argumentId, record });
    for (const predecessor of record.supersedes) {
      superseded.add(predecessor);
    }
  }

  const standing = argumentsAtHead.filter(({ id, record }) => record.target === gateClaimId && !superseded.has(id));
  const lines = briefLines(view, claimRecord, standing);
  const direct: PackedRecord[] = [];
  for (const line of lines.direct) {
    direct.push(await evidenceItem(reader, line, true));
  }
  const attacking: PackedRecord[] = [];
  for (const line of lines.attacking) {
    attacking.push(await evidenceItem(reader, line, false));
  }

  return { direct: sortPacked(direct), attacking: sortPacked(attacking) };
}

/** Every record id a claim's brief would read at a head, before trimming, so a budget never narrows
 * what staleness is checked against. */
export async function fullReadIds(
  view: Workspace,
  caseId: RecordId,
  gateClaimId: RecordId,
  head: string,
): Promise<RecordId[]> {
  const reader = headReader(view, head);
  const { direct, attacking } = await gatherEvidence(view, reader, gateClaimId);
  return [caseId, gateClaimId, ...[...direct, ...attacking].flatMap((item) => item.reads)];
}

/** Renders a brief as a pure function of the view and its recipe's substrates: no clock, no
 * environment, no locale. */
export async function renderBrief(view: Workspace, recipe: ComputedRecipe): Promise<BriefRender> {
  const { head, caseId, budget, kernelVersion } = parseBriefSubstrates(recipe);
  const gateClaimId = recipe.command[1] as RecordId | undefined;
  if (gateClaimId === undefined) {
    throw new RangeError("a brief's recipe names no gate claim to render");
  }

  const reader = headReader(view, head);
  const caseRecord = (await reader.read(caseId, "case")) as CaseRecord;
  const { direct: sortedDirect, attacking: sortedAttacking } = await gatherEvidence(view, reader, gateClaimId);
  const claimRecord = (await reader.read(gateClaimId, "claim")) as ClaimRecord;

  const claimItem: PackedRecord = {
    id: gateClaimId,
    kind: "claim",
    pinned: true,
    setAside: false,
    text: `- claim ${gateClaimId}: ${inlineText(renderedTextOf(claimRecord.rendering))}`,
    reads: [gateClaimId],
  };

  const { kept, omissions } = trimToBudget([claimItem, ...sortedDirect, ...sortedAttacking].map(toTrimItem), budget);
  const keptIds = new Set(kept.map((item) => item.id));

  const keptDirect = sortedDirect.filter((item) => keptIds.has(item.id));
  const keptAttacking = sortedAttacking.filter((item) => keptIds.has(item.id));

  const sections: string[] = [
    renderHeader(caseId, caseRecord, gateClaimId, kernelVersion),
    "",
    "## Claim under judgment",
    claimItem.text,
    "",
    "## Direct evidence",
    ...(keptDirect.length > 0 ? keptDirect.map((item) => item.text) : ["(none)"]),
    "",
    "## Attacking evidence",
    ...(keptAttacking.length > 0 ? keptAttacking.map((item) => item.text) : ["(none)"]),
  ];
  if (omissions.length > 0) {
    sections.push("", "## Omitted", ...omissions.map((omission) => omissionLine(omission)));
  }

  const reads: ReadEntry[] = [
    readEntryFor(caseId),
    readEntryFor(gateClaimId, slotReadKey(claimRecord.slot)),
    ...[...keptDirect, ...keptAttacking].flatMap((item) => item.reads).map((id) => readEntryFor(id)),
  ];

  return { output: sections.join("\n"), reads, omissions };
}
