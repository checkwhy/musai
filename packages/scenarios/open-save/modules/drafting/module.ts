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

const MODULE_NAME = "drafting";

const TEMPLATE_ID = MODULE_NAME + "/report/draft";

const CONTRIBUTIONS: readonly ContributionEntry[] = [
  {
    kind: "template",
    id: TEMPLATE_ID,
    version: "1",
    input: true,
    output: true,
    documentation: "a report's own starter draft, for a case opened before anyone has typed a word",
  },
];

function starterContent(): string {
  return "# A drafted report\n\nStarter prose for a report a person drafts by hand.\n";
}

function respond(output: unknown): Uint8Array {
  const text = JSON.stringify({ ok: true, output, diagnostics: [] });
  return new TextEncoder().encode(text);
}

function respondError(code: string, data: unknown, message: string): Uint8Array {
  const text = JSON.stringify({ ok: false, error: { code, data, message } });
  return new TextEncoder().encode(text);
}

/** The one export the envelope defines: canonical-JSON bytes in, bytes out. */
export function invoke(requestBytes: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(requestBytes);
  const request = JSON.parse(text) as EnvelopeRequest;

  if (request.contribution === "describe") {
    return respond(CONTRIBUTIONS);
  }
  if (request.contribution === "template" && request.id === TEMPLATE_ID) {
    return respond({ format: "markdown", content: starterContent() });
  }
  return respondError(
    "unknown-contribution",
    { id: request.id, contribution: request.contribution },
    request.id + " names a contribution this module does not answer",
  );
}
