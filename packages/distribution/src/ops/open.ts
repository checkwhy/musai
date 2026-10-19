import type { OperationDescriptor } from "@musai/api-core";
import { OperationError, openWorkspace } from "@musai/api-core";
import { type RecordId, versionString } from "@musai/records";
import { materialiseView } from "@musai/store";
import { findCaseRecord } from "../cases.js";
import { DERIVED, editablePathsOf, renderView, type ViewFile, type ViewFileMarker } from "../view/render.js";

/** Maps each worktree path to its marker, so `save` reads it from the commit it diffs against. */
export const VIEW_MANIFEST_PATH = ".view-manifest.json";

export interface ViewManifestEntry {
  readonly path: string;
  readonly marker: ViewFileMarker;
  readonly artifactId?: RecordId;
  readonly format?: string;
}

export function buildViewManifest(files: readonly ViewFile[]): ViewManifestEntry[] {
  return files.map((file) => {
    const entry: { path: string; marker: ViewFileMarker; artifactId?: RecordId; format?: string } = {
      path: file.path,
      marker: file.marker,
    };
    if (file.artifactId !== undefined) {
      entry.artifactId = file.artifactId;
    }
    if (file.format !== undefined) {
      entry.format = file.format;
    }
    return entry;
  });
}

export interface CaseOpenInput {
  readonly case: string;
}

export interface CaseOpenOutput {
  readonly path: string;
  readonly commit: string;
  readonly files: readonly string[];
}

function renderCaseOpenText(output: CaseOpenOutput): string {
  return output.path;
}

/** `case.open@1`: renders a case into a worktree a person can hand-edit. The worktree is a render,
 * so two calls at one head give one path and commit and mint nothing. */
export const caseOpen: OperationDescriptor<CaseOpenInput, CaseOpenOutput> = {
  id: "case.open",
  version: versionString("1"),
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
    required: ["path", "commit", "files"],
    properties: {
      path: { type: "string" },
      commit: { type: "string" },
      files: { type: "array", items: { type: "string" } },
    },
  },
  effect: "write",
  authority: null,
  plans: false,
  authorOnly: true,
  reasons: ["declaration-conflict", "head-moved", "invalid-input", "no-such-record", "sibling-conflict"],
  documentation: "Checks out a case's dossier, drafts and artifacts into a git worktree a person can hand-edit.",
  statements: ["case"],
  cli: {
    verb: "open",
    positional: ["case"],
    flags: [],
    describe: "materialise a case into a worktree for hand editing",
  },
  renderText: renderCaseOpenText,
  exitCode: () => 0,
  async handler(input, context) {
    const opened = await openWorkspace(context);
    const found = await findCaseRecord(opened, input.case);
    if (found === null) {
      throw new OperationError({
        reason: "no-such-record",
        about: [input.case],
        detail: `no case found named ${input.case}`,
      });
    }

    const rendered = await renderView(opened, found.id, found.record);
    const manifest: ViewFile = {
      path: VIEW_MANIFEST_PATH,
      content: new TextEncoder().encode(JSON.stringify(buildViewManifest(rendered))),
      marker: DERIVED,
    };
    const files = [...rendered, manifest];

    const worktree = await materialiseView(opened.ctx, found.record.slug, files, editablePathsOf(files), context.now);

    return { path: worktree.path, commit: worktree.headCommit, files: files.map((file) => file.path) };
  },
};
