import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexDb } from "@musai/fold";
import {
  DESCRIBE_OUTPUT_SCHEMA,
  decodeResponse,
  ENVELOPE_PROTOCOL,
  type EnvelopeRequest,
  type EnvelopeResponse,
  ERROR_CODES,
  encodeRequest,
  type InvokedContribution,
  isPointRole,
  kernelPoint,
  type Need,
  needId,
  validateEnvelopeInput,
  validateEnvelopeOutput,
} from "@musai/modules";
import type { RunRecipe } from "@musai/records";
import {
  type ContributionEntry,
  CURRENT_SCHEMA_VERSIONS,
  canonicalBytes,
  citationRecipeFor,
  DESCRIBE_CONTRIBUTION,
  type FetchRecipe,
  recordId,
  renderSelector,
  type Selector,
  validateRecord,
  versionString,
} from "@musai/records";
import { Store } from "@musai/store";
import { type FixtureRepo, makeFixtureRepo } from "@musai/test-support";
import { Ajv } from "ajv";
import { afterEach, describe, expect, test } from "vitest";
import { dispatchEvent, type SubscriptionEntry } from "../src/evaluator/restart.js";

function ruleEntry(id: string, overrides: Partial<ContributionEntry> = {}): ContributionEntry {
  return {
    kind: "rule",
    id,
    version: versionString("1"),
    input: true,
    output: true,
    documentation: "a test rule contribution",
    ...overrides,
  };
}

/** An entry with the kernel point its kind names, which the envelope validates against. */
function invoked(entry: ContributionEntry): InvokedContribution {
  return { entry, point: kernelPoint(entry.kind)! };
}

function requestFor(id: string, input: unknown, protocol: number = ENVELOPE_PROTOCOL): EnvelopeRequest {
  return { protocol, contribution: "rule", id, version: versionString("1"), input };
}

describe("the envelope: bytes in, bytes out, and nothing else crosses", () => {
  test("a request round-trips through canonical bytes unchanged", () => {
    const request = requestFor("musai.core/example", { claimId: "c1", conditions: {}, evidence: [] });
    const bytes = encodeRequest(request);
    const roundTripped = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    expect(roundTripped).toEqual(request);
  });

  test("a contribution id and a selector key holding non-ASCII characters produce identical bytes on both sides", () => {
    const request = requestFor("café/módulo", { claimId: "réclamé", conditions: {}, evidence: [] });
    const sentBytes = encodeRequest(request);
    const receivedBytes = canonicalBytes(JSON.parse(new TextDecoder().decode(sentBytes)));
    expect(receivedBytes).toEqual(sentBytes);

    const selector: Selector = {
      module: "café",
      parser: "análise",
      version: versionString("1"),
      key: "chave-não-ascii",
    };
    const senderBytes = canonicalBytes({ selector, rendered: renderSelector(selector) });
    const receiverBytes = canonicalBytes(JSON.parse(new TextDecoder().decode(senderBytes)));
    expect(receiverBytes).toEqual(senderBytes);
  });

  test("a rule input whose conditions carry a scope object validates on the wire", () => {
    const request = requestFor("musai.core/example", {
      claimId: "c1",
      conditions: { platform: "linux", chapter: { kind: "range", from: "01", to: "09" } },
      evidence: [],
    });
    expect(validateEnvelopeInput(invoked(ruleEntry("musai.core/example")), request).ok).toBe(true);
  });

  test("an input with no evidence and no conditions is a complete envelope", () => {
    const request = requestFor("musai.core/example", { claimId: "c1", conditions: {}, evidence: [] });
    const result = validateEnvelopeInput(invoked(ruleEntry("musai.core/example")), request);
    expect(result.ok).toBe(true);
  });

  test("an inline binary value is refused naming the field, while a blob reference crosses", () => {
    const withBinary = requestFor("musai.core/example", { payload: new Uint8Array([1, 2, 3]) });
    expect(() => encodeRequest(withBinary)).toThrow(/payload/);

    const withBlobReference = requestFor("musai.core/example", { payload: { blob: `sha256:${"a".repeat(64)}` } });
    expect(() => encodeRequest(withBlobReference)).not.toThrow();
  });

  test("a manifest schema that tries to widen a kernel-required field still fails validation against the conjunction", () => {
    const wideningEntry = ruleEntry("musai.core/example", { input: { type: "object" } });
    const missingClaimId = requestFor("musai.core/example", { conditions: {}, evidence: [] });
    const result = validateEnvelopeInput(invoked(wideningEntry), missingClaimId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid-input");
    }
  });

  test("a manifest schema that narrows is honoured", () => {
    const narrowingEntry = ruleEntry("musai.core/example", {
      input: { type: "object", properties: { claimId: { const: "only-this-claim" } } },
    });
    const matching = requestFor("musai.core/example", { claimId: "only-this-claim", conditions: {}, evidence: [] });
    expect(validateEnvelopeInput(invoked(narrowingEntry), matching).ok).toBe(true);

    const notMatching = requestFor("musai.core/example", {
      claimId: "some-other-claim",
      conditions: {},
      evidence: [],
    });
    expect(validateEnvelopeInput(invoked(narrowingEntry), notMatching).ok).toBe(false);
  });

  test("an output failing validation returns the invalid-output code rather than throwing", () => {
    const entry = ruleEntry("musai.core/example");
    let result: ReturnType<typeof validateEnvelopeOutput> | undefined;
    expect(() => {
      result = validateEnvelopeOutput(invoked(entry), { kind: "verdict", label: "unsure", reason: "not a real label" });
    }).not.toThrow();
    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.error.code).toBe("invalid-output");
    }
  });

  test("a protocol mismatch produces a response carrying the mismatch code, the module name and both versions, and does not throw", () => {
    const entry = ruleEntry("musai.core/example");
    const mismatched = requestFor("musai.core/example", {}, ENVELOPE_PROTOCOL + 1);
    let result: ReturnType<typeof validateEnvelopeInput> | undefined;
    expect(() => {
      result = validateEnvelopeInput(invoked(entry), mismatched);
    }).not.toThrow();
    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.error.code).toBe("protocol-mismatch");
      expect(result.error.data).toMatchObject({
        module: "musai.core",
        requestProtocol: ENVELOPE_PROTOCOL + 1,
        kernelProtocol: ENVELOPE_PROTOCOL,
      });
      expect(result.error.message).toContain("musai.core/example");
    }
  });

  test("every member of the error-code tuple is producible by some path, so no code is declared and unreachable", () => {
    for (const code of ERROR_CODES) {
      const response: EnvelopeResponse = { ok: false, error: { code, data: { code }, message: `exercising ${code}` } };
      const bytes = canonicalBytes(response);
      const decoded = decodeResponse(bytes);
      expect(decoded.ok).toBe(false);
      if (!decoded.ok) {
        expect(decoded.error.code).toBe(code);
      }
    }
  });
});

