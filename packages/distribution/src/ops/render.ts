import { readFile } from "node:fs/promises";
import { type OperationDescriptor, OperationError, openWorkspace, type Workspace } from "@musai/api-core";
import { type RecordId, splitReceiptsSection, versionString } from "@musai/records";
import { parseAnchors } from "../anchor/markdown.js";
import { decidingRun, labelledClaim } from "../claim.js";
import { CHECK_CLAIM_TYPE, claimSlotNamed, shortIdOf } from "../claim-ref.js";
import { markdownCommand, markdownText, markOf } from "../text.js";
import { repositoryOf } from "./check.js";

export interface RenderMarkdownInput {
  /** A markdown file whose footnotes resolve to claims in its receipts section. */
  readonly file?: string;
}

/** One checklist line, as a reader that is not a person takes it. */
export interface RenderedClaim {
  readonly statement: string;
  readonly label: "holds" | "fails" | "open";
  readonly reason: string | null;
  readonly short: string;
  readonly decidedOnStaleEvidence?: true;
}

export interface RenderMarkdownOutput {
  readonly markdown: string;
  /** The checklist's claims in its order; a rendered file carries none. */
  readonly claims?: readonly RenderedClaim[];
}

function checklistLine(claim: RenderedClaim, command: readonly string[] | null): string {
  const { statement, label, reason, short, decidedOnStaleEvidence } = claim;
  const box = label === "holds" ? "x" : " ";
  const why = reason !== null ? ` (${reason})` : decidedOnStaleEvidence ? " (decided on stale evidence)" : "";
  const ran = command === null ? "" : ` · ${markdownCommand(command)}`;
  return `- [${box}] ${markOf(label)} ${markdownText(statement)}${why}${ran} — \`musai why ${short}\``;
}

/** Each of the repository's check claims as one checklist line, read from its latest receipts. */
async function checklist(opened: Workspace, workspace: string): Promise<RenderMarkdownOutput> {
  const { subject } = await repositoryOf(workspace);
  const claims: RenderedClaim[] = [];
  const lines: string[] = [];
  for (const slot of opened.index.claimSlotsOfType(CHECK_CLAIM_TYPE)) {
    const claim = opened.index.claimAtSlot(slot);
    if (claim?.record.kind !== "claim" || claim.record.conditions["subject"] !== subject) {
      continue;
    }
    const labelled = await labelledClaim(opened, slot, "recorded");
    const { status } = labelled;
    const rendered: RenderedClaim = {
      statement: String(claim.record.conditions["statement"]),
      label: status.label,
      reason: status.label === "open" ? status.reason : null,
      short: shortIdOf(slot),
      ...(status.label !== "open" && status.decidedOnStaleEvidence ? { decidedOnStaleEvidence: true } : {}),
    };
    claims.push(rendered);
    const run = await decidingRun(opened, labelled);
    lines.push(checklistLine(rendered, run === null ? null : run.record.recipe.command));
  }
  return {
    markdown:
      lines.length > 0
        ? lines.join("\n")
        : 'No checked claims here yet: `musai check "tests pass" -- <command>` makes one.',
    claims,
  };
}

/** The file with a mark before each footnote that resolves to a claim, the rest as written. */
async function markedFile(opened: Workspace, file: string): Promise<string> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(file);
  } catch (error) {
    throw new OperationError({
      reason: "invalid-input",
      about: [file],
      detail: `refusing to render ${file}: it could not be read (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`,
    });
  }
  const marks = new Map<string, string>();
  for (const anchor of parseAnchors(bytes).anchors) {
    if (anchor.fullId === null) {
      continue;
    }
    const slot = claimSlotNamed(opened.index, anchor.fullId as RecordId);
    if (opened.index.claimAtSlot(slot) === undefined) {
      continue;
    }
    const { status } = await labelledClaim(opened, slot, "recorded");
    marks.set(anchor.label, markOf(status.label));
  }
  const text = new TextDecoder().decode(bytes);
  const { body } = splitReceiptsSection(text);
  const marked = body.replace(/\[\^([^\]]+)\](?!:)/g, (reference: string, label: string) => {
    const mark = marks.get(label);
    return mark === undefined ? reference : `${mark}${reference}`;
  });
  return marked + text.slice(body.length);
}

/** `render.markdown@2`: the repository's check claims as a checklist, or a markdown file with each
 * anchored claim marked, read from the latest receipts and never performed. */
export const renderMarkdown: OperationDescriptor<RenderMarkdownInput, RenderMarkdownOutput> = {
  id: "render.markdown",
  version: versionString("2"),
  input: {
    type: "object",
    additionalProperties: false,
    properties: { file: { type: "string", minLength: 1 } },
  },
  output: {
    type: "object",
    additionalProperties: false,
    required: ["markdown"],
    properties: {
      markdown: { type: "string" },
      claims: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["statement", "label", "reason", "short"],
          properties: {
            statement: { type: "string" },
            label: { enum: ["holds", "fails", "open"] },
            reason: { type: ["string", "null"] },
            short: { type: "string" },
            decidedOnStaleEvidence: { const: true },
          },
        },
      },
    },
  },
  effect: "read",
  authority: null,
  plans: true,
  reasons: ["invalid-input", "no-such-record", "workspace-incomplete"],
  documentation: "Renders the repository's check claims, or a markdown file's anchored claims, with their marks.",
  paths: ["file"],
  cli: {
    verb: "render",
    positional: [],
    flags: ["file"],
    describe: "print the repository's checked claims as a checklist, or mark a markdown file's anchored claims",
  },
  renderText: (output) => output.markdown,
  exitCode: () => 0,
  async handler(input, context) {
    const opened = await openWorkspace(context);
    return input.file === undefined
      ? await checklist(opened, context.workspace)
      : { markdown: await markedFile(opened, input.file) };
  },
};
