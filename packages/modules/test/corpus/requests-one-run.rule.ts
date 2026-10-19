interface EnvelopeRequest {
  readonly protocol: number;
  readonly contribution: string;
  readonly id: string;
  readonly version: string;
  readonly input: unknown;
}

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

const EXPECTED_OUTPUT = "ok";

/** Requests the one run it needs, then concludes from what the run printed. */
function decide(input: RuleInput): unknown {
  const receipt = input.evidence[0];
  if (receipt === undefined) {
    return {
      kind: "request",
      needs: [
        {
          kind: "run",
          recipe: {
            command: ["node", "-e", "process.stdout.write(" + JSON.stringify(EXPECTED_OUTPUT) + ")"],
            workingDirectory: "/",
            environment: {},
            declared: [],
            substrates: [],
            isolation: "hygiene",
          },
        },
      ],
    };
  }
  if (receipt.exitCode !== 0) {
    return { kind: "verdict", label: "open", reason: "the run did not complete" };
  }
  return receipt.output === EXPECTED_OUTPUT
    ? { kind: "verdict", label: "holds", reason: "the run printed what the rule expects" }
    : { kind: "verdict", label: "fails", reason: "the run printed something else" };
}

/** The one export the envelope defines: canonical-JSON bytes in, bytes out. */
export function invoke(requestBytes: Uint8Array): Uint8Array {
  const request = JSON.parse(new TextDecoder().decode(requestBytes)) as EnvelopeRequest;
  const output = decide(request.input as RuleInput);
  return new TextEncoder().encode(JSON.stringify({ ok: true, output, diagnostics: [] }));
}
