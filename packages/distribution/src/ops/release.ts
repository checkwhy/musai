import {
  definedOperation,
  MINTED_ARRAY_SCHEMA,
  OperationError,
  type OperationHandler,
  releaseStanding,
  sealStanding,
  type Workspace,
  type WriteResult,
} from "@musai/api-core";
import {
  type Audience,
  canonicalBytes,
  isTimestamp,
  parseAudience,
  RELEASE_USES,
  type RecordId,
  type ReleaseExtent,
  type ReleaseTerms,
  type ReleaseUse,
  releaseTermsProblem,
  versionString,
} from "@musai/records";

export interface ReleaseInput {
  readonly id: string;
  readonly to: string;
  /** Comma-separated, from `review`, `cite` and `republish`. */
  readonly for?: string;
  readonly from?: string;
  readonly until?: string;
  readonly marking?: string;
  /** Releases what the record cites too, as one attestation. */
  readonly closure?: boolean;
  /** Outranks the workspace's own configuration and anything the allowed signers register. */
  readonly key?: string;
}

export interface SealInput {
  readonly id: string;
  readonly from: string;
  /** Seals what the record cites too, as one attestation. */
  readonly closure?: boolean;
  readonly key?: string;
}

/** Names releases by `to` or seals by `from`, exactly one of them. */
export interface RevokeInput {
  readonly id: string;
  readonly to?: string;
  readonly from?: string;
  readonly key?: string;
}

export interface ReleaseOutput extends WriteResult {
  /** 1 when the record already stood as asked, so nothing was minted. */
  readonly unchanged: number;
}

/** The uses a release grants when the caller names none. */
export const DEFAULT_USES = "review,cite";

function renderReleaseText(output: ReleaseOutput): string {
  const lines: string[] = output.minted.map((item) => item.id);
  if (output.unchanged > 0) {
    lines.push("the record already stood as asked");
  }
  return lines.join("\n");
}

function refuse(about: string, detail: string): OperationError {
  return new OperationError({ reason: "invalid-input", about: [about], detail });
}

/** An audience as a caller typed it; a name must be one the workspace's `audiences` declares. */
export function audienceOf(opened: Workspace, named: string): Audience {
  let form: ReturnType<typeof parseAudience>;
  try {
    form = parseAudience(named);
  } catch (error) {
    throw refuse(named, (error as Error).message);
  }
  if (form.form === "name" && !opened.audiences.names.has(form.name)) {
    throw refuse(
      named,
      `${named} is not an audience the workspace's audiences file declares; declare it there, or name public, a key or an identity`,
    );
  }
  return named as Audience;
}

function termsOf(input: ReleaseInput): ReleaseTerms {
  const named = (input.for ?? DEFAULT_USES).split(",").map((use) => use.trim());
  const unknown = named.filter((use) => !(RELEASE_USES as readonly string[]).includes(use));
  if (unknown.length > 0) {
    throw refuse(unknown[0]!, `${unknown.join(", ")} is not a use: a release grants ${RELEASE_USES.join(", ")}`);
  }
  for (const [field, value] of [
    ["from", input.from],
    ["until", input.until],
  ] as const) {
    if (value !== undefined && !isTimestamp(value)) {
      throw refuse(value, `--${field} takes an RFC 3339 timestamp, got ${value}`);
    }
  }
  const terms: ReleaseTerms = {
    form: "bytes",
    uses: RELEASE_USES.filter((use): use is ReleaseUse => named.includes(use)),
    from: (input.from ?? null) as ReleaseTerms["from"],
    until: (input.until ?? null) as ReleaseTerms["until"],
    marking: input.marking ?? null,
  };
  const problem = releaseTermsProblem(terms);
  if (problem !== null) {
    throw refuse(input.id, problem);
  }
  return terms;
}

function sameTerms(a: ReleaseTerms, b: ReleaseTerms): boolean {
  const bytes = (terms: ReleaseTerms) => new TextDecoder().decode(canonicalBytes(terms));
  return bytes(a) === bytes(b);
}

