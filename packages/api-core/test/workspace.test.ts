import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Admission, IndexDb, type IndexedContribution } from "@musai/fold";
import type { EventPayload, RuleOutput } from "@musai/modules";
import { installModule, readClaimTypeDeclarations } from "@musai/modules";
import type { Audience, ClaimRecord, ContributionEntry, ModuleRecord, RecordId, RunRecipe } from "@musai/records";
import {
  type ClaimTypeDeclaration,
  CURRENT_SCHEMA_VERSIONS,
  KernelError,
  performedRun,
  recordId,
  recordPath,
  SlotRefusedError,
  slotFor,
  TRIPLE_CLAIM_TYPE,
  TRIPLE_DECLARATION,
  versionString,
} from "@musai/records";
import { BindingError } from "@musai/run";
import { type CommitChanges, LOCAL_DIR, MUSAI_DIR, Store, scopeIndexPath } from "@musai/store";
import {
  blobStoreOf,
  type FixtureRepo,
  fixedClock,
  makeFixtureRepo,
  manifestWithContributions,
  ownConfigValue,
  removeTrustFile,
  writeFixtureRecords,
  writeOwnConfig,
  writeTrustFile,
} from "@musai/test-support";
import { covers } from "@musai/trust";
import { execa } from "execa";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { SubscriptionTrace } from "../src/context.js";
import { Workspace, type WorkspaceOptions } from "../src/workspace.js";

const FIXED_INSTANT = "2026-01-01T00:00:00.000Z";
/** Distinct from `FIXED_INSTANT`, to show a guarantee follows the clock given, not a constant. */
const OTHER_INSTANT = "2026-06-15T12:30:00.000Z";

let cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.map((cleanup) => cleanup()));
  cleanups = [];
});

function claimOf(
  declaration: ClaimTypeDeclaration,
  conditions: Readonly<Record<string, string>>,
  rendering: string,
): ClaimRecord {
  return {
    kind: "claim",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: declaration.type,
    about: [],
    slot: slotFor(declaration, conditions),
    conditions,
    canonical: conditions,
    rendering,
    evidence: [],
    exclusiveGroup: null,
  };
}

describe("the claim types a workspace validates against", () => {
  test("an opened workspace knows the base triple and nothing else", async () => {
    const repo = await makeFixtureRepo("workspace-open");
    cleanups.push(repo.cleanup);

    const opened = await Workspace.open({ dir: repo.workspace, scope: repo.scope, now: fixedClock(FIXED_INSTANT) });

    expect([...opened.claimTypes.keys()]).toEqual([TRIPLE_CLAIM_TYPE]);
  });

  test("a repo made with one namespaced declaration opens a workspace whose claim types hold it, read back the same way the fold answers for an installed pack", async () => {
    const declaration: ClaimTypeDeclaration = {
      type: "workspace-fixture/reported@1",
      identityDimensions: ["id"],
      canonical: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    };
    const repo = await makeFixtureRepo("workspace-declared-type", [declaration]);
    cleanups.push(repo.cleanup);

    const opened = await Workspace.open({ dir: repo.workspace, scope: repo.scope, now: fixedClock(FIXED_INSTANT) });

    expect(opened.claimTypes.get(declaration.type)).toEqual(declaration);
    const read = readClaimTypeDeclarations(opened.index);
    expect(read.declarations).toEqual([declaration]);
    expect(read.refused).toEqual([]);
  });

  test("a repo made with no declarations folds no module record", async () => {
    const repo = await makeFixtureRepo("workspace-no-declarations");
    cleanups.push(repo.cleanup);

    const opened = await Workspace.open({ dir: repo.workspace, scope: repo.scope, now: fixedClock(FIXED_INSTANT) });

    expect(opened.index.installedModuleRecords()).toEqual([]);
  });

  test("makeFixtureRepo rejects a declaration whose type has no /, naming the type", async () => {
    await expect(
      makeFixtureRepo("workspace-unnamespaced", [{ type: "no-slash@1", identityDimensions: ["id"] }]),
    ).rejects.toThrow("no-slash@1");
  });
});

describe("the project layer's slot assignments a workspace carries", () => {
  test("an opened workspace answers exactly what the trust branch's configuration holds under slots", async () => {
    const repo = await makeFixtureRepo("workspace-project-slots");
    cleanups.push(repo.cleanup);
    const assigned = { "fixture.module/count": 3, "fixture.module/flag": true };
    await writeTrustFile(repo.ctx, "config.json", JSON.stringify({ slots: assigned }));

    const opened = await Workspace.open({ dir: repo.workspace, scope: repo.scope, now: fixedClock(FIXED_INSTANT) });

    expect(opened.projectSlots).toEqual(assigned);
  });

  test("an opened workspace whose configuration names no slots answers an empty assignment", async () => {
    const repo = await makeFixtureRepo("workspace-project-slots-none");
    cleanups.push(repo.cleanup);

    const opened = await Workspace.open({ dir: repo.workspace, scope: repo.scope, now: fixedClock(FIXED_INSTANT) });

    expect(opened.projectSlots).toEqual({});
  });

  test("a configuration whose slots is not an object refuses the open, naming slots", async () => {
    const repo = await makeFixtureRepo("workspace-project-slots-malformed");
    cleanups.push(repo.cleanup);
    await writeTrustFile(repo.ctx, "config.json", JSON.stringify({ slots: "everything" }));

    await expect(
      Workspace.open({ dir: repo.workspace, scope: repo.scope, now: fixedClock(FIXED_INSTANT) }),
    ).rejects.toMatchObject({ reason: "workspace-incomplete", about: ["slots"] });
  });
});

describe("the audiences a workspace reads from its trust branch", () => {
  test("a fresh workspace's known covers peer, and peer does not cover known", async () => {
    const repo = await makeFixtureRepo("workspace-audiences");
    cleanups.push(repo.cleanup);

    const opened = await Workspace.open({ dir: repo.workspace, scope: repo.scope, now: fixedClock(FIXED_INSTANT) });

    expect(covers(opened.audiences, "known", "peer")).toBe(true);
    expect(covers(opened.audiences, "peer", "known")).toBe(false);
  });

  test("a workspace whose trust branch holds no audiences file declares no name", async () => {
    const repo = await makeFixtureRepo("workspace-audiences-absent");
    cleanups.push(repo.cleanup);
    await removeTrustFile(repo.ctx, "audiences");

    const opened = await Workspace.open({ dir: repo.workspace, scope: repo.scope, now: fixedClock(FIXED_INSTANT) });

    expect(opened.audiences.names.size).toBe(0);
  });
});

