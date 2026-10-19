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

const MODULE_NAME = "musai.core";

function respond(output: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ ok: true, output, diagnostics: [] }));
}

function respondError(code: string, data: unknown, message: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ ok: false, error: { code, data, message } }));
}

interface ParserInput {
  readonly output: string;
  readonly exitCode: number;
}

/** Names no recipe, substrate or path, so no selected item depends on where a run happened. */
const PARSER_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["output", "exitCode"],
  properties: {
    output: { type: "string" },
    exitCode: { type: "number" },
  },
};

const UNCONSTRAINED_SCHEMA = true;

function parseWholeRun(input: ParserInput): Record<string, unknown> {
  return { output: input.output };
}

function parseExitCode(input: ParserInput): Record<string, unknown> {
  return { exitCode: input.exitCode };
}

/** Normalises line endings so a range reads the same whichever convention the output used. */
function normalizedLines(output: string): readonly string[] {
  return output.replace(/\r\n/g, "\n").split("\n");
}

/** Every range the output holds, since no channel carries a caller's bounds. A range outside it
 * is a key never produced, refused at admission. */
function parseLineRange(input: ParserInput): Record<string, unknown> {
  const lines = normalizedLines(input.output);
  const map: Record<string, unknown> = {};
  for (let start = 1; start <= lines.length; start++) {
    for (let end = start; end <= lines.length; end++) {
      map[String(start) + "-" + String(end)] = lines.slice(start - 1, end).join("\n");
    }
  }
  return map;
}

function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Keys every node, container and leaf alike, by its RFC 6901 pointer. */
function flattenToPointerMap(value: unknown, prefix: string, map: Record<string, unknown>): void {
  map[prefix] = value;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      flattenToPointerMap(item, prefix + "/" + String(index), map);
    });
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      flattenToPointerMap(item, prefix + "/" + escapePointerSegment(key), map);
    }
  }
}

/** Output that is not JSON throws, rather than answering a map where every pointer looks absent. */
function parsePointer(input: ParserInput): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.output);
  } catch (error) {
    throw new Error(
      "the pointer parser could not parse the observation's output as JSON: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  const map: Record<string, unknown> = {};
  flattenToPointerMap(parsed, "", map);
  return map;
}

function outcomeOf(body: string): string {
  if (/<failure\b/.test(body)) {
    return "failed";
  }
  if (/<error\b/.test(body)) {
    return "errored";
  }
  if (/<skipped\b/.test(body)) {
    return "skipped";
  }
  return "passed";
}

function parseTestReport(input: ParserInput): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  const pattern = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (;;) {
    const match = pattern.exec(input.output);
    if (match === null) {
      break;
    }
    const attrs = match[1] ?? "";
    const body = match[2] ?? "";
    const nameMatch = /\bname="([^"]*)"/.exec(attrs);
    if (nameMatch === null) {
      continue;
    }
    map[nameMatch[1]!] = outcomeOf(body);
  }
  return map;
}

const WHOLE_RUN_ID = MODULE_NAME + "/whole-run";
const EXIT_CODE_ID = MODULE_NAME + "/exit-code";
const LINE_RANGE_ID = MODULE_NAME + "/line-range";
const POINTER_ID = MODULE_NAME + "/pointer";
const TEST_REPORT_ID = MODULE_NAME + "/test-report";

const PARSERS: Record<string, (input: ParserInput) => Record<string, unknown>> = {
  [WHOLE_RUN_ID]: parseWholeRun,
  [EXIT_CODE_ID]: parseExitCode,
  [LINE_RANGE_ID]: parseLineRange,
  [POINTER_ID]: parsePointer,
  [TEST_REPORT_ID]: parseTestReport,
};

