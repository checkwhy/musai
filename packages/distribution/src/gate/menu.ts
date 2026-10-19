import type { Workspace } from "@musai/api-core";
import { OperationError } from "@musai/api-core";
import { type ClaimRecord, conditionString, type RecordId, renderedTextOf } from "@musai/records";
import { applyingMembers } from "../claim.js";

/** One choice a gate's menu offers. `value` is the member's `disposition` where declared, so two
 * packs using one word for one idea offer the same choice. */
export interface MenuOption {
  readonly claim: RecordId;
  readonly value: string;
  readonly description: string;
}

/** Refused at ask time for a menu a person could not use: a retired claim, no applying member, or
 * a value twice. */
export class MenuRefusedError extends OperationError {
  constructor(about: readonly string[], detail: string) {
    super({ reason: "no-such-record", about, detail });
    this.name = "MenuRefusedError";
  }
}

function fallsFalsifyingDescription(rendering: string): string {
  return `not: ${rendering}`;
}

function binaryMenu(claimId: RecordId, claim: ClaimRecord): readonly MenuOption[] {
  return [
    { claim: claimId, value: "holds", description: renderedTextOf(claim.rendering) },
    { claim: claimId, value: "fails", description: fallsFalsifyingDescription(renderedTextOf(claim.rendering)) },
  ];
}

/** The value a menu offers a member under. A group is admitted against it, so the menu a plan opens
 * is the menu a person is later asked. */
export function optionValue(claimId: RecordId, claim: ClaimRecord): string {
  return conditionString(claim.conditions, "disposition") ?? claimId;
}

/** The menu a gate claim offers: one option per applying member of its group, or `holds` and
 * `fails` for a claim naming no group. */
export function askMenu(
  view: Workspace,
  gateClaimId: RecordId,
): { readonly group: string | null; readonly options: readonly MenuOption[] } {
  const claim = view.read(gateClaimId) as ClaimRecord;
  const successors = view.index.successorsOf(gateClaimId);
  if (successors.length > 0) {
    throw new MenuRefusedError(
      [gateClaimId],
      `${gateClaimId} was superseded by ${successors.map((entry) => entry.successor).join(", ")}, so it offers no menu`,
    );
  }
  const group = claim.exclusiveGroup;

  if (group === null) {
    return { group, options: binaryMenu(gateClaimId, claim) };
  }

  const siblings = applyingMembers(view, group);
  if (siblings.length === 0) {
    throw new MenuRefusedError(
      [group],
      `exclusive group ${group} names no member that applies here to offer a menu over`,
    );
  }

  const options: MenuOption[] = siblings.map((sibling) => {
    const record = sibling.record as ClaimRecord;
    return { claim: sibling.id, value: optionValue(sibling.id, record), description: renderedTextOf(record.rendering) };
  });

  const seen = new Set<string>();
  for (const option of options) {
    if (seen.has(option.value)) {
      throw new MenuRefusedError(
        [group, option.value],
        `exclusive group ${group} offers the value ${option.value} more than once, and a person could not tell its options apart`,
      );
    }
    seen.add(option.value);
  }

  return { group, options };
}
