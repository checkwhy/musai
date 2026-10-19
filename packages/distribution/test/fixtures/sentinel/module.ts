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

const MODULE_NAME = "sentinel";

const KIND_ID = MODULE_NAME + "/watch";
const CLAIM_TYPE = MODULE_NAME + "/watched@1";
const RULE_ID = MODULE_NAME + "/runs-cleanly";
const SUBSCRIPTION_ID = MODULE_NAME + "/on-claim-put";

const CONTRIBUTIONS: readonly ContributionEntry[] = [
  {
    kind: "kind",
    id: KIND_ID,
    version: "1",
    input: true,
    output: true,
    documentation: "a watch's own setlist: one claim, settled by this module's own rule",
  },
  {
    kind: "claim-type",
    id: CLAIM_TYPE,
    version: "1",
    input: { identityDimensions: ["case"] },
    output: true,
    documentation: "that a watch's sentinel run exits cleanly, identified by the booking it belongs to",
  },
  {
    kind: "rule",
    id: RULE_ID,
    version: "1",
    input: true,
    output: true,
    documentation: "asks for the sentinel run and holds when it exited cleanly",
  },
  {
    kind: "subscription",
    id: SUBSCRIPTION_ID,
    version: "1",
    input: { properties: { name: { const: "claim.put" } } },
    output: true,
    documentation: "asks for the sentinel run as soon as a claim is put, before any rule asks for it",
  },
];

/** The one run the subscription and the rule both ask for, byte for byte. */
const SENTINEL_RUN = {
  command: ["node", "-e", "process.stdout.write('sentinel')"],
  workingDirectory: "/",
  environment: {},
  declared: [],
  substrates: [],
  isolation: "hygiene",
};

interface KindInput {
  readonly slug: string;
  readonly about: readonly string[];
  readonly overrides: Readonly<Record<string, unknown>>;
}

/** One claim per booking, identified by its slug and naming the rule that settles it. */
function openSetlist(input: KindInput): unknown {
  return {
    claims: [
      {
        type: CLAIM_TYPE,
        conditions: { case: input.slug, [RULE_ID]: "{}" },
        canonical: { case: input.slug },
        rendering: "the sentinel run for " + input.slug + " exits cleanly",
        about: [...input.about],
        exclusiveGroup: null,
      },
    ],
  };
}

interface RuleInput {
  readonly claimId: string;
  readonly conditions: Readonly<Record<string, string>>;
  readonly evidence: readonly { readonly runId: string; readonly exitCode: number; readonly output: string }[];
  readonly refusals?: readonly { readonly error: { readonly code: string; readonly message: string } }[];
}

function evaluateRunsCleanly(input: RuleInput): unknown {
  const refusal = input.refusals?.[0];
  if (refusal !== undefined) {
    return { kind: "verdict", label: "open", reason: refusal.error.code + ": " + refusal.error.message };
  }
  if (input.evidence.length === 0) {
    return { kind: "request", needs: [{ kind: "run", recipe: SENTINEL_RUN }] };
  }
  const everyExitClean = input.evidence.every((item) => item.exitCode === 0);
  return {
    kind: "verdict",
    label: everyExitClean ? "holds" : "fails",
    reason: everyExitClean ? "the sentinel run exited cleanly" : "the sentinel run exited with a non-zero code",
  };
}

/** A subscription answers a need, never a verdict; the kernel performs it at the event. */
function onClaimPut(): unknown {
  return { kind: "request", needs: [{ kind: "run", recipe: SENTINEL_RUN }] };
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
  if (request.contribution === "kind" && request.id === KIND_ID) {
    return respond(openSetlist(request.input as KindInput));
  }
  if (request.contribution === "rule" && request.id === RULE_ID) {
    return respond(evaluateRunsCleanly(request.input as RuleInput));
  }
  if (request.contribution === "subscription" && request.id === SUBSCRIPTION_ID) {
    return respond(onClaimPut());
  }
  return respondError(
    "unknown-contribution",
    { id: request.id, contribution: request.contribution },
    request.id + " names a contribution this module does not answer",
  );
}