describe("the project layer's declared names a workspace carries", () => {
  test("an opened workspace carries the secret flag its configuration declares for each name", async () => {
    const repo = await makeFixtureRepo("workspace-declared-names");
    cleanups.push(repo.cleanup);
    await writeTrustFile(
      repo.ctx,
      "config.json",
      JSON.stringify({ declaredNames: { API_TOKEN: { secret: true }, LOG_LEVEL: { secret: false } } }),
    );

    const opened = await Workspace.open({ dir: repo.workspace, scope: repo.scope, now: fixedClock(FIXED_INSTANT) });

    expect(opened.layerDeclarations).toEqual(
      new Map([
        ["API_TOKEN", { secret: true }],
        ["LOG_LEVEL", { secret: false }],
      ]),
    );
  });

  test("an opened workspace whose configuration declares no names carries none", async () => {
    const repo = await makeFixtureRepo("workspace-declared-names-none");
    cleanups.push(repo.cleanup);

    const opened = await Workspace.open({ dir: repo.workspace, scope: repo.scope, now: fixedClock(FIXED_INSTANT) });

    expect(opened.layerDeclarations).toEqual(new Map());
  });

  test("a configuration declaring a name with no boolean secret flag refuses the open, naming declaredNames", async () => {
    const repo = await makeFixtureRepo("workspace-declared-names-malformed");
    cleanups.push(repo.cleanup);
    await writeTrustFile(repo.ctx, "config.json", JSON.stringify({ declaredNames: { API_TOKEN: { secret: "yes" } } }));

    const refusal = await Workspace.open({
      dir: repo.workspace,
      scope: repo.scope,
      now: fixedClock(FIXED_INSTANT),
    }).catch((caught: unknown) => caught);

    expect(refusal).toBeInstanceOf(BindingError);
    expect((refusal as BindingError).message).toContain("declaredNames");
  });
});

const SUBSCRIBER = "subscriber-module";

function entry(kind: ContributionEntry["kind"], id: string, input: unknown): ContributionEntry {
  return { kind, id, version: versionString("1"), input, output: true, documentation: "d" };
}

function subscriptionOn(id: string, event: string): ContributionEntry {
  return entry("subscription", id, { properties: { name: { const: event } } });
}

/** The bundle is never loaded: these tests read the manifest, and a rule reaches a stub invoker. */
async function installPack(
  repo: FixtureRepo,
  name: string,
  contributions: readonly ContributionEntry[],
): Promise<void> {
  const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
  const index = new IndexDb(":memory:");
  await index.fold(store);
  await installModule(
    name,
    versionString("1.0.0"),
    manifestWithContributions(contributions),
    new TextEncoder().encode(`bundle for ${name}`),
    recordId({ marker: `build-for-${name}` }),
    store,
    blobStoreOf(repo.workspace),
    index,
  );
}

async function installSubscriber(repo: FixtureRepo, subscriptions: readonly ContributionEntry[]): Promise<void> {
  await installPack(repo, SUBSCRIBER, [
    ...subscriptions,
    entry("requirement", `${SUBSCRIBER}/printf`, {
      binary: "printf",
      versionPredicate: null,
      neededBy: "the subscription fixtures' run",
      install: "already on this machine",
    }),
  ]);
}

interface Invocation {
  readonly subscription: string;
  readonly event: EventPayload;
}

const NOTHING_TO_DO: RuleOutput = { kind: "verdict", label: "holds", reason: "nothing to do" };

function recordingInvoker(
  answer: (subscription: IndexedContribution, event: EventPayload) => RuleOutput = () => NOTHING_TO_DO,
): {
  readonly invocations: Invocation[];
  readonly invoker: NonNullable<WorkspaceOptions["subscriptionInvoker"]>;
} {
  const invocations: Invocation[] = [];
  return {
    invocations,
    invoker: async (_workspace, subscription, event) => {
      invocations.push({ subscription: subscription.entry.id, event });
      return answer(subscription, event);
    },
  };
}

const unreachableInvoker: NonNullable<WorkspaceOptions["subscriptionInvoker"]> = async (_workspace, subscription) => {
  throw new Error(`invoked ${subscription.entry.id}, which nothing should have reached`);
};

async function openSubscribed(
  scope: string,
  subscriptions: readonly ContributionEntry[],
  invoker: WorkspaceOptions["subscriptionInvoker"],
  instant: string = FIXED_INSTANT,
): Promise<{ opened: Workspace; repo: FixtureRepo }> {
  const repo = await makeFixtureRepo(scope);
  cleanups.push(repo.cleanup);
  if (subscriptions.length > 0) {
    await installSubscriber(repo, subscriptions);
  }
  const opened = await Workspace.open({
    dir: repo.workspace,
    scope: repo.scope,
    now: fixedClock(instant),
    subscriptionInvoker: invoker,
  });
  return { opened, repo };
}

function tripleClaim(subject: string): ClaimRecord {
  return claimOf(TRIPLE_DECLARATION, { subject, predicate: "is", object: "written" }, `${subject} is written`);
}

/** A command that prints and exits, so a subscription's need mints a real receipt. */
const PRINTING_RECIPE: RunRecipe = {
  command: ["printf", "%s", "a subscription ran"],
  workingDirectory: "/",
  environment: {},
  declared: [],
  substrates: [],
  isolation: "hygiene",
};

/** Fixture repositories install no core module, so this carries the resolution-age slot alone. */
const RESOLUTION_AGE_PACK = "musai.core";

const RESOLUTION_AGE_SLOT: ContributionEntry = {
  kind: "slot",
  id: `${RESOLUTION_AGE_PACK}/resolution-age`,
  version: versionString("1"),
  input: { layers: ["project", "preset", "booking"], hasDefault: true, default: 0 },
  output: { type: "integer", minimum: 0 },
  documentation: "d",
};

