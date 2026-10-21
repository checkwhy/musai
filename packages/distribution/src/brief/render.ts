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
import { type HoldingCheck, holdingCheck } from "../evaluation.js";
import { inlineText } from "../text.js";
import { parseBriefSubstrates } from "./recipe.js";
import { type Omission, omissionLine, type TrimItem, trimToBudget } from "./trim.js";

/** One record a brief packed. `pinned` is never trimmed; `text` is the line the trim counted. */
export interface PackedRecord {
  readonly id: RecordId;
  readonly kind: "claim" | "argument" | EvidenceKind;
  readonly pinned: boolean;
  readonly setAside: boolean;
  readonly text: string;
  /** The argument an attacking line quotes, whose lines the trim keeps or drops together. */
  readonly argument?: RecordId;
  /** Every record whose bytes `text` carries, so a seal on any of them withholds the brief. */
  readonly reads: readonly RecordId[];
}

/** An argument a brief weighs: one standing against its claim or a run the claim cites. */
export interface StandingArgument {
  readonly id: RecordId;
  readonly record: ArgumentRecord;
}

/** An argument packed by its reason; `run` names the cited run it contests, if not the claim. */
export interface Contest {
  readonly argument: RecordId;
  readonly reason: string;
  readonly run?: RecordId;
}

/** A line a brief packs: an evidence run, and for an attack the argument whose reason it quotes. */
export interface BriefLine {
  readonly run: RecordId;
  /** What reads the run as evidence: an edge's selector, or the rule a holding check rests on. */
  readonly by: string;
  readonly attack?: Contest;
}

function edgeLine(edge: EvidenceEdge): BriefLine {
  return { run: edge.run, by: renderSelector(edge.selector) };
}

function contestOf(claimId: RecordId, { id, record }: StandingArgument): Contest {
  const reason = renderedTextOf(record.reason);
  return record.target === claimId ? { argument: id, reason } : { argument: id, reason, run: record.target };
}

/** What a brief over `claim` packs before trimming, given what stands against each target and
 * the check it rests on where one holds: the one home for what a brief reads. */
export function briefLines(
  view: Workspace,
  claimId: RecordId,
  claim: ClaimRecord,
  against: (target: RecordId) => readonly StandingArgument[],
  check: HoldingCheck | null,
): {
  readonly direct: readonly BriefLine[];
  readonly attacking: readonly BriefLine[];
  readonly withheld: readonly Contest[];
} {
  const checked = check === null ? [] : check.receipts.map((run) => ({ run, by: `rule ${check.rule}` }));
  // A run the claim rests on but this view withholds supports nothing here, so nothing contests it.
  const direct = citedEvidence(view, [...claim.evidence.map(edgeLine), ...checked]);
  const cites = [...new Set(direct.map((line) => line.run))].sort();
  const standing = [claimId, ...cites].flatMap((target) => against(target));
  return {
    direct,
    attacking: standing.flatMap((argument) =>
      citedEvidence(view, argument.record.evidence).map((edge) => ({
        ...edgeLine(edge),
        attack: contestOf(claimId, argument),
      })),
    ),
    withheld: standing
      .filter(({ record }) => citedEvidence(view, record.evidence).length < record.evidence.length)
      .map((argument) => contestOf(claimId, argument)),
  };
}

export function lineReadIds(line: BriefLine): RecordId[] {
  return line.attack === undefined ? [line.run] : [line.run, line.attack.argument];
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

/** Whether an attestation gives its subject's principal class, which a testimony's kind reads. */
export function givesPrincipalClass(record: AttestationRecord): boolean {
  return record.purpose === "made" || record.purpose === "asserted";
}

/** The attestation behind a subject, unverified: a kind needs only the principal's class. */
async function firstAttestation(
  reader: HeadReader,
  subject: RecordId,
): Promise<(AttestationPrincipalSource & { readonly id: RecordId }) | null> {
  const ids = await reader.list("attestation");
  for (const id of [...ids].sort()) {
    const record = (await reader.read(id, "attestation")) as AttestationRecord;
    if (record.subject === subject && givesPrincipalClass(record)) {
      return { id, principalClass: record.principalClass };
    }
  }
  return null;
}

async function evidenceItem(reader: HeadReader, line: BriefLine, pinned: boolean): Promise<PackedRecord> {
  const { attack } = line;
  const run = (await reader.read(line.run, "run")) as RunRecord;
  const attestation = run.runKind === "testimony" ? await firstAttestation(reader, line.run) : null;
  const kind = evidenceKindOf(run, attestation);
  const by = inlineText(line.by);
  const against = attack?.run === undefined ? "" : ` against the run ${attack.run}`;
  const suffix = attack !== undefined ? `${against}: ${inlineText(attack.reason)}` : "";
  return {
    id: line.run,
    kind,
    pinned,
    setAside: false,
    text: `- ${kind} ${line.run} (${by})${suffix}`,
    reads: attestation === null ? lineReadIds(line) : [...lineReadIds(line), attestation.id],
    ...(attack === undefined ? {} : { argument: attack.argument }),
  };
}

function ladderKindOf(kind: PackedRecord["kind"]): EvidenceKind {
  return kind === "claim" || kind === "argument" ? "receipt" : kind;
}

/** A contest the view withholds the grounds of is pinned, so no budget hides that it stands. */
function withheldItem(view: Workspace, attack: Contest): PackedRecord {
  const contested = attack.run === undefined ? "the claim" : `the run ${attack.run}`;
  return {
    id: attack.argument,
    kind: "argument",
    pinned: true,
    setAside: false,
    text: `- argument ${attack.argument} contests ${contested} on grounds withheld under the clearance ${view.clearance}: ${inlineText(attack.reason)}`,
    reads: [attack.argument],
  };
}

function evidenceRankOf(item: PackedRecord): number {
  return EVIDENCE_ORDER.indexOf(ladderKindOf(item.kind));
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
    evidenceKind: ladderKindOf(record.kind),
    setAside: record.setAside,
    pinned: record.pinned,
    bytes: new TextEncoder().encode(record.text).byteLength,
  };
}

