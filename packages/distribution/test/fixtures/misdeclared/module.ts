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

const MODULE_NAME = "misdeclared";

const KIND_ID = MODULE_NAME + "/entry";
const CLAIM_TYPE = MODULE_NAME + "/noted@1";

/** A kind naming one claim type whose canonical schema names a JSON type that does not exist. */
const CONTRIBUTIONS: readonly ContributionEntry[] = [
  {
    kind: "kind",
    id: KIND_ID,
    version: "1",
    input: true,
    output: true,
    documentation: "an entry's own setlist: one claim of the misdeclared type",
  },
  {
    kind: "claim-type",
    id: CLAIM_TYPE,
    version: "1",
    input: { identityDimensions: ["case"], canonical: { type: "nonsense" } },
    output: true,
    documentation: "that an entry was noted, its payload schema misspelled",
  },
];

interface KindInput {
  readonly slug: string;
  readonly about: readonly string[];
}

function openSetlist(input: KindInput): unknown {
  return {
    claims: [
      {
        type: CLAIM_TYPE,
        conditions: { case: input.slug },
        canonical: { case: input.slug },
        rendering: "the entry " + input.slug + " was noted",
        about: [...input.about],
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
