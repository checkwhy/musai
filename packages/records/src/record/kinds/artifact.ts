import { isRecordId, type RecordId } from "../../canonical/canonicalize.js";
import type { DraftResult, KindContract } from "../contract.js";
import { invalid, parseRecordIdList, parseSalt, type Salted, withoutSalt } from "../fields.js";
import { isSealedValue, type SealableText } from "../sealed.js";

/** One lifecycle state of an artifact; a draft resolving a fork of two lanes supersedes both. */
export interface ArtifactRecord extends Salted {
  kind: "artifact";
  schemaVersion: number;
  case: RecordId;
  lifecycle: "drafted" | "dropped" | "retracted";
  content: SealableText;
  format: string;
  supersedes: RecordId[];
}

const ARTIFACT_LIFECYCLES = ["drafted", "dropped", "retracted"] as const;

export type ArtifactDraft = Omit<ArtifactRecord, "schemaVersion">;

function validateArtifact(fields: Record<string, unknown>): DraftResult<ArtifactDraft> {
  const { case: caseId, lifecycle, content, format, supersedes } = fields;
  if (!isRecordId(caseId)) {
    return invalid("artifact.case must be a record id");
  }
  if (typeof lifecycle !== "string" || !(ARTIFACT_LIFECYCLES as readonly string[]).includes(lifecycle)) {
    return invalid("artifact.lifecycle must be one of drafted, dropped, retracted");
  }
  if (typeof content !== "string" && !isSealedValue(content)) {
    return invalid("artifact.content must be a string or a sealed value");
  }
  if (typeof format !== "string") {
    return invalid("artifact.format must be a string naming the grammar its content is written in");
  }
  const parsedSupersedes = parseRecordIdList(supersedes, "artifact", "supersedes", "empty when nothing is replaced");
  if (!parsedSupersedes.ok) {
    return invalid(parsedSupersedes.error);
  }
  const salt = parseSalt(fields, "artifact");
  if (!salt.ok) {
    return salt;
  }
  const record: ArtifactDraft = {
    kind: "artifact",
    case: caseId,
    lifecycle: lifecycle as ArtifactRecord["lifecycle"],
    content: content as SealableText,
    format,
    supersedes: parsedSupersedes.ids,
    ...salt.field,
  };
  return { ok: true, record };
}

export const artifactContract: KindContract<"artifact", ArtifactDraft> = {
  kind: "artifact",
  version: 4,
  normalizers: {
    // Versions 2 and 3 hold the current fields but the salt, which neither knew.
    2: withoutSalt,
    3: withoutSalt,
  },
  numberPolicy: { schemaVersion: "measured" },
  sealedPaths: new Set(["$.content"]),
  packMayDraft: true,
  saltable: true,
  validate: validateArtifact,
};