/** Run receipts minted writing one claim: one where the run was performed, none where reused. */
async function runsPutByWriteAt(
  repo: FixtureRepo,
  invoker: NonNullable<WorkspaceOptions["subscriptionInvoker"]>,
  instant: string,
  subject: string,
): Promise<number> {
  const opened = await Workspace.open({
    dir: repo.workspace,
    scope: repo.scope,
    now: fixedClock(instant),
    subscriptionInvoker: invoker,
  });
  const put = vi.spyOn(opened.store, "put");
  await opened.put([{ kind: "claim", value: tripleClaim(subject) }]);
  return put.mock.calls.filter(([kind]) => kind === "run").length;
}

describe("a write through the workspace dispatches the events of the records it wrote", () => {
  test("a subscription naming an event is invoked when a record of that event's kind is written through the workspace", async () => {
    const { invocations, invoker } = recordingInvoker();
    const { opened } = await openSubscribed(
      "dispatch-claim-put",
      [subscriptionOn(`${SUBSCRIBER}/on-claim`, "claim.put")],
      invoker,
    );

    const [claimId] = await opened.put([{ kind: "claim", value: tripleClaim("dispatched") }]);

    expect(invocations).toEqual([
      {
        subscription: `${SUBSCRIBER}/on-claim`,
        event: { name: "claim.put", payload: { id: claimId, about: claimId, at: await opened.store.tip() } },
      },
    ]);
  });

  test("the records a dispatch mints raise events that are dispatched to nobody", async () => {
    const { invocations, invoker } = recordingInvoker((subscription) =>
      subscription.entry.id === `${SUBSCRIBER}/on-claim`
        ? { kind: "request", needs: [{ kind: "run", recipe: PRINTING_RECIPE }] }
        : NOTHING_TO_DO,
    );
    const { opened, repo } = await openSubscribed(
      "dispatch-no-cascade",
      [subscriptionOn(`${SUBSCRIBER}/on-claim`, "claim.put"), subscriptionOn(`${SUBSCRIBER}/on-run`, "run.recorded")],
      invoker,
    );

    await opened.put([{ kind: "claim", value: tripleClaim("cascading") }]);

    const fresh = new IndexDb();
    await fresh.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
    expect(fresh.eventsAfter()!.filter((row) => row.kind === "run.recorded")).toHaveLength(1);
    expect(invocations.map((invocation) => invocation.subscription)).toEqual([`${SUBSCRIBER}/on-claim`]);
  });

  test("a write dispatches the events of its own records and none of a commit another writer landed", async () => {
    const { invocations, invoker } = recordingInvoker();
    const { opened, repo } = await openSubscribed(
      "dispatch-own-records",
      [subscriptionOn(`${SUBSCRIBER}/on-claim`, "claim.put")],
      invoker,
    );
    const [other] = await writeFixtureRecords(repo, [{ kind: "claim", value: tripleClaim("another writer's") }]);

    const [own] = await opened.put([{ kind: "claim", value: tripleClaim("this writer's") }]);

    expect(opened.read(other!)).toEqual(tripleClaim("another writer's"));
    expect(invocations.map((invocation) => (invocation.event.payload as { id: string }).id)).toEqual([own]);
  });

  test("a fold another handle lands between a write and its own fold hides none of that write's events", async () => {
    const { invocations, invoker } = recordingInvoker();
    const { opened, repo } = await openSubscribed(
      "dispatch-shared-fold",
      [subscriptionOn(`${SUBSCRIBER}/on-claim`, "claim.put")],
      invoker,
    );
    const putMany = opened.store.putMany.bind(opened.store);
    vi.spyOn(opened.store, "putMany").mockImplementation(async (items, hooks) => {
      const ids = await putMany(items, hooks);
      const other = new IndexDb(scopeIndexPath(repo.ctx.gitDir, repo.scope));
      await other.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
      return ids;
    });

    const [id] = await opened.put([{ kind: "claim", value: tripleClaim("folded elsewhere") }]);

    expect(opened.read(id!)).toEqual(tripleClaim("folded elsewhere"));
    expect(invocations.map((invocation) => (invocation.event.payload as { id: string }).id)).toEqual([id]);
  });

  test("the first write a workspace folds dispatches the events of its own records", async () => {
    const repo = await makeFixtureRepo("dispatch-first-write");
    cleanups.push(repo.cleanup);
    const { invocations, invoker } = recordingInvoker();
    const opened = await Workspace.open({
      dir: repo.workspace,
      scope: repo.scope,
      now: fixedClock(FIXED_INSTANT),
      subscriptionInvoker: invoker,
    });
    await installSubscriber(repo, [subscriptionOn(`${SUBSCRIBER}/on-claim`, "claim.put")]);
    expect(opened.index.watermark()).toBeNull();

    const [id] = await opened.put([{ kind: "claim", value: tripleClaim("first") }]);

    expect(invocations.map((invocation) => (invocation.event.payload as { id: string }).id)).toEqual([id]);
  });

  test("a workspace with no subscription installed reaches no invoker when it writes", async () => {
    const { opened } = await openSubscribed("dispatch-nothing-installed", [], unreachableInvoker);
    const eventsRead = vi.spyOn(opened.index, "eventsAfter");

    const [id] = await opened.put([{ kind: "claim", value: tripleClaim("unsubscribed") }]);

    expect(opened.read(id!)).toEqual(tripleClaim("unsubscribed"));
    expect(eventsRead).not.toHaveBeenCalled();
  });

  test("a subscription declaring no const on name is dispatched nothing", async () => {
    const { invocations, invoker } = recordingInvoker();
    const unnamed = entry("subscription", `${SUBSCRIBER}/on-anything`, {});
    const { opened } = await openSubscribed("dispatch-unnamed", [unnamed], invoker);

    await opened.put([{ kind: "claim", value: tripleClaim("unnamed") }]);

    expect(invocations).toEqual([]);
  });

  test("a receipt a dispatch minted is readable through the workspace that wrote, with no second open", async () => {
    const { invoker } = recordingInvoker(() => ({
      kind: "request",
      needs: [{ kind: "run", recipe: PRINTING_RECIPE }],
    }));
    const { opened, repo } = await openSubscribed(
      "dispatch-receipt-read",
      [subscriptionOn(`${SUBSCRIBER}/on-claim`, "claim.put")],
      invoker,
    );

    await opened.put([{ kind: "claim", value: tripleClaim("receipted") }]);

    const fresh = new IndexDb();
    await fresh.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
    const [minted] = fresh.eventsAfter()!.filter((row) => row.kind === "run.recorded");
    expect(minted).toBeDefined();
    expect(opened.read(minted!.recordId).kind).toBe("run");
  });

  test("a run a dispatch asks for naming a binary no installed module declares mints no receipt, and the write it was dispatched for still lands", async () => {
    const { invoker } = recordingInvoker(() => ({
      kind: "request",
      needs: [{ kind: "run", recipe: { ...PRINTING_RECIPE, command: ["true"] } }],
    }));
    const { opened, repo } = await openSubscribed(
      "dispatch-undeclared-binary",
      [subscriptionOn(`${SUBSCRIBER}/on-claim`, "claim.put")],
      invoker,
    );

    const [claimId] = await opened.put([{ kind: "claim", value: tripleClaim("undeclared") }]);

    const fresh = new IndexDb();
    await fresh.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
    expect(fresh.recordById(claimId!)).toBeDefined();
    expect(fresh.eventsAfter()!.filter((row) => row.kind === "run.recorded")).toEqual([]);
  });

  test("a subscription's error answer is reported to the opener's trace with the subscription, its version and the event, and the write it followed still lands", async () => {
    const traces: SubscriptionTrace[] = [];
    const error = { code: "contribution-threw", data: { why: "no" }, message: "the sink threw" } as const;
    const { invoker } = recordingInvoker(() => ({ kind: "error", error }));
    const repo = await makeFixtureRepo("dispatch-error-trace");
    cleanups.push(repo.cleanup);
    await installSubscriber(repo, [subscriptionOn(`${SUBSCRIBER}/on-claim`, "claim.put")]);
    const opened = await Workspace.open({
      dir: repo.workspace,
      scope: repo.scope,
      now: fixedClock(FIXED_INSTANT),
      subscriptionInvoker: invoker,
      onSubscriptionTrace: async (trace) => {
        traces.push(trace);
      },
    });

    const [claimId] = await opened.put([{ kind: "claim", value: tripleClaim("traced error") }]);

    expect(traces).toEqual([
      {
        subscription: `${SUBSCRIBER}/on-claim`,
        version: "1",
        event: { name: "claim.put", payload: { id: claimId, about: claimId, at: await opened.store.tip() } },
        error,
      },
    ]);
    expect(opened.read(claimId!)).toEqual(tripleClaim("traced error"));
  });

  test("a need of a subscription's run the kernel refuses is reported to the opener's trace under that subscription", async () => {
    const traces: SubscriptionTrace[] = [];
    const { invoker } = recordingInvoker(() => ({
      kind: "request",
      needs: [{ kind: "run", recipe: { ...PRINTING_RECIPE, command: ["true"] } }],
    }));
    const repo = await makeFixtureRepo("dispatch-refused-need-trace");
    cleanups.push(repo.cleanup);
    await installSubscriber(repo, [subscriptionOn(`${SUBSCRIBER}/on-claim`, "claim.put")]);
    const opened = await Workspace.open({
      dir: repo.workspace,
      scope: repo.scope,
      now: fixedClock(FIXED_INSTANT),
      subscriptionInvoker: invoker,
      onSubscriptionTrace: async (trace) => {
        traces.push(trace);
      },
    });

    await opened.put([{ kind: "claim", value: tripleClaim("traced refusal") }]);

    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      subscription: `${SUBSCRIBER}/on-claim`,
      event: { name: "claim.put" },
      error: { code: "need-refused" },
    });
  });

  test("a trace sink that throws refuses the call after the write landed, with the receipts the dispatch minted folded", async () => {
    const { invoker } = recordingInvoker((subscription) =>
      subscription.entry.id === `${SUBSCRIBER}/on-claim`
        ? { kind: "request", needs: [{ kind: "run", recipe: PRINTING_RECIPE }] }
        : { kind: "error", error: { code: "contribution-threw", data: null, message: "the sink threw" } },
    );
    const repo = await makeFixtureRepo("dispatch-throwing-trace");
    cleanups.push(repo.cleanup);
    await installSubscriber(repo, [
      subscriptionOn(`${SUBSCRIBER}/on-claim`, "claim.put"),
      subscriptionOn(`${SUBSCRIBER}/on-claim-too`, "claim.put"),
    ]);
    const opened = await Workspace.open({
      dir: repo.workspace,
      scope: repo.scope,
      now: fixedClock(FIXED_INSTANT),
      subscriptionInvoker: invoker,
      onSubscriptionTrace: async () => {
        throw new Error("the log is not writable");
      },
    });

    const refused = await opened
      .put([{ kind: "claim", value: tripleClaim("unwritable trace") }])
      .catch((e: unknown) => e);

    expect(refused).toMatchObject({ message: "the log is not writable" });
    const [minted] = opened.index.eventsAfter()!.filter((row) => row.kind === "run.recorded");
    expect(minted).toBeDefined();
    expect(opened.read(minted!.recordId).kind).toBe("run");
  });

  test("a trace sink that throws on one trace is still handed every later trace of the dispatch, and the first failure is the call's", async () => {
    const { invoker } = recordingInvoker(() => ({
      kind: "error",
      error: { code: "contribution-threw", data: null, message: "answered an error" },
    }));
    const repo = await makeFixtureRepo("dispatch-throwing-first-trace");
    cleanups.push(repo.cleanup);
    await installSubscriber(repo, [
      subscriptionOn(`${SUBSCRIBER}/on-claim`, "claim.put"),
      subscriptionOn(`${SUBSCRIBER}/on-claim-too`, "claim.put"),
    ]);
    const handed: string[] = [];
    const opened = await Workspace.open({
      dir: repo.workspace,
      scope: repo.scope,
      now: fixedClock(FIXED_INSTANT),
      subscriptionInvoker: invoker,
      onSubscriptionTrace: async (trace) => {
        handed.push(trace.subscription);
        throw new Error(`the log refused ${trace.subscription}`);
      },
    });

    const refused = await opened
      .put([{ kind: "claim", value: tripleClaim("two unwritable traces") }])
      .catch((e: unknown) => e);

    expect([...handed].sort()).toEqual([`${SUBSCRIBER}/on-claim`, `${SUBSCRIBER}/on-claim-too`]);
    expect(refused).toMatchObject({ message: `the log refused ${handed[0]}` });
  });

  test("a subscription that answers a verdict and one whose needs are all performed leave no trace", async () => {
    const traces: SubscriptionTrace[] = [];
    const { invoker } = recordingInvoker((subscription) =>
      subscription.entry.id === `${SUBSCRIBER}/on-claim`
        ? { kind: "request", needs: [{ kind: "run", recipe: PRINTING_RECIPE }] }
        : NOTHING_TO_DO,
    );
    const repo = await makeFixtureRepo("dispatch-no-trace");
    cleanups.push(repo.cleanup);
    await installSubscriber(repo, [
      subscriptionOn(`${SUBSCRIBER}/on-claim`, "claim.put"),
      subscriptionOn(`${SUBSCRIBER}/on-claim-too`, "claim.put"),
    ]);
    const opened = await Workspace.open({
      dir: repo.workspace,
      scope: repo.scope,
      now: fixedClock(FIXED_INSTANT),
      subscriptionInvoker: invoker,
      onSubscriptionTrace: async (trace) => {
        traces.push(trace);
      },
    });

    await opened.put([{ kind: "claim", value: tripleClaim("untraced") }]);

    expect(traces).toEqual([]);
  });

  test("a workspace opened under a pinned clock dates the commit its write lands in and the run receipt its dispatch mints with that instant, and a workspace opened under a different pinned clock dates both with the different instant", async () => {
    async function datedWrite(scope: string, instant: string): Promise<{ committed: string; started: string }> {
      const { invoker } = recordingInvoker(() => ({
        kind: "request",
        needs: [{ kind: "run", recipe: PRINTING_RECIPE }],
      }));
      const { opened, repo } = await openSubscribed(
        scope,
        [subscriptionOn(`${SUBSCRIBER}/on-claim`, "claim.put")],
        invoker,
        instant,
      );

      const [claimId] = await opened.put([{ kind: "claim", value: tripleClaim("dated-write") }]);

      const walked: CommitChanges[] = [];
      for await (const commit of new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }).changesSince(null)) {
        walked.push(commit);
      }
      const own = walked.find((commit) => commit.changed.some(({ path }) => path === recordPath("claim", claimId!)));
      expect(own).toBeDefined();

      const fresh = new IndexDb();
      await fresh.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
      const minted = fresh.eventsAfter()!.find((row) => row.kind === "run.recorded");
      expect(minted).toBeDefined();
      const receipt = opened.read(minted!.recordId);
      if (receipt.kind !== "run") {
        throw new Error("the dispatch minted a record that is not a run");
      }

      return {
        committed: new Date(own!.committedAt).toISOString(),
        started: performedRun(minted!.recordId, receipt).observation.startedAt!,
      };
    }

    const first = await datedWrite("dispatch-clock-first", FIXED_INSTANT);
    expect(first.committed).toBe(FIXED_INSTANT);
    expect(first.started).toBe(FIXED_INSTANT);

    const second = await datedWrite("dispatch-clock-second", OTHER_INSTANT);
    expect(second.committed).toBe(OTHER_INSTANT);
    expect(second.started).toBe(OTHER_INSTANT);
  });

  test("a subscription's run declaring a name only the workspace's configuration marks secret records it as a keyed hash", async () => {
    const recipe: RunRecipe = { ...PRINTING_RECIPE, declared: [{ name: "LAYER_TOKEN", secret: false }] };
    const { invoker } = recordingInvoker(() => ({ kind: "request", needs: [{ kind: "run", recipe }] }));
    const repo = await makeFixtureRepo("dispatch-layer-declarations");
    cleanups.push(repo.cleanup);
    await installSubscriber(repo, [subscriptionOn(`${SUBSCRIBER}/on-claim`, "claim.put")]);
    await writeTrustFile(repo.ctx, "config.json", JSON.stringify({ declaredNames: { LAYER_TOKEN: { secret: true } } }));
    const opened = await Workspace.open({
      dir: repo.workspace,
      scope: repo.scope,
      now: fixedClock(FIXED_INSTANT),
      subscriptionInvoker: invoker,
    });
    await writeFile(
      join(opened.localDir, "bindings.json"),
      JSON.stringify({ LAYER_TOKEN: { secret: false, value: "bound-plain-declared-secret" } }),
      { mode: 0o600 },
    );

    await opened.put([{ kind: "claim", value: tripleClaim("declared") }]);

    const fresh = new IndexDb();
    await fresh.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
    const [minted] = fresh.eventsAfter()!.filter((row) => row.kind === "run.recorded");
    const receipt = opened.read(minted!.recordId);
    if (receipt.kind !== "run") {
      throw new Error("the dispatch minted a record that is not a run");
    }
    expect(performedRun(minted!.recordId, receipt).observation.bindings).toEqual([
      expect.objectContaining({ name: "LAYER_TOKEN", secret: true, value: null, keyedHash: expect.any(String) }),
    ]);
  });

  test("a dispatch past the age the resolution-age slot allows performs its run again, and one within it reuses the receipt", async () => {
    const { invoker } = recordingInvoker(() => ({
      kind: "request",
      needs: [{ kind: "run", recipe: PRINTING_RECIPE }],
    }));
    const repo = await makeFixtureRepo("dispatch-resolution-age");
    cleanups.push(repo.cleanup);
    await installPack(repo, RESOLUTION_AGE_PACK, [RESOLUTION_AGE_SLOT]);
    await installSubscriber(repo, [subscriptionOn(`${SUBSCRIBER}/on-claim`, "claim.put")]);

    expect(await runsPutByWriteAt(repo, invoker, FIXED_INSTANT, "first")).toBe(1);
    expect(await runsPutByWriteAt(repo, invoker, FIXED_INSTANT, "same instant")).toBe(0);
    expect(await runsPutByWriteAt(repo, invoker, OTHER_INSTANT, "later")).toBe(1);
  });

  test("a dispatch in a workspace declaring no resolution-age slot reuses a receipt of any age", async () => {
    const { invoker } = recordingInvoker(() => ({
      kind: "request",
      needs: [{ kind: "run", recipe: PRINTING_RECIPE }],
    }));
    const repo = await makeFixtureRepo("dispatch-no-resolution-age");
    cleanups.push(repo.cleanup);
    await installSubscriber(repo, [subscriptionOn(`${SUBSCRIBER}/on-claim`, "claim.put")]);

    expect(await runsPutByWriteAt(repo, invoker, FIXED_INSTANT, "first")).toBe(1);
    expect(await runsPutByWriteAt(repo, invoker, OTHER_INSTANT, "later")).toBe(0);
  });

  test("a write raising a subscribed event over a fold whose slot set the registry refuses lands its batch, reaches no subscription, and refuses naming the slot", async () => {
    const { invocations, invoker } = recordingInvoker(() => ({
      kind: "request",
      needs: [{ kind: "run", recipe: PRINTING_RECIPE }],
    }));
    const repo = await makeFixtureRepo("dispatch-unreadable-slot-set");
    cleanups.push(repo.cleanup);
    // Install refuses this declaration, so it lands as a module record arriving through git would.
    const broken: ModuleRecord = {
      kind: "module",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.module,
      name: "broken-pack",
      version: versionString("1.0.0"),
      manifest: manifestWithContributions([entry("slot", "broken-pack/limit", {})]),
      bundle: recordId({ marker: "bundle-for-broken-pack" }),
      build: recordId({ marker: "build-for-broken-pack" }),
    };
    await new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }).put("module", broken);
    await installSubscriber(repo, [subscriptionOn(`${SUBSCRIBER}/on-claim`, "claim.put")]);
    const opened = await Workspace.open({
      dir: repo.workspace,
      scope: repo.scope,
      now: fixedClock(FIXED_INSTANT),
      subscriptionInvoker: invoker,
    });

    const write = opened.put([{ kind: "claim", value: tripleClaim("landed under an unreadable slot set") }]);

    await expect(write).rejects.toBeInstanceOf(SlotRefusedError);
    await expect(write).rejects.toThrow("broken-pack/limit");
    const fresh = new IndexDb();
    await fresh.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
    const events = fresh.eventsAfter()!;
    expect(events.filter((row) => row.kind === "claim.put")).toHaveLength(1);
    expect(events.filter((row) => row.kind === "run.recorded")).toHaveLength(0);
    expect(invocations).toEqual([]);
  });

  test("opening a workspace over records already written dispatches nothing", async () => {
    const repo = await makeFixtureRepo("dispatch-open");
    cleanups.push(repo.cleanup);
    await installSubscriber(repo, [subscriptionOn(`${SUBSCRIBER}/on-claim`, "claim.put")]);
    const [held] = await writeFixtureRecords(repo, [{ kind: "claim", value: tripleClaim("already held") }]);

    const opened = await Workspace.open({
      dir: repo.workspace,
      scope: repo.scope,
      now: repo.now,
      subscriptionInvoker: unreachableInvoker,
    });

    expect(opened.read(held!)).toEqual(tripleClaim("already held"));
  });
});

