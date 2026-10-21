import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { OperationDescriptor } from "@musai/api-core";
import { openWorkspace, runHandler } from "@musai/api-core";
import type { ModuleArtefacts } from "@musai/devkit";
import { IndexDb } from "@musai/fold";
import {
  type Audience,
  type CaseRecord,
  type ClaimRecord,
  type ClaimTypeDeclaration,
  CURRENT_SCHEMA_VERSIONS,
  canonicalBytes,
  claimTypesFrom,
  type RecordId,
  type RecordKind,
  recordId,
  slotFor,
  versionString,
} from "@musai/records";
import { type GitContext, initWorkspace, LOCAL_DIR, rotateKey, Store } from "@musai/store";
import { blobStoreOf, declareClaimTypes, fixedClock, receiptIds, writeTrustFile } from "@musai/test-support";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { installDistributionModule, readDistributionArtefacts } from "../src/distribution.js";
import { REGISTRY } from "../src/index.js";
import type { CaseBookInput, CaseBookOutput } from "../src/ops/case.js";
import { caseStatus } from "../src/ops/case-status.js";
import { claimStatus } from "../src/ops/claim.js";
import { type PendingRecord, pendingFor } from "../src/pending.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const opLogDir = join(here, "fixtures", "op-log");
const now = fixedClock("2026-01-01T00:00:00.000Z");

describe("pendingFor", () => {
  test("builds a pending record naming what is being asked and which operation would answer it", () => {
    const pending: PendingRecord = pendingFor("gate.disposition", "gate.answer@2", {
      gate: `sha256:${"a".repeat(64)}`,
    });
    expect(pending.asking).toBe("gate.disposition");
    expect(pending.answeredBy).toBe("gate.answer@2");
    expect(pending.input).toEqual({ gate: `sha256:${"a".repeat(64)}` });
  });

  test("no exported operation signature accepts a function parameter: every decision is a returned PendingRecord", () => {
    for (const descriptor of REGISTRY.values()) {
      expect(typeof descriptor.handler).toBe("function");
      // `handler` is the descriptor's one function, and no input it validates carries one.
      expect(descriptor.input).not.toHaveProperty("callback");
    }
  });
});

