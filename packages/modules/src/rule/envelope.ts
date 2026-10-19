import type { ContributionEntry, RunRecipe, VersionString } from "@musai/records";
import {
  type AttestationPurpose,
  canonicalBytes,
  citationRecipeFor,
  DIMENSION_ORDERS,
  type FetchRecipe,
  isPlainObject,
  PACK_ATTEST_PURPOSES,
  PACK_MINTABLE_KINDS,
  type RecordId,
  type RecordKind,
  type ReleaseGrant,
  recordId,
  SchemaCompiler,
  type Seal,
} from "@musai/records";
import type { ValidateFunction } from "ajv";

/** The protocol this envelope speaks; a module built against another fails closed naming both. */
export const ENVELOPE_PROTOCOL = 1;

/** One invocation's request, plain data a byte-only host carries unchanged. */
export interface EnvelopeRequest {
  readonly protocol: number;
  readonly contribution: string;
  readonly id: string;
  readonly version: VersionString;
  readonly input: unknown;
}

/** Something a contribution noticed; it lands in the derivation and never changes a verdict. */
export type Diagnostic = Readonly<Record<string, unknown>>;

/** Codes both hosts emit identically, so a receiver's failure compares equal to the sender's. */
export const ERROR_CODES = [
  "unknown-contribution",
  "protocol-mismatch",
  "invalid-input",
  "invalid-output",
  "time-limit",
  "memory-limit",
  "contribution-threw",
  "need-refused",
  "stall",
  "unsupported-need",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

/** A failure at the envelope's level: a closed code, canonical data and a message for a person. */
export interface EnvelopeError {
  readonly code: ErrorCode;
  readonly data: unknown;
  readonly message: string;
}

/** A decoded response. Bytes never cross inline in `output`: they cross as a blob reference. */
export type EnvelopeResponse =
  | { readonly ok: true; readonly output: unknown; readonly diagnostics: readonly Diagnostic[] }
  | { readonly ok: false; readonly error: EnvelopeError };

/** Everything a contribution may ask the kernel for. An invoke is identified by its whole shape,
 * so two inputs to one contribution are two needs. It names no version: the fold holds one. */
export type Need =
  | { readonly kind: "run"; readonly recipe: RunRecipe }
  | { readonly kind: "fetch"; readonly recipe: FetchRecipe }
  | { readonly kind: "record"; readonly id: RecordId }
  | { readonly kind: "invoke"; readonly contribution: string; readonly input: unknown };

/** A record a plan would mint, as a draft with no id: a pack is never handed the canonicaliser. A
 * case's `about` is admission input and reaches neither the record nor its id. */
export interface PlannedRecord {
  readonly kind: RecordKind;
  readonly value: unknown;
  readonly about?: readonly string[];
  /** Asks the kernel to salt the draft under the workspace key, as a draft never names its salt. */
  readonly salt?: true;
}

/** An attestation a plan asks for, over its own draft or a held record it re-shares, releases,
 * seals or revokes; the kernel supplies who and when. */
export interface AttestIntent {
  readonly subject: { readonly put: number } | { readonly record: RecordId };
  readonly purpose: AttestationPurpose;
  /** What a release grants; never asked for by a pack. */
  readonly release?: ReleaseGrant;
  /** What a seal hides the record from; never asked for by a pack. */
  readonly seal?: Seal;
  /** The attestations this one replaces or withdraws. */
  readonly supersedes?: readonly RecordId[];
}

/** What an operation answers with; anything more would be a decision the kernel should make. */
export interface OperationPlan {
  readonly put: readonly PlannedRecord[];
  readonly attest: readonly AttestIntent[];
  readonly needs: readonly Need[];
}

/** The id a need is satisfied by. A fetch is keyed by the run-shaped recipe its receipt carries,
 * never by the bare fetch recipe. */
export function needId(need: Need): RecordId {
  switch (need.kind) {
    case "run":
      return recordId(need.recipe);
    case "fetch":
      return recordId(citationRecipeFor(need.recipe));
    case "record":
      return need.id;
    case "invoke":
      return recordId(need);
    default:
      // An unknown kind still gets an id, so a caller can report it as unsupported.
      return recordId(need);
  }
}

function assertNoBinaryPayload(value: unknown, path: string): void {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    throw new RangeError(
      `refusing to encode ${path}: a binary value must cross the boundary as a blob reference, never inline`,
    );
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertNoBinaryPayload(item, `${path}[${index}]`);
    });
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      assertNoBinaryPayload(item, `${path}.${key}`);
    }
  }
}