describe("needId: the id satisfaction is decided on, defined once for every need kind", () => {
  const recipe: RunRecipe = {
    command: ["true"],
    workingDirectory: "/",
    environment: {},
    declared: [],
    substrates: [],
    isolation: "hygiene",
  };

  test("a run need's id is its recipe's own canonical id", () => {
    const need: Need = { kind: "run", recipe };
    expect(needId(need)).toBe(recordId(recipe));
  });

  test("a fetch need's id is the canonical id of the run-shaped recipe its own citation will carry, distinct from a run recipe's", () => {
    const fetchRecipe: FetchRecipe = { locator: "https://example.test/data", headers: [], names: [] };
    const need: Need = { kind: "fetch", recipe: fetchRecipe };
    expect(needId(need)).toBe(recordId(citationRecipeFor(fetchRecipe)));
    expect(needId(need)).not.toBe(recordId(fetchRecipe));
    expect(needId(need)).not.toBe(recordId(recipe));
  });

  test("a record need's id is the record id itself", () => {
    const id = recordId({ marker: "some-record" });
    const need: Need = { kind: "record", id };
    expect(needId(need)).toBe(id);
  });

  test("an invoke need's id is the canonical id of its whole shape", () => {
    const need: Need = { kind: "invoke", contribution: "pack/thing", input: { a: 1 } };
    expect(needId(need)).toBe(recordId(need));
  });

  test("two invokes of one contribution with different inputs are two needs, and two identical ones are one", () => {
    const need: Need = { kind: "invoke", contribution: "pack/thing", input: { a: 1 } };
    const sameAgain: Need = { kind: "invoke", contribution: "pack/thing", input: { a: 1 } };
    const otherInput: Need = { kind: "invoke", contribution: "pack/thing", input: { a: 2 } };
    expect(needId(sameAgain)).toBe(needId(need));
    expect(needId(otherInput)).not.toBe(needId(need));
  });
});

