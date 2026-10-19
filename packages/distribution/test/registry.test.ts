import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRegistry,
  DuplicateOperationError,
  type OperationDescriptor,
  runHandler,
  validateAgainstSchema,
} from "@musai/api-core";
import {
  type CaseRecord,
  type ClaimRecord,
  type ClaimTypeDeclaration,
  CURRENT_SCHEMA_VERSIONS,
  claimTypesFrom,
  EFFECT_CLASSES,
  type RecordId,
  recordId,
  slotFor,
  timestamp,
  versionString,
} from "@musai/records";
import { initWorkspace, Store } from "@musai/store";
import { declareClaimTypes, fixedClock, fixWorkspaceKey, pseudonymOf, writeTrustFile } from "@musai/test-support";
import { afterEach, describe, expect, test } from "vitest";
import { REGISTRY } from "../src/index.js";
import { briefRender } from "../src/ops/brief.js";
import { gateAnswer } from "../src/ops/gate.js";
import { rulingMake } from "../src/ops/ruling.js";

function fakeOperation(overrides: Partial<OperationDescriptor> = {}): OperationDescriptor {
  return {
    id: "fake.operation",
    version: versionString("1"),
    input: true,
    output: true,
    effect: "read",
    authority: null,
    plans: true,
    reasons: [],
    documentation: "a fake operation for registry tests",
    cli: { verb: "fake", positional: [], flags: [], describe: "a fake verb" },
    renderText: () => "",
    exitCode: () => 0,
    handler: async () => undefined,
    ...overrides,
  };
}

describe("building the registry from declared operations", () => {
  test("two descriptors sharing one id@version are refused, naming both", () => {
    const first = fakeOperation({ documentation: "the first declaration" });
    const second = fakeOperation({ documentation: "the second declaration" });
    expect(() => buildRegistry([first, second], new Set())).toThrow(DuplicateOperationError);
    try {
      buildRegistry([first, second], new Set());
      expect.unreachable("buildRegistry must throw on a duplicate id@version");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("fake.operation@1");
      expect(message).toContain("the first declaration");
      expect(message).toContain("the second declaration");
    }
  });

  test("a descriptor carrying no CLI projection is refused, naming the operation", () => {
    const { cli: _cli, ...rest } = fakeOperation();
    const withoutCli = rest as OperationDescriptor;
    expect(() => buildRegistry([withoutCli], new Set())).toThrow(/fake\.operation@1/);
  });

  test("enumeration order is id@version ascending regardless of declaration order", () => {
    const b = fakeOperation({ id: "b.op" });
    const a = fakeOperation({ id: "a.op" });
    const c = fakeOperation({ id: "c.op" });
    const registry = buildRegistry([b, a, c], new Set());
    expect([...registry.keys()]).toEqual(["a.op@1", "b.op@1", "c.op@1"]);
  });
});

