interface EnvelopeRequest {
  readonly protocol: number;
  readonly contribution: string;
  readonly id: string;
  readonly version: string;
  readonly input: unknown;
}

interface ContributionEntry {
  readonly kind: string;
  readonly id: string;
  readonly version: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly documentation: string;
}

const MODULE_NAME = "two-rulers";

const KIND_ID = MODULE_NAME + "/audit";
const CLAIM_TYPE = MODULE_NAME + "/audited@1";
const RULE_ID = MODULE_NAME + "/audits";
const DECLARATIVE = "musai.core/declarative";

/** A kind opening one claim whose conditions name two rules: core's declarative one and its own. */
const CONTRIBUTIONS: readonly ContributionEntry[] = [
  {
    kind: "kind",
    id: KIND_ID,
    version: "1",
    input: true,
    output: true,
    documentation: "an audit's own setlist: one claim that two rules would each settle",
  },
  {
    kind: "claim-type",
    id: CLAIM_TYPE,
    version: "1",
    input: { identityDimensions: ["case"] },
    output: true,
    documentation: "that an audit passes, identified by the booking it belongs to",
  },
  {
    kind: "rule",
    id: RULE_ID,
    version: "1",
    input: true,
    output: true,
    documentation: "a rule that is never asked, since the claim naming it names another",
  },
];

interface KindInput {
  readonly slug: string;
}

function openSetlist(input: KindInput): unknown {
  return {
    claims: [
      {
        type: CLAIM_TYPE,
        conditions: { case: input.slug, [DECLARATIVE]: "{}", [RULE_ID]: "{}" },
        canonical: { case: input.slug },
        rendering: "the audit of " + input.slug + " passes",
        about: [],
        exclusiveGroup: null,
      },
    ],
  };
}

function respond(output: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ ok: true, output, diagnostics: [] }));
}

function respondError(code: string, data: unknown, message: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ ok: false, error: { code, data, message } }));
}

export function invoke(requestBytes: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(requestBytes);
  const request = JSON.parse(text) as EnvelopeRequest;

  if (request.contribution === "describe") {
    return respond(CONTRIBUTIONS);
  }
  if (request.contribution === "kind" && request.id === KIND_ID) {
    return respond(openSetlist(request.input as KindInput));
  }
  return respondError(
    "unknown-contribution",
    { id: request.id, contribution: request.contribution },
    request.id + " names a contribution this module does not answer",
  );
}
