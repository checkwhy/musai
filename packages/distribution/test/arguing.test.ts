import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OperationContext } from "@musai/api-core";
import { isOperationError, openWorkspace, runHandler, validateOperationOutput } from "@musai/api-core";
import { buildModule } from "@musai/devkit";
import { IndexDb } from "@musai/fold";
import { installModule } from "@musai/modules";
import {
  type ArgumentRecord,
  type ClaimRecord,
  type ClaimTypeDeclaration,
  CURRENT_SCHEMA_VERSIONS,
  claimTypesFrom,
  type EvidenceEdge,
  isKernelError,
  type KernelError,
  type PerformedRunRecord,
  type ReasonClass,
  type RecordId,
  type RulingRecord,
  type RunRecord,
  recordId,
  renderSelector,
  type SealedValue,
  STATUS_REASONS,
  slotFor,
  timestamp,
  versionString,
} from "@musai/records";
import { RUNNER_PERFORMER, secretObservation } from "@musai/run";
import { currentKey, type GitContext, initWorkspace, MUSAI_DIR, mintKeyFile, Store } from "@musai/store";
import {
  blobStoreOf,
  cachedBlobPath,
  declareClaimTypes,
  fixedClock,
  fixtureBrief,
  gatewaySource,
  installModuleRecord,
  installParserFixture,
  PARSER_FIXTURE_MODULE,
  PARSER_FIXTURE_SELECTOR,
  parserFixtureManifest,
  pseudonymOf,
} from "@musai/test-support";
import { mintAttestation } from "@musai/trust";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, onTestFinished, test } from "vitest";
import { REGISTRY } from "../src/index.js";
import { challengeFile } from "../src/ops/challenge.js";
import { claimStatus } from "../src/ops/claim.js";
import { claimWhy } from "../src/ops/why.js";

const CORE_MODULE_DIR = fileURLToPath(new URL("../../core-module", import.meta.url));

const CLAIM_TYPE = "musai.arguing-test/claim@1";
const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: CLAIM_TYPE, identityDimensions: ["id"] };
const CLAIM_TYPES = claimTypesFrom([CLAIM_DECLARATION]);
const FIXED_INSTANT = timestamp("2026-01-01T00:00:00.000Z");
const now = fixedClock(FIXED_INSTANT);

function slotOf(id: string): string {
  return slotFor(CLAIM_DECLARATION, { id });
}

function runOfKind(runKind: PerformedRunRecord["runKind"], output: string): PerformedRunRecord {
  return {
    kind: "run",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
    runKind,
    determinism: "nondeterministic",
    performer: RUNNER_PERFORMER,
    recipe: { command: [], workingDirectory: "/", environment: {}, declared: [], substrates: [], isolation: "hygiene" },
    observation: {
      resolved: [],
      isolationHeld: "hygiene",
      binaries: [],
      bindings: [],
      output,
      outputLossy: false,
      exitCode: 0,
      scrubbed: [],
      startedAt: FIXED_INSTANT,
      finishedAt: FIXED_INSTANT,
      reads: [],
      cost: {},
    },
  };
}

function edgeOn(run: RecordId, key: string): EvidenceEdge {
  return {
    run,
    selector: { module: "musai.core", parser: "exit-code", version: versionString("1"), key },
    item: recordId({ run, key }),
  };
}

function claimRecord(id: string, evidence: ClaimRecord["evidence"]): ClaimRecord {
  return {
    kind: "claim",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: CLAIM_TYPE,
    about: [],
    slot: slotOf(id),
    conditions: { id },
    canonical: { statement: id },
    rendering: id,
    evidence,
    exclusiveGroup: null,
  };
}

/** A claim type a store can write and no workspace here declares. */
const UNDECLARED_DECLARATION: ClaimTypeDeclaration = {
  type: "musai.arguing-test/undeclared@1",
  identityDimensions: ["id"],
};

function undeclaredClaimRecord(id: string, evidence: ClaimRecord["evidence"]): ClaimRecord {
  return {
    ...claimRecord(id, evidence),
    type: UNDECLARED_DECLARATION.type,
    slot: slotFor(UNDECLARED_DECLARATION, { id }),
  };
}

function argumentAgainst(target: RecordId, evidence: EvidenceEdge[], reason: string): ArgumentRecord {
  return {
    kind: "argument",
    schemaVersion: CURRENT_SCHEMA_VERSIONS.argument,
    target,
    reason,
    evidence,
    premises: [],
    supersedes: [],
  };
}