/** The canonical bytes of a request; a binary value must cross as a blob reference. */
export function encodeRequest(request: EnvelopeRequest): Uint8Array {
  assertNoBinaryPayload(request, "$");
  return canonicalBytes(request);
}

export function decodeResponse(bytes: Uint8Array): EnvelopeResponse {
  const text = new TextDecoder().decode(bytes);
  const parsed: unknown = JSON.parse(text);
  if (!isPlainObject(parsed)) {
    throw new TypeError("a response's bytes must decode to a JSON object");
  }
  if (parsed["ok"] === true) {
    const diagnostics = parsed["diagnostics"];
    if (!Array.isArray(diagnostics)) {
      throw new TypeError("a response's diagnostics must be an array");
    }
    return { ok: true, output: parsed["output"], diagnostics: diagnostics as Diagnostic[] };
  }
  if (parsed["ok"] === false) {
    const error = parsed["error"];
    if (!isPlainObject(error)) {
      throw new TypeError("a response's error must be an object");
    }
    if (!isErrorCode(error["code"])) {
      throw new TypeError(`a response's error.code must be one of ${ERROR_CODES.join(", ")}`);
    }
    if (typeof error["message"] !== "string") {
      throw new TypeError("a response's error.message must be a string");
    }
    return {
      ok: false,
      error: { code: error["code"], data: error["data"], message: error["message"] },
    };
  }
  throw new TypeError("a response's ok field must be true or false");
}

type JsonSchema = boolean | Record<string, unknown>;

const schemas = new SchemaCompiler();

function compile(schema: JsonSchema): ValidateFunction {
  return schemas.compile(schema as Record<string, unknown>);
}

/** `data`: read from the fold, never invoked. `invoke`: called through the envelope. */
export const POINT_ROLES = ["data", "invoke"] as const;

export type PointRole = (typeof POINT_ROLES)[number];

export function isPointRole(value: unknown): value is PointRole {
  return typeof value === "string" && (POINT_ROLES as readonly string[]).includes(value);
}

/** A contribution point from the kernel table or contributed by a module. */
export interface ContributionPoint {
  readonly name: string;
  readonly input: JsonSchema;
  readonly output: JsonSchema;
  readonly role: PointRole;
}

/** An entry and the point it answers at, handed in because a host holds neither record nor fold. */
export interface InvokedContribution {
  readonly entry: ContributionEntry;
  readonly point: ContributionPoint;
}

const RULE_EVIDENCE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["runId", "exitCode", "output"],
  properties: {
    runId: { type: "string" },
    exitCode: { type: "number" },
    output: { type: "string" },
  },
};

/** `RuleInput`, unwidened by anything a manifest could declare. */
const RULE_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["claimId", "conditions", "evidence"],
  properties: {
    claimId: { type: "string" },
    conditions: {
      type: "object",
      additionalProperties: {
        oneOf: [
          { type: "string" },
          {
            type: "object",
            required: ["kind"],
            properties: { kind: { enum: ["from", "until", "range", "set", "except", "any", "coded"] } },
          },
        ],
      },
    },
    evidence: { type: "array", items: RULE_EVIDENCE_SCHEMA },
    refusals: { type: "array" },
    invocations: {
      type: "array",
      items: { type: "object", required: ["moduleRecord"], properties: { moduleRecord: { type: "string" } } },
    },
    records: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "record"],
        properties: { id: { type: "string" }, record: { type: "object" } },
      },
    },
  },
};

