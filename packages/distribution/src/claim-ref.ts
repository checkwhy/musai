import { DECLARATIVE_RULE, OperationError } from "@musai/api-core";
import type { IndexDb } from "@musai/fold";
import { type Audience, type RecordId, RecordRefusedError } from "@musai/records";
import { commandLine } from "@musai/run";

/** What naming a claim reads from the fold. */
export type ClaimLookup = Pick<
  IndexDb,
  "claimAtSlot" | "contributorsAtSlot" | "recordById" | "claimsWithHexPrefix" | "claimSlotsRendering"
>;

/** The claim type `check` mints, whose sentence names it. */
export const CHECK_CLAIM_TYPE = "musai.core/check@1";

/** What closes a fork among records of `type`, a claim type at a slot or `case` under a slug, as
 * `status`, a refused read and `doctor` tell the author. */
export function forkRemedy(type: string): string {
  const named = type === "case" ? "case" : "claim";
  const mint =
    type === CHECK_CLAIM_TYPE ? "`check --replace` mints" : `\`lab keep <${named}>\` mints from the one it names`;
  return `a successor superseding them all, as ${mint}, closes the fork`;
}

/** How a person has a claim judged by a rule: the interpreter by a command, any other by name. */
export function checkSpelling(rule: string): string {
  return rule === DECLARATIVE_RULE
    ? 'check "<sentence>" -- <command>'
    : `check "<sentence>" ${commandLine(["--rule", rule])}`;
}

export const SHORT_ID_LENGTH = 12;

/** The slot's first hex digits, which `check` prints and `status` and `why` take back. */
export function shortIdOf(slot: string): string {
  return slot.slice("sha256:".length, "sha256:".length + SHORT_ID_LENGTH);
}

/** The `status` evaluating the check at `slot` under `clearance`, as told to a reader `viewing`. */
export function statusAdvice(slot: string, clearance: Audience | undefined, viewing: Audience | undefined): string {
  const command = `\`status ${shortIdOf(slot)}\``;
  if (clearance === viewing) {
    return command;
  }
  return clearance === undefined ? `${command} without a clearance` : `${command} under the clearance ${clearance}`;
}

/** Shorter prefixes are more often a word than a label, as `musai-verify` reads them too. */
const SHORT_ID_FLOOR = 8;

const HEX_NAME = /^(?:sha256:)?([0-9a-f]+)$/;

/** The hex digits a record id, or a short id of one, spells; `undefined` for anything else. */
export function shortIdHex(named: string): string | undefined {
  const hex = HEX_NAME.exec(named)?.[1];
  return hex !== undefined && hex.length >= SHORT_ID_FLOOR && hex.length <= 64 ? hex : undefined;
}

/** The hex digits `named` spells as a record id or a short id of one, refused for anything else. */
export function idPrefixOf(named: string, what: string): string {
  const hex = shortIdHex(named);
  if (hex === undefined) {
    throw new OperationError({
      reason: "invalid-input",
      about: [named],
      detail: `${named} names no ${what}: name it by its record id or eight or more of its hex digits`,
    });
  }
  return hex;
}

/** What resolving a prefix reads of the fold beside the records it matches. */
export type RefusalLookup = Pick<IndexDb, "refusedIdsWithHexPrefix" | "refusalFor">;

/** The one of `matches` the prefix `hex` names, `undefined` for none; a refused record counts as a
 * match, so one matching it alone is refused as a read of it is. */
export function onlyMatch<T extends { readonly id: string }>(
  index: RefusalLookup,
  named: string,
  hex: string,
  matches: readonly T[],
  what: string,
): T | undefined {
  const held = new Set(matches.map(({ id }) => id));
  // A cleared fold keeps no refusal naming a record it withholds, so a station learns of none.
  const refused = index.refusedIdsWithHexPrefix(hex).filter((id) => !held.has(id));
  const ids = [...held, ...refused];
  if (ids.length > 1) {
    throw new OperationError({
      reason: "invalid-input",
      about: [named],
      detail: `${named} names ${ids.length} ${what}s: ${ids.join(", ")}; name one by more of its id`,
    });
  }
  const [unreadable] = refused;
  if (unreadable !== undefined) {
    throw new RecordRefusedError(unreadable, index.refusalFor(unreadable)!.reason);
  }
  return matches[0];
}

/** The one of `matches` the prefix `hex` names, refused where it names none or several. */
export function heldMatch<T extends { readonly id: string }>(
  index: RefusalLookup,
  named: string,
  hex: string,
  matches: readonly T[],
  what: string,
): T {
  const match = onlyMatch(index, named, hex, matches, what);
  if (match === undefined) {
    throw new OperationError({
      reason: "no-such-record",
      about: [named],
      detail: `${named} names no ${what} this workspace holds`,
    });
  }
  return match;
}

function ambiguous(named: string, slots: readonly string[], what: string): OperationError {
  return new OperationError({
    reason: "invalid-input",
    about: [named],
    detail: `${named} names ${slots.length} claims as ${what}: ${slots.join(", ")}; name one by more of its slot`,
  });
}

/** A fork names no claim as current, so each of its contributors names the slot by its own id. */
function liveAt(index: ClaimLookup, slot: string, id: string): boolean {
  return index.contributorsAtSlot(slot).some((contributor) => contributor.id === id);
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
    return held?.record.kind === "claim" && liveAt(index, held.record.slot, id) ? held.record.slot : named;
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
    .filter((row) => row.slot.startsWith(`sha256:${hex}`) || liveAt(index, row.slot, row.id));
  const slots = [...new Set(standing.map((row) => row.slot))];
  if (slots.length > 1) {
    throw ambiguous(named, slots, "a prefix");
  }
  return slots[0] ?? named;
}