function secretRun(value: string, key: Parameters<typeof secretObservation>[0]): PerformedRunRecord {
  const base = runOfKind("run", "a run that read a secret");
  return {
    ...base,
    recipe: { ...base.recipe, declared: [{ name: "TOKEN", secret: true }] },
    observation: { ...base.observation, bindings: [secretObservation(key, "TOKEN", value)] },
  };
}

async function bindTokenTo(localDir: string, value: string): Promise<void> {
  const path = join(localDir, "bindings.json");
  await writeFile(path, JSON.stringify({ TOKEN: { value, secret: true } }), { mode: 0o600 });
  await chmod(path, 0o600);
}

/** A store whose fold declares this file's claim type, which a claim written through it needs. */
async function storeDeclaringClaimType(ctx: GitContext, scope: string): Promise<Store> {
  const store = new Store({ ctx, scope, now, claimTypes: CLAIM_TYPES });
  await declareClaimTypes(store, [CLAIM_DECLARATION]);
  return store;
}

describe("an argument attacking a claim reaches the verdict, weighed against what holds the claim up", () => {
  let workspace: string;
  let store: Store;
  const scope = "default";

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-arguing-"));
    const { gitDir } = await initWorkspace(workspace, { now });
    const ctx: GitContext = { gitDir };
    store = await storeDeclaringClaimType(ctx, scope);
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("a receipt-backed challenge against the claim itself fails a claim a receipt holds up", async () => {
    const [heldBy] = await store.putMany([
      { kind: "run", value: runOfKind("run", "the receipt holding the claim up") },
    ]);
    const [claimId] = await store.putMany([
      { kind: "claim", value: claimRecord("beaten", [edgeOn(heldBy!, "result")]) },
    ]);
    const [challengeRun] = await store.putMany([{ kind: "run", value: runOfKind("run", "a re-run disagreeing") }]);
    await store.putMany([
      { kind: "argument", value: argumentAgainst(claimId!, [edgeOn(challengeRun!, "result")], "the re-run disagrees") },
    ]);

    const output = await claimStatus.handler({ claim: slotOf("beaten") }, { workspace, scope, now });
    expect(output.label).toBe("fails");
    expect(output.comparison.winner).toContain(challengeRun!);
  });

  test("a defeated claim's derivation names what beat it below, and never itself as its own loser", async () => {
    const [heldBy] = await store.putMany([
      { kind: "run", value: runOfKind("run", "the receipt behind a walked derivation") },
    ]);
    const [claimId] = await store.putMany([
      { kind: "claim", value: claimRecord("walked", [edgeOn(heldBy!, "result")]) },
    ]);
    const [challengeRun] = await store.putMany([{ kind: "run", value: runOfKind("run", "the re-run that wins") }]);
    await store.putMany([
      { kind: "argument", value: argumentAgainst(claimId!, [edgeOn(challengeRun!, "result")], "walked") },
    ]);

    const { derivation } = await claimWhy.handler({ claim: slotOf("walked"), full: true }, { workspace, scope, now });
    const root = derivation!;
    expect(root.beat).toBeNull();
    expect(root.children[0]!.beat).toBe(slotOf("walked"));
  });

  test("a citation-backed challenge bounces off a claim a receipt holds up", async () => {
    const [heldBy] = await store.putMany([{ kind: "run", value: runOfKind("run", "the receipt holding this one up") }]);
    const [claimId] = await store.putMany([
      { kind: "claim", value: claimRecord("unmoved", [edgeOn(heldBy!, "result")]) },
    ]);
    const [citation] = await store.putMany([{ kind: "run", value: runOfKind("citation", "something someone wrote") }]);
    await store.putMany([
      {
        kind: "argument",
        value: argumentAgainst(claimId!, [edgeOn(citation!, "result")], "a citation against a receipt"),
      },
    ]);

    const output = await claimStatus.handler({ claim: slotOf("unmoved") }, { workspace, scope, now });
    expect(output.label).toBe("holds");
    expect(output.comparison.winner).toContain(heldBy!);
  });

  test("a challenge that beats the run only removes the support, leaving the claim open rather than failed", async () => {
    const [heldBy] = await store.putMany([
      { kind: "run", value: runOfKind("run", "the receipt this challenge attacks") },
    ]);
    await store.putMany([{ kind: "claim", value: claimRecord("unsupported", [edgeOn(heldBy!, "result")]) }]);
    const [challengeRun] = await store.putMany([
      { kind: "run", value: runOfKind("run", "a re-run against the run itself") },
    ]);
    await store.putMany([
      {
        kind: "argument",
        value: argumentAgainst(heldBy!, [edgeOn(challengeRun!, "result")], "the run did not show that"),
      },
    ]);

    const output = await claimStatus.handler({ claim: slotOf("unsupported") }, { workspace, scope, now });
    expect(output.label).toBe("open");
    expect(output.reason).toBe("no-evidence");
  });

  test("a claim nothing holds up is as easy to knock over as the floor of the ladder", async () => {
    const [claimId] = await store.putMany([{ kind: "claim", value: claimRecord("bare", []) }]);
    const [challengeRun] = await store.putMany([
      { kind: "run", value: runOfKind("run", "a receipt against a bare claim") },
    ]);
    await store.putMany([
      {
        kind: "argument",
        value: argumentAgainst(claimId!, [edgeOn(challengeRun!, "result")], "nothing backs this claim"),
      },
    ]);

    const output = await claimStatus.handler({ claim: slotOf("bare") }, { workspace, scope, now });
    expect(output.label).toBe("fails");
    expect(output.comparison.winner).toContain(challengeRun!);
  });

  test("an argument a later one supersedes stops attacking what it named", async () => {
    const [heldBy] = await store.putMany([
      { kind: "run", value: runOfKind("run", "the receipt behind a withdrawn challenge") },
    ]);
    const [claimId] = await store.putMany([
      { kind: "claim", value: claimRecord("withdrawn", [edgeOn(heldBy!, "result")]) },
    ]);
    const [challengeRun] = await store.putMany([{ kind: "run", value: runOfKind("run", "a re-run later withdrawn") }]);
    const [firstArgument] = await store.putMany([
      {
        kind: "argument",
        value: argumentAgainst(claimId!, [edgeOn(challengeRun!, "result")], "filed, then withdrawn"),
      },
    ]);
    await store.putMany([
      {
        kind: "argument",
        value: { ...argumentAgainst(claimId!, [], "withdrawing the challenge above"), supersedes: [firstArgument!] },
      },
    ]);

    const output = await claimStatus.handler({ claim: slotOf("withdrawn") }, { workspace, scope, now });
    expect(output.label).toBe("holds");
  });
});

