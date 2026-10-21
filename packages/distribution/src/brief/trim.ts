import { OperationError } from "@musai/api-core";
import { EVIDENCE_ORDER, type EvidenceKind } from "@musai/evaluate";

/** The evidence order reversed: an agent's guess is the first thing a tight budget gives up. */
export const TRIM_ORDER: readonly EvidenceKind[] = [...EVIDENCE_ORDER].reverse();

function trimRank(kind: EvidenceKind): number {
  return TRIM_ORDER.indexOf(kind);
}

/** A string's UTF-8 byte length, the unit every brief budget counts in. */
export function byteLengthUtf8(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** One item the trim weighs; a set-aside run trims before a standing one of its kind. */
export interface TrimItem {
  readonly id: string;
  readonly evidenceKind: EvidenceKind;
  readonly setAside: boolean;
  readonly pinned: boolean;
  readonly bytes: number;
}

export interface Omission {
  readonly id: string;
  readonly reason: "over-budget";
}

export interface TrimResult {
  readonly kept: readonly TrimItem[];
  readonly omissions: readonly Omission[];
}

/** An omitted item's line, shared by the trim's sizing and the render so the two agree on bytes. */
export function omissionLine(omission: Omission): string {
  return `- ${omission.id} — omitted (${omission.reason})`;
}

function compareForTrim(a: TrimItem, b: TrimItem): number {
  const rankA = trimRank(a.evidenceKind);
  const rankB = trimRank(b.evidenceKind);
  if (rankA !== rankB) {
    return rankA - rankB;
  }
  if (a.setAside !== b.setAside) {
    return a.setAside ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function sumBytes(items: readonly TrimItem[]): number {
  return items.reduce((total, item) => total + item.bytes, 0);
}

function omissionBytes(omissions: readonly Omission[]): number {
  return omissions.reduce((total, omission) => total + byteLengthUtf8(omissionLine(omission)), 0);
}

/** Trims unpinned items weakest first until they and the omission list fit the budget. A budget the
 * pinned items and the list overflow is refused rather than exceeded. */
export function trimToBudget(items: readonly TrimItem[], budget: number): TrimResult {
  const pinned = items.filter((item) => item.pinned);
  const pinnedBytes = sumBytes(pinned);

  let kept = items
    .filter((item) => !item.pinned)
    .slice()
    .sort(compareForTrim);
  const omissions: Omission[] = [];

  const totalBytes = (): number => pinnedBytes + sumBytes(kept) + omissionBytes(omissions);

  while (totalBytes() > budget && kept.length > 0) {
    const weakest = kept[0]!;
    kept = kept.slice(1);
    omissions.push({ id: weakest.id, reason: "over-budget" });
  }

  if (totalBytes() > budget) {
    throw new OperationError({
      reason: "over-budget",
      about: pinned.map((item) => item.id),
      detail: `refusing to trim: even with every trimmable item removed, the claim under judgment, its direct evidence, any contest on withheld grounds and the omission list occupy ${String(totalBytes())} bytes against a budget of ${String(budget)}`,
    });
  }

  return { kept: [...pinned, ...kept], omissions };
}
