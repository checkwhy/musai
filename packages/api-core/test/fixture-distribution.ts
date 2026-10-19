import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationPlan } from "@musai/modules";
import { type ClaimTypeDeclaration, DEPRECATED_REASONS, KernelError, timestamp, versionString } from "@musai/records";
import { type GitContext, initWorkspace, LOCAL_DIR, MUSAI_DIR, Store } from "@musai/store";
import { declareClaimTypes, fixedClock, fixtureRunRecord, writeTrustFile } from "@musai/test-support";
import { writeSignerConfig } from "@musai/trust";
import { expect, onTestFinished } from "vitest";
import type { OperationContext } from "../src/context.js";
import type { Distribution } from "../src/distribution.js";
import { definedOperation } from "../src/handler.js";
import { buildRegistry, type OperationDescriptor } from "../src/registry.js";
import { MINTED_ARRAY_SCHEMA, type WriteResult } from "../src/write-result.js";

export const FIXTURE_INSTANT = timestamp("2026-01-01T00:00:00.000Z");

export const FIXTURE_CLOCK = fixedClock(FIXTURE_INSTANT);

export interface LabelInput {
  readonly label: string;
}

export interface HeadOutput {
  readonly head: string | null;
}

export interface MisansweredOutput {
  readonly answer: number;
}

const EMPTY_PLAN: OperationPlan = { put: [], attest: [], needs: [] };

const NO_INPUT_SCHEMA = { type: "object", additionalProperties: false, properties: {} };

const LABEL_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["label"],
  properties: { label: { type: "string" } },
};

const WRITE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["minted"],
  properties: { minted: MINTED_ARRAY_SCHEMA },
};

function oneRunPlan(input: LabelInput): {
  readonly plan: OperationPlan;
  readonly output: (applied: WriteResult) => WriteResult;
} {
  return {
    plan: { put: [{ kind: "run", value: fixtureRunRecord(input.label) }], attest: [], needs: [] },
    output: (applied) => ({ minted: applied.minted }),
  };
}

export const fixtureRead = definedOperation<Record<string, never>, HeadOutput>(
  {
    id: "fixture.read",
    version: versionString("1"),
    input: NO_INPUT_SCHEMA,
    output: {
      type: "object",
      additionalProperties: false,
      required: ["head"],
      properties: { head: { type: ["string", "null"] } },
    },
    effect: "read",
    authority: null,
    reasons: ["invalid-input"],
    documentation: "answers with the scope's head, planning nothing",
    cli: { verb: "read", positional: [], flags: [], describe: "read the scope's head" },
    renderText: (output) => output.head ?? "",
    exitCode: () => 0,
  },
  {
    async plan(_input, view) {
      const head = await view.store.tip();
      return { plan: EMPTY_PLAN, output: () => ({ head }) };
    },
  },
);

export const fixtureWrite = definedOperation<LabelInput, WriteResult>(
  {
    id: "fixture.write",
    version: versionString("1"),
    input: LABEL_INPUT_SCHEMA,
    output: WRITE_OUTPUT_SCHEMA,
    effect: "write",
    authority: null,
    reasons: ["invalid-input", "head-moved"],
    documentation: "drafts one run record carrying the label",
    cli: { verb: "write", positional: ["label"], flags: [], describe: "write one run record" },
    renderText: (output) => output.minted.map((item) => item.id).join("\n"),
    exitCode: () => 0,
  },
  { plan: async (input) => oneRunPlan(input) },
);

export const fixtureGated = definedOperation<LabelInput, WriteResult>(
  {
    id: "fixture.gated",
    version: versionString("1"),
    input: LABEL_INPUT_SCHEMA,
    output: WRITE_OUTPUT_SCHEMA,
    effect: "write",
    authority: "rule",
    reasons: ["invalid-input", "head-moved", "not-authorised"],
    documentation: "drafts one run record carrying the label, for a principal holding rule",
    cli: { verb: "gated", positional: ["label"], flags: [], describe: "write one run record under rule" },
    renderText: (output) => output.minted.map((item) => item.id).join("\n"),
    exitCode: () => 0,
  },
  { plan: async (input) => oneRunPlan(input) },
);

export interface AttestedInput extends LabelInput {
  readonly key?: string;
}

/** Puts a run its caller makes, under rule, signing with the key the input names. */
export const fixtureAttested = definedOperation<AttestedInput, WriteResult>(
  {
    id: "fixture.attested",
    version: versionString("1"),
    input: {
      type: "object",
      additionalProperties: false,
      required: ["label"],
      properties: { label: { type: "string" }, key: { type: "string" } },
    },
    output: WRITE_OUTPUT_SCHEMA,
    effect: "write",
    authority: "rule",
    reasons: ["invalid-input", "head-moved", "not-authorised"],
    documentation: "drafts one run record carrying the label and attests making it, for a principal holding rule",
    cli: { verb: "attested", positional: ["label"], flags: ["key"], describe: "make one run record under rule" },
    renderText: (output) => output.minted.map((item) => item.id).join("\n"),
    exitCode: () => 0,
  },
  {
    plan: async (input) => ({
      plan: {
        put: [{ kind: "run", value: fixtureRunRecord(input.label) }],
        attest: [{ subject: { put: 0 }, purpose: "made" }],
        needs: [],
      },
      output: (applied) => ({ minted: applied.minted }),
      ...(input.key === undefined ? {} : { key: input.key }),
    }),
  },
);