describe("a claim whose type the workspace does not declare applies nowhere, whatever holds it up", () => {
  let workspace: string;
  let store: Store;
  let undeclaredStore: Store;
  const scope = "default";

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-inapplicable-"));
    const { gitDir } = await initWorkspace(workspace, { now });
    store = await storeDeclaringClaimType({ gitDir }, scope);
    // The fold never heard of the second type: the store admits the write, the workspace does not.
    undeclaredStore = new Store({
      ctx: { gitDir },
      scope,
      now,
      claimTypes: claimTypesFrom([CLAIM_DECLARATION, UNDECLARED_DECLARATION]),
    });
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("a claim of a declared type naming no rule holds on its receipt, with nothing said about applying", async () => {
    const [heldBy] = await store.putMany([
      { kind: "run", value: runOfKind("run", "the receipt a declared claim rests on") },
    ]);
    await store.putMany([{ kind: "claim", value: claimRecord("declared", [edgeOn(heldBy!, "result")]) }]);

    const output = await claimStatus.handler({ claim: slotOf("declared") }, { workspace, scope, now });
    expect(output.label).toBe("holds");
    expect(output.reason).toBeNull();
    expect(output.comparison.winner).toContain(heldBy!);
    expect(output.detail).toBeUndefined();
  });

  test("a claim of an undeclared type reads open and inapplicable on a receipt that would hold it, and its derivation names the type rather than walking the receipt", async () => {
    const [heldBy] = await store.putMany([
      { kind: "run", value: runOfKind("run", "the receipt an undeclared claim rests on") },
    ]);
    await undeclaredStore.putMany([
      { kind: "claim", value: undeclaredClaimRecord("undeclared", [edgeOn(heldBy!, "result")]) },
    ]);
    const slot = slotFor(UNDECLARED_DECLARATION, { id: "undeclared" });

    const status = await claimStatus.handler({ claim: slot }, { workspace, scope, now });
    expect(status.label).toBe("open");
    expect(status.reason).toBe("inapplicable");
    expect(status.detail).toContain(UNDECLARED_DECLARATION.type);

    // The receipt would decide the claim if it applied; the derivation gives the gate's reason.
    const derivation = await claimWhy.handler({ claim: slot }, { workspace, scope, now });
    expect(derivation).toMatchObject({ reason: "inapplicable", via: status.comparison.via, detail: status.detail });
    expect(derivation.detail).toContain(UNDECLARED_DECLARATION.type);
  });

  test("a claim of an undeclared type with nothing to walk says why it reads open in its derivation", async () => {
    await undeclaredStore.putMany([{ kind: "claim", value: undeclaredClaimRecord("undeclared-bare", []) }]);
    const slot = slotFor(UNDECLARED_DECLARATION, { id: "undeclared-bare" });

    const derivation = await claimWhy.handler({ claim: slot }, { workspace, scope, now });
    expect(derivation).toMatchObject({ reason: "inapplicable" });
    expect(derivation.detail).toContain(UNDECLARED_DECLARATION.type);
  });

  test("a ruling nothing vouches for leaves a claim that does not apply inapplicable, not contested", async () => {
    const [heldBy] = await store.putMany([
      { kind: "run", value: runOfKind("run", "the receipt under an unvouched ruling") },
    ]);
    const [claimId] = await undeclaredStore.putMany([
      { kind: "claim", value: undeclaredClaimRecord("unvouched", [edgeOn(heldBy!, "result")]) },
    ]);
    const unvouched: RulingRecord = {
      kind: "ruling",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.ruling,
      over: { claim: claimId! },
      verdict: "holds",
      reason: "committed by a peer, signed by nobody",
      brief: recordId({ marker: "an unvouched ruling's brief" }),
    };
    await store.putMany([{ kind: "ruling", value: unvouched }]);

    const status = await claimStatus.handler(
      { claim: slotFor(UNDECLARED_DECLARATION, { id: "unvouched" }) },
      { workspace, scope, now },
    );
    expect(status.label).toBe("open");
    expect(status.reason).toBe("inapplicable");
    expect(status.detail).toContain(UNDECLARED_DECLARATION.type);
  });
});

