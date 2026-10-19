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

const MODULE_NAME = "fixture-minimal";

const PARSER_ID = `${MODULE_NAME}/exit-code`;
const RULE_ID = `${MODULE_NAME}/clean-exit`;

const CONTRIBUTIONS: readonly ContributionEntry[] = [
  {
    kind: "parser",
    id: PARSER_ID,
    version: "1",
    input: true,
    output: true,
    documentation: "selects a run's own exit code from its observation",
  },
  {
    kind: "rule",
    id: RULE_ID,
    version: "1",
    input: true,
    output: true,
    documentation:
      "holds when every piece of evidence exited cleanly, fails when one did not, and stays open with none yet",
  },
];

interface RuleEvidence {
  readonly runId: string;
  readonly exitCode: number;
  readonly output: string;
}

interface RuleInput {
  readonly claimId: string;
  readonly conditions: Readonly<Record<string, string>>;
  readonly evidence: readonly RuleEvidence[];
}

function evaluateCleanExit(input: RuleInput): unknown {
  if (input.evidence.length === 0) {
    return { kind: "verdict", label: "open", reason: "no evidence yet" };
  }
  const everyExitClean = input.evidence.every((item) => item.exitCode === 0);
  return {
    kind: "verdict",
    label: everyExitClean ? "holds" : "fails",
    reason: everyExitClean ? "every run exited cleanly" : "a run exited with a non-zero code",
  };
}

function selectExitCode(input: { readonly exitCode: number }): unknown {
  return { exitCode: input.exitCode };
}

function respond(output: unknown): Uint8Array {
  const text = JSON.stringify({ ok: true, output, diagnostics: [] });
  return new TextEncoder().encode(text);
}

function respondError(code: string, data: unknown, message: string): Uint8Array {
  const text = JSON.stringify({ ok: false, error: { code, data, message } });
  return new TextEncoder().encode(text);
}

/** The one export the envelope defines. The bundle's code runs only inside a call to it. */
export function invoke(requestBytes: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(requestBytes);
  const request = JSON.parse(text) as EnvelopeRequest;

  if (request.contribution === "describe") {
    return respond(CONTRIBUTIONS);
  }
  if (request.contribution === "rule" && request.id === RULE_ID) {
    return respond(evaluateCleanExit(request.input as RuleInput));
  }
  if (request.contribution === "parser" && request.id === PARSER_ID) {
    return respond(selectExitCode(request.input as { exitCode: number }));
  }
  return respondError(
    "unknown-contribution",
    { id: request.id, contribution: request.contribution },
    `${request.id} names a contribution this module does not answer`,
  );
}
