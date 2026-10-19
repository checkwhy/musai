import type { Workspace } from "@musai/api-core";
import {
  buildAdmissionWorkspace,
  definedOperation,
  installedModules,
  MINTED_ARRAY_SCHEMA,
  OperationError,
  type OperationHandler,
  SALT_INPUT_SCHEMA,
  saltAsked,
  verifiedEvidenceEdge,
  type WriteResult,
} from "@musai/api-core";
import {
  type ArgumentRecord,
  CURRENT_SCHEMA_VERSIONS,
  type RecordId,
  type RecordKind,
  type Selector,
  versionString,
} from "@musai/records";
import { parseSelectorText } from "../anchor/grammar.js";

export interface ChallengeFileInput {
  readonly target: string;
  readonly reason: string;
  readonly run: string;
  readonly selector: string;
  /** A private key to sign this challenge with, outranking any configured or registered key. */
  readonly key?: string;
  readonly salt?: boolean;
}

export type ChallengeFileOutput = WriteResult;

function renderChallengeFileText(output: ChallengeFileOutput): string {
  return output.minted.map((item) => item.id).join("\n");
}

const CHALLENGEABLE_KINDS: ReadonlySet<RecordKind> = new Set(["claim", "run", "argument"]);

export function assertChallengeable(named: string, kind: RecordKind): void {
  if (!CHALLENGEABLE_KINDS.has(kind)) {
    throw new OperationError({
      reason: "no-such-record",
      about: [named],
      detail: `${named} is a ${kind} record, and a challenge attacks a claim, a run or another argument`,
    });
  }
}

/** The record a typed target names. Slots and record ids share one spelling, so the slot is tried
 * first; an argument always stores the record id. */
function resolveTarget(opened: Workspace, named: string): RecordId {
  const atSlot = opened.index.claimAtSlot(named);
  if (atSlot !== undefined && atSlot.record.kind === "claim") {
    return atSlot.id;
  }
  assertChallengeable(named, opened.read(named as RecordId).kind);
  return named as RecordId;
}

const challengeFileHandler: OperationHandler<ChallengeFileInput, ChallengeFileOutput> = {
  async plan(input, opened) {
    const target = resolveTarget(opened, input.target);

    const parts = parseSelectorText(input.selector);
    if (parts === null) {
      throw new OperationError({
        reason: "invalid-input",
        about: [input.selector],
        detail: `${input.selector} is not a selector: a selector reads <module>/<parser>@<version>:<key>`,
      });
    }
    const selector: Selector = {
      module: parts.module,
      parser: parts.parser,
      version: versionString(parts.version),
      key: parts.key,
    };

    const admissionWorkspace = await buildAdmissionWorkspace(opened, await installedModules(opened));
    const edge = await verifiedEvidenceEdge(opened, admissionWorkspace, input.run as RecordId, selector);

    const argument: ArgumentRecord = {
      kind: "argument",
      schemaVersion: CURRENT_SCHEMA_VERSIONS.argument,
      target,
      reason: input.reason,
      evidence: [edge],
      premises: [],
      supersedes: [],
    };

    return {
      plan: {
        put: [{ kind: "argument", value: argument, ...saltAsked(input.salt) }],
        attest: [{ subject: { put: 0 }, purpose: "made" }],
        needs: [],
      },
      output: (applied) => ({ minted: applied.minted }),
      key: input.key,
    };
  },
};

/** `challenge.file@2`: files one argument resting on one admitted piece of evidence. A record is
 * forever, so evidence that is missing or unrankable is refused before the write. */
export const challengeFile = definedOperation<ChallengeFileInput, ChallengeFileOutput>(
  {
    id: "challenge.file",
    version: versionString("2"),
    input: {
      type: "object",
      additionalProperties: false,
      required: ["target", "reason", "run", "selector"],
      properties: {
        target: { type: "string" },
        reason: { type: "string" },
        run: { type: "string" },
        selector: { type: "string" },
        key: { type: "string" },
        salt: SALT_INPUT_SCHEMA,
      },
    },
    output: {
      type: "object",
      additionalProperties: false,
      required: ["minted"],
      properties: {
        minted: MINTED_ARRAY_SCHEMA,
      },
    },
    effect: "write",
    authority: null,
    reasons: ["no-such-record", "invalid-input", "head-moved", "unsupported-format"],
    documentation: "Files a challenge against a claim, a run or another argument, admitting the evidence it cites.",
    paths: ["key"],
    cli: {
      verb: "challenge",
      positional: ["target"],
      flags: ["reason", "run", "selector", "key", "salt"],
      describe: "file a challenge against a claim, a run or another argument",
    },
    renderText: renderChallengeFileText,
    exitCode: () => 0,
  },
  challengeFileHandler,
);
