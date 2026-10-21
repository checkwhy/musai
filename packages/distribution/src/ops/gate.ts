import type { OperationDescriptor, Workspace } from "@musai/api-core";
import {
  definedOperation,
  establishedChannel,
  MINTED_ARRAY_SCHEMA,
  OperationError,
  type OperationHandler,
  openWorkspace,
  runHandler,
  SALT_INPUT_SCHEMA,
  type WriteResult,
} from "@musai/api-core";
import type { ClaimStatus } from "@musai/evaluate";
import { type ComputedRunRecord, conditionString, type RecordId, type RunRecord, versionString } from "@musai/records";
import { citedClaims } from "../cases.js";
import { applicabilityAt, applyingMembers, groupHolder, labelledClaim, vouchedRulingsFor } from "../claim.js";
import { movedReadLine, movedReadsDiff } from "../gate/diff.js";
import { askMenu, type MenuOption } from "../gate/menu.js";
import { mintRuling } from "../gate/ruling-mint.js";
import { GATE_CLASSES, type GateClass, isGateClass } from "../gate-classes.js";
import type { PendingRecord } from "../pending.js";
import { pendingFor } from "../pending.js";
import { briefRender } from "./brief.js";

const MENU_OPTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["claim", "value", "description"],
  properties: {
    claim: { type: "string" },
    value: { type: "string" },
    description: { type: "string" },
  },
};

const PENDING_RECORD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["asking", "answeredBy", "input"],
  properties: {
    asking: { type: "string" },
    answeredBy: { type: "string" },
    input: { type: "object" },
  },
};

export interface GatePendingInput {
  readonly case?: string;
}

export interface PendingGate {
  readonly case: string;
  readonly claim: RecordId;
  readonly gateClass: GateClass;
}

export interface GatePendingOutput {
  readonly gates: readonly PendingGate[];
  /** Gates answered by a ruling whose pinned evidence has since moved; a menu by its holder. */
  readonly flagged?: readonly PendingGate[];
  /** Why no gate came back, when not because every gate is answered: a mistyped slug, say. */
  readonly unlisted?: string;
}

function renderGatePendingText(output: GatePendingOutput): string {
  const line = (gate: PendingGate) => `${gate.case} ${gate.claim} (${gate.gateClass})`;
  const flagged = (output.flagged ?? []).map((gate) => `${line(gate)} answered on stale evidence`);
  if (output.gates.length === 0) {
    return [output.unlisted ?? "no gates await an answer", ...flagged].join("\n");
  }
  return [...output.gates.map(line), ...flagged].join("\n");
}

type Answered = "pending" | "answered" | "flagged";

/** A vouched ruling settles a binary gate either way, unless tied rulings contest it. */
async function bareGateAnswered(opened: Workspace, slot: string): Promise<Answered> {
  if ((await vouchedRulingsFor(opened, slot)).length === 0) {
    return "pending";
  }
  return answeredAs((await labelledClaim(opened, slot, "none")).status);
}

function answeredAs(status: ClaimStatus): Answered {
  if (status.label === "open") {
    return "pending";
  }
  return status.decidedOnStaleEvidence ? "flagged" : "answered";
}

/** `gate.pending@1`: every gate claim awaiting an answer. A menu is listed once, by its first
 * applying member, until any member holds, on grounds this view holds or not. */