/** Whether a value has the shape of a rule's input, asked before anything reads into it. */
export function isWellFormedRuleInput(value: unknown): boolean {
  return compile(RULE_INPUT_SCHEMA)(value) === true;
}

/** A need must carry what its id derives from, or a module's bug becomes the kernel's crash. An
 * invoke's input is checked where the invoked point is known, not here. */
const NEED_SCHEMA: JsonSchema = {
  type: "object",
  required: ["kind"],
  properties: {
    kind: { enum: ["run", "fetch", "record", "invoke"] },
  },
  oneOf: [
    { required: ["recipe"], properties: { kind: { enum: ["run", "fetch"] }, recipe: { type: "object" } } },
    { required: ["id"], properties: { kind: { const: "record" }, id: { type: "string" } } },
    {
      required: ["contribution", "input"],
      properties: { kind: { const: "invoke" }, contribution: { type: "string", minLength: 1 } },
    },
  ],
};

const RULE_OUTPUT_SCHEMA: JsonSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "label", "reason"],
      properties: {
        kind: { const: "verdict" },
        label: { enum: ["holds", "fails", "open"] },
        reason: { type: "string" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "needs"],
      properties: {
        kind: { const: "request" },
        needs: { type: "array", items: NEED_SCHEMA },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "error"],
      properties: {
        kind: { const: "error" },
        error: { type: "object" },
      },
    },
  ],
};

/** A subscription's input: an event name and payload; an entry narrows it with a `const` name. */
const EVENT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "payload"],
  properties: {
    name: { type: "string" },
    payload: {},
  },
};

/** A point placing no schema of its own; the entry's declared schema is the whole contract. */
const UNCONSTRAINED_SCHEMA: JsonSchema = true;

/** A requirement's input; `versionPredicate` is `null` where any version will do. */
const REQUIREMENT_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["binary", "versionPredicate", "neededBy", "install"],
  properties: {
    binary: { type: "string" },
    versionPredicate: { type: ["string", "null"] },
    neededBy: { type: "string" },
    install: { type: "string" },
  },
};

const REQUIREMENT_OUTPUT_SCHEMA: JsonSchema = { const: true };

/** Whether a requirement entry's input is the data its point declares, asked before it is read. */
export function isWellFormedRequirementInput(value: unknown): boolean {
  return compile(REQUIREMENT_INPUT_SCHEMA)(value) === true;
}

/** Everything a booking knows of the case; a kind performs no I/O, so this is its whole world. */
const KIND_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["slug", "about", "overrides"],
  properties: {
    slug: { type: "string" },
    about: { type: "array", items: { type: "string" } },
    overrides: { type: "object" },
  },
};

/** A kind's setlist in working order. A claim carries no slot, evidence or predecessor: the kernel
 * computes the slot, and naming evidence would mint a claim's standing rather than describe it. */
const KIND_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["claims"],
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "conditions", "canonical", "rendering"],
        properties: {
          type: { type: "string" },
          conditions: { type: "object" },
          canonical: { type: "object" },
          rendering: { type: "string" },
          about: { type: "array", items: { type: "string" } },
          exclusiveGroup: { type: ["string", "null"] },
        },
      },
    },
  },
};

/** A pack's plan, checked at the module boundary. It may put only `PACK_MINTABLE_KINDS` and attest
 * only its own drafts; a `put` index past the end is refused where the plan is realised. */
