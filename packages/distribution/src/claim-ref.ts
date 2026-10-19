import { DECLARATIVE_RULE, OperationError } from "@musai/api-core";
import type { IndexDb } from "@musai/fold";
import type { RecordId } from "@musai/records";

/** What naming a claim reads from the fold. */
export type ClaimLookup = Pick<IndexDb, "claimAtSlot" | "recordById" | "claimsWithHexPrefix" | "claimSlotsRendering">;

/** The claim type `check` mints, whose sentence names it. */
export const CHECK_CLAIM_TYPE = "musai.core/check@1";

/** How a person has a claim judged by a rule: the interpreter by a command, any other by name. */
export function checkSpelling(rule: string): string {
  return rule === DECLARATIVE_RULE ? 'check "<sentence>" -- <command>' : `check "<sentence>" --rule ${rule}`;
}

const SHORT_ID_LENGTH = 12;

/** The slot's first hex digits, which `check` prints and `status` and `why` take back. */
export function shortIdOf(slot: string): string {
  return slot.slice("sha256:".length, "sha256:".length + SHORT_ID_LENGTH);
}

/** Shorter prefixes are more often a word than a label, as `musai-verify` reads them too. */
const SHORT_ID_FLOOR = 8;

const HEX_NAME = /^(?:sha256:)?([0-9a-f]+)$/;

function ambiguous(named: string, slots: readonly string[], what: string): OperationError {
  return new OperationError({
    reason: "invalid-input",
    about: [named],
    detail: `${named} names ${slots.length} claims as ${what}: ${slots.join(", ")}; name one by more of its slot`,
  });
}

/** The slot a slot, a claim's record id, a prefix of either or a check's exact sentence names; a
 * name matching none is handed back for the caller to refuse. */
export function claimSlotNamed(index: ClaimLookup, named: string): string {
  if (index.claimAtSlot(named) !== undefined) {
    return named;
  }
  const hex = HEX_NAME.exec(named)?.[1];
  if (hex?.length === 64) {
    const id = `sha256:${hex}` as RecordId;
    const held = index.recordById(id);
    // A superseded claim's id is handed back, so the caller's refusal names what replaced it.
    return held?.record.kind === "claim" && index.claimAtSlot(held.record.slot)?.id === id ? held.record.slot : named;
  }
  const sentences = index.claimSlotsRendering(CHECK_CLAIM_TYPE, named);
  if (sentences.length > 1) {
    throw ambiguous(named, sentences, "a sentence");
  }
  if (sentences.length === 1) {
    return sentences[0]!;
  }
  if (hex === undefined) {
    return named;
  }
  if (hex.length < SHORT_ID_FLOOR) {
    throw new OperationError({
      reason: "invalid-input",
      about: [named],
      detail: `${named} is too short to name a claim: a short id names at least eight hex characters of its slot or record id`,
    });
  }
  // A superseded claim's id names nothing, as its full id does; its slot still names the claim.
  const standing = index
    .claimsWithHexPrefix(hex)
    .filter((row) => row.slot.startsWith(`sha256:${hex}`) || index.claimAtSlot(row.slot)?.id === row.id);
  const slots = [...new Set(standing.map((row) => row.slot))];
  if (slots.length > 1) {
    throw ambiguous(named, slots, "a prefix");
  }
  return slots[0] ?? named;
}