describe("challenge.file@2, the verb that puts an argument into the graph", () => {
  let workspace: string;
  let store: Store;
  const scope = "default";

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-challenge-"));
    const { gitDir } = await initWorkspace(workspace, { now });
    store = await storeDeclaringClaimType({ gitDir }, scope);
    const { stdout } = await execa("git", ["rev-parse", "--absolute-git-dir"], { cwd: CORE_MODULE_DIR });
    const index = new IndexDb(":memory:");
    await index.fold(store);
    await buildModule(CORE_MODULE_DIR, store, {
      blobs: blobStoreOf(workspace),
      index,
      sourceGitDir: stdout.trim(),
      now: fixedClock("2026-08-30T00:00:00.000Z"),
    });
  }, 120_000);

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  function ctx(): OperationContext {
    return { workspace, scope, now: fixedClock("2026-08-30T00:00:00.000Z") };
  }

  test("a filed challenge mints an argument and its attestation, and the claim it names stops holding", async () => {
    const [heldBy] = await store.putMany([
      { kind: "run", value: runOfKind("run", "the receipt a challenge will beat") },
    ]);
    await store.putMany([{ kind: "claim", value: claimRecord("filed-against", [edgeOn(heldBy!, "result")]) }]);
    const [challengeRun] = await store.putMany([
      { kind: "run", value: runOfKind("run", "the challenge's own re-run") },
    ]);

    const before = await claimStatus.handler({ claim: slotOf("filed-against") }, ctx());
    expect(before.label).toBe("holds");

    const filedOutput = await runHandler(
      challengeFile,
      {
        target: slotOf("filed-against"),
        reason: "the re-run does not show what the first one did",
        run: challengeRun!,
        selector: "musai.core/exit-code@1:exitCode",
      },
      { ...ctx(), via: "tty", principalName: "someone" },
    );
    expect(filedOutput.minted.map((item) => item.kind)).toEqual(["argument", "attestation"]);

    const after = await claimStatus.handler({ claim: slotOf("filed-against") }, ctx());
    expect(after.label).toBe("fails");
    expect(after.comparison.winner).toContain(challengeRun!);
  });

  test("a challenge filed with a salt mints a salted argument, and its attestation names the salted id", async () => {
    const [heldBy] = await store.putMany([{ kind: "run", value: runOfKind("run", "the receipt a salt attacks") }]);
    await store.putMany([{ kind: "claim", value: claimRecord("salted-against", [edgeOn(heldBy!, "result")]) }]);
    const [challengeRun] = await store.putMany([{ kind: "run", value: runOfKind("run", "the salted re-run") }]);
    const input = {
      target: slotOf("salted-against"),
      reason: "the re-run does not show what the first one did",
      run: challengeRun!,
      selector: "musai.core/exit-code@1:exitCode",
    };
    const context = { ...ctx(), via: "tty", principalName: "someone" } as const;

    const planned = await runHandler(challengeFile, { ...input, salt: true }, { ...context, mode: "plan" });
    const filed = await runHandler(challengeFile, { ...input, salt: true }, context);
    const [argument, attestation] = filed.minted;
    expect(filed.minted.map((item) => item.id)).toEqual(planned.minted.map((item) => item.id));
    expect(argument!.record).toMatchObject({ kind: "argument", salt: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const { salt: _salt, ...unsalted } = argument!.record as Record<string, unknown>;
    expect(argument!.id).not.toBe(recordId(unsalted));
    expect(attestation!.record).toMatchObject({ subject: argument!.id });
  });

  test("a challenge citing a selector key the parser does not produce is refused before anything is minted", async () => {
    const [heldBy] = await store.putMany([
      { kind: "run", value: runOfKind("run", "the receipt behind an unadmitted challenge") },
    ]);
    await store.putMany([{ kind: "claim", value: claimRecord("unadmitted", [edgeOn(heldBy!, "result")]) }]);
    const [challengeRun] = await store.putMany([
      { kind: "run", value: runOfKind("run", "a run whose parser answers no such key") },
    ]);

    const error = await runHandler(
      challengeFile,
      {
        target: slotOf("unadmitted"),
        reason: "cites a key that does not exist",
        run: challengeRun!,
        selector: "musai.core/exit-code@1:no-such-key",
      },
      { ...ctx(), via: "tty", principalName: "someone" },
    ).catch((caught: unknown) => caught);

    expect(isOperationError(error)).toBe(true);
    expect((error as { reason: string }).reason).toBe("invalid-input");
    expect((await claimStatus.handler({ claim: slotOf("unadmitted") }, ctx())).label).toBe("holds");
  });

  test("a challenge resting on a brief is refused, since a brief is what a decider was shown and not evidence", async () => {
    const [heldBy] = await store.putMany([
      { kind: "run", value: runOfKind("run", "the receipt behind a brief-backed challenge") },
    ]);
    await store.putMany([{ kind: "claim", value: claimRecord("brief-backed", [edgeOn(heldBy!, "result")]) }]);
    const [briefRun] = await store.putMany([{ kind: "run", value: fixtureBrief("a brief, not evidence") }]);

    const error = await runHandler(
      challengeFile,
      {
        target: slotOf("brief-backed"),
        reason: "rests on a brief",
        run: briefRun!,
        selector: "musai.core/exit-code@1:exitCode",
      },
      { ...ctx(), via: "tty", principalName: "someone" },
    ).catch((caught: unknown) => caught);

    expect(isOperationError(error)).toBe(true);
    expect((error as { reason: string }).reason).toBe("invalid-input");
    expect((error as { detail: string }).detail).toContain("brief");
  });
});

