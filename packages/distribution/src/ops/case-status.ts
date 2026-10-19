import type { OperationDescriptor, Workspace } from "@musai/api-core";
import { openWorkspace } from "@musai/api-core";
import { type CaseRecord, type ClaimRecord, conditionString, type RecordId, versionString } from "@musai/records";
import { citedClaims, findCase } from "../cases.js";
import { type LabelledClaim, labelledClaim } from "../claim.js";
import { GATE_CLASSES, type GateClass, isGateClass } from "../gate-classes.js";

export interface CaseStatusInput {
  readonly case: string;
}

export interface CaseStatusNext {
  readonly gate: RecordId;
  readonly class: GateClass;
}

const CASE_OPEN_REASONS = ["cites-no-claim", "claim-open", "claim-stale", "claim-unchecked", "claim-fails"] as const;
export type CaseOpenReason = (typeof CASE_OPEN_REASONS)[number];

export interface CaseStatusOutput {
  readonly next: CaseStatusNext | null;
  readonly done: boolean;
  /** Why the case is not done. */
  readonly reason?: CaseOpenReason;
  /** A menu counts once, by its chosen option where one holds; an option not chosen counts as
   * `notChosen`, never as failing. */
  readonly counts: {
    readonly holds: number;
    readonly fails: number;
    readonly open: number;
    readonly notChosen: number;
  };
  /** Gates answered by a ruling whose pinned evidence has since moved. */
  readonly flagged?: readonly RecordId[];
}

/** What an open claim waits on: an answer no run gives, a run again over inputs that moved, or a
 * first run. */
type Waiting = "open" | "stale" | "unchecked";

const WAITING_ORDER: readonly Waiting[] = ["open", "stale", "unchecked"];

const REASON_WAITING: Readonly<Record<Waiting, CaseOpenReason>> = {
  open: "claim-open",
  stale: "claim-stale",
  unchecked: "claim-unchecked",
};

interface Counted {
  readonly label: "holds" | "fails" | "open";
  readonly waiting: Waiting | null;
}

function countedOf({ status, unchecked }: LabelledClaim): Counted {
  if (status.label !== "open") {
    return { label: status.label, waiting: null };
  }
  return { label: "open", waiting: unchecked === true ? "unchecked" : status.reason === "stale" ? "stale" : "open" };
}

/** An answer no run gives outranks a stale check, which outranks an unrun one: only performing
 * answers either of those. */
function mostPressing(entries: readonly Counted[]): Waiting | undefined {
  return WAITING_ORDER.find((candidate) => entries.some((entry) => entry.waiting === candidate));
}

/** A menu nobody has chosen from is one choice, waiting on what its most pressing option waits on,
 * or one failure where every option was ruled out. */
function undecided(options: readonly Counted[]): Counted {
  const waiting = mostPressing(options);
  return waiting === undefined ? { label: "fails", waiting: null } : { label: "open", waiting };
}

/** A case's progress: its first open gate in playbook order, its claims' counts, and whether every
 * claim it cites holds or fails only as a menu option not chosen. */
export async function deriveCaseStatus(
  opened: Workspace,
  caseRecord: CaseRecord,
  perform: boolean,
): Promise<CaseStatusOutput> {
  let next: CaseStatusNext | null = null;
  const flagged: RecordId[] = [];
  const counted: Counted[] = [];
  const menus = new Map<string, Counted[]>();
  let cited = 0;
  for (const { id: claimId, record } of citedClaims(opened, caseRecord)) {
    const claim = record as ClaimRecord;
    cited += 1;
    // Not performing still reads the latest receipts, or a claim only a check settles reads open.
    const labelled = await labelledClaim(opened, claim.slot, perform ? "perform" : "recorded");
    const { status } = labelled;
    if (claim.exclusiveGroup === null) {
      counted.push(countedOf(labelled));
    } else {
      menus.set(claim.exclusiveGroup, [...(menus.get(claim.exclusiveGroup) ?? []), countedOf(labelled)]);
    }
    const gateClass = conditionString(claim.conditions, "gateClass");
    if (!isGateClass(gateClass)) {
      continue;
    }
    if (next === null && status.label === "open") {
      next = { gate: claimId, class: gateClass };
    }
    if (status.label !== "open" && status.decidedOnStaleEvidence) {
      flagged.push(claimId);
    }
  }
  let notChosen = 0;
  for (const options of menus.values()) {
    if (!options.some((option) => option.label === "holds")) {
      counted.push(undecided(options));
      continue;
    }
    counted.push(...options.filter((option) => option.label !== "fails"));
    notChosen += options.filter((option) => option.label === "fails").length;
  }
  const counts = { holds: 0, fails: 0, open: 0, notChosen };
  for (const { label } of counted) {
    counts[label] += 1;
  }
  const reason = openReason(cited, counted, counts);
  return {
    next,
    done: reason === null,
    ...(reason !== null ? { reason } : {}),
    counts,
    ...(flagged.length > 0 ? { flagged } : {}),
  };
}