/** Withholds whatever `hidden` names when it is judged. */
async function withholding(author: Workspace, hidden: ReadonlySet<RecordId>): Promise<Admission> {
  return {
    digest: JSON.stringify([...hidden].sort()),
    through: author.index.watermark(),
    trust: author.matrix.commit,
    admits: ({ id }) => !hidden.has(id),
    withholds: (id) => hidden.has(id),
    judgedAgain: () => withholding(author, hidden),
  };
}

/** Cleared to `writer`, withholding whatever `hidden` names each time the admission is judged. */
async function openClearedSubscribed(
  scope: string,
  invoker: NonNullable<WorkspaceOptions["subscriptionInvoker"]>,
  hidden: ReadonlySet<RecordId>,
): Promise<Workspace> {
  const repo = await makeFixtureRepo(scope);
  cleanups.push(repo.cleanup);
  await installSubscriber(repo, [subscriptionOn(`${SUBSCRIBER}/on-claim`, "claim.put")]);
  await writeTrustFile(repo.ctx, "audiences", "writer\n");
  return Workspace.open({
    dir: repo.workspace,
    scope: repo.scope,
    now: fixedClock(FIXED_INSTANT),
    subscriptionInvoker: invoker,
    clearance: { audience: "writer" as Audience, admission: (author) => withholding(author, hidden) },
  });
}