describe("the reserved describe request: how a build derives a manifest without a second export", () => {
  test("a manifest entry declaring describe as its kind is refused", () => {
    const moduleValue = {
      kind: "module",
      schemaVersion: CURRENT_SCHEMA_VERSIONS.module,
      name: "musai.core",
      version: "1",
      manifest: {
        protocolVersion: ENVELOPE_PROTOCOL,
        contributions: [
          {
            kind: DESCRIBE_CONTRIBUTION,
            id: "musai.core/describe",
            version: "1",
            input: true,
            output: true,
            documentation: "not a real contribution kind",
          },
        ],
        sourceTree: { digest: { sha256: "a".repeat(64) } },
        toolchain: [],
        packages: [],
      },
      bundle: null,
      build: null,
    };
    const result = validateRecord(moduleValue);
    expect(result.ok).toBe(false);
  });

  test("a request carrying the describe contribution validates against the kernel's own schema for it", () => {
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(DESCRIBE_OUTPUT_SCHEMA as object);
    const contributionTable: ContributionEntry[] = [ruleEntry("musai.core/example")];
    expect(validate(contributionTable)).toBe(true);
    expect(validate([{ kind: "rule" }])).toBe(false);
  });

  test("a bundle describing an operation contribution carries its declared effect and authority through", () => {
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(DESCRIBE_OUTPUT_SCHEMA as object);
    const operation = ruleEntry("pack/stamps", { kind: "operation", effect: "write", authority: null });
    expect(validate([operation])).toBe(true);
  });
});

describe("a subscription is a contribution: named event in, the ordinary response shape out", () => {
  test("a subscription's input validates against the kernel's schema, and its output is validated the same way a rule's is, through one code path", () => {
    const subscription = ruleEntry("musai.core/on-run-completed", {
      kind: "subscription",
      input: { properties: { name: { const: "run.completed" } } },
    });
    const eventRequest: EnvelopeRequest = {
      protocol: ENVELOPE_PROTOCOL,
      contribution: "subscription",
      id: "musai.core/on-run-completed",
      version: versionString("1"),
      input: { name: "run.completed", payload: { runId: "sha256:aa" } },
    };
    expect(validateEnvelopeInput(invoked(subscription), eventRequest).ok).toBe(true);

    const rule = ruleEntry("musai.core/example");
    const verdict = { kind: "verdict", label: "holds", reason: "handled" };
    expect(validateEnvelopeOutput(invoked(subscription), verdict).ok).toBe(true);
    expect(validateEnvelopeOutput(invoked(rule), verdict).ok).toBe(true);

    const malformed = { kind: "verdict", label: "unsure", reason: "not a real label" };
    expect(validateEnvelopeOutput(invoked(subscription), malformed).ok).toBe(false);
    expect(validateEnvelopeOutput(invoked(rule), malformed).ok).toBe(false);
  });

  test("a need carrying nothing to identify it by is refused here, before the kernel would derive an id from what is missing", () => {
    const rule = ruleEntry("musai.core/example");
    const wellFormed = {
      kind: "request",
      needs: [
        {
          kind: "run",
          recipe: {
            command: ["true"],
            workingDirectory: "/",
            environment: {},
            declared: [],
            substrates: [],
            isolation: "hygiene",
          },
        },
        { kind: "record", id: `sha256:${"a".repeat(64)}` },
      ],
    };
    expect(validateEnvelopeOutput(invoked(rule), wellFormed).ok).toBe(true);

    for (const need of [{ kind: "run" }, { kind: "fetch" }, { kind: "record" }, { kind: "run", id: "not-a-recipe" }]) {
      const result = validateEnvelopeOutput(invoked(rule), { kind: "request", needs: [need] });
      expect({ need, ok: result.ok }).toEqual({ need, ok: false });
    }
  });

  test("an invoke need travels beside a run need, and one missing the contribution it calls or the input it is called with is refused", () => {
    const rule = ruleEntry("musai.core/example");
    const wellFormed = {
      kind: "request",
      needs: [
        {
          kind: "run",
          recipe: {
            command: ["true"],
            workingDirectory: "/",
            environment: {},
            declared: [],
            substrates: [],
            isolation: "hygiene",
          },
        },
        { kind: "invoke", contribution: "musai.core/example", input: { question: "is it so" } },
      ],
    };
    expect(validateEnvelopeOutput(invoked(rule), wellFormed).ok).toBe(true);

    for (const need of [
      { kind: "invoke", input: { question: "is it so" } },
      { kind: "invoke", contribution: "musai.core/example" },
      { kind: "invoke", contribution: "", input: { question: "is it so" } },
    ]) {
      const result = validateEnvelopeOutput(invoked(rule), { kind: "request", needs: [need] });
      expect({ need, ok: result.ok }).toEqual({ need, ok: false });
    }
  });
});