describe("challenge.file refuses an edge under the reason the kernel met it with, relabelling only a selector's refusal", () => {
  const scope = "default";

  async function freshWorkspace(): Promise<string> {
    const workspace = await mkdtemp(join(tmpdir(), "musai-challenge-refusal-"));
    onTestFinished(() => rm(workspace, { recursive: true, force: true }));
    await initWorkspace(workspace, { now });
    return workspace;
  }

  function storeOf(workspace: string): Store {
    return new Store({ ctx: { gitDir: join(workspace, MUSAI_DIR) }, scope, now });
  }

  async function storedRun(workspace: string, run: RunRecord): Promise<RecordId> {
    const [id] = await storeOf(workspace).putMany([{ kind: "run", value: run }]);
    return id!;
  }

  async function challengeRefusal(
    workspace: string,
    run: RecordId,
    selector: string = renderSelector(PARSER_FIXTURE_SELECTOR),
  ): Promise<KernelError> {
    const error = await runHandler(
      challengeFile,
      { target: run, reason: "the run does not say what it is cited for", run, selector },
      { workspace, scope, now, via: "tty", principalName: "someone" },
    ).catch((caught: unknown) => caught);
    expect(isKernelError(error)).toBe(true);
    return error as KernelError;
  }

  test("a selector naming a key its parser does not produce refuses invalid-input, naming the selector and the run", async () => {
    const workspace = await freshWorkspace();
    await installParserFixture(workspace, scope, now);
    const run = await storedRun(workspace, runOfKind("run", "a run cited for a key no parser produces"));
    const selector = renderSelector({ ...PARSER_FIXTURE_SELECTOR, key: "no-such-key" });

    expect(await challengeRefusal(workspace, run, selector)).toMatchObject({
      reason: "invalid-input",
      code: "invocation",
      about: [selector, run],
    });
  });

  test("a selector naming a module installed with no bundle refuses workspace-incomplete, naming the module", async () => {
    const workspace = await freshWorkspace();
    await installModuleRecord(workspace, scope, PARSER_FIXTURE_MODULE, parserFixtureManifest().contributions, now);
    const run = await storedRun(workspace, runOfKind("run", "a run cited through a module nothing can load"));

    expect(await challengeRefusal(workspace, run)).toMatchObject({
      reason: "workspace-incomplete",
      code: "workspace",
      about: [PARSER_FIXTURE_MODULE],
    });
  });

  test("a run whose output is sealed refuses unsupported-format, naming the sealed output", async () => {
    const workspace = await freshWorkspace();
    await installParserFixture(workspace, scope, now);
    const readable = runOfKind("run", "");
    const sealedOutput: SealedValue = {
      $sealed: {
        alg: "aes-256-gcm",
        keyId: "a-key-this-workspace-never-held",
        ciphertext: "bm90LXRleHQtYW55Ym9keS1tZWFudC10by1yZWFk",
        digest: "b".repeat(64),
      },
    };
    const run = await storedRun(workspace, {
      ...readable,
      observation: { ...readable.observation, output: sealedOutput },
    });

    expect(await challengeRefusal(workspace, run)).toMatchObject({
      reason: "unsupported-format",
      code: "invocation",
      about: ["a run's output"],
    });
  });

  test("a parser whose bundle the rule scan refuses refuses invalid-input, naming the bundle's path", async () => {
    const workspace = await freshWorkspace();
    const store = storeOf(workspace);
    const index = new IndexDb(":memory:");
    await index.fold(store);
    const blobs = blobStoreOf(workspace);
    const { bundleId } = await installModule(
      PARSER_FIXTURE_MODULE,
      versionString("1.0.0"),
      parserFixtureManifest(),
      new TextEncoder().encode(
        gatewaySource(
          "invoke",
          "      return { exitCode: input.exitCode };",
          'import { readFileSync } from "node:fs";',
        ),
      ),
      recordId({ marker: `build-for-${PARSER_FIXTURE_MODULE}` }),
      store,
      blobs,
      index,
    );
    const run = await storedRun(workspace, runOfKind("run", "a run cited through a bundle the scan refuses"));

    expect(await challengeRefusal(workspace, run)).toMatchObject({
      reason: "invalid-input",
      code: "invocation",
      about: [cachedBlobPath(workspace, bundleId)],
    });
  });

  test("a challenge over a scope whose ref moved back past its fold is refused as a corrupted history", async () => {
    const workspace = await freshWorkspace();
    await installParserFixture(workspace, scope, now);
    const withoutTheRun = await storeOf(workspace).tip();
    const run = await storedRun(workspace, runOfKind("run", "a run the scope's ref is moved back past"));
    await openWorkspace({ workspace, scope, now });
    await execa("git", [
      "--git-dir",
      join(workspace, MUSAI_DIR),
      "update-ref",
      `refs/heads/scope/${scope}`,
      withoutTheRun!,
    ]);

    expect(await challengeRefusal(workspace, run)).toMatchObject({
      reason: "record-corrupted",
      code: "workspace",
    });
  });
});

