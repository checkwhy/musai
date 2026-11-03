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
}

export interface Omission {
  readonly id: string;
  readonly reason: "over-budget";
}

export interface TrimResult {
  readonly kept: readonly TrimItem[];
  readonly omissions: readonly Omission[];
}

/** An omitted item's line as the rendered brief prints it under its omissions. */
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

/** Trims unpinned items weakest first until what `sizeOf` measures of the result fits the budget.
 * A budget the pinned items and the omission list overflow is refused rather than exceeded. */
export function trimToBudget(
  items: readonly TrimItem[],
  budget: number,
  sizeOf: (result: TrimResult) => number,
): TrimResult {
  const pinned = items.filter((item) => item.pinned);

  let kept = items
    .filter((item) => !item.pinned)
    .slice()
    .sort(compareForTrim);
  const omissions: Omission[] = [];

  const totalBytes = (): number => sizeOf({ kept: [...pinned, ...kept], omissions });

  while (totalBytes() > budget && kept.length > 0) {
    const weakest = kept[0]!;
    kept = kept.slice(1);
    omissions.push({ id: weakest.id, reason: "over-budget" });
  }

  if (totalBytes() > budget) {
    throw new OperationError({
      reason: "over-budget",
      about: pinned.map((item) => item.id),
      detail: `refusing to trim: even with every trimmable item removed, the brief's header, the claim under judgment, its direct evidence, any contest on withheld grounds and the omission list occupy ${String(totalBytes())} bytes against a budget of ${String(budget)}`,
    });
  }

  return { kept: [...pinned, ...kept], omissions };
}
