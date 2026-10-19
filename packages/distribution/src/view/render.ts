import type { Workspace } from "@musai/api-core";
import { buildAdmissionWorkspace, installedModules } from "@musai/api-core";
import { ENVELOPE_PROTOCOL, type EnvelopeRequest, firstAvailableHost, HOSTS, pointFor } from "@musai/modules";
import {
  type ArtifactRecord,
  type CaseRecord,
  type ClaimRecord,
  hexOfRecordId,
  type RecordId,
  renderedTextOf,
  textOf,
} from "@musai/records";
import { citedClaims } from "../cases.js";
import { decidingRun, labelledClaim } from "../claim.js";
import { markdownCommand, markdownText } from "../text.js";

/** A rendering of records, regenerated on every open; a save refuses it if it changed by hand. */
export const DERIVED = "derived";

/** A draft: the one file a hand edit may change. */
export const EDITABLE = "editable";

export type ViewFileMarker = typeof DERIVED | typeof EDITABLE;

/** One file `renderView` produces, relative to the worktree's root. */
export interface ViewFile {
  path: string;
  content: Uint8Array;
  marker: ViewFileMarker;
  /** The artifact this file renders, so a save knows what a changed draft supersedes. */
  artifactId?: RecordId;
  /** The grammar this file is written in; absent for the dossier, which anchors nothing. */
  format?: string;
}

const FILE_NAME_PREFIX_WIDTH = 12;

function shortId(id: RecordId): string {
  return hexOfRecordId(id).slice(0, FILE_NAME_PREFIX_WIDTH);
}

function extensionFor(format: string): string {
  return format === "markdown" ? "md" : "txt";
}

const encoder = new TextEncoder();

/** Every artifact citing `caseId`, in record id order. */
export async function artifactsOf(
  opened: Workspace,
  caseId: RecordId,
): Promise<Array<{ id: RecordId; record: ArtifactRecord }>> {
  return opened.index.artifactsOfCase(caseId);
}

/** The drafts nothing supersedes. Two lanes editing one draft leave two heads until a later draft
 * supersedes both. */
function openHeads(
  artifacts: readonly { id: RecordId; record: ArtifactRecord }[],
): Array<{ id: RecordId; record: ArtifactRecord }> {
  const superseded = new Set<RecordId>();
  for (const { record } of artifacts) {
    for (const parent of record.supersedes) {
      superseded.add(parent);
    }
  }
  return artifacts.filter(({ id, record }) => record.lifecycle === "drafted" && !superseded.has(id));
}

async function renderClaimLine(opened: Workspace, claim: ClaimRecord): Promise<string> {
  const labelled = await labelledClaim(opened, claim.slot, "recorded");
  const { status } = labelled;
  const detail = status.label === "open" ? ` (${status.reason})` : "";
  const run = await decidingRun(opened, labelled);
  const ran = run === null ? "" : ` · ${markdownCommand(run.record.recipe.command)}`;
  return `- ${markdownText(renderedTextOf(claim.rendering))} — ${status.label}${detail}${ran}`;
}

function renderArtifactLine(entry: { id: RecordId; record: ArtifactRecord }, isOpenHead: boolean): string {
  const parents =
    entry.record.supersedes.length > 0 ? ` (from ${entry.record.supersedes.map(shortId).join(", ")})` : "";
  const state = isOpenHead ? "open" : entry.record.lifecycle;
  return `- ${shortId(entry.id)}: ${state}${parents}`;
}

/** The read-only dossier: the case, its claims' statuses and every artifact's lifecycle. */
export async function renderDossier(
  opened: Workspace,
  caseId: RecordId,
  caseRecord: CaseRecord,
  artifacts: readonly { id: RecordId; record: ArtifactRecord }[],
): Promise<string> {
  const heads = new Set(openHeads(artifacts).map((entry) => entry.id));
  const claimLines = await Promise.all(
    citedClaims(opened, caseRecord).map(({ record }) => renderClaimLine(opened, record as ClaimRecord)),
  );
  const artifactLines = artifacts.map((entry) => renderArtifactLine(entry, heads.has(entry.id)));
  const lines = [
    `# ${caseRecord.slug}`,
    "",
    caseId,
    "",
    "## Claims",
    "",
    ...(claimLines.length > 0 ? claimLines : ["(none)"]),
    "",
    "## Artifacts",
    "",
    ...(artifactLines.length > 0 ? artifactLines : ["(none)"]),
    "",
  ];
  return lines.join("\n");
}