describe("the subscription dispatcher: one event, every registered subscription invoked, needs satisfied once", () => {
  let repo: FixtureRepo | undefined;

  afterEach(async () => {
    await repo?.cleanup();
    repo = undefined;
  });

  function recipeAppendingTo(counterFile: string): RunRecipe {
    return {
      command: ["node", "-e", `require("node:fs").appendFileSync(${JSON.stringify(counterFile)}, "1")`],
      workingDirectory: "/",
      environment: {},
      declared: [],
      substrates: [],
      isolation: "hygiene",
    };
  }

  test("two subscriptions for one event both naming one recipe cause exactly one spawn", async () => {
    repo = await makeFixtureRepo("envelope-dispatch-shared");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const index = new IndexDb();
    const scratchDir = await mkdtemp(join(tmpdir(), "musai-envelope-"));
    const counterFile = join(scratchDir, "counter");
    await writeFile(counterFile, "");
    const recipe = recipeAppendingTo(counterFile);
    const subscriptions: SubscriptionEntry[] = [
      { id: "musai.core/sink-a", handler: () => ({ kind: "request", needs: [{ kind: "run", recipe }] }) },
      { id: "musai.core/sink-b", handler: () => ({ kind: "request", needs: [{ kind: "run", recipe }] }) },
    ];

    const result = await dispatchEvent({
      event: { name: "run.completed", payload: {} },
      subscriptions,
      store,
      index,
      now: repo.now,
    });

    expect(result.outputs.size).toBe(2);
    expect(result.outcomes.size).toBe(1);
    expect(await readFile(counterFile, "utf8")).toBe("1");
  });

  test("the same event fired twice in one evaluation causes no second run for a recipe already satisfied", async () => {
    repo = await makeFixtureRepo("envelope-dispatch-twice");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const index = new IndexDb();
    const scratchDir = await mkdtemp(join(tmpdir(), "musai-envelope-"));
    const counterFile = join(scratchDir, "counter");
    await writeFile(counterFile, "");
    const recipe = recipeAppendingTo(counterFile);
    const subscriptions: SubscriptionEntry[] = [
      { id: "musai.core/sink-a", handler: () => ({ kind: "request", needs: [{ kind: "run", recipe }] }) },
    ];
    const evaluationOutcomes = new Map();

    await dispatchEvent({
      event: { name: "run.completed", payload: {} },
      subscriptions,
      store,
      index,
      evaluationOutcomes,
      now: repo.now,
    });
    await dispatchEvent({
      event: { name: "run.completed", payload: {} },
      subscriptions,
      store,
      index,
      evaluationOutcomes,
      now: repo.now,
    });

    expect(await readFile(counterFile, "utf8")).toBe("1");
  });
});

