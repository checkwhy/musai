interface EnvelopeRequest {
  readonly protocol: number;
  readonly contribution: string;
  readonly id: string;
  readonly version: string;
  readonly input: unknown;
}

interface SkillMarker {
  readonly name: string;
}

interface ContributionEntry {
  readonly kind: string;
  readonly id: string;
  readonly version: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly documentation: string;
  readonly skill?: SkillMarker;
}

const MODULE_NAME = "skillful";

const MARKED_TEMPLATE_ID = MODULE_NAME + "/greeting-skill";

const TEMPLATE_INPUT_SCHEMA = { type: "object", additionalProperties: false, properties: {} };
const TEMPLATE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["format", "content"],
  properties: { format: { type: "string" }, content: { type: "string" } },
};

/** A `template` marked as a plugin skill, bundled for a real sync end to end. */
const CONTRIBUTIONS: readonly ContributionEntry[] = [
  {
    kind: "template",
    id: MARKED_TEMPLATE_ID,
    version: "1",
    input: TEMPLATE_INPUT_SCHEMA,
    output: TEMPLATE_OUTPUT_SCHEMA,
    documentation: "this module's own conversational entry, synced into the plugin",
    skill: { name: "musai-skillful" },
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
  if (request.contribution === "template" && request.id === MARKED_TEMPLATE_ID) {
    return respond({ format: "text", content: "skillful's own conversational entry, rendered for real." });
  }
  return respondError(
    "unknown-contribution",
    { id: request.id, contribution: request.contribution },
    request.id + " names a contribution this module does not answer",
  );
}