const OPERATION_PLAN_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["put", "attest", "needs"],
  properties: {
    put: {
      type: "array",
      items: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "value"],
            properties: {
              kind: { enum: PACK_MINTABLE_KINDS.filter((kind) => kind !== "case") },
              value: { type: "object" },
              salt: { const: true },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "value", "about"],
            properties: {
              kind: { const: "case" },
              value: { type: "object" },
              about: { type: "array", items: { type: "string" } },
              salt: { const: true },
            },
          },
        ],
      },
    },
    attest: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["subject", "purpose"],
        properties: {
          subject: {
            type: "object",
            additionalProperties: false,
            required: ["put"],
            properties: { put: { type: "integer", minimum: 0 } },
          },
          purpose: { enum: [...PACK_ATTEST_PURPOSES] },
        },
      },
    },
    needs: { type: "array", items: NEED_SCHEMA },
  },
};

/** No `name`: a contributed point's name is its entry id, which a copy here could contradict. */
const POINT_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["input", "output", "role"],
  properties: {
    input: {},
    output: {},
    role: { enum: [...POINT_ROLES] },
  },
};

/** A point is read, never invoked. */
const POINT_OUTPUT_SCHEMA: JsonSchema = { const: true };

/** A dimension's name is a bare condition key: a key with a `/` names a module's contribution. */
const DIMENSION_NAME_SCHEMA: JsonSchema = { type: "string", minLength: 1, pattern: "^[^/]+$" };

/** No type id: the contribution id is the type id. Without `canonical` the payload is unchecked;
 * with no identity dimension every claim of the type would collide. */
const CLAIM_TYPE_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["identityDimensions"],
  properties: {
    identityDimensions: { type: "array", items: DIMENSION_NAME_SCHEMA, minItems: 1 },
    canonical: { type: ["object", "boolean"] },
  },
};

/** The order an `ordered` or `interval` dimension compares its values under. */
const DIMENSION_ORDER_DATA_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["order"],
  properties: {
    order: { enum: [...DIMENSION_ORDERS] },
  },
};

/** One branch per dimension type. Unlike a point, a dimension carries its `name`, a key a pack
 * names for its domain. */
const DIMENSION_INPUT_SCHEMA: JsonSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["name", "type", "data"],
      properties: {
        name: DIMENSION_NAME_SCHEMA,
        type: { const: "ordered" },
        data: DIMENSION_ORDER_DATA_SCHEMA,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["name", "type", "data"],
      properties: {
        name: DIMENSION_NAME_SCHEMA,
        type: { const: "interval" },
        data: DIMENSION_ORDER_DATA_SCHEMA,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["name", "type", "data"],
      properties: {
        name: DIMENSION_NAME_SCHEMA,
        type: { const: "dag" },
        data: {
          type: "object",
          additionalProperties: false,
          required: ["edges"],
          properties: {
            edges: { type: "object", additionalProperties: { type: "array", items: { type: "string" } } },
            expansions: {
              type: "object",
              additionalProperties: {
                type: "object",
                additionalProperties: false,
                required: ["first", "last"],
                properties: { first: { type: "string" }, last: { type: "string" } },
              },
            },
          },
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["name", "type", "data"],
      properties: {
        name: DIMENSION_NAME_SCHEMA,
        type: { const: "hierarchical" },
        data: {
          type: "object",
          additionalProperties: false,
          required: ["parentOf"],
          properties: {
            parentOf: { type: "object", additionalProperties: { type: ["string", "null"] } },
          },
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["name", "type", "data"],
      properties: {
        name: DIMENSION_NAME_SCHEMA,
        type: { const: "identity" },
        data: { type: "object", additionalProperties: false },
      },
    },
  ],
};

/** Evidence is keyed by the name of the recipe that asked for it, the only tie between them once
 * the kernel has returned evidence in request order. */
const EXPECTATION_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["expectation", "evidence"],
  properties: {
    expectation: { type: "object", required: ["kind"], properties: { kind: { type: "string" } } },
    evidence: { type: "object", additionalProperties: RULE_EVIDENCE_SCHEMA },
  },
};

/** A reason is required either way, since a verdict reads back both. */
const EXPECTATION_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["met", "reason"],
  properties: {
    met: { type: "boolean" },
    reason: { type: "string" },
  },
};

/** One record as the fold holds it and where it landed; a row function sees every record. */
const FOLD_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "kind", "record", "commit", "position"],
  properties: {
    id: { type: "string" },
    kind: { type: "string" },
    record: { type: "object" },
    commit: { type: "string" },
    position: { type: "number" },
  },
};

