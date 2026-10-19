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

const MODULE_NAME = "allocates";

const RULE_ID = MODULE_NAME + "/holds-after-allocating";

/** Arrays of a million slots kept alive: inside the memory default, past a ceiling of 8. */
const RETAINED_ARRAYS = 3;

const CONTRIBUTIONS: readonly ContributionEntry[] = [
  {
    kind: "rule",
    id: RULE_ID,
    version: "1",
    input: true,
    output: true,
    documentation:
      "asks for one clean run, then keeps tens of megabytes alive and holds, so the memory limit its invocation runs under decides whether it answers",
  },
];

function respond(output: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ ok: true, output, diagnostics: [] }));
}

function respondError(code: string, data: unknown, message: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ ok: false, error: { code, data, message } }));
}

/** The run the verdict rests on; a verdict on no receipt reads as no evidence. */
const CLEAN_EXIT = {
  command: ["node", "-e", "process.exit(0)"],
  workingDirectory: "/",
  environment: {},
  declared: [],
  substrates: [],
  isolation: "hygiene",
};

interface RuleInput {
  readonly evidence: readonly unknown[];
}

function holdAfterAllocating(input: RuleInput): unknown {
  if (input.evidence.length === 0) {
    return { kind: "request", needs: [{ kind: "run", recipe: CLEAN_EXIT }] };
  }
  const retained: string[][] = [];
  for (let index = 0; index < RETAINED_ARRAYS; index++) {
    retained.push(new Array<string>(1e6).fill("x"));
  }
  return { kind: "verdict", label: "holds", reason: "kept " + retained.length + " arrays alive and answered" };
}

/** The envelope's one export: canonical-JSON bytes in, bytes out. */
export function invoke(requestBytes: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(requestBytes);
  const request = JSON.parse(text) as EnvelopeRequest;

  if (request.contribution === "describe") {
    return respond(CONTRIBUTIONS);
  }
  if (request.contribution === "rule" && request.id === RULE_ID) {
    return respond(holdAfterAllocating(request.input as RuleInput));
  }
  return respondError(
    "unknown-contribution",
    { id: request.id, contribution: request.contribution },
    request.id + " names a contribution this module does not answer",
  );
}
