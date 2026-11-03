import {
  type ArtifactRecord,
  type CaseRecord,
  CURRENT_SCHEMA_VERSIONS,
  type RecordId,
  recordId,
  versionString,
} from "@musai/records";

/** A case booked bare under `slug`; two alike in all else share an id unless the put salts one. */
export function fixtureCase(
  slug: string,
  claims: readonly RecordId[] = [],
  { supersedes = [] }: { readonly supersedes?: readonly RecordId[] } = {},
): CaseRecord {
  return {
    kind: "case",
    supersedes: [...supersedes],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.case,
    type: null,
    slug,
    claims: [...claims],
    preset: {
      module: "musai.core",
      contribution: "musai.core/bare",
      moduleRecord: recordId({ marker: slug }),
    },
    projectCommit: "0".repeat(40),
    overrides: {},
    evaluatorVersion: versionString("1"),
  };
}

/** A plain-text draft of `caseId`, replacing `supersedes`. */
export function fixtureArtifact(
  caseId: RecordId,
  content: string,
  supersedes: readonly RecordId[] = [],
): ArtifactRecord {
  return {
    kind: "artifact",
    schemaVersion: CURRENT_SCHEMA_VERSIONS.artifact,
    case: caseId,
    lifecycle: "drafted",
    content,
    format: "text",
    supersedes: [...supersedes],
  };
}