/** Each argument's lines as one item ranked by its strongest line, named apart from the argument's
 * pinned line on withheld grounds, so an omission never names a line still printed. */
function argumentTrimItems(
  attacking: readonly PackedRecord[],
  withheld: readonly PackedRecord[],
): Map<RecordId, TrimItem> {
  const pinned = new Set(withheld.map((line) => line.id));
  const byArgument = new Map<RecordId, PackedRecord[]>();
  for (const line of attacking) {
    byArgument.set(line.argument!, [...(byArgument.get(line.argument!) ?? []), line]);
  }
  return new Map(
    [...byArgument].map(([argument, lines]) => {
      const strongest = lines.reduce((best, line) => (evidenceRankOf(line) < evidenceRankOf(best) ? line : best));
      const item: TrimItem = {
        ...toTrimItem(strongest),
        id: pinned.has(argument) ? `the evidence of ${argument}` : argument,
        bytes: lines.reduce((total, line) => total + toTrimItem(line).bytes, 0),
      };
      return [argument, item];
    }),
  );
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
): Promise<{ direct: PackedRecord[]; attacking: PackedRecord[]; withheld: PackedRecord[] }> {
  const claimRecord = (await reader.read(gateClaimId, "claim")) as ClaimRecord;

  // Read off the head, not the fold, so a re-render at an older head packs what stood then.
  const argumentsAtHead: StandingArgument[] = [];
  const superseded = new Set<RecordId>();
  for (const argumentId of [...(await reader.list("argument"))].sort()) {
    const record = (await reader.read(argumentId, "argument")) as ArgumentRecord;
    argumentsAtHead.push({ id: argumentId, record });
    for (const predecessor of record.supersedes) {
      superseded.add(predecessor);
    }
  }

  const standing = new Map<RecordId, StandingArgument[]>();
  for (const argument of argumentsAtHead) {
    if (!superseded.has(argument.id)) {
      standing.set(argument.record.target, [...(standing.get(argument.record.target) ?? []), argument]);
    }
  }
  const landedAtHead = new Set([...(await reader.list("run")), ...(await reader.list("module"))]);
  const lines = briefLines(
    view,
    gateClaimId,
    claimRecord,
    (target) => standing.get(target) ?? [],
    holdingCheck(view.index, claimRecord, (id) => landedAtHead.has(id), view.clearance),
  );
  const direct: PackedRecord[] = [];
  for (const line of lines.direct) {
    direct.push(await evidenceItem(reader, line, true));
  }
  const attacking: PackedRecord[] = [];
  for (const line of lines.attacking) {
    attacking.push(await evidenceItem(reader, line, false));
  }

  const withheld = lines.withheld.map((attack) => withheldItem(view, attack));
  return { direct: sortPacked(direct), attacking: sortPacked(attacking), withheld };
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
  const { direct, attacking, withheld } = await gatherEvidence(view, reader, gateClaimId);
  return [caseId, gateClaimId, ...[...direct, ...attacking, ...withheld].flatMap((item) => item.reads)];
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
  const {
    direct: sortedDirect,
    attacking: sortedAttacking,
    withheld,
  } = await gatherEvidence(view, reader, gateClaimId);
  const claimRecord = (await reader.read(gateClaimId, "claim")) as ClaimRecord;

  const claimItem: PackedRecord = {
    id: gateClaimId,
    kind: "claim",
    pinned: true,
    setAside: false,
    text: `- claim ${gateClaimId}: ${inlineText(renderedTextOf(claimRecord.rendering))}`,
    reads: [gateClaimId],
  };

  const byArgument = argumentTrimItems(sortedAttacking, withheld);
  const { kept, omissions } = trimToBudget(
    [...[claimItem, ...sortedDirect, ...withheld].map(toTrimItem), ...byArgument.values()],
    budget,
  );
  const keptItems = new Set(kept);

  const keptAttacking = [
    ...sortedAttacking.filter((item) => keptItems.has(byArgument.get(item.argument!)!)),
    ...withheld,
  ];

  const sections: string[] = [
    renderHeader(caseId, caseRecord, gateClaimId, kernelVersion),
    "",
    "## Claim under judgment",
    claimItem.text,
    "",
    "## Direct evidence",
    ...(sortedDirect.length > 0 ? sortedDirect.map((item) => item.text) : ["(none)"]),
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
    ...[...sortedDirect, ...keptAttacking].flatMap((item) => item.reads).map((id) => readEntryFor(id)),
  ];

  return { output: sections.join("\n"), reads, omissions };
}