describe("a claim rests on the secrets its evidence read, and stops resting where one moved", () => {
  let workspace: string;
  let store: Store;
  let localDir: string;
  const scope = "default";

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-secret-stale-"));
    const { gitDir, localDir: local } = await initWorkspace(workspace, { now });
    localDir = local;
    store = await storeDeclaringClaimType({ gitDir }, scope);
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("the claim holds while the secret still binds to what the run read, and reads stale once it is rotated", async () => {
    const key = currentKey(await mintKeyFile(localDir, { now }));
    await bindTokenTo(localDir, "first");

    const [runId] = await store.putMany([{ kind: "run", value: secretRun("first", key) }]);
    await store.putMany([{ kind: "claim", value: claimRecord("secret-backed", [edgeOn(runId!, "result")]) }]);

    const unmoved = await claimStatus.handler({ claim: slotOf("secret-backed") }, { workspace, scope, now });
    expect(unmoved.label).toBe("holds");

    await bindTokenTo(localDir, "second");

    const rotated = await claimStatus.handler({ claim: slotOf("secret-backed") }, { workspace, scope, now });
    expect(rotated.label).toBe("open");
    expect(rotated.reason).toBe("stale");
  });

  test("a claim whose evidence bound no secret is untouched by the bindings file", async () => {
    const [runId] = await store.putMany([{ kind: "run", value: runOfKind("run", "a run that read nothing secret") }]);
    await store.putMany([{ kind: "claim", value: claimRecord("no-secret", [edgeOn(runId!, "result")]) }]);

    const output = await claimStatus.handler({ claim: slotOf("no-secret") }, { workspace, scope, now });
    expect(output.label).toBe("holds");
  });
});

