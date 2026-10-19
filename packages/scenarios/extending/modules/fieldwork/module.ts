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
  readonly effect?: string;
  readonly authority?: string | null;
}

const KIND_ID = "fixture-fieldwork/survey";
const REPRODUCED_TYPE = "fixture-fieldwork/reproduced@1";
const GRADED_TYPE = "fixture-fieldwork/graded@1";
const SEVERITY_DIMENSION_ID = "fixture-fieldwork/severity";
const GRADE_POINT_ID = "fixture-fieldwork/grade";
const GRADE_BY_EXIT_CODE_ID = "fixture-fieldwork/grade-by-exit-code";
const EXIT_CODE_UNDER_ID = "fixture-fieldwork/exit-code-under";
const TRIAGE_ID = "fixture-fieldwork/triage";
const SEVERITIES_FOLD_ID = "fixture-fieldwork/severities";
const SEVERE_QUERY_ID = "fixture-fieldwork/severe";
const FILE_FOLLOWUP_ID = "fixture-fieldwork/file-followup";
const ON_CLAIM_ID = "fixture-fieldwork/on-claim";

/** The core module's interpreter for a check with no code of its own. */
const DECLARATIVE = "musai.core/declarative";

/** A probe exits under this for its fault to count as reproduced cleanly enough to grade. */
const EXIT_CODE_BOUND = 2;

/** A literal, since a pack is handed no kernel constant: it moves when the claim kind moves. */
const CLAIM_SCHEMA_VERSION = 3;

/** A probe's exit code, the one fact of its receipt that grading reads. */
const GRADE_INPUT = {
  type: "object",
  additionalProperties: false,
  required: ["exitCode"],
  properties: { exitCode: { type: "integer" } },
};

/** A severity on the same integer scale a survey declares. */
const GRADE_OUTPUT = {
  type: "object",
  additionalProperties: false,
  required: ["severity"],
  properties: { severity: { type: "integer" } },
};

/** One graded claim's row; both fields are required, so neither is ever null. */
const SEVERITY_ROW = {
  type: "object",
  additionalProperties: false,
  required: ["case_slug", "severity"],
  properties: { case_slug: { type: "string" }, severity: { type: "integer" } },
};

/** `musai lab list --view` hands a query only `kind` and orders the case ids it answers. The kind
 * expression is spelled twice, not by alias, so the statement leans on no engine extension. */
const SEVERE_STATEMENT = [
  "SELECT DISTINCT cases.id AS id, cases.slug AS slug, json_extract(cases.record_json, '$.type') AS kind",
  "FROM cases",
  "JOIN fixture_fieldwork_severities ON fixture_fieldwork_severities.case_slug = cases.slug",
  "WHERE fixture_fieldwork_severities.severity >= 3",
  "  AND (:kind IS NULL OR json_extract(cases.record_json, '$.type') = :kind)",
  "ORDER BY cases.id",
].join("\n");

