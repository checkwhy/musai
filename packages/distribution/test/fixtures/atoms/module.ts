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

const MODULE_NAME = "atoms";

const RULE_ID = MODULE_NAME + "/rests-on-atoms";

const CONTRIBUTIONS: readonly ContributionEntry[] = [
  {
    kind: "rule",
    id: RULE_ID,
    version: "1",
    input: true,
    output: true,
    documentation: "reads the atoms its condition names, and holds while every one of them is present",
  },
];

/** One clean run beside the atoms: a verdict ranks only where it rests on a receipt. */
const CLEAN_EXIT = {
  command: ["node", "-e", "process.exit(0)"],
  workingDirectory: "/",
  environment: {},
  declared: [],
  substrates: [],
  isolation: "hygiene",
};

interface AtomRecord {
  readonly conditions: Readonly<Record<string, string>>;
}

interface RuleInput {
  readonly conditions: Readonly<Record<string, string>>;
  readonly evidence: readonly { readonly exitCode: number }[];
  readonly refusals?: readonly { readonly error: { readonly code: string; readonly message: string } }[];
  readonly records?: readonly { readonly id: string; readonly record: AtomRecord }[];
}

function evaluateRestsOnAtoms(input: RuleInput): unknown {
  const refusal = input.refusals?.[0];
  if (refusal !== undefined) {
    return { kind: "verdict", label: "open", reason: refusal.error.code + ": " + refusal.error.message };
  }
  const atoms = input.conditions[RULE_ID]!.split(",");
  const read = new Map((input.records ?? []).map((entry) => [entry.id, entry.record]));
  if (input.evidence.length === 0 || atoms.some((atom) => !read.has(atom))) {
    return {
      kind: "request",
      needs: [...atoms.map((id) => ({ kind: "record", id })), { kind: "run", recipe: CLEAN_EXIT }],
    };
  }
  const gone = atoms.filter((atom) => read.get(atom)!.conditions["value"] !== "present");
  return gone.length === 0
    ? { kind: "verdict", label: "holds", reason: "every atom it rests on is present" }
    : { kind: "verdict", label: "fails", reason: "no longer present: " + gone.join(", ") };
}

function respond(output: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ ok: true, output, diagnostics: [] }));
}

function respondError(code: string, data: unknown, message: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ ok: false, error: { code, data, message } }));
}

/** The envelope's one export: canonical-JSON bytes in, bytes out. */
export function invoke(requestBytes: Uint8Array): Uint8Array {
  const request = JSON.parse(new TextDecoder().decode(requestBytes)) as EnvelopeRequest;
  if (request.contribution === "describe") {
    return respond(CONTRIBUTIONS);
  }
  if (request.contribution === "rule" && request.id === RULE_ID) {
    return respond(evaluateRestsOnAtoms(request.input as RuleInput));
  }
  return respondError(
    "unknown-contribution",
    { id: request.id, contribution: request.contribution },
    request.id + " names a contribution this module does not answer",
  );
}