describe("case.book@1 in plan mode", () => {
  let workspace: string;
  let artefacts: ModuleArtefacts;
  const scope = "default";

  beforeAll(async () => {
    artefacts = await readDistributionArtefacts();
  });

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-plan-mode-"));
    await initWorkspace(workspace, { now });
    const store = storeAt();
    const index = new IndexDb(":memory:");
    await index.fold(store);
    await installDistributionModule(artefacts, store, blobStoreOf(workspace), index);
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  function storeAt(): Store {
    return new Store({ ctx: { gitDir: join(workspace, ".musai") }, scope, now });
  }

  const caseBook = REGISTRY.get("case.book@1")! as OperationDescriptor<CaseBookInput, CaseBookOutput>;

  test("returns the same minted shape performing would, and leaves the tip unchanged", async () => {
    const before = await storeAt().tip();
    const planned = await runHandler(
      caseBook,
      { slug: "plan-case", about: ["urn:example:one"] },
      {
        workspace,
        scope,
        now,
        mode: "plan",
      },
    );
    const after = await storeAt().tip();

    expect(after).toBe(before);
    expect(planned.minted.length).toBeGreaterThan(0);
    for (const item of planned.minted) {
      expect(item).toHaveProperty("id");
      expect(item).toHaveProperty("kind");
      expect(item).toHaveProperty("record");
    }
  });

  test("case.book performs no run in either mode: the run list and the tip hold after a plan-mode call, and the run list after the performing call", async () => {
    const store = storeAt();
    const input = { slug: "plan-case-runs", about: ["urn:example:two"] };
    const runs = await store.list("run");
    const tip = await store.tip();

    await runHandler(caseBook, input, { workspace, scope, mode: "plan", now });
    expect(await store.list("run")).toEqual(runs);
    expect(await store.tip()).toBe(tip);

    await runHandler(caseBook, input, { workspace, scope, mode: "perform", now });
    expect(await store.tip()).not.toBe(tip);
    expect(await store.list("run")).toEqual(runs);
  });

  test("mints the same ids the following performing call then mints, at the same head", async () => {
    const input = { slug: "plan-then-perform", about: ["urn:example:three"] };
    const planned = await runHandler(caseBook, input, { workspace, scope, mode: "plan", now });
    const performed = await runHandler(caseBook, input, { workspace, scope, mode: "perform", now });

    expect(performed.minted.map((item) => item.id)).toEqual(planned.minted.map((item) => item.id));
    expect(performed.case).toBe(planned.case);
  });

  test("a salted booking mints the ids its plan showed, its case citing its salted claims", async () => {
    const input = { slug: "salted-booking", about: ["urn:example:four", "urn:example:five"], salt: true };
    const planned = await runHandler(caseBook, input, { workspace, scope, mode: "plan", now });
    const performed = await runHandler(caseBook, input, { workspace, scope, mode: "perform", now });
    expect(performed.minted.map((item) => item.id)).toEqual(planned.minted.map((item) => item.id));

    const [booked, ...claims] = performed.minted;
    for (const item of performed.minted) {
      const { salt, ...unsalted } = item.record as Record<string, unknown>;
      expect(salt).toMatch(/^[0-9a-f]{64}$/);
      expect(item.id).not.toBe(recordId(unsalted));
    }
    expect((booked!.record as CaseRecord).claims).toEqual(claims.map((item) => item.id));

    await expect(
      runHandler(caseBook, { ...input, salt: false }, { workspace, scope, mode: "plan", now }),
    ).rejects.toThrow(/already holds that slug, booked salted/);
  });

  test("booking a salted case again with a salt after the key rotated is refused, naming the key", async () => {
    const input = { slug: "salted-then-rotated", about: ["urn:example:nine"], salt: true };
    await runHandler(caseBook, input, { workspace, scope, mode: "perform", now });
    await rotateKey(join(workspace, ".musai", LOCAL_DIR), { now });

    await expect(runHandler(caseBook, input, { workspace, scope, mode: "plan", now })).rejects.toThrow(
      /already holds that slug, booked salted under another key/,
    );
  });

  test("booking an unsalted case again with a salt is refused, naming that it was booked unsalted", async () => {
    const input = { slug: "unsalted-then-salted", about: ["urn:example:eight"] };
    await runHandler(caseBook, input, { workspace, scope, mode: "perform", now });

    await expect(
      runHandler(caseBook, { ...input, salt: true }, { workspace, scope, mode: "plan", now }),
    ).rejects.toThrow(/already holds that slug, booked unsalted/);
  });

  test("a station's salted booking mints other claim ids than the author's, which its clearance mints again", async () => {
    await writeTrustFile({ gitDir: join(workspace, ".musai") }, "audiences", "writer\n");
    const input = { slug: "station-booking", about: ["urn:example:seven"], salt: true };
    const station = { workspace, scope, now, clearance: "writer" as Audience };
    const claimIds = (output: CaseBookOutput) =>
      output.minted.filter((item) => item.kind === "claim").map((item) => item.id);

    const authors = claimIds(await runHandler(caseBook, input, { workspace, scope, mode: "plan", now }));
    const planned = claimIds(await runHandler(caseBook, input, { ...station, mode: "plan" }));
    const performed = claimIds(await runHandler(caseBook, input, { ...station, mode: "perform" }));

    expect(planned).toHaveLength(authors.length);
    expect(planned.filter((id) => authors.includes(id))).toEqual([]);
    expect(performed).toEqual(planned);
  });

  test("booking a salted case again with the same salt answers the case it holds", async () => {
    const input = { slug: "salted-again", about: ["urn:example:six"], salt: true };
    const first = await runHandler(caseBook, input, { workspace, scope, mode: "perform", now });
    const tip = await storeAt().tip();
    const again = await runHandler(caseBook, input, { workspace, scope, mode: "perform", now });
    expect(again.case).toBe(first.case);
    expect(await storeAt().tip()).toBe(tip);
  });
});

