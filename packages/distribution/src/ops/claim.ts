import type { OperationDescriptor, Workspace } from "@musai/api-core";
import { openWorkspace } from "@musai/api-core";
import { exitCodeForLabel, versionString } from "@musai/records";
import { decidingRun, type LabelledClaim, labelledClaim } from "../claim.js";
import { shortIdOf } from "../claim-ref.js";
import { commandText, markOf } from "../text.js";

export interface ClaimStatusInput {
  readonly claim: string;
}

/** The record a status's winning node stands on: the run under a receipt or a rule, with the
 * command it ran, or a ruling. */
export type DecidingRecord =
  | { readonly kind: "run"; readonly id: string; readonly command: readonly string[] }
  | { readonly kind: "ruling" | "floor"; readonly id: string };

export interface ClaimStatusOutput {
  readonly label: "holds" | "fails" | "open";
  readonly reason: string | null;
  /** The slot's first hex digits, as `check` prints them. */
  readonly short: string;
  readonly decidedBy: DecidingRecord | null;
  readonly comparison: {
    readonly winner: string;
    readonly rival: string | null;
    readonly via: string;
    readonly corroborated: readonly string[];
  };
  /** Why the claim reads open, when its gate or its own check said why. */
  readonly detail?: string;
  readonly decidedOnStaleEvidence?: true;
}

function decidingRecordText(decidedBy: DecidingRecord): string {
  if (decidedBy.kind === "run") {
    return `run ${shortIdOf(decidedBy.id)} · ${commandText(decidedBy.command)}`;
  }
  return decidedBy.kind === "floor" ? "the workspace's floor" : `ruling ${shortIdOf(decidedBy.id)}`;
}

function renderClaimStatusText(output: ClaimStatusOutput): string {
  const reasonText = output.label === "open" && output.reason !== null ? ` — ${output.reason}` : "";
  const decidedText = output.decidedBy !== null ? ` · ${decidingRecordText(output.decidedBy)}` : "";
  const agreeing = output.comparison.corroborated.length;
  const agreeingText = agreeing > 0 ? `, with ${agreeing} more agreeing` : "";
  const staleText = output.decidedOnStaleEvidence ? ", decided on stale evidence" : "";
  const detailText = output.detail !== undefined ? `\n${output.detail}` : "";
  return `${markOf(output.label)} ${output.label} · ${output.short}${reasonText}${decidedText}${agreeingText}${staleText}${detailText}`;
}

/** An open claim names none: nothing decided it, whatever its comparison would have chosen. */
async function decidingRecordOf(opened: Workspace, labelled: LabelledClaim): Promise<DecidingRecord | null> {
  if (labelled.status.label === "open") {
    return null;
  }
  const winner = labelled.status.comparison.winner;
  if (labelled.rulingsById.has(winner)) {
    return { kind: "ruling", id: winner };
  }
  if (winner === opened.floor?.id) {
    return { kind: "floor", id: winner };
  }
  const run = await decidingRun(opened, labelled);
  return run === null ? null : { kind: "run", id: run.id, command: run.record.recipe.command };
}

/** `claim.status@3`: a claim's computed status. */
export const claimStatus: OperationDescriptor<ClaimStatusInput, ClaimStatusOutput> = {
  id: "claim.status",
  version: versionString("3"),
  input: {
    type: "object",
    additionalProperties: false,
    required: ["claim"],
    properties: {
      claim: { type: "string" },
    },
  },
  output: {
    type: "object",
    additionalProperties: false,
    required: ["label", "reason", "short", "decidedBy", "comparison"],
    properties: {
      label: { enum: ["holds", "fails", "open"] },
      reason: { type: ["string", "null"] },
      short: { type: "string" },
      decidedBy: {
        oneOf: [
          { type: "null" },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "id", "command"],
            properties: {
              kind: { const: "run" },
              id: { type: "string" },
              command: { type: "array", items: { type: "string" } },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "id"],
            properties: { kind: { enum: ["ruling", "floor"] }, id: { type: "string" } },
          },
        ],
      },
      comparison: {
        type: "object",
        additionalProperties: false,
        required: ["winner", "rival", "via", "corroborated"],
        properties: {
          winner: { type: "string" },
          rival: { type: ["string", "null"] },
          via: { type: "string" },
          corroborated: { type: "array", items: { type: "string" } },
        },
      },
      detail: { type: "string" },
      decidedOnStaleEvidence: { const: true },
    },
  },
  effect: "performs",
  authority: null,
  plans: true,
  reasons: ["declaration-conflict", "invalid-input", "no-such-record", "sibling-conflict"],
  documentation: "Prints a claim's computed status.",
  cli: {
    verb: "status",
    positional: ["claim"],
    flags: [],
    describe: "print a claim's computed status",
  },
  renderText: renderClaimStatusText,
  exitCode: (output) => exitCodeForLabel(output.label),
  async handler(input, context) {
    const opened = await openWorkspace(context);
    const labelled = await labelledClaim(opened, input.claim, context.mode === "plan" ? "recorded" : "perform");
    const { status, detail } = labelled;
    return {
      label: status.label,
      reason: status.label === "open" ? status.reason : null,
      short: shortIdOf(labelled.indexed.slot),
      decidedBy: await decidingRecordOf(opened, labelled),
      comparison: status.comparison,
      ...(detail !== undefined ? { detail } : {}),
      ...(status.label !== "open" && status.decidedOnStaleEvidence ? { decidedOnStaleEvidence: true } : {}),
    };
  },
};