describe("a write through a cleared workspace dispatches only what its fold admits", () => {
  test("a record the cleared fold withholds raises no event, though the write landed it", async () => {
    const { invocations, invoker } = recordingInvoker();
    const withheld = tripleClaim("withheld");
    const opened = await openClearedSubscribed("cleared-dispatch", invoker, new Set([recordId(withheld)]));

    const [admitted] = await opened.put([
      { kind: "claim", value: tripleClaim("admitted") },
      { kind: "claim", value: withheld },
    ]);

    expect(invocations.map((invocation) => (invocation.event.payload as { id: string }).id)).toEqual([admitted]);
  });

  test("a write that moves what the clearance admits refolds the cleared fold and still dispatches its own records", async () => {
    const { invocations, invoker } = recordingInvoker();
    const hidden = new Set<RecordId>();
    const opened = await openClearedSubscribed("cleared-refold", invoker, hidden);
    const [first] = await opened.put([{ kind: "claim", value: tripleClaim("first") }]);

    hidden.add(first!);
    const [second] = await opened.put([{ kind: "claim", value: tripleClaim("second") }]);

    expect(opened.index.holds(first!)).toBe(false);
    expect(invocations.map((invocation) => (invocation.event.payload as { id: string }).id)).toEqual([first, second]);
  });

  test("a run a dispatch asks for where no station image is configured is refused to its subscription, and the write lands", async () => {
    const { invoker } = recordingInvoker(() => ({
      kind: "request",
      needs: [{ kind: "run", recipe: PRINTING_RECIPE }],
    }));
    const opened = await openClearedSubscribed("cleared-dispatch-run", invoker, new Set());
    const asks = tripleClaim("asks-for-a-run");

    const [written] = await opened.put([{ kind: "claim", value: asks }]);

    expect(opened.read(written!)).toEqual(asks);
    expect(opened.index.eventsAfter()!.filter((row) => row.kind === "run.recorded")).toEqual([]);
  });
});