const PARSER_CONTRIBUTIONS: readonly ContributionEntry[] = [
  {
    kind: "parser",
    id: WHOLE_RUN_ID,
    version: "1",
    input: PARSER_INPUT_SCHEMA,
    output: UNCONSTRAINED_SCHEMA,
    documentation: "selects the observation's whole output under one key",
  },
  {
    kind: "parser",
    id: EXIT_CODE_ID,
    version: "1",
    input: PARSER_INPUT_SCHEMA,
    output: UNCONSTRAINED_SCHEMA,
    documentation: "selects the observation's own exit code",
  },
  {
    kind: "parser",
    id: LINE_RANGE_ID,
    version: "1",
    input: PARSER_INPUT_SCHEMA,
    output: UNCONSTRAINED_SCHEMA,
    documentation:
      'selects the lines between two 1-indexed inclusive bounds, keyed by "<start>-<end>", normalised across line-ending conventions',
  },
  {
    kind: "parser",
    id: POINTER_ID,
    version: "1",
    input: PARSER_INPUT_SCHEMA,
    output: UNCONSTRAINED_SCHEMA,
    documentation: "parses the observation's output as JSON and selects a value by its RFC 6901 pointer",
  },
  {
    kind: "parser",
    id: TEST_REPORT_ID,
    version: "1",
    input: PARSER_INPUT_SCHEMA,
    output: UNCONSTRAINED_SCHEMA,
    documentation: "turns a JUnit-shaped test report into a keyed map of case names to outcomes",
  },
];

interface RuleInput {
  readonly claimId: string;
  readonly conditions: Readonly<Record<string, unknown>>;
  readonly evidence: readonly { readonly runId: string; readonly exitCode: number; readonly output: string }[];
  readonly refusals?: readonly RuleRefusal[];
  readonly invocations?: readonly RuleInvocation[];
}

/** A need the kernel could not give, so the rule concludes naming why instead of asking again. */
interface RuleRefusal {
  readonly need: unknown;
  readonly error: { readonly code: string; readonly message: string };
}

/** `need` is what the rule matches an answer to its own ask by. */
interface RuleInvocation {
  readonly need: unknown;
  readonly moduleRecord: string;
  readonly output: unknown;
}

/** One canonical-JSON string under one reserved key, not a dimension per parameter field. */
const PARAMETERS_CONDITION = "musai.core/declarative";

/** Named so an expectation can point at what it selected from. */
interface DeclarativeRecipe {
  readonly name: string;
  readonly kind: "run" | "fetch";
  readonly recipe: unknown;
}

interface FieldRef {
  readonly recipe: string;
  readonly field: "output" | "exitCode";
}

/** Decided inline. Any other kind names the contribution that decides it, so a pack adds kinds. */
type DeclarativeExpectation =
  | { readonly kind: "equals"; readonly selector: FieldRef; readonly value: unknown }
  | { readonly kind: "differsFrom"; readonly selector: FieldRef; readonly value: unknown }
  | { readonly kind: "exitCodeIs"; readonly recipe: string; readonly value: number }
  | { readonly kind: "keyExists"; readonly selector: FieldRef; readonly key: string }
  | { readonly kind: "selectedItemsEqual"; readonly left: FieldRef; readonly right: FieldRef }
  | { readonly kind: "selectedItemsDiffer"; readonly left: FieldRef; readonly right: FieldRef };

const EXPECTATION_KINDS = [
  "equals",
  "differsFrom",
  "exitCodeIs",
  "keyExists",
  "selectedItemsEqual",
  "selectedItemsDiffer",
];

/** Its kind is the id of the contribution that decides it; the rest is that contribution's. */
interface ContributedExpectation {
  readonly kind: string;
}

interface DeclarativeParameters {
  readonly recipes: readonly DeclarativeRecipe[];
  readonly expectations: readonly (DeclarativeExpectation | ContributedExpectation)[];
}

function isInlineExpectation(
  expectation: DeclarativeExpectation | ContributedExpectation,
): expectation is DeclarativeExpectation {
  return EXPECTATION_KINDS.indexOf(expectation.kind) !== -1;
}

