interface EnvelopeRequest {
  readonly contribution: string;
  readonly id: string;
  readonly input: unknown;
}

interface RuleInput {
  readonly evidence: readonly { readonly exitCode: number }[];
  readonly refusals?: readonly { readonly error: { readonly message: string } }[];
}

const RULE_ID = "scaffolded/exits-cleanly";

const CONTRIBUTIONS = [
  {
    kind: "rule",
    id: RULE_ID,
    version: "1",
    input: true,
    output: true,
    documentation: "holds when its command exits cleanly in the project's working tree",
  },
];

/** Stands in the project's working tree, bound as `tree`, so it names no path on any machine. */
const RECIPE = {
  command: ["node", "-e", "process.stdout.write('ok')"],
  workingDirectory: ".",
  environment: {},
  declared: [],
  substrates: [{ name: "tree", uri: "musai:tree" }],
  isolation: "hygiene",
};

function decide(input: RuleInput): unknown {
  const refusal = input.refusals?.[0];
  if (refusal !== undefined) {
    return { kind: "verdict", label: "open", reason: refusal.error.message };
  }
  const run = input.evidence[0];
  if (run === undefined) {
    return { kind: "request", needs: [{ kind: "run", recipe: RECIPE }] };
  }
  return run.exitCode === 0
    ? { kind: "verdict", label: "holds", reason: "the run exited cleanly" }
    : { kind: "verdict", label: "fails", reason: "the run exited " + run.exitCode };
}

function respond(response: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(response));
}

/** The one export the envelope defines: request bytes in, response bytes out, nothing ambient. */
export function invoke(requestBytes: Uint8Array): Uint8Array {
  const request = JSON.parse(new TextDecoder().decode(requestBytes)) as EnvelopeRequest;
  if (request.contribution === "describe") {
    return respond({ ok: true, output: CONTRIBUTIONS, diagnostics: [] });
  }
  if (request.contribution === "rule" && request.id === RULE_ID) {
    return respond({ ok: true, output: decide(request.input as RuleInput), diagnostics: [] });
  }
  const message = request.id + " names a contribution this module does not answer";
  return respond({ ok: false, error: { code: "unknown-contribution", data: { id: request.id }, message } });
}
