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

const MODULE_NAME = "quiet";
const TEMPLATE_ID = MODULE_NAME + "/note";

const TEMPLATE_INPUT_SCHEMA = { type: "object", additionalProperties: false, properties: {} };
const TEMPLATE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["format", "content"],
  properties: { format: { type: "string" }, content: { type: "string" } },
};

/** A `template` with no skill marker: installed, and nothing a sync would write. */
const CONTRIBUTIONS: readonly ContributionEntry[] = [
  {
    kind: "template",
    id: TEMPLATE_ID,
    version: "1",
    input: TEMPLATE_INPUT_SCHEMA,
    output: TEMPLATE_OUTPUT_SCHEMA,
    documentation: "a template this module never marks as a plugin skill",
  },
];

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
  if (request.contribution === "template" && request.id === TEMPLATE_ID) {
    return respond({ format: "text", content: "quiet has nothing to say to the plugin." });
  }
  return respondError(
    "unknown-contribution",
    { id: request.id, contribution: request.contribution },
    request.id + " names a contribution this module does not answer",
  );
}