function heldRecord(opened: Workspace, id: string): RecordId {
  opened.read(id as RecordId);
  return id as RecordId;
}

/** Granting what already stands writes nothing; new terms for the same audience and extent
 * supersede the release that stands. */
const releaseGrantHandler: OperationHandler<ReleaseInput, ReleaseOutput> = {
  async plan(input, opened) {
    const subject = heldRecord(opened, input.id);
    const audience = audienceOf(opened, input.to);
    const terms = termsOf(input);
    const extent = input.closure === true ? "closure" : "record";
    const same = (await releaseStanding(opened, subject)).standing.filter(
      (release) => release.record.audience === audience && release.record.extent === extent,
    );
    const unchanged = same.some((release) => sameTerms(release.record.terms, terms));
    return {
      plan: {
        put: [],
        attest: unchanged
          ? []
          : [
              {
                subject: { record: subject },
                purpose: "released",
                release: { audience, extent, terms },
                supersedes: same.map((release) => release.id),
              },
            ],
        needs: [],
      },
      output: (applied) => ({ minted: applied.minted, unchanged: unchanged ? 1 : 0 }),
      key: input.key,
    };
  },
};

/** Writes nothing where a seal from the audience stands at the extent asked; at another extent, the
 * new seal supersedes those standing from it. */
const releaseSealHandler: OperationHandler<SealInput, ReleaseOutput> = {
  async plan(input, opened) {
    const subject = heldRecord(opened, input.id);
    const audience = audienceOf(opened, input.from);
    const extent: ReleaseExtent = input.closure === true ? "closure" : "record";
    const from = (await sealStanding(opened, subject)).standing.filter(
      (seal) => seal.record.seal.audience === audience,
    );
    const unchanged = from.some((seal) => (seal.record.seal.extent ?? "record") === extent);
    // A seal of the record alone names no extent, so it hashes as every v5 seal without one does.
    const seal = extent === "record" ? { audience } : { audience, extent };
    return {
      plan: {
        put: [],
        attest: unchanged
          ? []
          : [
              {
                subject: { record: subject },
                purpose: "sealed",
                seal,
                ...(from.length === 0 ? {} : { supersedes: from.map((standing) => standing.id) }),
              },
            ],
        needs: [],
      },
      output: (applied) => ({ minted: applied.minted, unchanged: unchanged ? 1 : 0 }),
      key: input.key,
    };
  },
};

/** What a revocation names: the standing releases to `to`, or the standing seals from `from`. */
async function withdrawnBy(input: RevokeInput, opened: Workspace, subject: RecordId): Promise<readonly RecordId[]> {
  const { to, from } = input;
  if (to !== undefined && from === undefined) {
    const audience = audienceOf(opened, to);
    const { standing } = await releaseStanding(opened, subject);
    return standing.filter((release) => release.record.audience === audience).map((release) => release.id);
  }
  if (from !== undefined && to === undefined) {
    const audience = audienceOf(opened, from);
    const { standing } = await sealStanding(opened, subject);
    return standing.filter((seal) => seal.record.seal.audience === audience).map((seal) => seal.id);
  }
  throw refuse(
    input.id,
    "a revocation names exactly one of to, the audience whose releases it withdraws, and from, the audience whose seals it lifts",
  );
}

/** Withdraws every standing release to, or lifts every standing seal from, exactly the audience
 * named: one naming a wider audience stands until it is revoked by its own name. */
const releaseRevokeHandler: OperationHandler<RevokeInput, ReleaseOutput> = {
  async plan(input, opened) {
    const subject = heldRecord(opened, input.id);
    const withdrawn = await withdrawnBy(input, opened, subject);
    return {
      plan: {
        put: [],
        attest:
          withdrawn.length === 0
            ? []
            : [
                {
                  subject: { record: subject },
                  purpose: "revoked",
                  supersedes: withdrawn,
                },
              ],
        needs: [],
      },
      output: (applied) => ({ minted: applied.minted, unchanged: withdrawn.length === 0 ? 1 : 0 }),
      key: input.key,
    };
  },
};