const PACK = "example.pack";
const PACK_TYPE = `${PACK}/finding@1`;
const PACK_DIMENSION = `${PACK}/severity`;

const PACK_CONTRIBUTIONS: readonly ContributionEntry[] = [
  entry("claim-type", PACK_TYPE, { identityDimensions: ["case"] }),
  entry("dimension", PACK_DIMENSION, { name: "severity", type: "ordered", data: { order: "numeric" } }),
];

describe("a write through the workspace folds itself", () => {
  test("a record put through the workspace is found by a read on the same workspace, with no second open", async () => {
    const repo = await makeFixtureRepo("workspace-put-folds");
    cleanups.push(repo.cleanup);
    await installPack(repo, PACK, PACK_CONTRIBUTIONS);
    const opened = await Workspace.open({ dir: repo.workspace, scope: repo.scope, now: fixedClock(FIXED_INSTANT) });
    const claim = claimOf(opened.claimTypes.get(PACK_TYPE)!, { case: "put-then-read" }, "the finding put then read");

    const [id] = await opened.put([{ kind: "claim", value: claim }]);

    expect(opened.read(id!)).toEqual(claim);
  });
});

describe("the claim types and dimensions an installed module contributes", () => {
  test("a workspace opened over the fold holding them validates a claim of the contributed type and refuses one of a type nothing declares", async () => {
    const repo = await makeFixtureRepo("contributed-claim-type");
    cleanups.push(repo.cleanup);
    await installPack(repo, PACK, PACK_CONTRIBUTIONS);

    const opened = await Workspace.open({ dir: repo.workspace, scope: repo.scope, now: fixedClock(FIXED_INSTANT) });

    const declaration = opened.claimTypes.get(PACK_TYPE);
    expect(declaration?.identityDimensions).toEqual(["case"]);
    const claim = claimOf(declaration!, { case: "reported" }, "the reported finding");
    const [id] = await opened.put([{ kind: "claim", value: claim }]);
    expect(opened.read(id!)).toEqual(claim);
    await expect(
      opened.store.putMany([
        {
          kind: "claim",
          value: claimOf({ type: "undeclared@1", identityDimensions: ["case"] }, { case: "x" }, "undeclared"),
        },
      ]),
    ).rejects.toThrow("claim names an unregistered type: undeclared@1");
  });

  test("a workspace opened before the install sees neither, and one opened after sees both", async () => {
    const repo = await makeFixtureRepo("contributed-read-at-open");
    cleanups.push(repo.cleanup);
    const options: WorkspaceOptions = { dir: repo.workspace, scope: repo.scope, now: fixedClock(FIXED_INSTANT) };
    const before = await Workspace.open(options);

    await installPack(repo, PACK, PACK_CONTRIBUTIONS);
    const after = await Workspace.open(options);

    expect(before.claimTypes.has(PACK_TYPE)).toBe(false);
    expect(before.dimensions.has("severity")).toBe(false);
    expect(after.claimTypes.has(PACK_TYPE)).toBe(true);
    expect(after.dimensions.get("severity")).toEqual({
      name: "severity",
      type: "ordered",
      data: { order: "numeric" },
    });
  });
});

