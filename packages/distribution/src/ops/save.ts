import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Workspace } from "@musai/api-core";
import {
  definedOperation,
  MINTED_ARRAY_SCHEMA,
  OperationError,
  type OperationHandler,
  SALT_INPUT_SCHEMA,
  saltAsked,
  type WriteResult,
} from "@musai/api-core";
import {
  type ArtifactRecord,
  CURRENT_SCHEMA_VERSIONS,
  type Reason,
  type RecordId,
  versionString,
} from "@musai/records";
import { assertSafeSlugSegment, gitCatFile, gitRevParse, OPEN_DIR, VIEW_BRANCH_PREFIX } from "@musai/store";
import { anchorGrammarFor, UngrammaredFormatError } from "../anchor/formats.js";
import { findCaseRecord } from "../cases.js";
import { DERIVED, EDITABLE } from "../view/render.js";
import { VIEW_MANIFEST_PATH, type ViewManifestEntry } from "./open.js";

/** One path `save` did not turn into a record, and why. */
export interface SaveRefusal {
  readonly path: string;
  readonly reason: Reason;
  readonly detail: string;
}

export interface CaseSaveInput {
  readonly case: string;
  readonly salt?: boolean;
}

export interface CaseSaveOutput extends WriteResult {
  readonly refused: readonly SaveRefusal[];
  /** A path that saved with something worth saying, such as no anchor grammar for its format. */
  readonly warnings: readonly SaveRefusal[];
}

function renderCaseSaveText(output: CaseSaveOutput): string {
  const lines: string[] = [];
  for (const item of output.minted) {
    lines.push(`minted ${item.id}`);
  }
  for (const item of output.refused) {
    lines.push(`refused ${item.path}: ${item.reason} — ${item.detail}`);
  }
  for (const item of output.warnings) {
    lines.push(`warning ${item.path}: ${item.reason} — ${item.detail}`);
  }
  return lines.length > 0 ? lines.join("\n") : "nothing changed";
}

/** The worktree's manifest describes the render, so it is not part of `renderView`'s output. */
const MANIFEST_SELF_ENTRY: ViewManifestEntry = { path: VIEW_MANIFEST_PATH, marker: DERIVED };