describe("why names every open reason as status names it, and walks no derivation from an open claim", () => {
  let workspace: string;
  let store: Store;
  let undeclaredStore: Store;
  let localDir: string;
  const scope = "default";
  const context = () => ({ workspace, scope, now });

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-why-reasons-"));
    const { gitDir, localDir: local } = await initWorkspace(workspace, { now });
    localDir = local;
    store = await storeDeclaringClaimType({ gitDir }, scope);
    undeclaredStore = new Store({
      ctx: { gitDir },
      scope,
      now,
      claimTypes: claimTypesFrom([CLAIM_DECLARATION, UNDECLARED_DECLARATION]),
    });
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  async function heldClaim(id: string): Promise<{ claimId: RecordId; runId: RecordId }> {
    const [runId] = await store.putMany([{ kind: "run", value: runOfKind("run", `the receipt under ${id}`) }]);
    const [claimId] = await store.putMany([{ kind: "claim", value: claimRecord(id, [edgeOn(runId!, "result")]) }]);
    return { claimId: claimId!, runId: runId! };
  }

  async function rule(claimId: RecordId, verdict: "holds" | "fails", principal: string | null): Promise<RecordId> {
    const [brief] = await store.putMany([{ kind: "run", value: fixtureBrief(`a brief for ${principal}`) }]);
    const ruling: RulingRecord = {
      kind: "ruling",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.ruling,
      over: { claim: claimId },
      verdict,
      reason: `${principal} says ${verdict}`,
      brief: brief!,
    };
    const [rulingId] = await store.putMany([{ kind: "ruling", value: ruling }]);
    if (principal !== null) {
      const attestation = mintAttestation({
        subject: rulingId!,
        principal: pseudonymOf(principal),
        principalClass: "person",
        via: "tty",
        purpose: "made",
        at: now(),
      });
      await store.putMany([{ kind: "attestation", value: attestation.record }]);
    }
    return rulingId!;
  }

  /** A claim open for each reason; `null` where no musai claim is weighed against a budget. */
  const OPEN_FOR: Record<ReasonClass, (() => Promise<string>) | null> = {
    cycle: async () => {
      const { runId } = await heldClaim("cycle");
      const edge = edgeOn(runId, "result");
      await store.putMany([{ kind: "argument", value: argumentAgainst(runId, [edge], "it attacks itself") }]);
      return slotOf("cycle");
    },
    "no-evidence": async () => {
      await store.putMany([{ kind: "claim", value: claimRecord("no-evidence", []) }]);
      return slotOf("no-evidence");
    },
    "contested-authority": async () => {
      const { claimId } = await heldClaim("contested-authority");
      await rule(claimId, "holds", "alice@example.com");
      await rule(claimId, "fails", "bob@example.com");
      return slotOf("contested-authority");
    },
    "over-budget": null,
    stale: async () => {
      const key = currentKey(await mintKeyFile(localDir, { now }));
      await bindTokenTo(localDir, "first");
      const [runId] = await store.putMany([{ kind: "run", value: secretRun("first", key) }]);
      await store.putMany([{ kind: "claim", value: claimRecord("stale", [edgeOn(runId!, "result")]) }]);
      await bindTokenTo(localDir, "second");
      return slotOf("stale");
    },
    inapplicable: async () => {
      const [runId] = await store.putMany([{ kind: "run", value: runOfKind("run", "the inapplicable receipt") }]);
      const claim = undeclaredClaimRecord("inapplicable", [edgeOn(runId!, "result")]);
      await undeclaredStore.putMany([{ kind: "claim", value: claim }]);
      return claim.slot;
    },
  };

  test.each(STATUS_REASONS.filter((reason) => OPEN_FOR[reason] !== null))(
    "why names %s where status does, in its output and on its first line, with no derivation",
    async (reason) => {
      const slot = await OPEN_FOR[reason]!();

      const status = await runHandler(claimStatus, { claim: slot }, context());
      const why = await runHandler(claimWhy, { claim: slot, full: true }, context());

      expect(status).toMatchObject({ label: "open", reason });
      expect(why).toMatchObject({ label: "open", reason });
      expect(claimStatus.renderText!(status)).toContain(`open · ${status.short} — ${reason}`);
      expect(claimWhy.renderText!(why).split("\n")[0]).toContain(`open (${reason}) · `);
      expect(why.derivation).toBeUndefined();
    },
  );

  test("a claim contested by rulings of equal authority names both rulings and no winner, never reading as decided", async () => {
    const { claimId, runId } = await heldClaim("tied");
    const holding = await rule(claimId, "holds", "carol@example.com");
    const failing = await rule(claimId, "fails", "dave@example.com");

    const why = await runHandler(claimWhy, { claim: slotOf("tied"), full: true }, context());
    const lines = claimWhy.renderText!(why).split("\n");

    expect(why).toMatchObject({ label: "open", reason: "contested-authority" });
    expect(why.derivation).toBeUndefined();
    expect(why.rulings).toEqual(
      expect.arrayContaining([
        {
          id: holding,
          verdict: "holds",
          authority: "person",
          principals: [pseudonymOf("carol@example.com")],
          names: [pseudonymOf("carol@example.com")],
        },
        {
          id: failing,
          verdict: "fails",
          authority: "person",
          principals: [pseudonymOf("dave@example.com")],
          names: [pseudonymOf("dave@example.com")],
        },
      ]),
    );
    expect(lines[0]).toMatch(/^◌ open \(contested-authority\) · tied /);
    expect(lines).toContain(
      `  ruling ${holding.slice(7, 19)} · holds, person ruling by ${pseudonymOf("carol@example.com")}`,
    );
    expect(lines).toContain(
      `  ruling ${failing.slice(7, 19)} · fails, person ruling by ${pseudonymOf("dave@example.com")}`,
    );
    expect(lines.some((line) => line.includes("decided by"))).toBe(false);
    expect(why.runs.map((run) => run.id)).toEqual([runId]);
  });

  test("a ruling nothing vouches for over a holding receipt reads contested, never as the receipt deciding", async () => {
    const { claimId } = await heldClaim("unvouched");
    const held = await runHandler(claimWhy, { claim: slotOf("unvouched"), full: true }, context());
    const unvouched = await rule(claimId, "fails", null);

    const why = await runHandler(claimWhy, { claim: slotOf("unvouched"), full: true }, context());
    const text = claimWhy.renderText!(why);

    expect(held).toMatchObject({ label: "holds" });
    expect(held.derivation).toBeDefined();
    expect(why).toMatchObject({ label: "open", reason: "contested-authority" });
    expect(why.derivation).toBeUndefined();
    expect(why.rulings).toEqual([
      { id: unvouched, verdict: "fails", authority: "contested-authority", principals: [], names: [] },
    ]);
    expect(text.split("\n")[0]).toMatch(/^◌ open \(contested-authority\) · unvouched /);
    expect(text).toContain(`  ruling ${unvouched.slice(7, 19)} · fails, contested-authority ruling attested by nobody`);
    expect(text).not.toContain("decided by");
  });

  test("why's answer is held to its closed output schema, which refuses a stray field at any hop", async () => {
    const { claimId } = await heldClaim("closed");
    const held = await runHandler(claimWhy, { claim: slotOf("closed"), full: true }, context());
    await rule(claimId, "fails", "erin@example.com");
    await rule(claimId, "holds", "frank@example.com");
    const contested = await runHandler(claimWhy, { claim: slotOf("closed"), full: true }, context());
    const derivation = held.derivation!;
    const [run] = held.runs;
    const [ruling] = contested.rulings!;

    expect(REGISTRY.get("claim.why@3")).toBe(claimWhy);
    expect(derivation.children.length).toBeGreaterThan(0);
    for (const output of [held, contested]) {
      expect(validateOperationOutput(claimWhy, output)).toEqual({ ok: true });
    }
    for (const stray of [
      { ...held, stray: 1 },
      { ...held, runs: [{ ...run!, stray: 1 }] },
      { ...held, derivation: { ...derivation, stray: 1 } },
      { ...held, derivation: { ...derivation, children: [{ ...derivation.children[0]!, stray: 1 }] } },
      { ...contested, rulings: [{ ...ruling!, stray: 1 }] },
    ]) {
      expect(validateOperationOutput(claimWhy, stray)).toMatchObject({ ok: false });
    }
  });
});
