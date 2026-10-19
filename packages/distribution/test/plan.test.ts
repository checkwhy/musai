import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OperationContext, Workspace } from "@musai/api-core";
import {
  type AdmittedDeclaration,
  admitPlan,
  isOperationError,
  openWorkspace,
  perform,
  realisePlan,
  runHandler,
} from "@musai/api-core";
import { buildModule, type ModuleArtefacts } from "@musai/devkit";
import { IndexDb } from "@musai/fold";
import { INVOCATION_LIMITS_SLOT_ID, type OperationPlan } from "@musai/modules";
import {
  type AttestationRecord,
  type Clock,
  type EffectClass,
  PACK_IRREVERSIBLE_SLOT_ID,
  type PerformedRunRecord,
  type RecordKind,
  recordId,
  timestamp,
  versionString,
} from "@musai/records";
import { initWorkspace, LOCAL_DIR, SLOTS_CONFIG_KEY, Store } from "@musai/store";
import { blobStoreOf, fixedClock, fixtureBrief, foldedIndex, writeTrustFile } from "@musai/test-support";
import { mintAttestation } from "@musai/trust";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { installDistributionModule, readDistributionArtefacts } from "../src/distribution.js";
import { admitDrafts } from "../src/drafts.js";
import { mintRuling } from "../src/gate/ruling-mint.js";
import { caseBook } from "../src/ops/case.js";

const BOOKED_AT = timestamp("2026-01-01T00:00:00.000Z");
const ATTESTED_AT = timestamp("2026-03-04T05:06:07.000Z");
const scope = "default";
/** A module whose rule holds tens of megabytes: inside the memory default, past a ceiling of 8. */
const ALLOCATES_MODULE_DIR = fileURLToPath(new URL("./fixtures/allocates", import.meta.url));

/** The operation key a refusal names for a plan realised under `declaring`. */
const REALISING = "fixture.write@1";

const SOMEONE = `key:SHA256:${"s".repeat(43)}`;
const SOMEONE_ELSE = `key:SHA256:${"e".repeat(43)}`;
const ARBITER = `key:SHA256:${"a".repeat(43)}`;

function declaring(authority: "rule" | null, effect: EffectClass = "write"): AdmittedDeclaration {
  return { id: "fixture.write", version: versionString("1"), effect, authority, contributed: false };
}