describe("the projection contract every declared operation holds, which a lint over imports cannot see", () => {
  test("every descriptor has a non-empty CLI verb, a closed effect class, and JSON-Schema-shaped input and output", () => {
    expect(REGISTRY.size).toBeGreaterThan(0);
    for (const [key, descriptor] of REGISTRY) {
      expect(descriptor.cli.verb, `${key} must declare a non-empty CLI verb`).not.toBe("");
      expect(EFFECT_CLASSES, `${key}'s effect must be one of ${EFFECT_CLASSES.join(", ")}`).toContain(
        descriptor.effect,
      );
      for (const half of ["input", "output"] as const) {
        const schema = descriptor[half];
        const isJsonSchemaObject = typeof schema === "object" && schema !== null && !Array.isArray(schema);
        expect(schema === true || isJsonSchemaObject, `${key}'s ${half} must be a JSON Schema object or true`).toBe(
          true,
        );
      }
    }
  });

  test("every operation that takes a path or works for the author alone declares the invalid-input a clearance gives it", () => {
    const undeclared = [...REGISTRY.entries()]
      .filter(([, descriptor]) => (descriptor.paths?.length ?? 0) > 0 || descriptor.authorOnly === true)
      .filter(([, descriptor]) => !descriptor.reasons.includes("invalid-input"))
      .map(([key]) => key);
    expect(undeclared).toEqual([]);
  });

  test("every operation's output is closed: an object in it names every field, save a value open by nature", () => {
    const openByNature: Readonly<Record<string, string>> = {
      "minted[].record": "a minted record's body, which its kind's own schema holds",
      "config.get@1 value": "a configuration value, any JSON, which its key's own reader holds",
      "config.set@1 value": "a configuration value, any JSON, which its key's own reader holds",
      "gate.ask@1 pending.input": "the input for the operation it names, held by that one's input schema",
      "module.new@1 testReport.results[].mismatches[].expected": "a golden's response, any JSON value",
      "module.new@1 testReport.results[].mismatches[].actual": "a contribution's response, any JSON value",
      "module.test@1 results[].mismatches[].expected": "a golden's response, any JSON value",
      "module.test@1 results[].mismatches[].actual": "a contribution's response, any JSON value",
    };
    const open: string[] = [];
    const walk = (key: string, path: string, schema: unknown): void => {
      const node = (schema === true ? {} : schema) as Record<string, unknown>;
      const unnamed =
        Object.keys(node).length === 0 || (node["type"] === "object" && node["additionalProperties"] !== false);
      if (unnamed && !(path in openByNature || `${key} ${path}` in openByNature)) {
        open.push(`${key} ${path}`);
      }
      const at = (name: string) => (path === "" ? name : `${path}.${name}`);
      for (const [name, child] of Object.entries((node["properties"] ?? {}) as Record<string, unknown>)) {
        walk(key, at(name), child);
      }
      for (const [name, child] of Object.entries((node["$defs"] ?? {}) as Record<string, unknown>)) {
        walk(key, `$defs.${name}`, child);
      }
      for (const child of [...((node["oneOf"] ?? []) as unknown[]), ...((node["anyOf"] ?? []) as unknown[])]) {
        walk(key, path, child);
      }
      if (node["items"] !== undefined) {
        walk(key, `${path}[]`, node["items"]);
      }
    };
    for (const [key, descriptor] of REGISTRY) {
      walk(key, "", descriptor.output);
    }
    expect(open).toEqual([]);
  });

  test("every operation declaring a role-matrix action is one whose own minting path checks it", () => {
    // `perform` checks the declared action; this lists the finer check a verb's mint still makes.
    const checkedElsewhere: Readonly<Record<string, string>> = {
      "ruling.make@2":
        "perform checks `rule`; mintRuling's own authorityOf checks the tier the channel declared, and maySupersede which rulings it may retire",
      "gate.answer@2": "perform checks `rule`; mintRuling's own authorityOf checks the tier the channel declared",
      "release.grant@2": "perform checks `publish`; admitPlan refuses a release relayed through model",
      "release.revoke@2": "perform checks `publish`; admitPlan refuses lifting a seal relayed through model",
      "release.seal@1": "perform checks `publish`; admitPlan refuses a seal relayed through model",
    };
    const declaring = [...REGISTRY.entries()]
      .filter(([, descriptor]) => descriptor.authority !== null)
      .map(([key]) => key)
      .sort();
    expect(declaring).toEqual(Object.keys(checkedElsewhere).sort());
  });

  test("every operation that is not a read and claims to plan says how it honours plan mode", () => {
    // A hand-built writer honours plan mode or declares `plans: false`; a new one says which.
    const honoursPlanMode: Readonly<Record<string, string>> = {
      "blobs.import@1": "puts blobs only when the call is performing",
      "bundle.rerun@3": "performs a recipe only when the call is performing and says yes",
      "brief.render@1": "definedOperation",
      "case.book@1": "definedOperation",
      "case.save@1": "definedOperation",
      "challenge.file@2": "definedOperation",
      "config.set@1": "validates the value, and writes the trust branch only when the call is performing",
      "config.unset@1": "removes the key only when the call is performing",
      "gate.answer@2": "definedOperation",
      "release.grant@2": "definedOperation",
      "release.revoke@2": "definedOperation",
      "release.seal@1": "definedOperation",
      "ruling.make@2": "definedOperation",
      "store.relayout@1": "rewrites the history only when the call is performing",
      "scope.fork@1": "forks only when the call is performing",
      "scope.merge@1": "merges only when the call is performing",
      "scope.drop@1": "drops only when the call is performing",
      "case.soundcheck@1": "performs a check only when the call is performing",
      "case.status@2": "performs a check only when the call is performing",
      "claim.status@2": "performs a check only when the call is performing",
      "claim.why@3": "performs a check only when the call is performing",
      "gate.ask@1": "reaches brief.render through the same context, whose plan mode it carries",
    };
    const planning = [...REGISTRY.entries()]
      .filter(([, descriptor]) => descriptor.effect !== "read" && descriptor.plans)
      .map(([key]) => key)
      .sort();
    expect(planning).toEqual(Object.keys(honoursPlanMode).sort());
  });
});