/** Folded into the rule's conclusive error rather than thrown, so the loop concludes. */
class ParameterError extends Error {}

function parseParameters(conditions: Readonly<Record<string, unknown>>): DeclarativeParameters {
  const raw = conditions[PARAMETERS_CONDITION];
  if (raw === undefined) {
    throw new ParameterError(
      "the declarative interpreter's parameter object is missing its condition: " + PARAMETERS_CONDITION,
    );
  }
  if (typeof raw !== "string") {
    throw new ParameterError(
      "the declarative interpreter's parameter object must be a single canonical-JSON string, and " +
        PARAMETERS_CONDITION +
        " holds a scope instead",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ParameterError(
      "the declarative interpreter's parameter object does not parse as JSON: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  const candidate = parsed as DeclarativeParameters;
  for (const expectation of candidate.expectations) {
    if (typeof expectation.kind !== "string" || expectation.kind.length === 0) {
      throw new ParameterError(
        "the declarative interpreter's parameter object names an expectation with no kind, so nothing can decide it: " +
          JSON.stringify(expectation),
      );
    }
  }
  return candidate;
}

/** Evidence arrives in the order the recipes were declared, so a count mismatch breaks the only
 * tie from evidence to recipe and concludes here. */
function evidenceByRecipeName(
  parameters: DeclarativeParameters,
  evidence: RuleInput["evidence"],
): Record<string, RuleInput["evidence"][number]> {
  if (evidence.length !== parameters.recipes.length) {
    throw new ParameterError(
      "the declarative interpreter holds evidence for " +
        evidence.length +
        " of its " +
        parameters.recipes.length +
        " recipes, so no expectation can be told which recipe it reads from",
    );
  }
  const byName: Record<string, RuleInput["evidence"][number]> = {};
  parameters.recipes.forEach((recipe, index) => {
    byName[recipe.name] = evidence[index]!;
  });
  return byName;
}

function fieldValue(ref: FieldRef, byName: Record<string, RuleInput["evidence"][number]>): unknown {
  const entry = byName[ref.recipe];
  if (entry === undefined) {
    throw new ParameterError(
      "the declarative interpreter's parameter object names a recipe with no matching evidence: " + ref.recipe,
    );
  }
  return ref.field === "output" ? entry.output : entry.exitCode;
}

function evaluateExpectation(
  expectation: DeclarativeExpectation,
  byName: Record<string, RuleInput["evidence"][number]>,
): { readonly met: boolean; readonly reason: string } {
  if (expectation.kind === "equals") {
    const value = fieldValue(expectation.selector, byName);
    const met = JSON.stringify(value) === JSON.stringify(expectation.value);
    return {
      met,
      reason:
        expectation.selector.recipe +
        "." +
        expectation.selector.field +
        (met ? " equals " : " does not equal ") +
        JSON.stringify(expectation.value),
    };
  }
  if (expectation.kind === "differsFrom") {
    const value = fieldValue(expectation.selector, byName);
    const met = JSON.stringify(value) !== JSON.stringify(expectation.value);
    return {
      met,
      reason:
        expectation.selector.recipe +
        "." +
        expectation.selector.field +
        (met ? " differs from " : " does not differ from ") +
        JSON.stringify(expectation.value),
    };
  }
  if (expectation.kind === "exitCodeIs") {
    const entry = byName[expectation.recipe];
    if (entry === undefined) {
      throw new ParameterError(
        "the declarative interpreter's parameter object names a recipe with no matching evidence: " +
          expectation.recipe,
      );
    }
    const met = entry.exitCode === expectation.value;
    return {
      met,
      reason:
        expectation.recipe +
        "'s exit code is " +
        String(entry.exitCode) +
        (met ? " as expected" : ", not " + String(expectation.value)),
    };
  }
  if (expectation.kind === "keyExists") {
    const value = fieldValue(expectation.selector, byName);
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = typeof value === "string" ? (JSON.parse(value) as Record<string, unknown>) : undefined;
    } catch {
      parsed = undefined;
    }
    const met = parsed !== undefined && Object.hasOwn(parsed, expectation.key);
    return {
      met,
      reason:
        expectation.selector.recipe +
        "." +
        expectation.selector.field +
        (met ? " holds the key " : " does not hold the key ") +
        expectation.key,
    };
  }
  const left = fieldValue(expectation.left, byName);
  const right = fieldValue(expectation.right, byName);
  const equal = JSON.stringify(left) === JSON.stringify(right);
  if (expectation.kind === "selectedItemsEqual") {
    return {
      met: equal,
      reason:
        expectation.left.recipe +
        " and " +
        expectation.right.recipe +
        (equal ? " select equal items" : " select differing items"),
    };
  }
  return {
    met: !equal,
    reason:
      expectation.left.recipe +
      " and " +
      expectation.right.recipe +
      (!equal ? " select differing items" : " select equal items"),
  };
}

interface ExpectationInvoke {
  readonly kind: "invoke";
  readonly contribution: string;
  readonly input: { readonly expectation: unknown; readonly evidence: unknown };
}

function isInvoke(need: unknown): need is ExpectationInvoke {
  return typeof need === "object" && need !== null && (need as { kind?: unknown }).kind === "invoke";
}

/** A need returns as canonical JSON with sorted keys; an expectation keeps its author's order. */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) !== Array.isArray(right)) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && sameValue(leftRecord[key], rightRecord[key]))
  );
}

