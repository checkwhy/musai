import { authorityFromAttestation, type CheckedAuthority, maySupersede } from "@musai/evaluate";
import type { IndexedRulingOnSlot } from "@musai/fold";
import {
  ANY_SCOPE,
  type ClaimRecord,
  type MadeAttestationRecord,
  type RecordId,
  type RulingRecord,
  type Timestamp,
} from "@musai/records";
import { may } from "@musai/trust";
import { verifiedAttestationsFor } from "./open-workspace.js";
import type { Workspace } from "./workspace.js";

/** A ruling as every reader weighs it: who stands behind it, at what tier, and what retired it. */
export interface WeighedRuling {
  readonly id: RecordId;
  readonly record: RulingRecord;
  readonly attestations: readonly MadeAttestationRecord[];
  readonly principals: readonly string[];
  /** `null` where nothing within the matrix vouches for it. */
  readonly tier: CheckedAuthority | null;
  readonly decidedAt: Timestamp | null;
  /** The successor whose succession counts, the first in landing order that the rule admits. */
  readonly retiredBy: RecordId | null;
}

/** Why a successor would not retire a name, or that it would. */
export type Retirement =
  | { readonly retires: true }
  | { readonly retires: false; readonly why: "not-on-slot" }
  | { readonly retires: false; readonly why: "retired"; readonly by: RecordId }
  | { readonly retires: false; readonly why: "outranked"; readonly name: WeighedRuling };

/** The successor a reader weighs: its principal, its checked tier, and the slot it rules on. */
export interface Successor {
  readonly principal: string;
  readonly tier: CheckedAuthority | null;
  readonly slot: string;
}

type Standing = Pick<WeighedRuling, "attestations" | "principals" | "tier" | "decidedAt">;

async function standingOf(opened: Workspace, id: RecordId): Promise<Standing> {
  const attestations = (await verifiedAttestationsFor(opened, id)) as readonly MadeAttestationRecord[];
  const primary = attestations[0] ?? null;
  const evaluated = authorityFromAttestation({ id }, primary, opened.matrix, ANY_SCOPE);
  return {
    attestations,
    principals: attestations.map((attestation) => attestation.principal),
    tier: evaluated?.withinAuthority ? evaluated.class : null,
    decidedAt: primary?.at ?? null,
  };
}

function admits(opened: Workspace, successor: Successor, name: Standing): boolean {
  if (successor.tier === null) {
    return false;
  }
  return maySupersede(
    { principal: successor.principal, authority: successor.tier },
    { principals: name.principals, authority: name.tier },
    may(opened.matrix, successor.principal, "override-person", ANY_SCOPE),
  );
}

function slotRuledBy(opened: Workspace, record: RulingRecord): string | null {
  return "claim" in record.over ? (opened.read(record.over.claim) as ClaimRecord).slot : null;
}

async function firstCountingSuccessor(
  opened: Workspace,
  name: IndexedRulingOnSlot,
  standing: Standing,
  slot: string,
): Promise<RecordId | null> {
  if (!("claim" in name.record.over)) {
    return null;
  }
  for (const { successor: id, kind } of name.successors) {
    if (kind !== "ruling") {
      continue;
    }
    const record = opened.read(id) as RulingRecord;
    if (slotRuledBy(opened, record) !== slot) {
      continue;
    }
    const successor = await standingOf(opened, id);
    const principal = successor.principals[0];
    if (principal !== undefined && admits(opened, { principal, tier: successor.tier, slot }, standing)) {
      return id;
    }
  }
  return null;
}

/** Every ruling on the slot's live claims, each weighed under the one succession rule. */
export async function weighedRulingsFor(opened: Workspace, slot: string): Promise<readonly WeighedRuling[]> {
  const weighed: WeighedRuling[] = [];
  for (const ruling of opened.index.rulingsFor(slot, opened.dimensions)) {
    const standing = await standingOf(opened, ruling.id);
    const retiredBy = await firstCountingSuccessor(opened, ruling, standing, slot);
    weighed.push({ id: ruling.id, record: ruling.record, ...standing, retiredBy });
  }
  return weighed;
}

/** Whether a successor not yet written would retire `name`, as `weighedRulingsFor` reads it. */
export async function retirementOf(opened: Workspace, name: RecordId, successor: Successor): Promise<Retirement> {
  const named = (await weighedRulingsFor(opened, successor.slot)).find((ruling) => ruling.id === name);
  if (named === undefined || !("claim" in named.record.over)) {
    return { retires: false, why: "not-on-slot" };
  }
  if (named.retiredBy !== null) {
    return { retires: false, why: "retired", by: named.retiredBy };
  }
  return admits(opened, successor, named) ? { retires: true } : { retires: false, why: "outranked", name: named };
}
