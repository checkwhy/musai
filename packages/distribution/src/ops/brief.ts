import type { Workspace } from "@musai/api-core";
import {
  definedOperation,
  MINTED_ARRAY_SCHEMA,
  OperationError,
  type OperationHandler,
  type WriteResult,
} from "@musai/api-core";
import { readPresetDeclarations, readSlotDeclarations } from "@musai/modules";
import {
  type CaseRecord,
  type ComputedRunRecord,
  CURRENT_SCHEMA_VERSIONS,
  EVALUATOR_VERSION,
  LayerRefusedError,
  type RecordId,
  resolveSlot,
  versionString,
} from "@musai/records";
import { RUNNER_PERFORMER } from "@musai/run";
import { BRIEF_BUDGET_SLOT_ID, briefRecipe } from "../brief/recipe.js";
import { renderBrief } from "../brief/render.js";
import { findCaseForClaim } from "../cases.js";

export interface BriefRenderInput {
  readonly claim: string;
  readonly budget?: number;
}

export interface BriefRenderOutput extends WriteResult {
  readonly brief: RecordId;
  readonly output: string;
}

function renderBriefRenderText(output: BriefRenderOutput): string {
  return output.output;
}

/** The core module's default budget, so a bare workspace renders as one left at that default. */
const FALLBACK_BRIEF_BUDGET_BYTES = 20000;

/** The caller's budget, else the slot through the case's layering, else the core default when no
 * module declares the slot. */
async function resolveBudget(opened: Workspace, caseRecord: CaseRecord, override: number | undefined): Promise<number> {
  if (override !== undefined) {
    return override;
  }
  try {
    const slotRegistry = readSlotDeclarations(opened.index);
    const presetRegistry = readPresetDeclarations(opened.index, slotRegistry);
    const presetAssignments = presetRegistry.get(caseRecord.preset.contribution)?.assignments;
    const resolution = resolveSlot(BRIEF_BUDGET_SLOT_ID, slotRegistry, {
      preset: presetAssignments,
      booking: caseRecord.overrides,
    });
    return resolution.value as number;
  } catch (error) {
    if (error instanceof LayerRefusedError) {
      return FALLBACK_BRIEF_BUDGET_BYTES;
    }
    throw error;
  }
}

const briefRenderHandler: OperationHandler<BriefRenderInput, BriefRenderOutput> = {
  async plan(input, opened) {
    const claimId = input.claim as RecordId;
    // A brief pins a claim record, not a slot; a slot handed here is answered with its record.
    const atSlot = opened.index.claimAtSlot(input.claim);
    if (atSlot !== undefined && atSlot.id !== claimId) {
      throw new OperationError({
        reason: "no-such-record",
        about: [claimId],
        detail: `${claimId} is a slot, and a brief pins one claim record: the claim at that slot is ${atSlot.id}`,
      });
    }
    const claimCandidate = opened.read(claimId);
    if (claimCandidate.kind !== "claim") {
      throw new OperationError({
        reason: "no-such-record",
        about: [claimId],
        detail: `${claimId} is not a claim record`,
      });
    }

    const found = await findCaseForClaim(opened, claimId);
    const head = opened.index.watermark();
    if (head === null) {
      throw new OperationError({
        reason: "no-such-record",
        about: [claimId],
        detail: "the scope holds no records to render a brief against",
      });
    }

    const budget = await resolveBudget(opened, found.record, input.budget);
    const recipe = briefRecipe(claimId, {
      head,
      caseId: found.id,
      budget,
      kernelVersion: EVALUATOR_VERSION,
      clearance: opened.clearance,
    });
    const rendered = await renderBrief(opened, recipe);

    const run: ComputedRunRecord = {
      kind: "run",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
      runKind: "brief",
      // Two renders at the same head, budget, kernel version and clearance are byte-identical.
      performer: RUNNER_PERFORMER,
      determinism: "deterministic",
      recipe,
      observation: { output: rendered.output, reads: [...rendered.reads], cost: {} },
    };
    return {
      plan: { put: [{ kind: "run", value: run }], attest: [], needs: [] },
      output: (applied) => ({ minted: applied.minted, brief: applied.minted[0]!.id, output: rendered.output }),
    };
  },
};

/** `brief.render@1`: mints a gate claim's brief run, whose id is its content, so a plan-mode
 * call and the performing call after it mint the same run id. */
export const briefRender = definedOperation<BriefRenderInput, BriefRenderOutput>(
  {
    id: "brief.render",
    version: versionString("1"),
    input: {
      type: "object",
      additionalProperties: false,
      required: ["claim"],
      properties: {
        claim: { type: "string" },
        budget: { type: "integer", minimum: 0 },
      },
    },
    output: {
      type: "object",
      additionalProperties: false,
      required: ["minted", "brief", "output"],
      properties: {
        minted: MINTED_ARRAY_SCHEMA,
        brief: { type: "string" },
        output: { type: "string" },
      },
    },
    effect: "write",
    authority: null,
    reasons: ["no-such-record", "over-budget", "head-moved"],
    documentation:
      "Renders a brief run for a gate claim: a recipe a stranger could re-run, and an observation naming every record it packed.",
    cli: {
      verb: "brief",
      positional: ["claim"],
      flags: ["budget"],
      describe: "render the brief a person answers a gate claim from",
    },
    renderText: renderBriefRenderText,
    exitCode: () => 0,
  },
  briefRenderHandler,
);