const CONTRIBUTIONS: readonly ContributionEntry[] = [
  {
    kind: "kind",
    id: KIND_ID,
    version: "1",
    input: true,
    output: true,
    documentation:
      "a field survey booked about the site it surveys: that the fault there reproduces under a probe, and that the probe grades it at the severity the survey declares",
  },
  {
    kind: "claim-type",
    id: REPRODUCED_TYPE,
    version: "1",
    input: { identityDimensions: ["case"] },
    output: true,
    documentation: "that the fault a survey describes reproduces, identified by the survey it belongs to",
  },
  {
    kind: "claim-type",
    id: GRADED_TYPE,
    version: "1",
    input: {
      identityDimensions: ["case", "severity"],
      canonical: {
        type: "object",
        additionalProperties: false,
        required: ["case", "severity"],
        properties: { case: { type: "string" }, severity: { type: "string" } },
      },
    },
    output: true,
    documentation: "that a probe grades the fault a survey describes at the severity it declares",
  },
  {
    kind: "dimension",
    id: SEVERITY_DIMENSION_ID,
    version: "1",
    input: { name: "severity", type: "ordered", data: { order: "numeric" } },
    output: true,
    documentation: "how severe a fault is, ordered as a number so that 9 sorts below 10",
  },
  {
    kind: "point",
    id: GRADE_POINT_ID,
    version: "1",
    input: { input: GRADE_INPUT, output: GRADE_OUTPUT, role: "invoke" },
    output: true,
    documentation: "where a probe's exit code is turned into a severity",
  },
  {
    kind: GRADE_POINT_ID,
    id: GRADE_BY_EXIT_CODE_ID,
    version: "1",
    input: GRADE_INPUT,
    output: GRADE_OUTPUT,
    documentation: "grades a clean exit at severity 1 and any other exit code two above itself",
  },
  {
    kind: "expectation",
    id: EXIT_CODE_UNDER_ID,
    version: "1",
    input: {
      type: "object",
      required: ["expectation", "evidence"],
      properties: {
        expectation: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "recipe", "value"],
          properties: {
            kind: { const: EXIT_CODE_UNDER_ID },
            recipe: { type: "string" },
            value: { type: "integer" },
          },
        },
      },
    },
    output: {
      type: "object",
      additionalProperties: false,
      required: ["met", "reason"],
      properties: { met: { type: "boolean" }, reason: { type: "string" } },
    },
    documentation: "met when the named recipe's run exited with a code strictly under the expectation's value",
  },
  {
    kind: "rule",
    id: TRIAGE_ID,
    version: "1",
    input: true,
    output: true,
    documentation:
      "runs the survey's probe, has its exit code graded, and holds when the grade is the severity the survey declares",
  },
  {
    kind: "fold",
    id: SEVERITIES_FOLD_ID,
    version: "1",
    input: true,
    output: {
      type: "object",
      properties: { rows: { type: "array", items: SEVERITY_ROW } },
      indexes: [["case_slug"]],
    },
    documentation: "one row per graded claim: the case it belongs to and the severity it declares",
  },
  {
    kind: "query",
    id: SEVERE_QUERY_ID,
    version: "1",
    input: {
      type: "object",
      additionalProperties: false,
      properties: { kind: { type: ["string", "null"] } },
      statement: SEVERE_STATEMENT,
      tables: ["cases", "fixture_fieldwork_severities"],
    },
    output: {
      type: "object",
      required: ["rows"],
      properties: {
        rows: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "slug", "kind"],
            properties: { id: { type: "string" }, slug: { type: "string" }, kind: { type: "string" } },
          },
        },
      },
    },
    documentation:
      "every case with a fault graded severity 3 or above, narrowed to a single kind where a caller names one",
  },
  {
    kind: "operation",
    id: FILE_FOLLOWUP_ID,
    version: "1",
    input: {
      type: "object",
      additionalProperties: false,
      required: ["case", "note"],
      properties: { case: { type: "string" }, note: { type: "string" } },
    },
    output: true,
    documentation:
      "files a follow-up on a survey: asserts that its fault reproduces, in the words of the note, and runs the filing first",
    effect: "performs",
    authority: null,
  },
  {
    kind: "subscription",
    id: ON_CLAIM_ID,
    version: "1",
    input: { properties: { name: { const: "claim.put" } } },
    output: true,
    documentation: "notes every claim put, by one run whose receipt the workspace keeps",
  },
];

interface Evidence {
  readonly runId: string;
  readonly exitCode: number;
  readonly output: string;
}

interface KindInput {
  readonly slug: string;
  readonly about: readonly string[];
  readonly overrides: Readonly<Record<string, unknown>>;
}

/** The site, severity and probe exit code a survey declares, the integers spelled as strings. */
interface Survey {
  readonly site: string;
  readonly severity: string;
  readonly exit: string;
}

/** The integer a string spells in its one canonical decimal form, else `undefined`. */
function integerSpelledBy(text: string): number | undefined {
  const value = Number(text);
  return Number.isSafeInteger(value) && String(value) === text ? value : undefined;
}

/** The site is the URI's last path segment, and `severity` and `exit` its query's, each `"0"` if
 * absent. Both must be integers: the exit code is spelled into the probe's command. */
function surveyFrom(uri: string): Survey | undefined {
  const question = uri.indexOf("?");
  const path = question === -1 ? uri : uri.slice(0, question);
  const fields = new Map<string, string>();
  if (question !== -1) {
    for (const pair of uri.slice(question + 1).split("&")) {
      const equals = pair.indexOf("=");
      if (equals !== -1) {
        fields.set(pair.slice(0, equals), pair.slice(equals + 1));
      }
    }
  }
  const segments = path.split("/").filter((segment) => segment.length > 0);
  const site = segments[segments.length - 1];
  const severity = fields.get("severity") ?? "0";
  const exit = fields.get("exit") ?? "0";
  if (site === undefined || integerSpelledBy(severity) === undefined || integerSpelledBy(exit) === undefined) {
    return undefined;
  }
  return { site, severity, exit };
}

/** Stands on no tree and is handed nothing, so its receipt depends on the script alone. */
function nodeRecipe(script: string): unknown {
  return {
    command: ["node", "-e", script],
    workingDirectory: "/",
    environment: {},
    declared: [],
    substrates: [],
    isolation: "hygiene",
  };
}

