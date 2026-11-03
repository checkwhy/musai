import type { Workspace } from "@musai/api-core";
import { givesPrincipalClass, makerFirst, OperationError } from "@musai/api-core";
import { type AttestationPrincipalSource, EVIDENCE_ORDER, type EvidenceKind, evidenceKindOf } from "@musai/evaluate";
import {
  type ArgumentRecord,
  type AttestationRecord,
  type Audience,
  type CaseRecord,
  type ClaimRecord,
  type ComputedRecipe,
  type ComputedRunRecord,
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
import { statusAdvice } from "../claim-ref.js";
import { type ConcludedCheck, concludedCheck, unevaluatedSinceRebuild } from "../evaluation.js";
import { inlineText } from "../text.js";
import { briefClearanceOf, parseBriefSubstrates } from "./recipe.js";
import { byteLengthUtf8, type Omission, omissionLine, type TrimItem, type TrimResult, trimToBudget } from "./trim.js";

/** One record a brief packed. `pinned` is never trimmed; `text` is its line in the brief. */
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
  /** What reads the run as evidence: an edge's selector, or the rule a check concluded by. */
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
 * the check where it concluded, a failing one's receipts apart: the one home for what it reads. */
export function briefLines(
  view: Workspace,
  claimId: RecordId,
  claim: ClaimRecord,
  against: (target: RecordId) => readonly StandingArgument[],
  check: ConcludedCheck | null,
): {
  readonly direct: readonly BriefLine[];
  readonly failing: readonly BriefLine[];
  readonly attacking: readonly BriefLine[];
  readonly withheld: readonly Contest[];
} {
  const ruled = (said: string) =>
    check === null ? [] : check.receipts.map((run) => ({ run, by: `rule ${check.rule}${said}` }));
  const holds = check?.verdict === "holds";
  // A run the claim rests on but this view withholds counts for nothing, so nothing contests it.
  const direct = citedEvidence(view, [...claim.evidence.map(edgeLine), ...(holds ? ruled("") : [])]);
  const failing = citedEvidence(view, holds ? [] : ruled(", which fails"));
  const cites = [...new Set([...direct, ...failing].map((line) => line.run))].sort();
  const standing = [claimId, ...cites].flatMap((target) => against(target));
  return {
    direct,
    failing,
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

/** The maker's attestation behind a subject, unverified, since a kind reads only its class. */
async function makerAttestation(
  reader: HeadReader,
  subject: RecordId,
): Promise<(AttestationPrincipalSource & { readonly id: RecordId }) | null> {
  const found: { readonly id: RecordId; readonly record: AttestationRecord }[] = [];
  for (const id of [...(await reader.list("attestation"))].sort()) {
    const record = (await reader.read(id, "attestation")) as AttestationRecord;
    if (record.subject === subject && givesPrincipalClass(record)) {
      found.push({ id, record });
      if (record.purpose === "made") {
        break;
      }
    }
  }
  const maker = makerFirst(found);
  return maker === null ? null : { id: maker.id, principalClass: maker.record.principalClass };
}

async function evidenceItem(reader: HeadReader, line: BriefLine, pinned: boolean): Promise<PackedRecord> {
  const { attack } = line;
  const run = (await reader.read(line.run, "run")) as RunRecord;
  const attestation = run.runKind === "testimony" ? await makerAttestation(reader, line.run) : null;
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

/** The runs and modules landed at the head `reader` reads, which choose a check's evaluation. */
async function landedAtHead(reader: HeadReader): Promise<(id: RecordId) => boolean> {
  const landed = new Set([...(await reader.list("run")), ...(await reader.list("module"))]);
  return (id) => landed.has(id);
}

/** The pinned line a brief carries where its claim's check has not run since its rule's rebuild,
 * naming its status for any reader, since the brief then packs none of the check's receipts. */
function unrunCheckLine(view: Workspace, landed: (id: RecordId) => boolean, claimRecord: ClaimRecord): string | null {
  return unevaluatedSinceRebuild(view.index, claimRecord, landed, view.clearance)
    ? `- the claim's check has not run since its rule was rebuilt; ${statusAdvice(claimRecord.slot, view.clearance, undefined)} evaluates it`
    : null;
}

/** The check a rendered brief packed, read at its head under the clearance it was rendered in. */
export async function packedCheck(
  view: Workspace,
  brief: ComputedRunRecord,
  claimRecord: ClaimRecord,
): Promise<ConcludedCheck | null> {
  const reader = headReader(view, parseBriefSubstrates(brief.recipe).head);
  return concludedCheck(view.index, claimRecord, await landedAtHead(reader), briefClearanceOf(brief.recipe));
}

/** Every evidence item a claim's brief under `clearance` would pack at a head, before trimming: the
 * one home for what a claim's evidence means, shared with the staleness check. */
async function gatherEvidence(
  view: Workspace,
  reader: HeadReader,
  landed: (id: RecordId) => boolean,
  gateClaimId: RecordId,
  clearance: Audience | undefined,
): Promise<{ direct: PackedRecord[]; failing: PackedRecord[]; attacking: PackedRecord[]; withheld: PackedRecord[] }> {
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
  const lines = briefLines(
    view,
    gateClaimId,
    claimRecord,
    (target) => standing.get(target) ?? [],
    concludedCheck(view.index, claimRecord, landed, clearance),
  );
  const direct: PackedRecord[] = [];
  for (const line of lines.direct) {
    direct.push(await evidenceItem(reader, line, true));
  }
  const failing: PackedRecord[] = [];
  for (const line of lines.failing) {
    failing.push(await evidenceItem(reader, line, true));
  }
  const attacking: PackedRecord[] = [];
  for (const line of lines.attacking) {
    attacking.push(await evidenceItem(reader, line, false));
  }

  const withheld = lines.withheld.map((attack) => withheldItem(view, attack));
  return { direct: sortPacked(direct), failing: sortPacked(failing), attacking: sortPacked(attacking), withheld };
}

/** Every record id a claim's brief under `clearance` would read at a head, before trimming, so a
 * budget never narrows what staleness is checked against. */
export async function fullReadIds(
  view: Workspace,
  caseId: RecordId,
  gateClaimId: RecordId,
  head: string,
  clearance: Audience | undefined,
): Promise<RecordId[]> {
  const reader = headReader(view, head);
  const { direct, failing, attacking, withheld } = await gatherEvidence(
    view,
    reader,
    await landedAtHead(reader),
    gateClaimId,
    clearance,
  );
  return [caseId, gateClaimId, ...[...direct, ...failing, ...attacking, ...withheld].flatMap((item) => item.reads)];
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
  const landed = await landedAtHead(reader);
  const caseRecord = (await reader.read(caseId, "case")) as CaseRecord;
  const {
    direct: sortedDirect,
    failing,
    attacking: sortedAttacking,
    withheld,
  } = await gatherEvidence(view, reader, landed, gateClaimId, view.clearance);
  const claimRecord = (await reader.read(gateClaimId, "claim")) as ClaimRecord;

  const claimItem: PackedRecord = {
    id: gateClaimId,
    kind: "claim",
    pinned: true,
    setAside: false,
    text: `- claim ${gateClaimId}: ${inlineText(renderedTextOf(claimRecord.rendering))}`,
    reads: [gateClaimId],
  };

  const unrun = unrunCheckLine(view, landed, claimRecord);
  const unrunItem: TrimItem[] =
    unrun === null ? [] : [{ id: unrun, evidenceKind: "receipt", setAside: false, pinned: true }];

  const header = renderHeader(caseId, caseRecord, gateClaimId, kernelVersion);
  const byArgument = argumentTrimItems(sortedAttacking, withheld);
  const compose = ({ kept, omissions }: TrimResult) => {
    const keptItems = new Set(kept);
    const keptAttacking = [
      ...failing,
      ...sortedAttacking.filter((item) => keptItems.has(byArgument.get(item.argument!)!)),
      ...withheld,
    ];
    const sections: string[] = [
      header,
      "",
      "## Claim under judgment",
      claimItem.text,
      ...(unrun === null ? [] : [unrun]),
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
    return { output: sections.join("\n"), keptAttacking };
  };
  const trimmed = trimToBudget(
    [...[claimItem, ...sortedDirect, ...failing, ...withheld].map(toTrimItem), ...unrunItem, ...byArgument.values()],
    budget,
    (result) => byteLengthUtf8(compose(result).output),
  );
  const { output, keptAttacking } = compose(trimmed);

  const reads: ReadEntry[] = [
    readEntryFor(caseId),
    readEntryFor(gateClaimId, slotReadKey(claimRecord.slot)),
    ...[...sortedDirect, ...keptAttacking].flatMap((item) => item.reads).map((id) => readEntryFor(id)),
  ];

  return { output, reads, omissions: trimmed.omissions };
}