/** Two readings are equal only when nothing inside the entry changed. */
async function contentsOf(path: string): Promise<unknown> {
  if (!(await stat(path)).isDirectory()) {
    return await readFile(path, "utf8");
  }
  const entries: Record<string, unknown> = {};
  for (const name of (await readdir(path)).sort()) {
    entries[name] = await contentsOf(join(path, name));
  }
  return entries;
}

/** `allowed-signers` holds the trust branch's seeded bytes, since opening rewrites it from them. */
const WORKSPACE_LOCAL_ENTRIES: ReadonlyArray<{ name: string; directory: boolean; bytes: string }> = [
  { name: "open", directory: true, bytes: "a case worktree\n" },
  { name: "keys.json", directory: false, bytes: '{"kept":"keys"}\n' },
  { name: "bindings.json", directory: false, bytes: '{"kept":"bindings"}\n' },
  { name: "checkouts.json", directory: false, bytes: '{"kept":"checkouts"}\n' },
  { name: "signer.json", directory: false, bytes: '{"kept":"signer"}\n' },
  { name: "allowed-signers", directory: false, bytes: "" },
  { name: "calls", directory: true, bytes: "a call\n" },
];

describe("a scope's name cannot collide with what the workspace keeps", () => {
  test.each(WORKSPACE_LOCAL_ENTRIES)(
    "a workspace opened under the scope $name folds apart from the $name entry under local/ and leaves it unchanged",
    async ({ name, directory, bytes }) => {
      const repo = await makeFixtureRepo(name);
      cleanups.push(repo.cleanup);
      const localDir = join(repo.ctx.gitDir, LOCAL_DIR);
      const entry = join(localDir, name);
      if (directory) {
        await mkdir(entry);
        await writeFile(join(entry, "kept"), bytes);
      } else {
        await writeFile(entry, bytes);
      }
      const before = await contentsOf(entry);

      await Workspace.open({ dir: repo.workspace, scope: name, now: fixedClock(FIXED_INSTANT) });

      expect((await stat(join(localDir, "scopes", name, "index.sqlite"))).isFile()).toBe(true);
      expect(await contentsOf(entry)).toEqual(before);
    },
  );

  test("a workspace opened under the scope scopes folds in its own directory inside scopes/, not in scopes/ itself", async () => {
    const repo = await makeFixtureRepo("scopes");
    cleanups.push(repo.cleanup);
    const scopesDir = join(repo.ctx.gitDir, LOCAL_DIR, "scopes");

    await Workspace.open({ dir: repo.workspace, scope: "scopes", now: fixedClock(FIXED_INSTANT) });

    expect(await readdir(scopesDir)).toEqual(["scopes"]);
    expect((await stat(join(scopesDir, "scopes", "index.sqlite"))).isFile()).toBe(true);
  });

  test("a workspace whose local/ holds a fold beside the workspace's files and no scopes/ opens, folds from the log, and leaves that fold where it is", async () => {
    const repo = await makeFixtureRepo("before-scopes");
    cleanups.push(repo.cleanup);
    const localDir = join(repo.ctx.gitDir, LOCAL_DIR);
    const [id] = await writeFixtureRecords(repo, [{ kind: "claim", value: tripleClaim("written before") }]);
    const besideDir = join(localDir, repo.scope);
    await mkdir(besideDir);
    await new IndexDb(join(besideDir, "index.sqlite")).fold(
      new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }),
    );
    const beside = await readFile(join(besideDir, "index.sqlite"));
    expect(await readdir(localDir)).not.toContain("scopes");

    const opened = await Workspace.open({ dir: repo.workspace, scope: repo.scope, now: fixedClock(FIXED_INSTANT) });

    expect(opened.read(id!)).toEqual(tripleClaim("written before"));
    expect((await stat(scopeIndexPath(repo.ctx.gitDir, repo.scope))).isFile()).toBe(true);
    expect(await readFile(join(besideDir, "index.sqlite"))).toEqual(beside);
  });
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function refusalOfOpen(dir: string): Promise<unknown> {
  return Workspace.open({ dir, scope: "default", now: fixedClock(FIXED_INSTANT) }).then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("a workspace that arrives without local/, and a directory holding none", () => {
  test("a workspace cloned without local/ opens, and its fold rebuilds from the log", async () => {
    const repo = await makeFixtureRepo("cloned");
    cleanups.push(repo.cleanup);
    const [id] = await writeFixtureRecords(repo, [{ kind: "claim", value: tripleClaim("written before the clone") }]);
    const clone = await temporaryDirectory("musai-clone-");
    const gitDir = join(clone, MUSAI_DIR);
    await execa("git", ["clone", "--quiet", "--bare", repo.ctx.gitDir, gitDir]);
    expect(await readdir(gitDir)).not.toContain(LOCAL_DIR);
    expect(await ownConfigValue(gitDir, "gc.auto")).toBeNull();

    const opened = await Workspace.open({ dir: clone, scope: repo.scope, now: fixedClock(FIXED_INSTANT) });

    expect(opened.read(id!)).toEqual(tripleClaim("written before the clone"));
    expect((await stat(scopeIndexPath(gitDir, repo.scope))).isFile()).toBe(true);
    expect(await ownConfigValue(gitDir, "gc.auto")).toBe("0");
    expect(await ownConfigValue(gitDir, "gc.pruneExpire")).toBe("never");
  });

  test("an open that finds local/ asks the store nothing, so a collection setting its configuration lacks stays unset", async () => {
    const repo = await makeFixtureRepo("found-local");
    cleanups.push(repo.cleanup);
    await writeOwnConfig(repo.ctx.gitDir, ["--unset", "gc.auto"]);

    await Workspace.open({ dir: repo.workspace, scope: repo.scope, now: fixedClock(FIXED_INSTANT) });

    expect(await ownConfigValue(repo.ctx.gitDir, "gc.auto")).toBeNull();
  });

  test("a directory holding no workspace refuses workspace-incomplete, advising init", async () => {
    const root = await temporaryDirectory("musai-no-workspace-");
    await mkdir(join(root, "empty"));
    await mkdir(join(root, "emptied", MUSAI_DIR), { recursive: true });

    for (const dir of [join(root, "missing"), join(root, "empty"), join(root, "emptied")]) {
      const before = await contentsOf(root);
      const refusal = await refusalOfOpen(dir);

      expect(refusal).toBeInstanceOf(KernelError);
      expect(refusal).toMatchObject({ reason: "workspace-incomplete", about: [dir] });
      expect((refusal as KernelError).detail).toContain(`\`init ${dir}\``);
      expect(await contentsOf(root)).toEqual(before);
    }
  });

  test("a .musai holding content that is no workspace refuses workspace-incomplete, naming what is there and advising nothing", async () => {
    const root = await temporaryDirectory("musai-foreign-");
    await execa("git", ["init", "--quiet", join(root, "non-bare", MUSAI_DIR)]);
    await execa("git", ["init", "--quiet", "--bare", join(root, "bare-without-main", MUSAI_DIR)]);
    await mkdir(join(root, "unrelated", MUSAI_DIR), { recursive: true });
    await writeFile(join(root, "unrelated", MUSAI_DIR, "unrelated.txt"), "hello\n");
    await mkdir(join(root, "file"));
    await writeFile(join(root, "file", MUSAI_DIR), "a file where the repository goes\n");

    for (const dir of ["non-bare", "bare-without-main", "unrelated", "file"].map((name) => join(root, name))) {
      const before = await contentsOf(root);
      const refusal = await refusalOfOpen(dir);

      expect(refusal).toBeInstanceOf(KernelError);
      expect(refusal).toMatchObject({ reason: "workspace-incomplete", about: [dir] });
      expect((refusal as KernelError).detail).toContain(join(dir, MUSAI_DIR));
      expect((refusal as KernelError).detail).not.toContain("`init");
      expect(await contentsOf(root)).toEqual(before);
    }
  });

  test("a file given as the workspace's directory refuses workspace-incomplete, advising nothing", async () => {
    const root = await temporaryDirectory("musai-file-workspace-");
    const dir = join(root, "plain");
    await writeFile(dir, "a file where the workspace's directory goes\n");
    const before = await contentsOf(root);

    const refusal = await refusalOfOpen(dir);

    expect(refusal).toBeInstanceOf(KernelError);
    expect(refusal).toMatchObject({ reason: "workspace-incomplete", about: [dir] });
    expect((refusal as KernelError).detail).not.toContain("`init");
    expect(await contentsOf(root)).toEqual(before);
  });
});