/** Built from the exit code alone, so both of a survey's checks share one receipt. */
function probeRecipe(exit: string): unknown {
  return nodeRecipe(["process.exit(", exit, ")"].join(""));
}

/** Expects the probe's exit code under the bound, a kind the core module does not decide. */
function declarativeParameters(exit: string): string {
  return JSON.stringify({
    recipes: [{ name: "probe", kind: "run", recipe: probeRecipe(exit) }],
    expectations: [{ kind: EXIT_CODE_UNDER_ID, recipe: "probe", value: EXIT_CODE_BOUND }],
  });
}

/** Reproduction is settled by the declarative rule, the grade by this module's own. */
function openSetlist(input: KindInput, survey: Survey): unknown {
  return {
    claims: [
      {
        type: REPRODUCED_TYPE,
        conditions: { case: input.slug, [DECLARATIVE]: declarativeParameters(survey.exit) },
        canonical: { case: input.slug, site: survey.site },
        rendering: ["the fault at", survey.site, "reproduces under its probe"].join(" "),
        about: [...input.about],
        exclusiveGroup: null,
      },
      {
        type: GRADED_TYPE,
        conditions: {
          case: input.slug,
          severity: survey.severity,
          [TRIAGE_ID]: JSON.stringify({ exit: survey.exit, severity: survey.severity }),
        },
        canonical: { case: input.slug, severity: survey.severity },
        rendering: ["the fault at", survey.site, "grades at severity", survey.severity].join(" "),
        about: [...input.about],
        exclusiveGroup: null,
      },
    ],
  };
}

/** A clean exit grades 1; any other exit code grades two above itself. */
function gradeFor(exitCode: number): number {
  return exitCode === 0 ? 1 : exitCode + 2;
}

interface ExitCodeUnderInput {
  readonly expectation: { readonly recipe: string; readonly value: number };
  readonly evidence: Readonly<Record<string, Evidence>>;
}

/** A recipe with no evidence is not met, said as the reason rather than thrown. */
function exitCodeUnder(input: ExitCodeUnderInput): unknown {
  const { recipe, value } = input.expectation;
  if (!Object.hasOwn(input.evidence, recipe)) {
    return { met: false, reason: ["no evidence answers the recipe", recipe].join(" ") };
  }
  const { exitCode } = input.evidence[recipe]!;
  const met = exitCode < value;
  return {
    met,
    reason: ["the", recipe, "run exited", exitCode, met ? "which is under" : "which is not under", value].join(" "),
  };
}

interface RuleInput {
  readonly claimId: string;
  readonly conditions: Readonly<Record<string, unknown>>;
  readonly evidence: readonly Evidence[];
  readonly refusals?: readonly { readonly error: { readonly code: string; readonly message: string } }[];
  readonly invocations?: readonly { readonly need: unknown; readonly output: unknown }[];
}

/** The probe's exit code and the declared severity, carried under the rule's own condition. */
interface TriageParameters {
  readonly exit: string;
  readonly severity: string;
}

/** Carried as one JSON string; `undefined` unless both are integers spelled as strings. */
function triageParametersFrom(conditions: Readonly<Record<string, unknown>>): TriageParameters | undefined {
  const raw = conditions[TRIAGE_ID];
  if (typeof raw !== "string") {
    return undefined;
  }
  let parsed: Partial<Record<keyof TriageParameters, unknown>>;
  try {
    parsed = JSON.parse(raw) as Partial<Record<keyof TriageParameters, unknown>>;
  } catch {
    return undefined;
  }
  const { exit, severity } = parsed;
  if (typeof exit !== "string" || typeof severity !== "string") {
    return undefined;
  }
  if (integerSpelledBy(exit) === undefined || integerSpelledBy(severity) === undefined) {
    return undefined;
  }
  return { exit, severity };
}

/** Matched by the need that asked for it, contribution and exit code, and never by an id. */
function gradedFor(invocations: NonNullable<RuleInput["invocations"]>, exitCode: number): number | undefined {
  const answered = invocations.find((invocation) => {
    const need = invocation.need as { kind?: unknown; contribution?: unknown; input?: { exitCode?: unknown } };
    return need.kind === "invoke" && need.contribution === GRADE_BY_EXIT_CODE_ID && need.input?.exitCode === exitCode;
  });
  return answered === undefined ? undefined : (answered.output as { severity: number }).severity;
}

/** Asks for the probe, then for its grade, and holds when the grade is the declared severity.
 * A refused need leaves the claim `open`: nothing reached grades the probe. */
