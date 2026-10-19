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

const MODULE_NAME = "fixture-casebook";

const KIND_ID = MODULE_NAME + "/report";
const REPRODUCES_TYPE = MODULE_NAME + "/reproduces@1";
const JUDGMENT_TYPE = MODULE_NAME + "/worth-fixing@1";
const DISPOSITION_TYPE = MODULE_NAME + "/disposition@1";

/** The core module's interpreter for a check with no code of its own. */
const DECLARATIVE = "musai.core/declarative";

const CONTRIBUTIONS: readonly ContributionEntry[] = [
  {
    kind: "kind",
    id: KIND_ID,
    version: "1",
    input: true,
    output: true,
    documentation:
      "a report's own setlist: one check settled by a run, one judgment, and a disposition offered as a menu",
  },
  {
    kind: "claim-type",
    id: REPRODUCES_TYPE,
    version: "1",
    input: { identityDimensions: ["case"] },
    output: true,
    documentation: "that the fault a report describes reproduces, identified by the report it belongs to",
  },
  {
    kind: "claim-type",
    id: JUDGMENT_TYPE,
    version: "1",
    input: { identityDimensions: ["case"] },
    output: true,
    documentation: "that the fault a report describes is worth fixing, identified by the report it belongs to",
  },
  {
    kind: "claim-type",
    id: DISPOSITION_TYPE,
    version: "1",
    input: {
      identityDimensions: ["case", "disposition"],
      canonical: {
        type: "object",
        additionalProperties: false,
        required: ["case", "disposition"],
        properties: { case: { type: "string" }, disposition: { type: "string" } },
      },
    },
    output: true,
    documentation: "what is to be done about a report, one claim per disposition the report is offered",
  },
];

interface KindInput {
  readonly slug: string;
  readonly about: readonly string[];
  readonly overrides: Readonly<Record<string, unknown>>;
}

/** The command this case's check runs, taken from the booking where it named one. */
function suiteCommand(overrides: Readonly<Record<string, unknown>>): readonly string[] {
  const named = overrides["suite"];
  if (typeof named === "string") {
    return ["node", "-e", named];
  }
  return ["node", "-e", "process.exit(0)"];
}

function declarativeParameters(overrides: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({
    recipes: [
      {
        name: "suite",
        kind: "run",
        recipe: {
          command: suiteCommand(overrides),
          workingDirectory: "/",
          environment: {},
          declared: [],
          substrates: [],
          isolation: "hygiene",
        },
      },
    ],
    expectations: [{ kind: "exitCodeIs", recipe: "suite", value: 0 }],
  });
}

/** What the booking asks a claim of `type` to carry in its canonical payload, keyed by type id. */
function carried(overrides: Readonly<Record<string, unknown>>, type: string): Record<string, unknown> {
  const named = overrides[type];
  return typeof named === "object" && named !== null ? { ...(named as Record<string, unknown>) } : {};
}

/** What a run settles, then what a person weighs, then what they decide. The case sits in every
 * claim's identity, so two reports never share a claim. */
function openSetlist(input: KindInput): unknown {
  const subject = input.about.length > 0 ? input.about[0]! : input.slug;
  return {
    claims: [
      {
        type: REPRODUCES_TYPE,
        conditions: { case: input.slug, [DECLARATIVE]: declarativeParameters(input.overrides) },
        canonical: { case: input.slug, subject, ...carried(input.overrides, REPRODUCES_TYPE) },
        rendering: "the fault reported in " + subject + " reproduces",
        about: [...input.about],
        exclusiveGroup: null,
      },
      {
        type: JUDGMENT_TYPE,
        conditions: { case: input.slug, gateClass: "judgment" },
        canonical: { case: input.slug, subject },
        rendering: "the fault in " + subject + " is worth fixing",
        about: [...input.about],
        exclusiveGroup: null,
      },
      {
        type: DISPOSITION_TYPE,
        conditions: { case: input.slug, disposition: "file", gateClass: "intent" },
        canonical: { case: input.slug, disposition: "file", ...carried(input.overrides, DISPOSITION_TYPE) },
        rendering: "file " + input.slug + " as a new report",
        about: [],
        exclusiveGroup: input.slug + "/disposition",
      },
      {
        type: DISPOSITION_TYPE,
        conditions: { case: input.slug, disposition: "withdraw", gateClass: "intent" },
        canonical: { case: input.slug, disposition: "withdraw", ...carried(input.overrides, DISPOSITION_TYPE) },
        rendering: "withdraw " + input.slug + " without filing",
        about: [],
        exclusiveGroup: input.slug + "/disposition",
      },
    ],
  };
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
  if (request.contribution === "kind" && request.id === KIND_ID) {
    return respond(openSetlist(request.input as KindInput));
  }
  return respondError(
    "unknown-contribution",
    { id: request.id, contribution: request.contribution },
    request.id + " names a contribution this module does not answer",
  );
}
