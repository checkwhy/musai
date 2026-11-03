import type { Workspace } from "@musai/api-core";
import {
  admitCitedEdge,
  buildAdmissionWorkspace,
  definedOperation,
  installedModules,
  MINTED_ARRAY_SCHEMA,
  OperationError,
  type OperationHandler,
  saltAsked,
  type WriteResult,
} from "@musai/api-core";
import type { AdmissionWorkspace } from "@musai/evaluate";
import {
  type CaseRecord,
  type ClaimRecord,
  CURRENT_SCHEMA_VERSIONS,
  type EvidenceEdge,
  type RecordId,
  versionString,
} from "@musai/records";
import { idPrefixOf, onlyMatch, shortIdOf } from "../claim-ref.js";

export interface ForkKeepInput {
  readonly record: string;
}

export interface ForkKeepOutput extends WriteResult {
  readonly successor: RecordId;
  readonly supersedes: readonly RecordId[];
  readonly slot?: string;
  readonly slug?: string;
}

function renderForkKeepText(output: ForkKeepOutput): string {
  return `${output.successor} supersedes ${output.supersedes.map(shortIdOf).join(", ")}`;
}

type Kept =
  | { readonly kind: "claim"; readonly id: RecordId; readonly slot: string }
  | { readonly kind: "case"; readonly id: RecordId; readonly slug: string };

/** The live claim contributor or live case a record id or a prefix of one names. */
function keptRecord(opened: Workspace, named: string): Kept {
  const hex = idPrefixOf(named, "claim or case to keep");
  const rows = opened.index.claimsWithHexPrefix(hex);
  const claims = rows.filter((row) => row.id.startsWith(`sha256:${hex}`));
  const found = onlyMatch(opened.index, named, hex, [...claims, ...opened.index.casesWithHexPrefix(hex)], "record");
  if (found === undefined) {
    const slot = rows.find((row) => row.slot.startsWith(`sha256:${hex}`))?.slot;
    const held = slot === undefined ? [] : opened.index.contributorsAtSlot(slot).map((row) => row.id);
    throw new OperationError({
      reason: "no-such-record",
      about: [named],
      detail:
        slot === undefined
          ? `${named} names no claim or case this workspace holds`
          : `${named} names the slot ${slot}, and a slot keeps one of its contributors: ${held.join(", ")}`,
    });
  }
  if ("record" in found) {
    if (!opened.index.casesAtSlug(found.record.slug).some(({ id }) => id === found.id)) {
      throw retired(opened, found.id);
    }
    return { kind: "case", id: found.id, slug: found.record.slug };
  }
  if (!opened.index.contributorsAtSlot(found.slot).some((row) => row.id === found.id)) {
    throw retired(opened, found.id);
  }
  return { kind: "claim", id: found.id, slot: found.slot };
}

function retired(opened: Workspace, id: RecordId): OperationError {
  const successors = opened.index.successorsOf(id).map(({ successor }) => successor);
  return new OperationError({
    reason: "no-such-record",
    about: [id],
    detail: `refusing to keep ${id}: ${successors.join(", ")} superseded it, so it is no longer live`,
  });
}

/** The kept claim's edges are admitted again, as every verb minting an edge admits its own. */
async function admitKeptEvidence(opened: Workspace, evidence: readonly EvidenceEdge[]): Promise<void> {
  let admissionWorkspace: AdmissionWorkspace | undefined;
  for (const edge of evidence) {
    admissionWorkspace ??= await buildAdmissionWorkspace(opened, await installedModules(opened));
    await admitCitedEdge(edge, opened, admissionWorkspace);
  }
}

function noFork(id: RecordId, at: string, held: string): OperationError {
  return new OperationError({
    reason: "invalid-input",
    about: [id, at],
    detail: `refusing to keep ${id}: ${held} holds no fork, and a successor kept from one of its records closes a fork`,
  });
}

const forkKeepHandler: OperationHandler<ForkKeepInput, ForkKeepOutput> = {
  async plan(input, opened) {
    if (opened.clearance !== undefined) {
      throw new OperationError({
        reason: "invalid-input",
        about: [opened.clearance],
        detail: `refusing to keep under the clearance ${opened.clearance}: a successor supersedes every live record its fork holds, and a cleared fold may miss one sealed from it; keep from a surface launched with no clearance`,
      });
    }
    const kept = keptRecord(opened, input.record);
    if (kept.kind === "case") {
      const supersedes = opened.index.casesAtSlug(kept.slug).map(({ id }) => id);
      if (supersedes.length < 2) {
        throw noFork(kept.id, kept.slug, `its slug ${kept.slug}`);
      }
      const { salt, ...record } = opened.read(kept.id) as CaseRecord & { readonly salt?: string };
      const successor: CaseRecord = { ...record, schemaVersion: CURRENT_SCHEMA_VERSIONS.case, supersedes };
      return {
        plan: { put: [{ kind: "case", value: successor, ...saltAsked(salt !== undefined) }], attest: [], needs: [] },
        output: (applied) => ({
          minted: applied.minted,
          successor: applied.minted[0]!.id,
          supersedes,
          slug: kept.slug,
        }),
      };
    }
    if (opened.index.forkAtSlot(kept.slot).length === 0) {
      throw noFork(kept.id, kept.slot, `its slot ${shortIdOf(kept.slot)}`);
    }
    const { salt, ...record } = opened.read(kept.id) as ClaimRecord & { readonly salt?: string };
    await admitKeptEvidence(opened, record.evidence);
    const supersedes = opened.index.contributorsAtSlot(kept.slot).map((row) => row.id);
    const successor: ClaimRecord = { ...record, schemaVersion: CURRENT_SCHEMA_VERSIONS.claim, supersedes };
    return {
      plan: { put: [{ kind: "claim", value: successor, ...saltAsked(salt !== undefined) }], attest: [], needs: [] },
      output: (applied) => ({ minted: applied.minted, successor: applied.minted[0]!.id, supersedes, slot: kept.slot }),
    };
  },
};

/** `fork.keep@1`: closes a forked slot or slug by a successor carrying the claim or case named,
 * superseding every live record the fork holds. */
export const forkKeep = definedOperation<ForkKeepInput, ForkKeepOutput>(
  {
    id: "fork.keep",
    version: versionString("1"),
    input: {
      type: "object",
      additionalProperties: false,
      required: ["record"],
      properties: {
        record: { type: "string", description: "the record id, or a prefix of it, of the claim or case to keep" },
      },
    },
    output: {
      type: "object",
      additionalProperties: false,
      required: ["minted", "successor", "supersedes"],
      properties: {
        minted: MINTED_ARRAY_SCHEMA,
        successor: { type: "string" },
        supersedes: { type: "array", items: { type: "string" } },
        slot: { type: "string" },
        slug: { type: "string" },
      },
    },
    effect: "write",
    authority: null,
    reasons: ["head-moved", "invalid-input", "no-such-record"],
    documentation:
      "Closes a forked slot or slug by a successor carrying the claim or case named, superseding every live record the fork holds.",
    cli: {
      verb: "keep",
      positional: ["record"],
      flags: [],
      describe: "close a forked slot or slug, keeping the claim or case named and superseding every other",
    },
    renderText: renderForkKeepText,
    exitCode: () => 0,
  },
  forkKeepHandler,
);