function triage(input: RuleInput): unknown {
  const parameters = triageParametersFrom(input.conditions);
  if (parameters === undefined) {
    return {
      kind: "error",
      error: {
        code: "invalid-input",
        data: { conditions: input.conditions },
        message: ["the triage rule's condition", TRIAGE_ID, "must carry an exit code and a severity as integers"].join(
          " ",
        ),
      },
    };
  }
  const refusals = input.refusals ?? [];
  if (refusals.length > 0) {
    return {
      kind: "verdict",
      label: "open",
      reason: [
        "nothing reached grades the probe, so nothing decides this:",
        refusals.map((refusal) => refusal.error.message).join("; "),
      ].join(" "),
    };
  }
  if (input.evidence.length === 0) {
    return { kind: "request", needs: [{ kind: "run", recipe: probeRecipe(parameters.exit) }] };
  }
  const { exitCode } = input.evidence[0]!;
  const graded = gradedFor(input.invocations ?? [], exitCode);
  if (graded === undefined) {
    return {
      kind: "request",
      needs: [{ kind: "invoke", contribution: GRADE_BY_EXIT_CODE_ID, input: { exitCode } }],
    };
  }
  return {
    kind: "verdict",
    label: graded === integerSpelledBy(parameters.severity) ? "holds" : "fails",
    reason: [
      "the probe exited",
      exitCode,
      "and grades at severity",
      graded,
      "against the declared",
      parameters.severity,
    ].join(" "),
  };
}

interface FoldInput {
  readonly id: string;
  readonly kind: string;
  readonly record: Readonly<Record<string, unknown>>;
  readonly commit: string;
  readonly position: number;
}

/** Total over every record the fold applies, and never throwing. */
function severityRows(input: FoldInput): unknown {
  if (input.kind !== "claim" || input.record["type"] !== GRADED_TYPE) {
    return { rows: [] };
  }
  const conditions = input.record["conditions"] as Readonly<Record<string, unknown>>;
  const slug = conditions["case"];
  const severity = conditions["severity"];
  const level = typeof severity === "string" ? integerSpelledBy(severity) : undefined;
  if (typeof slug !== "string" || level === undefined) {
    return { rows: [] };
  }
  return { rows: [{ case_slug: slug, severity: level }] };
}

interface FollowupInput {
  readonly case: string;
  readonly note: string;
}

/** The claim takes a booking's identity, so it lands beside that one, and names no rule, so
 * rulings alone decide it. The kernel takes principal and channel from the call. */
function fileFollowup(input: FollowupInput): unknown {
  return {
    put: [
      {
        kind: "claim",
        value: {
          kind: "claim",
          schemaVersion: CLAIM_SCHEMA_VERSION,
          type: REPRODUCED_TYPE,
          about: [],
          conditions: { case: input.case },
          canonical: { case: input.case },
          rendering: input.note,
          evidence: [],
          exclusiveGroup: null,
          supersedes: [],
        },
      },
    ],
    attest: [{ subject: { put: 0 }, purpose: "asserted" }],
    needs: [{ kind: "run", recipe: nodeRecipe("process.stdout.write('filed')") }],
  };
}

/** A run only: a write's dispatch resolves no installed module to invoke a contribution through. */
function onClaimPut(): unknown {
  return { kind: "request", needs: [{ kind: "run", recipe: nodeRecipe("process.stdout.write('noted')") }] };
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
    const input = request.input as KindInput;
    const survey = input.about[0] === undefined ? undefined : surveyFrom(input.about[0]);
    if (survey === undefined) {
      return respondError(
        "invalid-input",
        { id: request.id },
        "a survey is booked about the site it surveys, with its severity and its probe's exit code as integers in the query string",
      );
    }
    return respond(openSetlist(input, survey));
  }
  if (request.contribution === GRADE_POINT_ID && request.id === GRADE_BY_EXIT_CODE_ID) {
    const input = request.input as { readonly exitCode: number };
    return respond({ severity: gradeFor(input.exitCode) });
  }
  if (request.contribution === "expectation" && request.id === EXIT_CODE_UNDER_ID) {
    return respond(exitCodeUnder(request.input as ExitCodeUnderInput));
  }
  if (request.contribution === "rule" && request.id === TRIAGE_ID) {
    return respond(triage(request.input as RuleInput));
  }
  if (request.contribution === "fold" && request.id === SEVERITIES_FOLD_ID) {
    return respond(severityRows(request.input as FoldInput));
  }
  if (request.contribution === "operation" && request.id === FILE_FOLLOWUP_ID) {
    return respond(fileFollowup(request.input as FollowupInput));
  }
  if (request.contribution === "subscription" && request.id === ON_CLAIM_ID) {
    return respond(onClaimPut());
  }
  return respondError(
    "unknown-contribution",
    { id: request.id, contribution: request.contribution },
    [request.id, "names a contribution this module does not answer"].join(" "),
  );
}