export const gatePending: OperationDescriptor<GatePendingInput, GatePendingOutput> = {
  id: "gate.pending",
  version: versionString("1"),
  input: {
    type: "object",
    additionalProperties: false,
    properties: {
      case: { type: "string" },
    },
  },
  output: {
    type: "object",
    additionalProperties: false,
    required: ["gates"],
    properties: {
      gates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["case", "claim", "gateClass"],
          properties: {
            case: { type: "string" },
            claim: { type: "string" },
            gateClass: { enum: [...GATE_CLASSES] },
          },
        },
      },
      flagged: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["case", "claim", "gateClass"],
          properties: {
            case: { type: "string" },
            claim: { type: "string" },
            gateClass: { enum: [...GATE_CLASSES] },
          },
        },
      },
      unlisted: { type: "string" },
    },
  },
  effect: "read",
  authority: null,
  plans: true,
  reasons: ["declaration-conflict", "invalid-input", "no-such-record", "sibling-conflict"],
  documentation: "Lists the gates awaiting an answer.",
  cli: {
    verb: "pending",
    positional: [],
    flags: ["case"],
    describe: "list the gates awaiting an answer",
  },
  renderText: renderGatePendingText,
  exitCode: () => 0,
  async handler(input, context) {
    const opened = await openWorkspace(context);
    const seenGroups = new Set<string>();
    const gates: PendingGate[] = [];
    const flagged: PendingGate[] = [];
    let namedCaseFound = input.case === undefined;

    for (const { record: caseRecord } of opened.index.cases()) {
      if (input.case !== undefined && caseRecord.slug !== input.case) {
        continue;
      }
      namedCaseFound = true;
      for (const { id: claimId, record: claimRecord } of citedClaims(opened, caseRecord)) {
        if (claimRecord.kind !== "claim") {
          continue;
        }
        const gateClass = conditionString(claimRecord.conditions, "gateClass");
        if (!isGateClass(gateClass)) {
          continue;
        }
        const group = claimRecord.exclusiveGroup;
        if (group !== null) {
          if (seenGroups.has(group)) {
            continue;
          }
          seenGroups.add(group);
          const [representative] = applyingMembers(opened, group);
          if (representative === undefined) {
            continue;
          }
          const holder = await groupHolder(opened, group);
          if (holder === null) {
            gates.push({ case: caseRecord.slug, claim: representative.id, gateClass });
          } else if (answeredAs((await labelledClaim(opened, holder.slot, "none")).status) === "flagged") {
            flagged.push({ case: caseRecord.slug, claim: opened.index.claimAtSlot(holder.slot)!.id, gateClass });
          }
          continue;
        }
        if (applicabilityAt(opened, claimRecord.slot, claimRecord).outcome !== "valid") {
          continue;
        }
        const answered = await bareGateAnswered(opened, claimRecord.slot);
        if (answered !== "answered") {
          (answered === "pending" ? gates : flagged).push({ case: caseRecord.slug, claim: claimId, gateClass });
        }
      }
    }

    const byCaseAndClaim = (a: PendingGate, b: PendingGate) =>
      a.case !== b.case ? (a.case < b.case ? -1 : 1) : a.claim < b.claim ? -1 : a.claim > b.claim ? 1 : 0;
    gates.sort(byCaseAndClaim);
    const flaggedField = flagged.length > 0 ? { flagged: flagged.sort(byCaseAndClaim) } : {};
    if (!namedCaseFound) {
      return {
        gates,
        unlisted: `no case is booked under the slug ${String(input.case)}, so no gate of its own can await an answer`,
      };
    }
    return { gates, ...flaggedField };
  },
};

export interface GateAskInput {
  readonly claim: string;
  readonly budget?: number;
}

export interface GateAskOutput extends WriteResult {
  readonly pending: PendingRecord;
  readonly brief: RecordId;
  readonly output: string;
  readonly options: readonly MenuOption[];
}

function renderGateAskText(output: GateAskOutput): string {
  const menu = output.options.map((option) => `  [${option.value}] ${option.description}`).join("\n");
  return `${output.output}\n\n## Menu\n${menu}`;
}

/** Named once so `gate.ask`'s pending record and `gate.answer` agree on who answers. */
const GATE_ANSWER_KEY = "gate.answer@2";

/** `gate.ask@1`: renders a gate claim's brief through `brief.render` and offers its menu. It mints
 * only the brief run; the answer is `gate.answer`'s. */
export const gateAsk: OperationDescriptor<GateAskInput, GateAskOutput> = {
  id: "gate.ask",
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
    required: ["minted", "pending", "brief", "output", "options"],
    properties: {
      minted: MINTED_ARRAY_SCHEMA,
      pending: PENDING_RECORD_SCHEMA,
      brief: { type: "string" },
      output: { type: "string" },
      options: { type: "array", items: MENU_OPTION_SCHEMA },
    },
  },
  effect: "write",
  authority: null,
  plans: true,
  reasons: ["no-such-record", "over-budget", "head-moved", "declaration-conflict", "invalid-input"],
  documentation: "Renders the brief for a gate claim and offers the menu it answers through.",
  cli: {
    verb: "ask",
    positional: ["claim"],
    flags: ["budget"],
    describe: "render a gate's brief and offer the menu that answers it",
  },
  renderText: renderGateAskText,
  exitCode: () => 0,
  async handler(input, context) {
    const gateClaimId = input.claim as RecordId;
    // The menu is read first, so a claim it refuses leaves no brief behind.
    const opened = await openWorkspace(context);
    const { options } = askMenu(opened, gateClaimId);

    const briefResult = await runHandler(briefRender, { claim: input.claim, budget: input.budget }, context);

    const pending = pendingFor(`disposition for ${gateClaimId}`, GATE_ANSWER_KEY, {
      pending: gateClaimId,
      brief: briefResult.brief,
    });

    return { minted: briefResult.minted, pending, brief: briefResult.brief, output: briefResult.output, options };
  },
};

