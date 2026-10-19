import type { OperationDescriptor, Workspace } from "@musai/api-core";
import { invokeContribution, OperationError, openWorkspace } from "@musai/api-core";
import { type CaseRecord, type RecordId, versionString } from "@musai/records";
import { citedClaims } from "../cases.js";
import { type CaseOpenReason, deriveCaseStatus } from "./case-status.js";

/** The core module's own case listing, run when a caller names no view. */
const DEFAULT_VIEW_ID = "musai.core/cases";

export interface ViewRunInput {
  readonly view?: string;
  readonly kind?: string;
  readonly status?: string;
  readonly since?: string;
}

export interface ViewRunOutput {
  readonly rows: readonly unknown[];
  /** Why no row came back, when not because the workspace holds no case. */
  readonly unlisted?: string;
}

interface ListedCase {
  readonly id: string;
  readonly slug: string;
  readonly kind: string;
}

interface ListedRow {
  readonly slug: string;
  readonly kind: string;
  readonly status: "done" | "open";
  readonly reason?: CaseOpenReason;
  readonly recency: string;
}

/** When a case was last worked on: the latest commit landing it, its claims, their rulings or its
 * artifacts. Derived per call, never recorded. */
function caseRecency(opened: Workspace, caseId: RecordId, caseRecord: CaseRecord): string {
  const related = new Set<RecordId>([caseId]);
  for (const { id: claimId, record: claim } of citedClaims(opened, caseRecord)) {
    related.add(claimId);
    if (claim.kind === "claim") {
      for (const ruling of opened.index.rulingsFor(claim.slot, opened.dimensions)) {
        related.add(ruling.id);
      }
    }
  }
  for (const { id } of opened.index.artifactsOfCase(caseId)) {
    related.add(id);
  }
  const time = opened.index.latestCommitTimeOf([...related]);
  if (time === null) {
    throw new Error(`the fold holds no commit for case ${caseId} or anything it cites`);
  }
  return time;
}

function renderRow(row: unknown): string {
  if (row !== null && typeof row === "object") {
    const candidate = row as Partial<ListedRow>;
    if (typeof candidate.slug === "string") {
      const columns = [candidate.slug, candidate.kind ?? "", candidate.status ?? "", candidate.recency ?? ""];
      return [...columns, ...(candidate.reason !== undefined ? [candidate.reason] : [])].join("\t");
    }
  }
  return JSON.stringify(row);
}

function renderViewRunText(output: ViewRunOutput): string {
  if (output.rows.length === 0) {
    return output.unlisted ?? "no cases";
  }
  return output.rows.map(renderRow).join("\n");
}

/** `view.run@1`: lists cases through a query contribution, then derives, filters and sorts by
 * status and recency, which no statement can project. */
export const viewRun: OperationDescriptor<ViewRunInput, ViewRunOutput> = {
  id: "view.run",
  version: versionString("1"),
  input: {
    type: "object",
    additionalProperties: false,
    properties: {
      view: { type: "string" },
      kind: { type: "string" },
      status: { type: "string" },
      since: { type: "string" },
    },
  },
  output: {
    type: "object",
    additionalProperties: false,
    required: ["rows"],
    properties: {
      rows: { type: "array" },
      unlisted: { type: "string" },
    },
  },
  effect: "read",
  authority: null,
  plans: true,
  reasons: ["declaration-conflict", "invalid-input", "no-such-record", "sibling-conflict"],
  documentation:
    "Lists cases through a named query contribution over the folded index, defaulting to the distribution's own case listing.",
  cli: {
    verb: "list",
    positional: [],
    flags: ["view", "kind", "status", "since"],
    describe: "list cases through an installed view, filtered by kind, status and recency",
  },
  renderText: renderViewRunText,
  exitCode: () => 0,
  async handler(input, context) {
    const opened = await openWorkspace(context);
    const viewId = input.view ?? DEFAULT_VIEW_ID;
    const explicit = input.view !== undefined;

    const contribution = opened.index.contributionById(viewId);
    if (contribution === undefined || contribution.entry.kind !== "query") {
      if (explicit) {
        throw new OperationError({
          reason: "no-such-record",
          about: [viewId],
          detail: `no view contribution named ${viewId} is installed`,
        });
      }
      return { rows: [], unlisted: `no view contribution named ${viewId} is installed, so no case can be listed` };
    }

    const response = await invokeContribution(opened, contribution.moduleName, contribution.entry, {
      kind: input.kind ?? null,
    });
    if (!response.ok) {
      throw new OperationError({
        reason: "no-such-record",
        about: [viewId],
        detail: `view ${viewId} refused: ${JSON.stringify(response.error)}`,
      });
    }

    const listed = (response.output as { rows: readonly ListedCase[] }).rows;
    const rows: ListedRow[] = [];
    for (const answered of listed) {
      const id = answered.id as RecordId;
      const record = opened.read(id) as CaseRecord;
      const status = await deriveCaseStatus(opened, record, false);
      rows.push({
        slug: answered.slug,
        kind: answered.kind,
        status: status.done ? "done" : "open",
        ...(status.reason !== undefined ? { reason: status.reason } : {}),
        recency: caseRecency(opened, id, record),
      });
    }

    // A filter never refuses: an unreadable window or an unknown status only narrows.
    const sinceMs = input.since === undefined ? Number.NaN : Date.parse(input.since);
    const filtered = rows.filter((row) => {
      if (input.status !== undefined && row.status !== input.status) {
        return false;
      }
      if (!Number.isNaN(sinceMs) && Date.parse(row.recency) < sinceMs) {
        return false;
      }
      return true;
    });

    filtered.sort((a, b) => {
      const recencyOrder = Date.parse(b.recency) - Date.parse(a.recency);
      if (recencyOrder !== 0) {
        return recencyOrder;
      }
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });

    return { rows: filtered };
  },
};