/** What a `template` contribution answers when rendering a case's first draft. */
export interface DraftTemplateResult {
  readonly format: string;
  readonly content: string;
}

function draftTemplateContributionId(caseRecord: CaseRecord): string {
  return `${caseRecord.preset.contribution}/draft`;
}

/** A case's starter draft from its preset's `template` contribution, or `null`: a case need not
 * have one. */
export async function resolveDraftTemplate(
  opened: Workspace,
  caseId: RecordId,
  caseRecord: CaseRecord,
): Promise<DraftTemplateResult | null> {
  const contributionId = draftTemplateContributionId(caseRecord);
  const contribution = opened.index.contributionById(contributionId);
  const point = contribution?.entry.kind === "template" ? pointFor(contribution.entry.kind, opened.index) : undefined;
  if (contribution === undefined || point === undefined) {
    return null;
  }

  const installed = await installedModules(opened);
  const admission = await buildAdmissionWorkspace(opened, installed);

  const hostDescriptor = await firstAvailableHost(HOSTS);
  if (hostDescriptor === undefined) {
    return null;
  }

  const host = hostDescriptor.create();
  try {
    const loaded = await host.load(admission.modulePath(contribution.moduleName), "invoke");
    const request: EnvelopeRequest = {
      protocol: ENVELOPE_PROTOCOL,
      contribution: "template",
      id: contributionId,
      version: contribution.entry.version,
      input: { case: caseId, slug: caseRecord.slug },
    };
    const { response } = await host.invoke(
      loaded,
      request,
      { entry: contribution.entry, point },
      admission.invocationLimits,
    );
    if (!response.ok) {
      return null;
    }
    const output = response.output as Partial<DraftTemplateResult> | null;
    if (typeof output?.format !== "string" || typeof output.content !== "string") {
      return null;
    }
    return { format: output.format, content: output.content };
  } finally {
    await host.close?.();
  }
}

/** The file set a case materialises into a worktree. It reads nothing but records, so one case at
 * one head renders byte-identical files. */
export async function renderView(opened: Workspace, caseId: RecordId, caseRecord: CaseRecord): Promise<ViewFile[]> {
  const artifacts = await artifactsOf(opened, caseId);
  const heads = openHeads(artifacts);

  const files: ViewFile[] = [];

  files.push({
    path: "dossier.md",
    content: encoder.encode(await renderDossier(opened, caseId, caseRecord, artifacts)),
    marker: DERIVED,
  });

  for (const entry of artifacts) {
    files.push({
      path: `artifacts/${shortId(entry.id)}.${extensionFor(entry.record.format)}`,
      content: encoder.encode(textOf(entry.record.content, `artifact ${entry.id}`)),
      marker: DERIVED,
      artifactId: entry.id,
      format: entry.record.format,
    });
  }

  for (const entry of heads) {
    files.push({
      path: `drafts/${shortId(entry.id)}.${extensionFor(entry.record.format)}`,
      content: encoder.encode(textOf(entry.record.content, `artifact ${entry.id}`)),
      marker: EDITABLE,
      artifactId: entry.id,
      format: entry.record.format,
    });
  }

  if (artifacts.length === 0) {
    const starter = await resolveDraftTemplate(opened, caseId, caseRecord);
    if (starter !== null) {
      files.push({
        path: `drafts/draft.${extensionFor(starter.format)}`,
        content: encoder.encode(starter.content),
        marker: EDITABLE,
        format: starter.format,
      });
    }
  }

  return files;
}

export function editablePathsOf(files: readonly ViewFile[]): ReadonlySet<string> {
  return new Set(files.filter((file) => file.marker === EDITABLE).map((file) => file.path));
}