describe("a verb about one named claim or case, in plan mode", () => {
  const scope = "default";
  const declaration: ClaimTypeDeclaration = { type: "musai.plan-mode-test/claim@1", identityDimensions: ["id"] };
  let workspace: string;
  let store: Store;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-plan-mode-check-"));
    await initWorkspace(workspace, { now });
    store = new Store({
      ctx: { gitDir: join(workspace, ".musai") },
      scope,
      now,
      claimTypes: claimTypesFrom([declaration]),
    });
    await declareClaimTypes(store, [declaration]);
    const index = new IndexDb(":memory:");
    await index.fold(store);
    await installDistributionModule(await readDistributionArtefacts(), store, blobStoreOf(workspace), index);
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  /** Puts a claim whose one check, a clean-exit recipe, has never been performed. */
  async function unperformedCheck(id: string): Promise<{ slot: string; claim: RecordId }> {
    const slot = slotFor(declaration, { id });
    const parameters = JSON.stringify({
      recipes: [
        {
          name: "r",
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
      expectations: [{ kind: "exitCodeIs", recipe: "r", value: 0 }],
    });
    const claim: ClaimRecord = {
      kind: "claim",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
      type: declaration.type,
      about: [],
      slot,
      conditions: { id, "musai.core/declarative": parameters },
      canonical: { statement: id },
      rendering: id,
      evidence: [],
      exclusiveGroup: null,
    };
    const [claimId] = await store.putMany([{ kind: "claim", value: claim }]);
    return { slot, claim: claimId! };
  }

  test("claim.status mints no run receipt and moves no head, where the same call performing mints one", async () => {
    const { slot } = await unperformedCheck("planned-claim");
    const runs = await store.list("run");
    const receipts = await receiptIds(store);
    const tip = await store.tip();

    await runHandler(claimStatus, { claim: slot }, { workspace, scope, now, mode: "plan" });
    expect(await store.list("run")).toEqual(runs);
    expect(await store.tip()).toBe(tip);

    await runHandler(claimStatus, { claim: slot }, { workspace, scope, now, mode: "perform" });
    expect(await receiptIds(store)).toHaveLength(receipts.length + 1);
    expect(await store.tip()).not.toBe(tip);
  }, 60_000);

  test("case.status over a case citing an unperformed check mints no run receipt and moves no head, where performing mints one", async () => {
    const { claim } = await unperformedCheck("planned-case-claim");
    const opened = await openWorkspace({ workspace, scope, now });
    const caseRecord: CaseRecord = {
      kind: "case",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.case,
      type: null,
      slug: "a-planned-case",
      claims: [claim],
      preset: {
        module: "musai.core",
        contribution: "musai.core/bare",
        moduleRecord: recordId({ marker: "the module record a preset names, never installed here" }),
      },
      projectCommit: opened.matrix.commit,
      overrides: {},
      evaluatorVersion: versionString("1"),
    };
    await store.putMany([{ kind: "case", value: caseRecord }]);
    const runs = await store.list("run");
    const receipts = await receiptIds(store);
    const tip = await store.tip();

    await runHandler(caseStatus, { case: "a-planned-case" }, { workspace, scope, now, mode: "plan" });
    expect(await store.list("run")).toEqual(runs);
    expect(await store.tip()).toBe(tip);

    await runHandler(caseStatus, { case: "a-planned-case" }, { workspace, scope, now, mode: "perform" });
    expect(await receiptIds(store)).toHaveLength(receipts.length + 1);
    expect(await store.tip()).not.toBe(tip);
  }, 60_000);
});

describe("a verb that drives a kernel primitive, in plan mode", () => {
  const scope = "default";
  const OUTSIDE_THE_STORE = [
    "bundle.export@2",
    "case.open@1",
    "check.run@1",
    "hook.stop@1",
    "key.rotate@1",
    "module.build@1",
    "module.new@1",
    "module.test@1",
    "plugin.sync@1",
    "workspace.init@1",
  ];
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-plan-mode-tooling-"));
    await initWorkspace(workspace, { now });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  /** Input each verb's schema accepts, so only the mode refuses the call. */
  function validInput(key: string): Record<string, unknown> {
    switch (key) {
      case "case.open@1":
        return { case: "some-case" };
      case "check.run@1":
        return { statement: "a sentence", command: ["node"] };
      case "hook.stop@1":
        return { hook: { transcript_path: join(workspace, "transcript.jsonl") } };
      case "workspace.init@1":
        return { workspace: join(workspace, "fresh") };
      case "bundle.export@2":
        return { id: `sha256:${"0".repeat(64)}`, to: "public", out: join(workspace, "bundle.tar.gz") };
      case "module.build@1":
      case "module.new@1":
      case "module.test@1":
        return { dir: join(workspace, "module") };
      default:
        return {};
    }
  }

  test("those that declare they cannot plan are exactly the verbs writing outside the store", () => {
    const refusing = [...REGISTRY.entries()].filter(([, descriptor]) => !descriptor.plans).map(([key]) => key);
    expect(refusing.sort()).toEqual(OUTSIDE_THE_STORE);
  });

  test.each(OUTSIDE_THE_STORE)("%s is refused invalid-input by name, and the workspace is untouched", async (key) => {
    const store = new Store({ ctx: { gitDir: join(workspace, ".musai") }, scope, now });
    const tip = await store.tip();
    const input = validInput(key);

    await expect(runHandler(REGISTRY.get(key)!, input, { workspace, scope, now, mode: "plan" })).rejects.toMatchObject({
      reason: "invalid-input",
      about: [key],
    });

    expect(await store.tip()).toBe(tip);
    if (key === "workspace.init@1") {
      await expect(access(input["workspace"] as string)).rejects.toThrow();
    }
    if (key === "bundle.export@2") {
      await expect(access(input["out"] as string)).rejects.toThrow();
    }
  });
});

/** One line of the recorded op-log's request file. */
interface RecordedRequest {
  readonly operation: string;
  readonly version: string;
  readonly input: Record<string, unknown>;
}

async function walkFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}

describe("the recorded operation log", () => {
  test("replays through the real handlers and reconciles byte-for-byte against its recorded outputs", async () => {
    const declaration = { type: "musai.op-log-fixture/claim@1", identityDimensions: ["id"] };
    const claimTypes = claimTypesFrom([declaration]);
    const workspace = await mkdtemp(join(tmpdir(), "musai-op-log-replay-"));
    try {
      const { gitDir } = await initWorkspace(workspace, { now });
      const ctx: GitContext = { gitDir };
      const store = new Store({ ctx, scope: "default", now, claimTypes });
      await declareClaimTypes(store, [declaration]);

      const recordFiles = await walkFiles(join(opLogDir, "records"));
      for (const file of recordFiles) {
        const rel = relative(join(opLogDir, "records"), file);
        const kind = rel.split("/")[0] as RecordKind;
        const bytes = new TextEncoder().encode((await readFile(file, "utf8")).trimEnd());
        await store.placeMany([{ kind, bytes }]);
      }

      const requestFiles = (await readdir(join(opLogDir, "requests"))).filter((name) => name.endsWith(".request.json"));
      expect(requestFiles.length).toBeGreaterThan(0);

      for (const requestFile of requestFiles) {
        const requestPath = join(opLogDir, "requests", requestFile);
        const responsePath = requestPath.replace(/\.request\.json$/, ".response.json");
        const request = JSON.parse(await readFile(requestPath, "utf8")) as RecordedRequest;
        const recordedResponseBytes = (await readFile(responsePath, "utf8")).trimEnd();

        const descriptor = REGISTRY.get(`${request.operation}@${request.version}`);
        expect(descriptor, `registry entry for ${request.operation}@${request.version}`).toBeDefined();

        const output = await runHandler(descriptor!, request.input, {
          workspace,
          scope: "default",
          mode: "perform",
          now,
        });
        const replayedBytes = new TextDecoder().decode(canonicalBytes(output));

        expect(replayedBytes).toBe(recordedResponseBytes);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
