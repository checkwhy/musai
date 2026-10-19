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

const MODULE_NAME = "twin-options";

const KIND_ID = MODULE_NAME + "/menu";
const CHOICE_TYPE = MODULE_NAME + "/choice@1";

/** A kind opening one menu with two members at two slots offering the same option. */
const CONTRIBUTIONS: readonly ContributionEntry[] = [
  {
    kind: "kind",
    id: KIND_ID,
    version: "1",
    input: true,
    output: true,
    documentation: "a menu's own setlist: two choices, one per side, both offered as file",
  },
  {
    kind: "claim-type",
    id: CHOICE_TYPE,
    version: "1",
    input: { identityDimensions: ["case", "side"] },
    output: true,
    documentation: "that one side of a menu is chosen, identified by the case and the side",
  },
];

interface KindInput {
  readonly slug: string;
}

function choice(slug: string, side: string): unknown {
  return {
    type: CHOICE_TYPE,
    conditions: { case: slug, side, disposition: "file", gateClass: "intent" },
    canonical: { case: slug, side },
    rendering: "file " + slug + " from the " + side,
    about: [],
    exclusiveGroup: slug + "/menu",
  };
}

function openSetlist(input: KindInput): unknown {
  return { claims: [choice(input.slug, "left"), choice(input.slug, "right")] };
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