describe("a plan realised and performed", () => {
  let workspace: string;
  let artefacts: ModuleArtefacts;

  beforeAll(async () => {
    artefacts = await readDistributionArtefacts();
  });

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-plan-"));
    await initWorkspace(workspace, { now: fixedClock(BOOKED_AT) });
    const store = storeAt();
    const index = new IndexDb(":memory:");
    await index.fold(store);
    await installDistributionModule(artefacts, store, blobStoreOf(workspace), index);
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  function storeAt(): Store {
    return new Store({ ctx: { gitDir: join(workspace, ".musai") }, scope, now: fixedClock(BOOKED_AT) });
  }

  function contextFor(fields: Partial<OperationContext> = {}): OperationContext {
    return { workspace, scope, now: fixedClock(ATTESTED_AT), ...fields };
  }

  function opened(): Promise<Workspace> {
    return openWorkspace({ workspace, scope, now: fixedClock(ATTESTED_AT) });
  }

  /** A real booking's records as drafts: a case with its claims, which any workspace can mint. */
  async function draftsOfABooking(slug: string): Promise<OperationPlan["put"]> {
    const planned = await runHandler(
      caseBook,
      { slug, about: ["https://example.test/a"] },
      contextFor({ mode: "plan" }),
    );
    return planned.minted.map((item) => ({ kind: item.kind as "case" | "claim", value: item.record }));
  }

  async function attestedPlan(): Promise<OperationPlan> {
    return { put: await draftsOfABooking("attested"), attest: [{ subject: { put: 0 }, purpose: "made" }], needs: [] };
  }

  test("a plan realised twice at one head answers with the same ids", async () => {
    const plan = await attestedPlan();
    const view = await opened();
    const first = await realisePlan(plan, view, contextFor({ via: "tty" }), REALISING, SOMEONE);
    const second = await realisePlan(plan, view, contextFor({ via: "tty" }), REALISING, SOMEONE);

    expect(first.minted.length).toBeGreaterThan(1);
    expect(second.minted.map((item) => item.id)).toEqual(first.minted.map((item) => item.id));
  });

  test("realising a plan writes nothing to the store", async () => {
    const plan = await attestedPlan();
    const before = await storeAt().tip();
    const realised = await realisePlan(plan, await opened(), contextFor({ via: "tty" }), REALISING, SOMEONE);

    expect(realised.minted.length).toBeGreaterThan(0);
    expect(await storeAt().tip()).toBe(before);
  });

  test("an attestation's principal, channel and instant come from the context and the workspace clock, never the plan", async () => {
    const plan = await attestedPlan();
    const realised = await realisePlan(plan, await opened(), contextFor({ via: "model" }), REALISING, SOMEONE);

    const attestations = realised.minted.filter((item) => item.kind === "attestation");
    expect(attestations).toHaveLength(1);
    const record = attestations[0]!.record as AttestationRecord;
    expect(record.principal).toBe(SOMEONE);
    expect(record.via).toBe("model");
    expect(record.principalClass).toBe("agent");
    expect(record.at).toBe(ATTESTED_AT);
    expect(record.subject).toBe(realised.minted[0]!.id);
  });

  test("an attestation naming a put entry the plan does not hold is refused, naming the index", async () => {
    const plan: OperationPlan = {
      put: await draftsOfABooking("short"),
      attest: [{ subject: { put: 7 }, purpose: "made" }],
      needs: [],
    };
    const refusal = await realisePlan(plan, await opened(), contextFor({ via: "tty" }), REALISING, SOMEONE).catch(
      (error: unknown) => error,
    );

    expect(isOperationError(refusal)).toBe(true);
    expect(refusal).toMatchObject({ reason: "invalid-input", about: ["7"] });
    expect((refusal as Error).message).toContain("put entry 7");
  });

  test("a plan asking for an attestation is refused where the context establishes no principal", async () => {
    const refusal = await realisePlan(
      await attestedPlan(),
      await opened(),
      contextFor({ via: "tty" }),
      REALISING,
      undefined,
    ).catch((error: unknown) => error);

    expect(isOperationError(refusal)).toBe(true);
    expect(refusal).toMatchObject({ reason: "invalid-input", about: ["principal"] });
  });

  test("a draft of a kind no admission covers is refused by entry rather than admitted in silence", async () => {
    const view = await opened();
    const [subject] = await view.put(await draftsOfABooking("uncovered"));
    const attestation = mintAttestation({
      subject: subject!,
      principal: SOMEONE,
      principalClass: "person",
      via: "tty",
      purpose: "made",
      at: ATTESTED_AT,
    });
    const plan: OperationPlan = { put: [{ kind: "attestation", value: attestation.record }], attest: [], needs: [] };
    const realised = await realisePlan(plan, view, contextFor({ via: "tty" }), REALISING, SOMEONE);

    const refusal = await admitDrafts(plan, realised, REALISING, view).catch((error: unknown) => error);

    expect(isOperationError(refusal)).toBe(true);
    expect(refusal).toMatchObject({ reason: "invalid-output", about: [REALISING, "put/0"] });
  });

  test("a pack's case asking for a salt cites the salted ids of the claims it drafts beside it, and is admitted", async () => {
    const drafts = await draftsOfABooking("salted-pack-case");
    const plan: OperationPlan = {
      put: drafts.map((entry) => ({
        ...entry,
        salt: true as const,
        ...(entry.kind === "case" ? { about: ["https://example.test/a"] } : {}),
      })),
      attest: [],
      needs: [],
    };
    const view = await opened();

    const realised = await realisePlan(plan, view, contextFor({ via: "tty" }), REALISING, SOMEONE);
    await admitDrafts(plan, realised, REALISING, view);

    const again = await realisePlan(plan, view, contextFor({ via: "tty" }), REALISING, SOMEONE);
    expect(again.minted.map((item) => item.id)).toEqual(realised.minted.map((item) => item.id));

    const [booked, ...claims] = realised.minted;
    expect(booked!.kind).toBe("case");
    expect((booked!.record as { claims: string[] }).claims).toEqual(claims.map((item) => item.id));
    for (const item of claims) {
      expect(item.record).toMatchObject({ salt: expect.stringMatching(/^[0-9a-f]{64}$/) });
    }
  });

  test("a pack's case asking for no salt cites the salted ids of the claims it drafts salted, and plan and perform agree", async () => {
    const drafts = await draftsOfABooking("unsalted-case-salted-claims");
    const plan: OperationPlan = {
      put: drafts.map((entry) =>
        entry.kind === "case" ? { ...entry, about: ["https://example.test/a"] } : { ...entry, salt: true as const },
      ),
      attest: [],
      needs: [],
    };
    const view = await opened();
    const context = contextFor({ via: "tty" });

    const realised = await realisePlan(plan, view, context, REALISING, SOMEONE);
    await admitDrafts(plan, realised, REALISING, view);
    const applied = await perform(realised, plan.needs, view);

    const [booked, ...claims] = realised.minted;
    expect(booked!.record).not.toHaveProperty("salt");
    expect((booked!.record as { claims: string[] }).claims).toEqual(claims.map((item) => item.id));
    for (const item of claims) {
      expect(item.record).toMatchObject({ salt: expect.stringMatching(/^[0-9a-f]{64}$/) });
    }
    expect(applied.minted.map((item) => item.id)).toEqual(realised.minted.map((item) => item.id));
  });

  test("a pack's case over claims drafted unsalted mints as before and creates no workspace key", async () => {
    const drafts = await draftsOfABooking("unsalted-case-unsalted-claims");
    const plan: OperationPlan = {
      put: drafts.map((entry) => (entry.kind === "case" ? { ...entry, about: ["https://example.test/a"] } : entry)),
      attest: [],
      needs: [],
    };
    const view = await opened();

    const realised = await realisePlan(plan, view, contextFor({ via: "tty" }), REALISING, SOMEONE);
    await admitDrafts(plan, realised, REALISING, view);

    expect(realised.minted.map((item) => item.id)).toEqual(
      drafts.map((entry) => recordId(entry.value as Record<string, unknown>)),
    );
    expect(await readdir(join(workspace, ".musai", LOCAL_DIR))).not.toContain("keys.json");
  });

  test("a pack's case asking for a salt may cite claims that ask for none, and a citation of neither derivation is refused", async () => {
    const drafts = await draftsOfABooking("salted-case-unsalted-claims");
    const plan: OperationPlan = {
      put: drafts.map((entry) =>
        entry.kind === "case" ? { ...entry, salt: true as const, about: ["https://example.test/a"] } : entry,
      ),
      attest: [],
      needs: [],
    };
    const view = await opened();
    const context = contextFor({ via: "tty" });
    const realised = await realisePlan(plan, view, context, REALISING, SOMEONE);
    await admitDrafts(plan, realised, REALISING, view);

    const stray = {
      ...plan.put[0]!,
      value: { ...(plan.put[0]!.value as object), claims: [`sha256:${"0".repeat(64)}`] },
    };
    const strayPlan = { ...plan, put: [stray, ...plan.put.slice(1)] };
    const strayRealised = await realisePlan(strayPlan, view, context, REALISING, SOMEONE);
    const cited = await admitDrafts(strayPlan, strayRealised, REALISING, view).catch((error: unknown) => error);

    expect(cited).toMatchObject({ reason: "invalid-output", about: [REALISING, "put/0"] });
    expect((cited as Error).message).toContain("its booking derives");
  });

  test("a pack's unsalted case citing an id its booking does not derive is refused, and creates no workspace key", async () => {
    const drafts = await draftsOfABooking("unsalted-stray-case");
    const stray = drafts.map((entry) =>
      entry.kind === "case"
        ? {
            ...entry,
            about: ["https://example.test/a"],
            value: { ...(entry.value as object), claims: [`sha256:${"0".repeat(64)}`] },
          }
        : entry,
    );
    const plan: OperationPlan = { put: stray, attest: [], needs: [] };
    const view = await opened();
    const realised = await realisePlan(plan, view, contextFor({ via: "tty" }), REALISING, SOMEONE);

    const cited = await admitDrafts(plan, realised, REALISING, view).catch((error: unknown) => error);

    expect(cited).toMatchObject({ reason: "invalid-output", about: [REALISING, "put/0"] });
    expect(await readdir(join(workspace, ".musai", LOCAL_DIR))).not.toContain("keys.json");
  });

  test("minted lists every put before every attestation", async () => {
    const plan = await attestedPlan();
    const realised = await realisePlan(plan, await opened(), contextFor({ via: "tty" }), REALISING, SOMEONE);

    expect(realised.minted).toHaveLength(plan.put.length + plan.attest.length);
    expect(realised.minted.map((item) => item.kind)).toEqual([
      ...plan.put.map((entry) => entry.kind),
      ...plan.attest.map(() => "attestation"),
    ]);
  });

  test("a booking's claims drafted with no slot realise to the ids the booking shows", async () => {
    const drafts = await draftsOfABooking("unslotted");
    const unslotted = drafts.map((entry) => {
      if (entry.kind !== "claim") {
        return entry;
      }
      const { slot: _slot, ...value } = entry.value as Record<string, unknown>;
      return { ...entry, value };
    });
    const view = await opened();

    const asDrafted = await realisePlan({ put: drafts, attest: [], needs: [] }, view, contextFor(), REALISING, SOMEONE);
    const derived = await realisePlan(
      { put: unslotted, attest: [], needs: [] },
      view,
      contextFor(),
      REALISING,
      SOMEONE,
    );

    expect(unslotted.filter((entry) => entry.kind === "claim")).not.toHaveLength(0);
    expect(derived.minted.map((item) => item.id)).toEqual(asDrafted.minted.map((item) => item.id));
  });

  test("a claim drafted with no slot and conditions that are not an object is refused by entry, naming the conditions", async () => {
    const drafts = await draftsOfABooking("unconditioned");
    const index = drafts.findIndex((entry) => entry.kind === "claim");
    const { slot: _slot, ...value } = drafts[index]!.value as Record<string, unknown>;
    const put = drafts.map((entry, at) =>
      at === index ? { ...entry, value: { ...value, conditions: "none" } } : entry,
    );

    const refusal = await realisePlan(
      { put, attest: [], needs: [] },
      await opened(),
      contextFor(),
      REALISING,
      SOMEONE,
    ).catch((error: unknown) => error);

    expect(isOperationError(refusal)).toBe(true);
    expect(refusal).toMatchObject({ reason: "invalid-output", about: [REALISING, `put/${index}`] });
    expect((refusal as Error).message).toContain("conditions");
    expect((refusal as Error).message).not.toContain("slot must be");
  });

  test("performing a realised plan writes exactly what realising it showed, in one commit", async () => {
    const plan = await attestedPlan();
    const context = contextFor({ via: "tty" });
    const view = await opened();
    const realised = await realisePlan(plan, view, context, REALISING, SOMEONE);
    const before = await storeAt().tip();

    const applied = await perform(realised, plan.needs, view);

    expect(applied.minted).toEqual(realised.minted);
    const after = await storeAt().tip();
    const between = execFileSync("git", [
      "--git-dir",
      join(workspace, ".musai"),
      "rev-list",
      "--count",
      `${before}..${after}`,
    ]);
    expect(between.toString().trim()).toBe("1");
    for (const item of realised.minted) {
      expect(await storeAt().read(item.id, item.kind as RecordKind)).toEqual(item.record);
    }
  });

  test("a plan's invoke need is performed through the installed module rather than refused as unsupported, and a needs-only plan never calls the write", async () => {
    const context = contextFor();
    const view = await opened();
    const needs: OperationPlan["needs"] = [
      { kind: "invoke", contribution: "musai.core/whole-run", input: { output: "hello", exitCode: 0 } },
    ];
    const realised = await realisePlan({ put: [], attest: [], needs }, view, context, REALISING, SOMEONE);

    const before = await storeAt().tip();
    const put = vi.spyOn(view, "put");
    const applied = await perform(realised, needs, view);
    expect(applied.minted).toEqual([]);
    expect(applied.receipts).toEqual([]);
    expect(put).not.toHaveBeenCalled();
    expect(await storeAt().tip()).toBe(before);

    const unknown: OperationPlan["needs"] = [{ kind: "invoke", contribution: "musai.core/no-such", input: {} }];
    const refusal = await perform(realised, unknown, view).catch((error: unknown) => error);
    expect(isOperationError(refusal)).toBe(true);
    expect((refusal as Error).message).toContain("holds no contribution of that id");
  });

  test("a plan's invoke need runs under the invocation limits the workspace's configuration assigns at the project layer", async () => {
    await buildModule(ALLOCATES_MODULE_DIR, storeAt(), {
      blobs: blobStoreOf(workspace),
      index: await foldedIndex(storeAt()),
      now: fixedClock(BOOKED_AT),
    });
    const needs: OperationPlan["needs"] = [
      {
        kind: "invoke",
        contribution: "allocates/holds-after-allocating",
        input: {
          claimId: "allocating",
          conditions: {},
          evidence: [{ runId: `sha256:${"1".repeat(64)}`, exitCode: 0, output: "" }],
        },
      },
    ];
    const unboundedView = await opened();
    const unbounded = await realisePlan(
      { put: [], attest: [], needs },
      unboundedView,
      contextFor(),
      REALISING,
      SOMEONE,
    );
    expect((await perform(unbounded, needs, unboundedView)).receipts).toEqual([]);

    await writeTrustFile(
      { gitDir: join(workspace, ".musai") },
      "config.json",
      JSON.stringify({ [SLOTS_CONFIG_KEY]: { [INVOCATION_LIMITS_SLOT_ID]: { timeLimitMs: 2000, memoryLimitMb: 8 } } }),
    );
    const boundedView = await opened();
    const bounded = await realisePlan({ put: [], attest: [], needs }, boundedView, contextFor(), REALISING, SOMEONE);
    const refusal = await perform(bounded, needs, boundedView).catch((error: unknown) => error);

    expect(isOperationError(refusal)).toBe(true);
    expect((refusal as Error).message).toContain("memory-limit");
  }, 60_000);

  test("a plan's run need declaring a name only the workspace's configuration marks secret records it as a keyed hash", async () => {
    const value = "bound-plain-declared-secret";
    await writeTrustFile(
      { gitDir: join(workspace, ".musai") },
      "config.json",
      JSON.stringify({ declaredNames: { LAYER_TOKEN: { secret: true } } }),
    );
    await writeFile(
      join(workspace, ".musai", "local", "bindings.json"),
      JSON.stringify({ LAYER_TOKEN: { secret: false, value } }),
      { mode: 0o600 },
    );
    const view = await opened();
    const needs: OperationPlan["needs"] = [
      {
        kind: "run",
        recipe: {
          command: ["node", "-e", "process.exit(0)"],
          workingDirectory: "/",
          environment: {},
          declared: [{ name: "LAYER_TOKEN", secret: false }],
          substrates: [],
          isolation: "hygiene",
        },
      },
    ];
    const realised = await realisePlan({ put: [], attest: [], needs }, view, contextFor(), REALISING, SOMEONE);

    const applied = await perform(realised, needs, view);

    expect(applied.receipts).toHaveLength(1);
    const receipt = (await storeAt().read(applied.receipts[0]!, "run")) as PerformedRunRecord;
    expect(receipt.observation.bindings).toEqual([
      expect.objectContaining({ name: "LAYER_TOKEN", secret: true, value: null, keyedHash: expect.any(String) }),
    ]);
  }, 30_000);

  describe("a plan's content against the effect its operation declares", () => {
    const runNeed: OperationPlan["needs"][number] = {
      kind: "invoke",
      contribution: "musai.core/whole-run",
      input: { output: "hello", exitCode: 0 },
    };

    test.each([
      [
        "puts a record",
        async (): Promise<OperationPlan> => ({ put: await draftsOfABooking("read"), attest: [], needs: [] }),
      ],
      ["attests", async (): Promise<OperationPlan> => ({ ...(await attestedPlan()), put: [] })],
      ["carries a need", async (): Promise<OperationPlan> => ({ put: [], attest: [], needs: [runNeed] })],
    ])("a read whose plan %s is refused invalid-output, naming the operation", async (_label, planOf) => {
      const plan = await planOf();
      const view = await opened();
      expect(() => admitPlan(plan, declaring(null, "read"), view, contextFor(), SOMEONE)).toThrow(
        expect.objectContaining({ reason: "invalid-output", about: ["fixture.write@1"] }),
      );
    });

    test("a write whose plan carries a need is refused invalid-output, naming the operation", async () => {
      const view = await opened();
      expect(() =>
        admitPlan({ put: [], attest: [], needs: [runNeed] }, declaring(null, "write"), view, contextFor(), SOMEONE),
      ).toThrow(expect.objectContaining({ reason: "invalid-output", about: ["fixture.write@1"] }));
    });

    test("a read with an empty plan, a write that puts and a performing plan with a need are admitted", async () => {
      const view = await opened();
      const context = contextFor({ via: "tty" });
      expect(() =>
        admitPlan({ put: [], attest: [], needs: [] }, declaring(null, "read"), view, context, SOMEONE),
      ).not.toThrow();
      const attested = await attestedPlan();
      expect(() => admitPlan(attested, declaring(null, "write"), view, context, SOMEONE)).not.toThrow();
      expect(() =>
        admitPlan({ put: [], attest: [], needs: [runNeed] }, declaring(null, "performs"), view, context, SOMEONE),
      ).not.toThrow();
    });
  });

  describe("an irreversible operation a pack contributes", () => {
    const irreversible: AdmittedDeclaration = {
      id: "fixture.pack/erase",
      version: versionString("1"),
      effect: "irreversible",
      authority: null,
      contributed: true,
    };

    test("is refused where the project's configuration says nothing, naming the operation and the slot", async () => {
      const view = await opened();
      const plan: OperationPlan = { put: await draftsOfABooking("refused"), attest: [], needs: [] };

      const refusal = (() => {
        try {
          admitPlan(plan, irreversible, view, contextFor(), SOMEONE);
          return undefined;
        } catch (error) {
          return error;
        }
      })();

      expect(isOperationError(refusal)).toBe(true);
      expect(refusal).toMatchObject({
        reason: "not-authorised",
        about: ["fixture.pack/erase@1", PACK_IRREVERSIBLE_SLOT_ID],
      });
      expect((refusal as Error).message).toContain("fixture.pack");
      expect((refusal as Error).message).toContain('"slots"');
    });

    test("is admitted where the project's configuration assigns the slot true", async () => {
      await writeTrustFile(
        { gitDir: join(workspace, ".musai") },
        "config.json",
        JSON.stringify({ slots: { [PACK_IRREVERSIBLE_SLOT_ID]: true } }),
      );
      const view = await opened();
      const plan: OperationPlan = { put: await draftsOfABooking("allowed"), attest: [], needs: [] };

      expect(() => admitPlan(plan, irreversible, view, contextFor(), SOMEONE)).not.toThrow();
    });
  });

  describe("under a role matrix naming who may rule", () => {
    beforeEach(async () => {
      await writeTrustFile({ gitDir: join(workspace, ".musai") }, "roles", `${ARBITER} owner any\n`);
    });

    test("an operation declaring an authority is refused for a principal the matrix does not grant it", async () => {
      const plan = await attestedPlan();
      const view = await opened();

      expect(() => admitPlan(plan, declaring("rule"), view, contextFor({ via: "tty" }), SOMEONE_ELSE)).toThrow(
        expect.objectContaining({ reason: "not-authorised", about: [SOMEONE_ELSE, "rule"] }),
      );
    });

    test("an operation declaring an authority is refused where the context establishes no principal", async () => {
      const view = await opened();
      const plan: OperationPlan = { put: await draftsOfABooking("nobody"), attest: [], needs: [] };

      expect(() => admitPlan(plan, declaring("rule"), view, contextFor(), undefined)).toThrow(
        expect.objectContaining({ reason: "not-authorised", about: ["fixture.write@1", "rule"] }),
      );
    });

    test("an operation declaring an authority is admitted for a principal the matrix grants it", async () => {
      const plan = await attestedPlan();
      const view = await opened();

      expect(() => admitPlan(plan, declaring("rule"), view, contextFor({ via: "tty" }), ARBITER)).not.toThrow();
    });
  });

  /** `realisePlan` reads the clock once and `perform` applies its answer, so ids match under a live
   * clock; a test needing `MUSAI_NOW` would prove the pinned instant instead. */
  describe("the structural form: perform applies exactly what realisePlan showed, under a live clock", () => {
    function liveClock(): Clock {
      return (): ReturnType<Clock> => timestamp(new Date().toISOString());
    }

    /** Long enough that a second clock read would land on another millisecond. */
    async function letTheClockMove(): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    test("records only: a case.book plan realised once and performed writes exactly the ids it showed", async () => {
      const view = await openWorkspace({ workspace, scope, now: liveClock() });
      const context = contextFor({ via: "tty" });
      const plan: OperationPlan = { put: await draftsOfABooking("live-clock-records-only"), attest: [], needs: [] };

      const realised = await realisePlan(plan, view, context, REALISING, SOMEONE);
      await letTheClockMove();
      const applied = await perform(realised, plan.needs, view);

      expect(applied.minted.map((item) => item.id)).toEqual(realised.minted.map((item) => item.id));
      for (const item of applied.minted) {
        expect(await storeAt().read(item.id, item.kind as RecordKind)).toEqual(item.record);
      }
    });

    test("records and an attestation: a ruling.make plan realised once and performed writes exactly the ids and the instant it showed", async () => {
      const view = await openWorkspace({ workspace, scope, now: liveClock() });
      const context = contextFor({ via: "tty" });
      const drafted = await draftsOfABooking("live-clock-ruling-claim");
      const written = await view.put(drafted);
      const claimIndex = drafted.findIndex((entry) => entry.kind === "claim");
      const claimId = written[claimIndex]!;
      const [briefId] = await view.put([{ kind: "run", value: fixtureBrief("brief for the structural ruling") }]);

      const rulingPlan = await mintRuling(view, {
        claim: claimId,
        verdict: "holds",
        reason: "the structural invariant, not the clock, decides this",
        brief: briefId!,
        supersedes: [],
        via: "tty",
        principal: SOMEONE,
      });
      const plan: OperationPlan = { put: rulingPlan.put, attest: rulingPlan.attest, needs: [] };

      const realised = await realisePlan(plan, view, context, REALISING, SOMEONE);
      await letTheClockMove();
      const applied = await perform(realised, plan.needs, view);

      expect(applied.minted.map((item) => item.id)).toEqual(realised.minted.map((item) => item.id));
      for (const item of applied.minted) {
        expect(await storeAt().read(item.id, item.kind as RecordKind)).toEqual(item.record);
      }
    });

    test("a plan whose need names a binary no installed module declares is refused undeclared-binary, naming the binary, and writes nothing", async () => {
      const view = await openWorkspace({ workspace, scope, now: liveClock() });
      const context = contextFor({ via: "tty" });
      const undeclared = "definitely-not-a-real-binary-musai-test";
      const plan: OperationPlan = {
        put: await draftsOfABooking("live-clock-undeclared"),
        attest: [],
        needs: [
          {
            kind: "run",
            recipe: {
              command: [undeclared],
              workingDirectory: "/",
              environment: {},
              declared: [],
              substrates: [],
              isolation: "hygiene",
            },
          },
        ],
      };
      const realised = await realisePlan(plan, view, context, REALISING, SOMEONE);
      const tip = await storeAt().tip();

      const refusal = await perform(realised, plan.needs, view).catch((error: unknown) => error);

      expect(isOperationError(refusal)).toBe(true);
      expect(refusal).toMatchObject({ reason: "undeclared-binary", detail: expect.stringContaining(undeclared) });
      expect(await storeAt().tip()).toBe(tip);
    });

    test("a plan carrying a need: the ids realise showed still equal what perform wrote, with the need's receipt performed in between", async () => {
      const view = await openWorkspace({ workspace, scope, now: liveClock() });
      const context = contextFor({ via: "tty" });
      const plan: OperationPlan = {
        put: await draftsOfABooking("live-clock-needs"),
        attest: [],
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
      };

      const realised = await realisePlan(plan, view, context, REALISING, SOMEONE);
      const applied = await perform(realised, plan.needs, view);

      expect(applied.minted.map((item) => item.id)).toEqual(realised.minted.map((item) => item.id));
      expect(applied.receipts).toHaveLength(1);
      for (const item of applied.minted) {
        expect(await storeAt().read(item.id, item.kind as RecordKind)).toEqual(item.record);
      }
    }, 30_000);
  });
});