function openReason(
  cited: number,
  counted: readonly Counted[],
  counts: CaseStatusOutput["counts"],
): CaseOpenReason | null {
  if (cited === 0) {
    return "cites-no-claim";
  }
  const waiting = mostPressing(counted);
  if (waiting !== undefined) {
    return REASON_WAITING[waiting];
  }
  return counts.fails > 0 ? "claim-fails" : null;
}

function renderCaseStatusText(output: CaseStatusOutput): string {
  const { holds, fails, open, notChosen } = output.counts;
  let headline: string;
  if (output.next !== null) {
    headline = `next: ${output.next.gate} (${output.next.class})`;
  } else if (output.reason === "claim-open") {
    headline = `no gate awaits an answer, and ${open} ${open === 1 ? "claim is" : "claims are"} still open`;
  } else if (output.reason === "claim-stale") {
    headline = "no gate awaits an answer, and a check reads stale until it runs again";
  } else if (output.reason === "claim-unchecked") {
    headline = `no gate awaits an answer, and ${open} ${open === 1 ? "check has" : "checks have"} not run here`;
  } else if (output.reason === "cites-no-claim") {
    headline = "this case cites no claim";
  } else if (output.reason === "claim-fails") {
    headline = "no claim is open, and a claim fails";
  } else {
    headline = "done";
  }
  const flagged = (output.flagged ?? []).map((gate) => `${gate} answered on stale evidence`);
  const passedOver = notChosen > 0 ? `, not chosen ${notChosen}` : "";
  return [headline, `holds ${holds}, fails ${fails}, open ${open}${passedOver}`, ...flagged].join("\n");
}

/** `case.status@2`: a case's progress, derived once for every reader. The CLI verb is `progress`,
 * since `status` is `claim.status`'s. */
export const caseStatus: OperationDescriptor<CaseStatusInput, CaseStatusOutput> = {
  id: "case.status",
  version: versionString("2"),
  input: {
    type: "object",
    additionalProperties: false,
    required: ["case"],
    properties: {
      case: { type: "string" },
    },
  },
  output: {
    type: "object",
    additionalProperties: false,
    required: ["next", "done", "counts"],
    properties: {
      next: {
        oneOf: [
          { type: "null" },
          {
            type: "object",
            additionalProperties: false,
            required: ["gate", "class"],
            properties: {
              gate: { type: "string" },
              class: { enum: [...GATE_CLASSES] },
            },
          },
        ],
      },
      done: { type: "boolean" },
      reason: { enum: [...CASE_OPEN_REASONS] },
      counts: {
        type: "object",
        additionalProperties: false,
        required: ["holds", "fails", "open", "notChosen"],
        properties: {
          holds: { type: "integer", minimum: 0 },
          fails: { type: "integer", minimum: 0 },
          open: { type: "integer", minimum: 0 },
          notChosen: { type: "integer", minimum: 0 },
        },
      },
      flagged: { type: "array", items: { type: "string" } },
    },
  },
  effect: "performs",
  authority: null,
  plans: true,
  reasons: ["declaration-conflict", "invalid-input", "no-such-record", "sibling-conflict"],
  documentation:
    "The next pending gate in a case's own playbook order, or that it is done, plus its claims' holds/fails/open counts, a menu counted once and each option not chosen apart.",
  statements: ["case"],
  cli: {
    verb: "progress",
    positional: ["case"],
    flags: [],
    describe: "the next pending gate in a case's own playbook order, or that it is done",
  },
  renderText: renderCaseStatusText,
  exitCode: () => 0,
  async handler(input, context) {
    const opened = await openWorkspace(context);
    const caseRecord = await findCase(opened, input.case);
    return deriveCaseStatus(opened, caseRecord, context.mode !== "plan");
  },
};