/** Writes through a store with no plan to preview, as a verb driving a kernel primitive does. */
export const fixtureTool: OperationDescriptor<LabelInput, WriteResult> = {
  id: "fixture.tool",
  version: versionString("1"),
  input: LABEL_INPUT_SCHEMA,
  output: WRITE_OUTPUT_SCHEMA,
  effect: "write",
  authority: null,
  plans: false,
  reasons: ["invalid-input", "head-moved"],
  documentation: "writes one run record carrying the label straight through the store",
  cli: { verb: "tool", positional: ["label"], flags: [], describe: "write one run record directly" },
  renderText: (output) => output.minted.map((item) => item.id).join("\n"),
  exitCode: () => 0,
  async handler(input, context) {
    const store = new Store({ ctx: gitContextOf(context.workspace), scope: context.scope, now: context.now });
    const record = fixtureRunRecord(input.label);
    const [id] = await store.putMany([{ kind: "run", value: record }]);
    return { minted: [{ id: id!, kind: "run", record }] };
  },
};

/** Answers with a number where its own output schema promises a string. */
export const fixtureMisanswers: OperationDescriptor<Record<string, never>, MisansweredOutput> = {
  id: "fixture.misanswers",
  version: versionString("1"),
  input: NO_INPUT_SCHEMA,
  output: {
    type: "object",
    additionalProperties: false,
    required: ["answer"],
    properties: { answer: { type: "string" } },
  },
  effect: "read",
  authority: null,
  plans: true,
  reasons: ["invalid-output"],
  documentation: "answers outside its own output schema",
  cli: { verb: "misanswers", positional: [], flags: [], describe: "answer with the wrong shape" },
  renderText: (output) => String(output.answer),
  exitCode: () => 0,
  handler: async () => ({ answer: 42 }),
};

/** Declared out of the order a registry enumerates them in. */
export const FIXTURE_OPERATIONS: readonly OperationDescriptor[] = [
  fixtureRead,
  fixtureWrite,
  fixtureGated,
  fixtureTool,
  fixtureMisanswers,
];

export function fixtureDistribution(extra: readonly OperationDescriptor[] = []): Distribution {
  return {
    name: "fixture",
    version: "1.0.0",
    registry: buildRegistry([...FIXTURE_OPERATIONS, ...extra], DEPRECATED_REASONS),
    admitDrafts: async () => {},
  };
}

function gitContextOf(dir: string): GitContext {
  return { gitDir: join(dir, MUSAI_DIR) };
}

export interface FixtureWorkspaceOptions {
  /** Each seeded as a data-only module under its type's namespace. */
  readonly claimTypes?: readonly ClaimTypeDeclaration[];
  /** Absent, the empty trust files grant every action to everyone. */
  readonly roles?: string;
  readonly allowedSigners?: string;
  /** The key this machine signs with in the workspace, as `init --key` configures it. */
  readonly signingKey?: string;
}

export interface FixtureWorkspace {
  readonly dir: string;
  readonly scope: string;
  /** A performing context with `overrides` laid over it. */
  context(overrides?: Partial<OperationContext>): OperationContext;
  /** Knows no claim type beyond the kernel's own. */
  store(): Store;
  head(): Promise<string | null>;
}

/** Called from inside a test, which removes the workspace's directory when it finishes. */
export async function fixtureWorkspace(options: FixtureWorkspaceOptions = {}): Promise<FixtureWorkspace> {
  const dir = await mkdtemp(join(tmpdir(), "api-core-fixture-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const scope = "default";
  await initWorkspace(dir, { now: FIXTURE_CLOCK });
  const store = (): Store => new Store({ ctx: gitContextOf(dir), scope, now: FIXTURE_CLOCK });
  if (options.roles !== undefined) {
    await writeTrustFile(gitContextOf(dir), "roles", options.roles);
  }
  if (options.allowedSigners !== undefined) {
    await writeTrustFile(gitContextOf(dir), "allowed-signers", options.allowedSigners);
  }
  if (options.signingKey !== undefined) {
    await writeSignerConfig(join(dir, MUSAI_DIR, LOCAL_DIR), { keyPath: options.signingKey });
  }
  if (options.claimTypes !== undefined) {
    await declareClaimTypes(store(), options.claimTypes);
  }
  return {
    dir,
    scope,
    context: (overrides = {}) => ({ workspace: dir, scope, now: FIXTURE_CLOCK, ...overrides }),
    store,
    head: () => store().tip(),
  };
}

export async function refusalOf(call: () => unknown): Promise<KernelError> {
  const outcome = await Promise.resolve()
    .then(call)
    .then(
      (answer: unknown) => ({ answered: answer }),
      (error: unknown) => ({ refused: error }),
    );
  if ("answered" in outcome) {
    return expect.unreachable(`the call answered where it must refuse: ${JSON.stringify(outcome.answered)}`);
  }
  expect(outcome.refused).toBeInstanceOf(KernelError);
  return outcome.refused as KernelError;
}