describe("the authority a ruling-minting operation declares, driven through runHandler", () => {
  const now = fixedClock(timestamp("2026-01-01T00:00:00.000Z"));
  const CLAIM_TYPE = "musai.registry-authority-fixture-test/claim@1";
  const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: CLAIM_TYPE, identityDimensions: ["id"] };
  const CLAIM_TYPES = claimTypesFrom([CLAIM_DECLARATION]);
  const UNAUTHORISED_PRINCIPAL = "someone-else@example.com";

  let workspace: string;

  afterEach(async () => {
    if (workspace) {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  /** A booked claim and its brief, with a role grant to another principal: with no trust files
   * every principal holds every action, and a test would pass vacuously. */
  async function fixtureWithClaimAndBrief(): Promise<{
    readonly scope: string;
    readonly claim: string;
    readonly brief: string;
  }> {
    workspace = await mkdtemp(join(tmpdir(), "musai-registry-authority-"));
    await initWorkspace(workspace, { now });
    await fixWorkspaceKey(workspace);
    await writeTrustFile(
      { gitDir: join(workspace, ".musai") },
      "roles",
      `${pseudonymOf("arbiter-person")} owner any\n`,
    );
    const scope = "default";
    const store = new Store({ ctx: { gitDir: join(workspace, ".musai") }, scope, now, claimTypes: CLAIM_TYPES });
    await declareClaimTypes(store, [CLAIM_DECLARATION]);

    const conditions = { id: "only" };
    const claim: ClaimRecord = {
      kind: "claim",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
      type: CLAIM_TYPE,
      about: [],
      slot: slotFor(CLAIM_DECLARATION, conditions),
      conditions,
      canonical: conditions,
      rendering: "the fixture claim holds",
      evidence: [],
      exclusiveGroup: null,
    };
    const [claimId] = await store.putMany([{ kind: "claim", value: claim }]);

    const caseRecord: CaseRecord = {
      kind: "case",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.case,
      type: null,
      slug: "registry-authority-fixture",
      claims: [claimId as RecordId],
      preset: {
        module: "musai.core",
        contribution: "musai.core/bare",
        moduleRecord: recordId({ marker: "registry-authority-fixture" }),
      },
      projectCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      overrides: {},
      evaluatorVersion: versionString("1"),
    };
    await store.putMany([{ kind: "case", value: caseRecord }]);

    const briefed = await runHandler(briefRender, { claim: claimId as RecordId }, { workspace, scope, now });

    return { scope, claim: claimId as RecordId, brief: briefed.brief };
  }

  test("ruling.make@2 refuses not-authorised for a principal the matrix does not grant, before anything is minted", async () => {
    const { scope, claim, brief } = await fixtureWithClaimAndBrief();
    const context = { workspace, scope, now, via: "tty" as const, principalName: UNAUTHORISED_PRINCIPAL };

    const refusal = await runHandler(
      rulingMake,
      { claim, verdict: "holds", reason: "an unauthorised attempt", brief },
      context,
    ).catch((error: unknown) => error);

    expect(refusal).toMatchObject({
      reason: "not-authorised",
      about: [pseudonymOf(UNAUTHORISED_PRINCIPAL), expect.any(String)],
    });
  });

  test("gate.answer@2 is gated exactly as ruling.make@2, for the same unauthorised principal", async () => {
    const { scope, claim, brief } = await fixtureWithClaimAndBrief();
    const context = { workspace, scope, now, via: "tty" as const, principalName: UNAUTHORISED_PRINCIPAL };

    const refusal = await runHandler(
      gateAnswer,
      { pending: claim, brief, choice: "holds", reason: "an unauthorised attempt" },
      context,
    ).catch((error: unknown) => error);

    expect(refusal).toMatchObject({
      reason: "not-authorised",
      about: [pseudonymOf(UNAUTHORISED_PRINCIPAL), expect.any(String)],
    });
  });
});

describe("validating a value against a schema a module declares", () => {
  test("a schema carrying an $id validates on every call, however many fresh equal copies of it arrive", () => {
    /** A fresh object per call, as a manifest read from the fold hands back. */
    const declared = () => ({
      $id: "https://example.test/greeting-tool-input",
      type: "object",
      required: ["greeting"],
      properties: { greeting: { type: "string" } },
    });

    expect(validateAgainstSchema(declared(), { greeting: "hello" })).toEqual({ ok: true });
    expect(validateAgainstSchema(declared(), { greeting: "hello again" })).toEqual({ ok: true });
    expect(validateAgainstSchema(declared(), { greeting: 5 }).ok).toBe(false);
  });
});