async function readWorktreeFile(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

/** The first anchor in an artifact that does not resolve, or `null`. Throws
 * `UngrammaredFormatError` for a format with no installed grammar; each caller decides. */
export function unresolvedAnchor(
  path: string,
  content: Uint8Array,
  format: string,
  resolves: (id: RecordId) => boolean,
): SaveRefusal | null {
  const parsed = anchorGrammarFor(format).parseAnchors(content);
  for (const anchor of parsed.anchors) {
    if (anchor.fullId === null) {
      return {
        path,
        reason: "no-such-record",
        detail: `anchor [^${anchor.label}] names no full id in ${path}'s own receipts section`,
      };
    }
    if (!resolves(anchor.fullId)) {
      return {
        path,
        reason: "no-such-record",
        detail: `anchor [^${anchor.label}] names ${anchor.fullId}, which is not in the store`,
      };
    }
  }
  return null;
}

interface PlannedSave {
  readonly put: readonly ArtifactRecord[];
  readonly refused: readonly SaveRefusal[];
  readonly warnings: readonly SaveRefusal[];
}

/** A save does not move the view branch's baseline, so a repeat is told by the case's records. */
function alreadyHeld(held: readonly { readonly record: ArtifactRecord }[], drafted: ArtifactRecord): boolean {
  return held.some(
    ({ record }) =>
      record.lifecycle === "drafted" &&
      record.salt === undefined &&
      record.content === drafted.content &&
      record.format === drafted.format &&
      record.supersedes.length === drafted.supersedes.length &&
      record.supersedes.every((id, at) => id === drafted.supersedes[at]),
  );
}

async function draftedArtifacts(input: CaseSaveInput, opened: Workspace): Promise<PlannedSave> {
  const found = await findCaseRecord(opened, input.case);
  if (found === null) {
    throw new OperationError({
      reason: "no-such-record",
      about: [input.case],
      detail: `no case found named ${input.case}`,
    });
  }

  const branch = `${VIEW_BRANCH_PREFIX}${found.record.slug}`;
  const tip = await gitRevParse(opened.ctx, `refs/heads/${branch}`);
  if (tip === null) {
    throw new OperationError({
      reason: "no-such-record",
      about: [input.case],
      detail: `case ${input.case} has no open worktree to save from; run "musai lab open ${input.case}" first`,
    });
  }
  assertSafeSlugSegment(found.record.slug);
  const worktreePath = join(opened.ctx.gitDir, OPEN_DIR, found.record.slug);

  const manifestBytes = await gitCatFile(opened.ctx, `${tip}:${VIEW_MANIFEST_PATH}`);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as ViewManifestEntry[];
  const entries = [...manifest, MANIFEST_SELF_ENTRY];

  const held = opened.index.artifactsOfCase(found.id);
  const put: ArtifactRecord[] = [];
  const refused: SaveRefusal[] = [];
  const warnings: SaveRefusal[] = [];

  for (const entry of entries) {
    const baseline = await gitCatFile(opened.ctx, `${tip}:${entry.path}`);
    const actual = await readWorktreeFile(join(worktreePath, entry.path));

    if (actual !== null && Buffer.from(baseline).equals(actual)) {
      continue;
    }

    if (entry.marker !== EDITABLE) {
      if (actual !== null) {
        refused.push({
          path: entry.path,
          reason: "render-edited",
          detail: `${entry.path} is a rendering of records; edit the records, not the render`,
        });
      }
      continue;
    }

    if (actual === null) {
      // A draft removed by hand has nothing to mint and loses no text.
      continue;
    }

    const format = entry.format ?? "markdown";
    const content = actual.toString("utf8");

    let anchorRefusal: SaveRefusal | null = null;
    try {
      anchorRefusal = unresolvedAnchor(entry.path, actual, format, (id) => {
        try {
          opened.read(id);
          return true;
        } catch {
          return false;
        }
      });
    } catch (error) {
      if (!(error instanceof UngrammaredFormatError)) {
        throw error;
      }
      warnings.push({
        path: entry.path,
        reason: "unsupported-format",
        detail: `format ${format} has no installed anchor grammar; ${entry.path} saves with no anchors`,
      });
    }

    if (anchorRefusal !== null) {
      refused.push(anchorRefusal);
      continue;
    }

    const record: ArtifactRecord = {
      kind: "artifact",
      schemaVersion: CURRENT_SCHEMA_VERSIONS.artifact,
      case: found.id,
      lifecycle: "drafted",
      content,
      format,
      supersedes: entry.artifactId !== undefined ? [entry.artifactId] : [],
    };
    if (input.salt !== true && alreadyHeld(held, record)) {
      continue;
    }
    put.push(record);
  }

  return { put, refused, warnings };
}

const caseSaveHandler: OperationHandler<CaseSaveInput, CaseSaveOutput> = {
  async plan(input, opened) {
    const { put, refused, warnings } = await draftedArtifacts(input, opened);
    return {
      plan: {
        put: put.map((record) => ({ kind: "artifact", value: record, ...saltAsked(input.salt) })),
        attest: [],
        needs: [],
      },
      output: (applied) => ({ minted: applied.minted, refused, warnings }),
    };
  },
};

/** `case.save@1`: mints one artifact per changed draft; a changed derived file is refused. */
export const caseSave = definedOperation<CaseSaveInput, CaseSaveOutput>(
  {
    id: "case.save",
    version: versionString("1"),
    input: {
      type: "object",
      additionalProperties: false,
      required: ["case"],
      properties: {
        case: { type: "string" },
        salt: SALT_INPUT_SCHEMA,
      },
    },
    output: {
      type: "object",
      additionalProperties: false,
      required: ["minted", "refused", "warnings"],
      properties: {
        minted: MINTED_ARRAY_SCHEMA,
        refused: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "reason", "detail"],
            properties: {
              path: { type: "string" },
              reason: { type: "string" },
              detail: { type: "string" },
            },
          },
        },
        warnings: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "reason", "detail"],
            properties: {
              path: { type: "string" },
              reason: { type: "string" },
              detail: { type: "string" },
            },
          },
        },
      },
    },
    effect: "write",
    authority: null,
    authorOnly: true,
    reasons: ["head-moved", "invalid-input", "no-such-record", "render-edited", "unsupported-format"],
    documentation: "Turns hand-edited drafts back into artifact records, one per changed draft.",
    statements: ["case"],
    cli: {
      verb: "save",
      positional: ["case"],
      flags: ["salt"],
      describe: "turn hand edits in an open case's worktree back into records",
    },
    renderText: renderCaseSaveText,
    exitCode: () => 0,
  },
  caseSaveHandler,
);
