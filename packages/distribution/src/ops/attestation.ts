import { type OperationDescriptor, openWorkspace, signatureCheck, type Workspace } from "@musai/api-core";
import type { IndexedAttestation, IndexedWithdrawing } from "@musai/fold";
import { type RecordId, type ReleaseTerms, versionString } from "@musai/records";
import { heldMatch, idPrefixOf } from "../claim-ref.js";

export interface AttestationShowInput {
  readonly id: string;
}

export interface AttestationShowOutput {
  readonly id: string;
  readonly schemaVersion: number;
  readonly purpose: string;
  readonly subject: string;
  readonly principal: string | null;
  readonly via: string | null;
  readonly at: string | null;
  /** The audience a release grants or a seal hides from; `null` for any other purpose. */
  readonly audience: string | null;
  readonly extent: "record" | "closure" | null;
  readonly terms: ReleaseTerms | null;
  readonly supersedes: readonly string[];
  readonly verified: boolean;
  /** Why the signature does not verify; `null` where it does. */
  readonly failure: string | null;
}

/** A later version's attestation is held only for what every version fixes. */
type Found = { readonly id: RecordId } & (
  | { readonly whole: IndexedAttestation }
  | { readonly withdrawing: IndexedWithdrawing }
);

function foundAttestation(opened: Workspace, named: string): Found {
  const hex = idPrefixOf(named, "attestation");
  return heldMatch(
    opened.index,
    named,
    hex,
    [
      ...opened.index.attestationsWithHexPrefix(hex).map((whole) => ({ id: whole.id, whole })),
      ...opened.index.withdrawingWithHexPrefix(hex).map((withdrawing) => ({ id: withdrawing.id, withdrawing })),
    ],
    "attestation",
  );
}

function entryOf(found: Found): IndexedAttestation | IndexedWithdrawing {
  return "whole" in found ? found.whole : found.withdrawing;
}

async function verdictOf(
  opened: Workspace,
  found: Found,
): Promise<Pick<AttestationShowOutput, "verified" | "failure">> {
  const { id, record } = entryOf(found);
  if (record.principal === null || record.at === null) {
    return { verified: false, failure: "it names no principal or time a signature could be checked against" };
  }
  const check = await signatureCheck(opened, { id, record: { principal: record.principal, at: record.at } });
  return check.good ? { verified: true, failure: null } : { verified: false, failure: check.failure ?? "no signature" };
}

function grantOf(found: Found): Pick<AttestationShowOutput, "audience" | "extent" | "terms"> {
  const record = "whole" in found ? found.whole.record : undefined;
  if (record?.purpose === "released") {
    return { audience: record.audience, extent: record.extent, terms: record.terms };
  }
  if (record?.purpose === "sealed") {
    return { audience: record.seal.audience, extent: record.seal.extent ?? "record", terms: null };
  }
  return { audience: null, extent: null, terms: null };
}

function termsText(terms: ReleaseTerms): string {
  return [
    `for ${terms.uses.join(", ")}`,
    ...(terms.from === null ? [] : [`from ${terms.from}`]),
    ...(terms.until === null ? [] : [`until ${terms.until}`]),
    ...(terms.marking === null ? [] : [`marked ${terms.marking}`]),
  ].join(", ");
}

function renderAttestationText(output: AttestationShowOutput): string {
  const rows: [string, string][] = [
    ["purpose", output.purpose],
    ["subject", output.subject],
    ["signer", `${output.principal ?? "none named"}, via ${output.via ?? "none named"}, at ${output.at ?? "no time"}`],
    ...(output.audience === null ? [] : ([["audience", output.audience]] as [string, string][])),
    ...(output.extent === null ? [] : ([["extent", output.extent]] as [string, string][])),
    ...(output.terms === null ? [] : ([["terms", termsText(output.terms)]] as [string, string][])),
    ["supersedes", output.supersedes.length === 0 ? "nothing" : output.supersedes.join(", ")],
    ["signature", output.verified ? "verifies" : `does not verify: ${output.failure}`],
  ];
  return [output.id, ...rows.map(([label, value]) => `${label.padEnd(11)}${value}`)].join("\n");
}

const NULLABLE_STRING = { type: ["string", "null"] } as const;

/** `attestation.show@1`: one attestation by id or prefix, and whether its signature verifies; the
 * author's alone, since a cleared fold must not learn that a seal exists. */
export const attestationShow: OperationDescriptor<AttestationShowInput, AttestationShowOutput> = {
  id: "attestation.show",
  version: versionString("1"),
  input: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: {
      id: { type: "string", description: "the attestation's record id, or eight or more of its hex digits" },
    },
  },
  output: {
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "schemaVersion",
      "purpose",
      "subject",
      "principal",
      "via",
      "at",
      "audience",
      "extent",
      "terms",
      "supersedes",
      "verified",
      "failure",
    ],
    properties: {
      id: { type: "string" },
      schemaVersion: { type: "integer" },
      purpose: { type: "string" },
      subject: { type: "string" },
      principal: NULLABLE_STRING,
      via: NULLABLE_STRING,
      at: NULLABLE_STRING,
      audience: NULLABLE_STRING,
      extent: { enum: ["record", "closure", null] },
      terms: {
        oneOf: [
          { type: "null" },
          {
            type: "object",
            additionalProperties: false,
            required: ["form", "uses", "from", "until", "marking"],
            properties: {
              form: { type: "string" },
              uses: { type: "array", items: { type: "string" } },
              from: NULLABLE_STRING,
              until: NULLABLE_STRING,
              marking: NULLABLE_STRING,
            },
          },
        ],
      },
      supersedes: { type: "array", items: { type: "string" } },
      verified: { type: "boolean" },
      failure: NULLABLE_STRING,
    },
  },
  effect: "read",
  authority: null,
  authorOnly: true,
  plans: true,
  reasons: ["invalid-input", "no-such-record"],
  documentation:
    "Shows one attestation by its id or a prefix of it: what it attests, its audience and extent, its signer, what it supersedes and whether its signature verifies.",
  cli: {
    verb: "show",
    group: "attestation",
    positional: ["id"],
    flags: [],
    describe: "show one attestation, its audience, extent, signer and what it supersedes, and whether it verifies",
  },
  renderText: renderAttestationText,
  exitCode: () => 0,
  async handler(input, context) {
    const opened = await openWorkspace(context);
    const found = foundAttestation(opened, input.id);
    const { id, record } = entryOf(found);
    return {
      id,
      schemaVersion: record.schemaVersion,
      purpose: record.purpose,
      subject: record.subject,
      principal: record.principal,
      via: record.via,
      at: record.at,
      ...grantOf(found),
      supersedes: [...record.supersedes],
      ...(await verdictOf(opened, found)),
    };
  },
};