/** `undefined` where the contribution answered anything but whether it was met and why. */
function expectationAnswer(output: unknown): { readonly met: boolean; readonly reason: string } | undefined {
  if (typeof output !== "object" || output === null) {
    return undefined;
  }
  const { met, reason } = output as { met?: unknown; reason?: unknown };
  return typeof met === "boolean" && typeof reason === "string" ? { met, reason } : undefined;
}

/** Requests the recipes, then invokes what decides each kind it does not know, then compares. A
 * refusal leaves the check open: refused evidence cannot say which recipe it came from. */
function decideDeclarative(input: RuleInput): unknown {
  let parameters: DeclarativeParameters;
  try {
    parameters = parseParameters(input.conditions);
  } catch (error) {
    return {
      kind: "error",
      error: {
        code: "invalid-input",
        data: { conditions: input.conditions },
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  const refusals = input.refusals ?? [];
  if (refusals.length > 0) {
    const refusedInvokes = refusals.filter((refusal) => isInvoke(refusal.need));
    if (refusedInvokes.length === 0) {
      return {
        kind: "verdict",
        label: "open",
        reason:
          "the kernel could not perform every recipe this check names, so nothing decides it: " +
          refusals.map((refusal) => refusal.error.message).join("; "),
      };
    }
    return {
      kind: "verdict",
      label: "open",
      reason:
        "the kernel could not invoke what decides every expectation this check names, so nothing decides it: " +
        refusedInvokes
          .map((refusal) => (refusal.need as ExpectationInvoke).contribution + ": " + refusal.error.message)
          .join("; "),
    };
  }

  if (input.evidence.length === 0) {
    return {
      kind: "request",
      needs: parameters.recipes.map((recipe) => ({ kind: recipe.kind, recipe: recipe.recipe })),
    };
  }

  try {
    const byName = evidenceByRecipeName(parameters, input.evidence);
    const invocations = input.invocations ?? [];
    const invocationFor = (expectation: ContributedExpectation): RuleInvocation | undefined =>
      invocations.find(
        (invocation) =>
          isInvoke(invocation.need) &&
          invocation.need.contribution === expectation.kind &&
          sameValue(invocation.need.input.expectation, expectation),
      );
    const unanswered = parameters.expectations.filter(
      (expectation) => !isInlineExpectation(expectation) && invocationFor(expectation) === undefined,
    );
    if (unanswered.length > 0) {
      return {
        kind: "request",
        needs: unanswered.map((expectation) => ({
          kind: "invoke",
          contribution: expectation.kind,
          input: { expectation, evidence: byName },
        })),
      };
    }

    const outcomes: { readonly met: boolean; readonly reason: string }[] = [];
    for (const expectation of parameters.expectations) {
      if (isInlineExpectation(expectation)) {
        outcomes.push(evaluateExpectation(expectation, byName));
        continue;
      }
      const answer = expectationAnswer(invocationFor(expectation)!.output);
      if (answer === undefined) {
        return {
          kind: "verdict",
          label: "open",
          reason:
            "the contribution " +
            expectation.kind +
            " did not answer whether the expectation was met and why, so it decides no expectation and nothing decides this check",
        };
      }
      outcomes.push(answer);
    }
    const failed = outcomes.find((outcome) => !outcome.met);
    if (failed === undefined) {
      return { kind: "verdict", label: "holds", reason: outcomes.map((outcome) => outcome.reason).join("; ") };
    }
    return { kind: "verdict", label: "fails", reason: failed.reason };
  } catch (error) {
    return {
      kind: "error",
      error: {
        code: "invalid-input",
        data: { conditions: input.conditions },
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

const DECLARATIVE_ID = MODULE_NAME + "/declarative";

const DECLARATIVE_CONTRIBUTIONS: readonly ContributionEntry[] = [
  {
    kind: "rule",
    id: DECLARATIVE_ID,
    version: "1",
    input: true,
    output: true,
    documentation:
      "the interpreter every rule with no code of its own names: reads a canonical parameter object of recipes and expectations from its conditions, requests the recipes as needs, and compares the selected items against the expectations",
  },
];

/** One sentence about one repository; the command checking it is a condition, never identity, so
 * re-checking on a moved tree moves the same claim. */
const CLAIM_TYPE_CONTRIBUTIONS: readonly ContributionEntry[] = [
  {
    kind: "claim-type",
    id: MODULE_NAME + "/check@1",
    version: "1",
    input: { identityDimensions: ["subject", "statement"] },
    output: true,
    documentation: "a sentence about a repository, named by its oldest root commit, checked by the command beside it",
  },
];

// Every setting the kernel consults is a slot declared here, so a receiver reads each default.

/** Carries the slot in the envelope's fixed halves, since nothing invokes a slot. */
function slotContribution(
  name: string,
  schema: unknown,
  layers: readonly string[],
  hasDefault: boolean,
  defaultValue: unknown,
  documentation: string,
): ContributionEntry {
  return {
    kind: "slot",
    id: MODULE_NAME + "/" + name,
    version: "1",
    input: { layers: [...layers], hasDefault, default: defaultValue },
    output: schema,
    documentation,
  };
}

const ISOLATION_POLICY_ID = MODULE_NAME + "/isolation-policy";
const RESOLUTION_AGE_ID = MODULE_NAME + "/resolution-age";

const ISOLATION_POLICY_SCHEMA = { type: "string", enum: ["refuse", "ask", "degrade"] };

/** A rate or a bound, never near 2^53, so it stays a number. */
const NON_NEGATIVE_INTEGER_SCHEMA = { type: "integer", minimum: 0 };

const INVOCATION_LIMITS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["timeLimitMs", "memoryLimitMb"],
  properties: {
    timeLimitMs: { type: "integer", minimum: 1 },
    memoryLimitMb: { type: "integer", minimum: 1 },
  },
};

const SIGNING_LEVEL_SCHEMA = { type: "string", enum: ["off", "person", "all"] };

const STALENESS_POLICY_SCHEMA = { type: "string", enum: ["strict", "lenient"] };

const SLOT_CONTRIBUTIONS: readonly ContributionEntry[] = [
  slotContribution(
    "isolation-policy",
    ISOLATION_POLICY_SCHEMA,
    ["project", "preset", "booking"],
    true,
    "refuse",
    "what a run does when its declared isolation level cannot be held: refuse before anything spawns, ask and record the person's answer beside the declared level, or degrade and record both the declared and the held level",
  ),
  slotContribution(
    "resolution-age",
    NON_NEGATIVE_INTEGER_SCHEMA,
    ["project", "preset", "booking"],
    true,
    0,
    "how old, in milliseconds, a resolution receipt may be before the resolution table redoes it rather than reusing it; zero means fresh per evaluation, still once per reference within it",
  ),
  slotContribution(
    "need-concurrency",
    { type: "integer", minimum: 1 },
    ["project", "preset", "booking"],
    true,
    1,
    "how many needs the restart loop may perform at once within one round",
  ),
  slotContribution(
    "invocation-limits",
    INVOCATION_LIMITS_SCHEMA,
    ["project", "preset", "booking"],
    true,
    { timeLimitMs: 2000, memoryLimitMb: 64 },
    "the time and memory limit every host bounds one invocation by",
  ),
  slotContribution(
    "signing-level",
    SIGNING_LEVEL_SCHEMA,
    ["project"],
    true,
    "off",
    "whether an attestation from a person, from anyone, or from nobody must be verified before anything advances — project-layer only, guarded by the authority action that already changes it",
  ),
  slotContribution(
    "pack-irreversible",
    { type: "boolean" },
    ["project"],
    true,
    false,
    "whether an operation a pack contributes may declare an irreversible effect — project-layer only, because a pack cannot grant itself the thing this decides",
  ),
  slotContribution(
    "staleness-policy",
    STALENESS_POLICY_SCHEMA,
    ["project", "preset", "booking"],
    true,
    "strict",
    "how the evaluator treats a claim whose trace touches a moved read: strict recomputes every such claim, lenient recomputes the same set today, since this phase has no second behaviour to distinguish them by",
  ),
  slotContribution(
    "brief-budget",
    NON_NEGATIVE_INTEGER_SCHEMA,
    ["project", "preset", "booking"],
    true,
    20000,
    "how many UTF-8 bytes a rendered brief, its omission list included, may occupy before the trim starts removing the weakest evidence",
  ),
];

// No shipped preset degrades or assigns a project-only slot; a person or the project decides those.

/** The interactive resolution age: a reference resolved yesterday is redone today. */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Carries its assignments in the envelope's `output` half, since nothing invokes a preset. */
function presetContribution(
  name: string,
  assignments: Readonly<Record<string, unknown>>,
  documentation: string,
): ContributionEntry {
  return {
    kind: "preset",
    id: MODULE_NAME + "/" + name,
    version: "1",
    input: true,
    output: { ...assignments },
    documentation,
  };
}

// Declared once, so the runner's authorisation lookup and `doctor` read one list.

/** Carries the requirement in the envelope's `input` half, since nothing invokes a requirement. */
function requirementContribution(
  binary: string,
  versionPredicate: string | null,
  neededBy: string,
  install: string,
): ContributionEntry {
  return {
    kind: "requirement",
    id: MODULE_NAME + "/" + binary,
    version: "1",
    input: { binary, versionPredicate, neededBy, install },
    output: true,
    documentation: binary + ", needed by " + neededBy,
  };
}

const REQUIREMENT_CONTRIBUTIONS: readonly ContributionEntry[] = [
  requirementContribution(
    "git",
    ">=2.40",
    "the store's own put, list and swap operations, and every substrate resolved from a git tree",
    "install git from your platform's own package manager, or from git-scm.com",
  ),
  requirementContribution(
    "ssh-keygen",
    null,
    "signing and verifying an attestation's sidecar signature",
    "install the OpenSSH client, which ships ssh-keygen, from your platform's own package manager",
  ),
  requirementContribution(
    "node",
    ">=24",
    "the module hosts' own subprocess isolation and every recipe this distribution spawns Node.js for",
    "install Node.js 24 or later from nodejs.org, or from your platform's own package manager",
  ),
  requirementContribution(
    "docker",
    null,
    "a recipe declaring a container image substrate",
    "install Docker from docker.com, or your platform's own container engine package",
  ),
];

const PRESET_CONTRIBUTIONS: readonly ContributionEntry[] = [
  presetContribution(
    "bare",
    {},
    "the preset a booking that names no preset gets: it assigns no slot, so every slot resolves at the default its own declaration carries and a booking acquires no policy nobody chose",
  ),
  presetContribution(
    "interactive",
    {
      [ISOLATION_POLICY_ID]: "ask",
      [RESOLUTION_AGE_ID]: ONE_DAY_MS,
    },
    "for a person at the terminal: a declared level that cannot be held becomes a question, recorded on the receipt as the declared level beside the level that held; a reference resolved yesterday is redone today",
  ),
  presetContribution(
    "ci",
    {
      [ISOLATION_POLICY_ID]: "refuse",
      [RESOLUTION_AGE_ID]: 0,
    },
    "for a machine: a declared level that cannot be held refuses before anything spawns, since there is nobody to ask and a silent degrade in an automated run is a receipt nobody will read closely; every resolution is fresh per evaluation",
  ),
];

// Status and recency are derivations, left to `view.run@1`; this projects what the records hold.

const CASES_QUERY_ID = MODULE_NAME + "/cases";

/** A case's kind is its booking's type, else its preset. The coalesce is spelled out twice so it
 * leans on no engine extension and the module's dependency scan can read it. */
const CASES_STATEMENT = [
  "SELECT cases.id AS id, cases.slug AS slug,",
  "  coalesce(json_extract(cases.record_json, '$.type'), json_extract(cases.record_json, '$.preset.contribution')) AS kind",
  "FROM cases",
  "WHERE :kind IS NULL",
  "  OR coalesce(json_extract(cases.record_json, '$.type'), json_extract(cases.record_json, '$.preset.contribution')) = :kind",
  "ORDER BY cases.id",
].join("\n");

const QUERY_CONTRIBUTIONS: readonly ContributionEntry[] = [
  {
    kind: "query",
    id: CASES_QUERY_ID,
    version: "1",
    input: {
      type: "object",
      additionalProperties: false,
      properties: { kind: { type: ["string", "null"] } },
      statement: CASES_STATEMENT,
      tables: ["cases"],
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
      "every case the workspace holds, as its record id, its slug and its kind, narrowed to a single kind where a caller names one",
  },
];

export function invoke(requestBytes: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(requestBytes);
  const request = JSON.parse(text) as EnvelopeRequest;

  if (request.contribution === "describe") {
    return respond([
      ...PARSER_CONTRIBUTIONS,
      ...DECLARATIVE_CONTRIBUTIONS,
      ...CLAIM_TYPE_CONTRIBUTIONS,
      ...SLOT_CONTRIBUTIONS,
      ...PRESET_CONTRIBUTIONS,
      ...REQUIREMENT_CONTRIBUTIONS,
      ...QUERY_CONTRIBUTIONS,
    ]);
  }

  if (request.contribution === "parser") {
    const parser = PARSERS[request.id];
    if (parser === undefined) {
      return respondError(
        "unknown-contribution",
        { id: request.id, contribution: request.contribution },
        request.id + " names a parser this module does not contribute",
      );
    }
    return respond(parser(request.input as ParserInput));
  }

  if (request.contribution === "rule" && request.id === DECLARATIVE_ID) {
    return respond(decideDeclarative(request.input as RuleInput));
  }

  return respondError(
    "unknown-contribution",
    { id: request.id, contribution: request.contribution },
    request.id + " names a contribution this module does not answer",
  );
}