export interface GateAnswerInput {
  readonly pending: string;
  readonly brief: string;
  readonly choice: string;
  readonly reason: string;
  /** A private key to sign this answer with, outranking any configured or registered key. */
  readonly key?: string;
  readonly salt?: boolean;
}

export type GateAnswerOutput = WriteResult;

export const GATE_ANSWER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["minted"],
  properties: {
    minted: MINTED_ARRAY_SCHEMA,
  },
} as const;

function renderGateAnswerText(output: GateAnswerOutput): string {
  return output.minted.map((item) => item.id).join("\n");
}

const gateAnswerHandler: OperationHandler<GateAnswerInput, GateAnswerOutput> = {
  async plan(input, opened, context) {
    const { via, principal } = await establishedChannel(context, opened, input.key);

    const gateClaimId = input.pending as RecordId;
    const { group, options } = askMenu(opened, gateClaimId);
    const chosen = options.find((option) => option.value === input.choice);
    if (chosen === undefined) {
      throw new OperationError({
        reason: "no-such-record",
        about: [input.choice],
        detail: `${input.choice} is not among the options ${gateClaimId} offers`,
      });
    }

    const verdict: "holds" | "fails" = group === null ? (chosen.value === "fails" ? "fails" : "holds") : "holds";

    const briefId = input.brief as RecordId;
    const asked = opened.read(briefId);
    // What is not a brief reaches `mintRuling`, which refuses it by name.
    const moved =
      asked.kind === "run" && (asked as RunRecord).runKind === "brief"
        ? await movedReadsDiff(opened, asked as ComputedRunRecord)
        : [];
    if (moved.length > 0) {
      throw new OperationError({
        reason: "stale",
        about: moved.map((entry) => entry.id),
        detail: `refusing to answer against ${briefId}: evidence moved since it was rendered:\n${moved.map(movedReadLine).join("\n")}`,
      });
    }

    const planned = await mintRuling(opened, {
      claim: chosen.claim,
      verdict,
      reason: input.reason,
      brief: input.brief as RecordId,
      supersedes: [],
      via,
      principal,
      salt: input.salt,
    });

    return {
      plan: { put: planned.put, attest: planned.attest, needs: [] },
      output: (applied) => ({ minted: applied.minted }),
      key: input.key,
    };
  },
};

/** `gate.answer@2`: mints the ruling a menu choice names through `mintRuling`, so a gate answered
 * and a ruling made directly are the same commit under the same `rule` authority. */
export const gateAnswer = definedOperation<GateAnswerInput, GateAnswerOutput>(
  {
    id: "gate.answer",
    version: versionString("2"),
    input: {
      type: "object",
      additionalProperties: false,
      required: ["pending", "brief", "choice", "reason"],
      properties: {
        pending: { type: "string" },
        brief: { type: "string" },
        choice: { type: "string" },
        reason: { type: "string" },
        key: { type: "string" },
        salt: SALT_INPUT_SCHEMA,
      },
    },
    output: GATE_ANSWER_OUTPUT_SCHEMA,
    effect: "write",
    authority: "rule",
    reasons: [
      "no-such-record",
      "sibling-conflict",
      "not-authorised",
      "head-moved",
      "stale",
      "inapplicable",
      "declaration-conflict",
      "invalid-input",
    ],
    documentation: "Mints one ruling and its attestation against a gate's menu.",
    paths: ["key"],
    cli: {
      verb: "answer",
      positional: ["pending"],
      flags: ["brief", "choice", "reason", "key", "salt"],
      describe: "answer a pending gate, minting one ruling and its attestation",
    },
    renderText: renderGateAnswerText,
    exitCode: () => 0,
  },
  gateAnswerHandler,
);
