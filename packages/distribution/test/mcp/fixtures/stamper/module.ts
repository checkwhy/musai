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
  readonly effect: string;
  readonly authority: string | null;
}

const ANSWERS_CONTRIBUTION_ID = "stamper/answers";
const ANSWERS_AS_READ_CONTRIBUTION_ID = "stamper/answers-as-read";
const ANSWERS_IRREVERSIBLY_CONTRIBUTION_ID = "stamper/answers-irreversibly";
const ASSERTS_AND_RUNS_CONTRIBUTION_ID = "stamper/asserts-and-runs";

/** The input of the three `answers` operations: the plan to answer with. */
const ANSWER_INPUT = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: { answer: { type: "object" } },
};

/** Four operations whose plans name no principal or channel, so the session's stands behind them.
 * The `answers` ones answer their input's plan verbatim, each under its own effect. */
const CONTRIBUTIONS: readonly ContributionEntry[] = [
  {
    kind: "operation",
    id: ANSWERS_CONTRIBUTION_ID,
    version: "1",
    input: ANSWER_INPUT,
    output: true,
    documentation: "answers with the plan its own input carries, declaring a write",
    effect: "write",
    authority: null,
  },
  {
    kind: "operation",
    id: ANSWERS_AS_READ_CONTRIBUTION_ID,
    version: "1",
    input: ANSWER_INPUT,
    output: true,
    documentation: "answers with the plan its own input carries, declaring a read",
    effect: "read",
    authority: null,
  },
  {
    kind: "operation",
    id: ANSWERS_IRREVERSIBLY_CONTRIBUTION_ID,
    version: "1",
    input: ANSWER_INPUT,
    output: true,
    documentation: "answers with the plan its own input carries, declaring an irreversible effect",
    effect: "irreversible",
    authority: null,
  },
  {
    kind: "operation",
    id: ASSERTS_AND_RUNS_CONTRIBUTION_ID,
    version: "1",
    input: {
      type: "object",
      additionalProperties: false,
      required: ["subject", "predicate", "object", "slot", "schemaVersion"],
      properties: {
        subject: { type: "string" },
        predicate: { type: "string" },
        object: { type: "string" },
        slot: { type: "string" },
        schemaVersion: { type: "number" },
      },
    },
    output: true,
    documentation:
      "drafts a claim from the triple its own input names, needs one run performed first, and asserts the claim it drafted",
    effect: "performs",
    authority: null,
  },
];

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
  if (
    request.contribution === "operation" &&
    (request.id === ANSWERS_CONTRIBUTION_ID ||
      request.id === ANSWERS_AS_READ_CONTRIBUTION_ID ||
      request.id === ANSWERS_IRREVERSIBLY_CONTRIBUTION_ID)
  ) {
    return respond((request.input as { readonly answer: unknown }).answer);
  }
  if (request.contribution === "operation" && request.id === ASSERTS_AND_RUNS_CONTRIBUTION_ID) {
    const input = request.input as {
      readonly subject: string;
      readonly predicate: string;
      readonly object: string;
      readonly slot: string;
      readonly schemaVersion: number;
    };
    const claim = {
      kind: "claim",
      supersedes: [],
      schemaVersion: input.schemaVersion,
      type: "triple@1",
      about: [],
      slot: input.slot,
      conditions: { subject: input.subject, predicate: input.predicate, object: input.object },
      canonical: { subject: input.subject, predicate: input.predicate, object: input.object },
      rendering: input.subject + " " + input.predicate + " " + input.object,
      evidence: [],
      exclusiveGroup: null,
    };
    return respond({
      put: [{ kind: "claim", value: claim }],
      attest: [{ subject: { put: 0 }, purpose: "asserted" }],
      needs: [
        {
          kind: "run",
          recipe: {
            command: ["node", "-e", "process.exit(0)"],
            workingDirectory: "/",
            environment: {},
            declared: [],
            substrates: [],
            isolation: "hygiene",
          },
        },
      ],
    });
  }
  return respondError(
    "unknown-contribution",
    { id: request.id, contribution: request.contribution },
    request.id + " names a contribution this module does not answer",
  );
}