describe("the kernel's own contribution points, resolved by name from a fixed table", () => {
  const KERNEL_POINT_NAMES = [
    "rule",
    "parser",
    "slot",
    "preset",
    "template",
    "subscription",
    "requirement",
    "view",
    "kind",
    "operation",
    "point",
    "claim-type",
    "dimension",
    "fold",
    "query",
    "expectation",
  ] as const;

  test("every one of the sixteen names resolves to a point carrying both operands and a role from the closed pair", () => {
    for (const name of KERNEL_POINT_NAMES) {
      const point = kernelPoint(name);
      expect(point?.name).toBe(name);
      expect(point?.input).not.toBeUndefined();
      expect(point?.output).not.toBeUndefined();
      expect(isPointRole(point?.role)).toBe(true);
    }
  });

  test("a name the kernel does not ship resolves to nothing", () => {
    for (const name of ["describe", "pack/thing", "not-a-point"]) {
      expect(kernelPoint(name)).toBeUndefined();
    }
  });

  test("the data-role points are exactly the ones read from the fold and never invoked, the rest called through the envelope", () => {
    const dataNames = KERNEL_POINT_NAMES.filter((name) => kernelPoint(name)?.role === "data").sort();
    const invokeNames = KERNEL_POINT_NAMES.filter((name) => kernelPoint(name)?.role === "invoke").sort();
    expect(dataNames).toEqual(["claim-type", "dimension", "point", "preset", "query", "requirement", "slot"].sort());
    expect(invokeNames).toHaveLength(9);
    expect(dataNames.length + invokeNames.length).toBe(KERNEL_POINT_NAMES.length);
  });

  test("a well-formed point definition satisfies the point point's own input operand, and one carrying a third role value does not", () => {
    const pointPoint = kernelPoint("point");
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(pointPoint!.input as object);
    expect(validate({ input: true, output: true, role: "data" })).toBe(true);
    expect(validate({ input: true, output: true, role: "invoke" })).toBe(true);
    expect(validate({ input: true, output: true, role: "not-a-role" })).toBe(false);
  });

  test("a claim-type declaration with an empty identityDimensions array is refused by the claim-type point's own input operand", () => {
    const claimTypePoint = kernelPoint("claim-type");
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(claimTypePoint!.input as object);
    expect(validate({ identityDimensions: [] })).toBe(false);
    expect(validate({ identityDimensions: ["subject"] })).toBe(true);
  });

  test("a claim-type declaration naming a type of its own is refused, since its contribution id is the type id", () => {
    const claimTypePoint = kernelPoint("claim-type");
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(claimTypePoint!.input as object);
    expect(validate({ type: "example@1", identityDimensions: ["subject"] })).toBe(false);
  });

  test("a claim-type declaration carries the schema its canonical payload satisfies as an object or a boolean, and nothing else", () => {
    const claimTypePoint = kernelPoint("claim-type");
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(claimTypePoint!.input as object);
    expect(validate({ identityDimensions: ["subject"], canonical: { type: "object" } })).toBe(true);
    expect(validate({ identityDimensions: ["subject"], canonical: true })).toBe(true);
    expect(validate({ identityDimensions: ["subject"], canonical: "a schema" })).toBe(false);
  });

  test("a kind's output carries its setlist alone, an array of claim type declarations beside it refused", () => {
    const kindPoint = kernelPoint("kind");
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(kindPoint!.output as object);
    const claims = [
      {
        type: "example.pack/finding@1",
        conditions: { case: "reported" },
        canonical: { case: "reported" },
        rendering: "the fault reported in ./reports/1 reproduces",
      },
    ];

    expect(validate({ claims })).toBe(true);
    expect(validate({ claims, claimTypes: [{ type: "example.pack/finding@1", identityDimensions: ["case"] }] })).toBe(
      false,
    );
  });

  test("a well-formed declaration of each dimension type satisfies the dimension point's own input operand", () => {
    const dimensionPoint = kernelPoint("dimension");
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(dimensionPoint!.input as object);
    expect(validate({ name: "build", type: "ordered", data: { order: "numeric" } })).toBe(true);
    expect(validate({ name: "span", type: "interval", data: { order: "lexicographic" } })).toBe(true);
    expect(validate({ name: "package", type: "dag", data: { edges: { "engine@1.0.0": ["engine@1.x"] } } })).toBe(true);
    expect(
      validate({ name: "platform", type: "hierarchical", data: { parentOf: { ubuntu: "linux", linux: null } } }),
    ).toBe(true);
    expect(validate({ name: "run", type: "identity", data: {} })).toBe(true);
  });

  test("a dimension declaring an empty name is refused by the dimension point's own input operand", () => {
    const dimensionPoint = kernelPoint("dimension");
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(dimensionPoint!.input as object);
    expect(validate({ name: "", type: "identity", data: {} })).toBe(false);
    expect(validate({ name: "", type: "ordered", data: { order: "numeric" } })).toBe(false);
  });

  test("a dimension naming an order outside the closed vocabulary is refused by the dimension point's own input operand", () => {
    const dimensionPoint = kernelPoint("dimension");
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(dimensionPoint!.input as object);
    expect(validate({ name: "build", type: "ordered", data: { order: "version" } })).toBe(false);
    expect(validate({ name: "span", type: "interval", data: { order: "version" } })).toBe(false);
  });

  test("a dimension carrying a comparison function rather than a named order is refused by the dimension point's own input operand", () => {
    const dimensionPoint = kernelPoint("dimension");
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(dimensionPoint!.input as object);
    expect(validate({ name: "build", type: "ordered", data: { compare: "a minus b" } })).toBe(false);
    expect(validate({ name: "build", type: "ordered", data: { order: "numeric", compare: "a minus b" } })).toBe(false);
  });

  test("an expectation and the evidence it selects from satisfy the expectation point's input operand, and an expectation carrying no kind does not", () => {
    const expectationPoint = kernelPoint("expectation");
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(expectationPoint!.input as object);
    const evidence = { "build-step": { runId: `sha256:${"a".repeat(64)}`, exitCode: 0, output: "ready" } };
    expect(
      validate({
        expectation: { kind: "considers-it-so", mood: "optimistic" },
        evidence,
      }),
    ).toBe(true);
    expect(validate({ expectation: { mood: "optimistic" }, evidence })).toBe(false);
  });

  test("whether an expectation was met and the reason to say so satisfy the expectation point's output operand, and an answer with no reason does not", () => {
    const expectationPoint = kernelPoint("expectation");
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(expectationPoint!.output as object);
    expect(validate({ met: true, reason: "the output equalled the value" })).toBe(true);
    expect(validate({ met: true })).toBe(false);
  });
});
