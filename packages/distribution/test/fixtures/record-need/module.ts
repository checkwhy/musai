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

const MODULE_NAME = "record-need";

const RULE_ID = MODULE_NAME + "/cites-a-record";

const CONTRIBUTIONS: readonly ContributionEntry[] = [
  {
    kind: "rule",
    id: RULE_ID,
    version: "1",
    input: true,
    output: true,
    documentation:
      "asks for the record its own condition names and for one clean run, and holds when the run exited cleanly",
  },
];

/** The run asked for beside the record, so the verdict rests on a receipt. */
const CLEAN_EXIT = {
  command: ["node", "-e", "process.exit(0)"],
  workingDirectory: "/",
  environment: {},
  declared: [],
  substrates: [],
  isolation: "hygiene",
};

interface RuleInput {
  readonly claimId: string;
  readonly conditions: Readonly<Record<string, string>>;
  readonly evidence: readonly { readonly runId: string; readonly exitCode: number; readonly output: string }[];
  readonly refusals?: readonly { readonly error: { readonly code: string; readonly message: string } }[];
}

function evaluateCitesARecord(input: RuleInput): unknown {
  const refusal = input.refusals?.[0];
  if (refusal !== undefined) {
    return { kind: "verdict", label: "open", reason: refusal.error.code + ": " + refusal.error.message };
  }
  if (input.evidence.length === 0) {
    return {
      kind: "request",
      needs: [
        { kind: "record", id: input.conditions[RULE_ID] },
        { kind: "run", recipe: CLEAN_EXIT },
      ],
    };
  }
  const everyExitClean = input.evidence.every((item) => item.exitCode === 0);
  return {
    kind: "verdict",
    label: everyExitClean ? "holds" : "fails",
    reason: everyExitClean ? "the record is there and the run exited cleanly" : "the run exited with a non-zero code",
  };
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
    return respond(evaluateCitesARecord(request.input as RuleInput));
  }
  return respondError(
    "unknown-contribution",
    { id: request.id, contribution: request.contribution },
    request.id + " names a contribution this module does not answer",
  );
}