/** The rows one record contributes; the entry's manifest narrows `rows.items` to its columns. */
const FOLD_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["rows"],
  properties: {
    rows: { type: "array" },
  },
};

/** A query's input is its parameter schema, so a surface projects it from its shape alone;
 * `statement` and `tables` are the only annotations it may carry. */
const QUERY_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type", "properties", "statement", "tables"],
  properties: {
    type: { const: "object" },
    additionalProperties: { const: false },
    properties: { type: "object" },
    required: { type: "array", items: { type: "string" } },
    statement: { type: "string", minLength: 1 },
    tables: { type: "array", items: { type: "string" }, minItems: 1 },
  },
};

/** The wrapper every query answers in; the row itself is the contribution's to declare. */
const QUERY_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  required: ["type", "required", "properties"],
  properties: {
    type: { const: "object" },
    required: { const: ["rows"] },
    properties: {
      type: "object",
      required: ["rows"],
      properties: {
        rows: {
          type: "object",
          required: ["type", "items"],
          properties: {
            type: { const: "array" },
            items: { type: "object", required: ["type"], properties: { type: { const: "object" } } },
          },
        },
      },
    },
  },
};

/** Every point the kernel ships; `point` is among them, or nothing would validate a `role`. */
const KERNEL_POINT_TABLE: readonly ContributionPoint[] = [
  { name: "rule", role: "invoke", input: RULE_INPUT_SCHEMA, output: RULE_OUTPUT_SCHEMA },
  { name: "parser", role: "invoke", input: UNCONSTRAINED_SCHEMA, output: UNCONSTRAINED_SCHEMA },
  { name: "slot", role: "data", input: UNCONSTRAINED_SCHEMA, output: UNCONSTRAINED_SCHEMA },
  { name: "preset", role: "data", input: UNCONSTRAINED_SCHEMA, output: UNCONSTRAINED_SCHEMA },
  { name: "template", role: "invoke", input: UNCONSTRAINED_SCHEMA, output: UNCONSTRAINED_SCHEMA },
  { name: "subscription", role: "invoke", input: EVENT_SCHEMA, output: RULE_OUTPUT_SCHEMA },
  { name: "requirement", role: "data", input: REQUIREMENT_INPUT_SCHEMA, output: REQUIREMENT_OUTPUT_SCHEMA },
  { name: "view", role: "invoke", input: UNCONSTRAINED_SCHEMA, output: UNCONSTRAINED_SCHEMA },
  { name: "kind", role: "invoke", input: KIND_INPUT_SCHEMA, output: KIND_OUTPUT_SCHEMA },
  { name: "operation", role: "invoke", input: UNCONSTRAINED_SCHEMA, output: OPERATION_PLAN_SCHEMA },
  { name: "point", role: "data", input: POINT_INPUT_SCHEMA, output: POINT_OUTPUT_SCHEMA },
  { name: "claim-type", role: "data", input: CLAIM_TYPE_INPUT_SCHEMA, output: { const: true } },
  { name: "dimension", role: "data", input: DIMENSION_INPUT_SCHEMA, output: { const: true } },
  { name: "fold", role: "invoke", input: FOLD_INPUT_SCHEMA, output: FOLD_OUTPUT_SCHEMA },
  { name: "query", role: "data", input: QUERY_INPUT_SCHEMA, output: QUERY_OUTPUT_SCHEMA },
  { name: "expectation", role: "invoke", input: EXPECTATION_INPUT_SCHEMA, output: EXPECTATION_OUTPUT_SCHEMA },
];

/** A manifest's declared schema is conjoined with these, so it can only narrow, never widen. */
const KERNEL_POINTS: ReadonlyMap<string, ContributionPoint> = new Map(
  KERNEL_POINT_TABLE.map((point) => [point.name, point]),
);

