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

const MODULE_NAME = "fails-after-runs";

const RULE_ID = MODULE_NAME + "/after-two-runs";

const CONTRIBUTIONS: readonly ContributionEntry[] = [
  {
    kind: "rule",
    id: RULE_ID,
    version: "1",
    input: true,
    output: true,
    documentation:
      "asks for two clean runs tagged by its condition, then either exhausts its host's memory or answers a request whose needs are no list, as its condition's first word says",
  },
];

interface RuleInput {
  readonly conditions: Readonly<Record<string, string>>;
  readonly evidence: readonly unknown[];
}

/** A clean exit carrying the condition's tag, so each claim's runs are its own. */
function cleanExit(tag: string, which: string): unknown {
  return {
    command: ["node", "-e", "process.exit(0)", tag, which],
    workingDirectory: "/",
    environment: {},
    declared: [],
    substrates: [],
    isolation: "hygiene",
  };
}

function afterTwoRuns(input: RuleInput): unknown {
  const [mode, tag] = (input.conditions[RULE_ID] ?? "").split(" ");
  if (input.evidence.length === 0) {
    return {
      kind: "request",
      needs: [
        { kind: "run", recipe: cleanExit(tag ?? "", "first") },
        { kind: "run", recipe: cleanExit(tag ?? "", "second") },
      ],
    };
  }
  if (mode === "malformed") {
    return { kind: "request", needs: "no list" };
  }
  const retained: string[][] = [];
  for (;;) {
    retained.push(new Array<string>(1e6).fill("x"));
  }
}

function respond(output: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ ok: true, output, diagnostics: [] }));
}

function respondError(code: string, data: unknown, message: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ ok: false, error: { code, data, message } }));
}

/** The envelope's one export: canonical-JSON bytes in, bytes out. */
export function invoke(requestBytes: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(requestBytes);
  const request = JSON.parse(text) as EnvelopeRequest;

  if (request.contribution === "describe") {
    return respond(CONTRIBUTIONS);
  }
  if (request.contribution === "rule" && request.id === RULE_ID) {
    return respond(afterTwoRuns(request.input as RuleInput));
  }
  return respondError(
    "unknown-contribution",
    { id: request.id, contribution: request.contribution },
    request.id + " names a contribution this module does not answer",
  );
}
