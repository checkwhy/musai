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

const MODULE_NAME = "greeter";

const GREETS_CONTRIBUTION_ID = MODULE_NAME + "/greets";
const NOTE_TEMPLATE_ID = MODULE_NAME + "/note";

const GREETS_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: { name: { type: "string" } },
};

const GREETS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["greeting"],
  properties: { greeting: { type: "string" } },
};

const NOTE_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["who"],
  properties: { who: { type: "string" } },
};

const NOTE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["format", "content"],
  properties: { format: { type: "string" }, content: { type: "string" } },
};

/** A `parser`, projected as a tool from its own schema, and a `template`, projected as a prompt. */
const CONTRIBUTIONS: readonly ContributionEntry[] = [
  {
    kind: "parser",
    id: GREETS_CONTRIBUTION_ID,
    version: "1",
    input: GREETS_INPUT_SCHEMA,
    output: GREETS_OUTPUT_SCHEMA,
    documentation: "greets the name its own input names",
  },
  {
    kind: "template",
    id: NOTE_TEMPLATE_ID,
    version: "1",
    input: NOTE_INPUT_SCHEMA,
    output: NOTE_OUTPUT_SCHEMA,
    documentation: "a short note addressed to the name its own input names",
  },
];

function respond(output: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ ok: true, output, diagnostics: [] }));
}

function respondError(code: string, data: unknown, message: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ ok: false, error: { code, data, message } }));
}

/** The envelope's one export; `describe` answers the contribution table a build derives from. */
export function invoke(requestBytes: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(requestBytes);
  const request = JSON.parse(text) as EnvelopeRequest;

  if (request.contribution === "describe") {
    return respond(CONTRIBUTIONS);
  }
  if (request.contribution === "parser" && request.id === GREETS_CONTRIBUTION_ID) {
    const input = request.input as { readonly name: string };
    return respond({ greeting: "hello, " + input.name });
  }
  if (request.contribution === "template" && request.id === NOTE_TEMPLATE_ID) {
    const input = request.input as { readonly who: string };
    return respond({ format: "text", content: "a note for " + input.who });
  }
  return respondError(
    "unknown-contribution",
    { id: request.id, contribution: request.contribution },
    request.id + " names a contribution this module does not answer",
  );
}