export function kernelPoint(name: string): ContributionPoint | undefined {
  return KERNEL_POINTS.get(name);
}

const CONTRIBUTION_ENTRY_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "id", "version", "input", "output", "documentation"],
  properties: {
    kind: { type: "string", minLength: 1 },
    id: { type: "string" },
    version: { type: "string" },
    input: {},
    output: {},
    documentation: { type: "string" },
    // A `template`'s skill marker; the module record's parser enforces its shape.
    skill: {},
    // An `operation`'s effect and authority, also left to the module record's parser.
    effect: {},
    authority: {},
  },
};

/** The reserved `describe` response: a bundle's contribution table, as its manifest shapes it. */
export const DESCRIBE_OUTPUT_SCHEMA: JsonSchema = {
  type: "array",
  items: CONTRIBUTION_ENTRY_SCHEMA,
};

export type EnvelopeValidation = { readonly ok: true } | { readonly ok: false; readonly error: EnvelopeError };

function moduleNameOf(contributionId: string): string {
  const slash = contributionId.indexOf("/");
  return slash === -1 ? contributionId : contributionId.slice(0, slash);
}

function validateAgainstConjunction(
  kernelSchema: JsonSchema,
  manifestSchema: unknown,
  value: unknown,
  code: Extract<ErrorCode, "invalid-input" | "invalid-output">,
  entryId: string,
): EnvelopeValidation {
  const half = code === "invalid-input" ? "input" : "output";
  const kernelValidate = compile(kernelSchema);
  if (!kernelValidate(value)) {
    return {
      ok: false,
      error: {
        code,
        data: { entry: entryId, errors: kernelValidate.errors ?? [] },
        message: `${entryId}'s ${half} disagrees with the kernel's own schema for its contribution kind`,
      },
    };
  }
  let manifestValidate: ValidateFunction;
  try {
    manifestValidate = compile(manifestSchema as JsonSchema);
  } catch (error) {
    return {
      ok: false,
      error: {
        code,
        data: { entry: entryId, error: error instanceof Error ? error.message : String(error) },
        message: `${entryId} declares a manifest schema that could not be compiled`,
      },
    };
  }
  if (!manifestValidate(value)) {
    return {
      ok: false,
      error: {
        code,
        data: { entry: entryId, errors: manifestValidate.errors ?? [] },
        message: `${entryId}'s ${half} disagrees with its own manifest's declared schema`,
      },
    };
  }
  return { ok: true };
}

/** Checks the protocol, then the input against the point's operand conjoined with the entry's
 * schema: a conjunction only narrows, so a looser manifest cannot admit a looser value. */
export function validateEnvelopeInput(contribution: InvokedContribution, request: EnvelopeRequest): EnvelopeValidation {
  if (request.protocol !== ENVELOPE_PROTOCOL) {
    return {
      ok: false,
      error: {
        code: "protocol-mismatch",
        data: {
          module: moduleNameOf(request.id),
          contribution: request.contribution,
          requestProtocol: request.protocol,
          kernelProtocol: ENVELOPE_PROTOCOL,
        },
        message: `${request.id} was invoked at protocol ${request.protocol}, but this kernel speaks protocol ${ENVELOPE_PROTOCOL}`,
      },
    };
  }
  const { entry, point } = contribution;
  return validateAgainstConjunction(point.input, entry.input, request.input, "invalid-input", entry.id);
}

/** Checks the output against the same conjunction as the input. */
export function validateEnvelopeOutput(contribution: InvokedContribution, output: unknown): EnvelopeValidation {
  const { entry, point } = contribution;
  return validateAgainstConjunction(point.output, entry.output, output, "invalid-output", entry.id);
}

/** What a subscription is invoked with, the shape `EVENT_SCHEMA` fixes. */
export interface EventPayload {
  readonly name: string;
  readonly payload: unknown;
}