const RELEASE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["minted", "unchanged"],
  properties: {
    minted: MINTED_ARRAY_SCHEMA,
    unchanged: { type: "integer", minimum: 0 },
  },
} as const;

/** Signed whatever the workspace's signing level, since nothing leaves until someone signs for it,
 * and never relayed through model. */
export const releaseGrant = definedOperation<ReleaseInput, ReleaseOutput>(
  {
    id: "release.grant",
    version: versionString("2"),
    input: {
      type: "object",
      additionalProperties: false,
      required: ["id", "to"],
      properties: {
        id: { type: "string" },
        to: { type: "string", description: "public, key:SHA256:…, identity:<issuer>#<subject>, or a declared name" },
        for: { type: "string", description: "the uses granted, comma-separated: review, cite, republish" },
        from: { type: "string", description: "the instant the release takes effect" },
        until: { type: "string", description: "the instant the release lapses" },
        marking: { type: "string", description: "<scheme>:<value>; republish needs an spdx: licence" },
        closure: { type: "boolean", description: "release everything the record cites as well" },
        key: { type: "string" },
      },
    },
    output: RELEASE_OUTPUT_SCHEMA,
    effect: "write",
    authority: "publish",
    reasons: ["no-such-record", "invalid-input", "head-moved", "not-authorised"],
    documentation:
      "Releases a record, or its whole closure, to an audience under terms, signed, so an export to that audience may carry it.",
    paths: ["key"],
    statements: ["to"],
    cli: {
      verb: "release",
      positional: ["id"],
      flags: ["to", "for", "from", "until", "marking", "closure", "key"],
      describe: "sign that a record, or its closure, may leave the machine for an audience, under terms",
    },
    renderText: renderReleaseText,
    exitCode: () => 0,
  },
  releaseGrantHandler,
);

/** Signed whatever the workspace's signing level, and never relayed through model. */
export const releaseSeal = definedOperation<SealInput, ReleaseOutput>(
  {
    id: "release.seal",
    version: versionString("1"),
    input: {
      type: "object",
      additionalProperties: false,
      required: ["id", "from"],
      properties: {
        id: { type: "string" },
        from: {
          type: "string",
          description:
            "the audience sealed from: public, key:SHA256:…, identity:<issuer>#<subject>, or a declared name",
        },
        closure: { type: "boolean", description: "seal everything the record cites as well" },
        key: { type: "string" },
      },
    },
    output: RELEASE_OUTPUT_SCHEMA,
    effect: "write",
    authority: "publish",
    reasons: ["no-such-record", "invalid-input", "head-moved", "not-authorised"],
    documentation:
      "Seals a record, or its whole closure, from an audience, signed, so no station cleared for that audience, for one inside it or for one containing it sees it.",
    paths: ["key"],
    statements: ["from"],
    cli: {
      verb: "seal",
      positional: ["id"],
      flags: ["from", "closure", "key"],
      describe: "sign that a record, or its closure, is hidden from every station cleared for an audience",
    },
    renderText: renderReleaseText,
    exitCode: () => 0,
  },
  releaseSealHandler,
);

/** What already left is not recalled; what leaves next does not include it. */
export const releaseRevoke = definedOperation<RevokeInput, ReleaseOutput>(
  {
    id: "release.revoke",
    version: versionString("2"),
    input: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string" },
        to: { type: "string", description: "the audience whose releases are withdrawn; never with from" },
        from: { type: "string", description: "the audience whose seals are lifted; never with to" },
        key: { type: "string" },
      },
    },
    output: RELEASE_OUTPUT_SCHEMA,
    effect: "write",
    authority: "publish",
    reasons: ["no-such-record", "invalid-input", "head-moved", "not-authorised"],
    documentation:
      "Withdraws a record's standing releases to one audience, or lifts its seals from one, by naming each.",
    paths: ["key"],
    statements: ["to", "from"],
    cli: {
      verb: "revoke",
      positional: ["id"],
      flags: ["to", "from", "key"],
      describe: "withdraw a record's releases to an audience, or lift its seals from one",
    },
    renderText: renderReleaseText,
    exitCode: () => 0,
  },
  releaseRevokeHandler,
);
