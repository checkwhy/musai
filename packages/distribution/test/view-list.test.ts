import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isOperationError, openWorkspace, runHandler } from "@musai/api-core";
import { buildModule } from "@musai/devkit";
import { IndexDb } from "@musai/fold";
import { ENVELOPE_PROTOCOL } from "@musai/modules";
import {
  type CaseRecord,
  type ClaimRecord,
  type ClaimTypeDeclaration,
  CURRENT_SCHEMA_VERSIONS,
  canonicalBytes,
  claimTypesFrom,
  type ModuleRecord,
  type RecordId,
  recordId,
  slotFor,
  versionString,
} from "@musai/records";
import { initWorkspace, Store } from "@musai/store";
import { blobStoreOf, declareClaimTypes, fixedClock } from "@musai/test-support";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { findCaseForClaim, findCaseRecord } from "../src/cases.js";
import { askMenu } from "../src/gate/menu.js";
import { caseStatus } from "../src/ops/case-status.js";
import { gateAnswer, gateAsk, gatePending } from "../src/ops/gate.js";
import { viewRun } from "../src/ops/view.js";
import { renderDossier } from "../src/view/render.js";
import { repoGitDir } from "./repo-git-dir.js";

const CORE_MODULE_DIR = fileURLToPath(new URL("../../core-module", import.meta.url));
const CLAIM_TYPE = "musai.view-list-fixture-test/claim@1";
const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: CLAIM_TYPE, identityDimensions: ["id"] };
const CLAIM_TYPES = claimTypesFrom([CLAIM_DECLARATION]);
const now = fixedClock("2026-08-30T00:00:00.000Z");

interface ClaimSpec {
  readonly id: string;
  readonly rendering: string;
  readonly gateClass?: "intent" | "judgment" | "evidence" | "publish";
  readonly exclusiveGroup?: string;
}

async function mintClaim(store: Store, spec: ClaimSpec): Promise<RecordId> {
  const conditions: Record<string, string> = { id: spec.id };
  if (spec.gateClass !== undefined) {
    conditions["gateClass"] = spec.gateClass;
  }
  const claim: ClaimRecord = {
    kind: "claim",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: CLAIM_TYPE,
    about: [],
    slot: slotFor(CLAIM_DECLARATION, conditions),
    conditions,
    canonical: conditions,
    rendering: spec.rendering,
    evidence: [],
    exclusiveGroup: spec.exclusiveGroup ?? null,
  };
  const [id] = await store.putMany([{ kind: "claim", value: claim }]);
  return id!;
}

async function bookCase(
  store: Store,
  slug: string,
  claimIds: readonly RecordId[],
  presetContribution = "musai.core/bare",
): Promise<RecordId> {
  const caseRecord: CaseRecord = {
    kind: "case",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.case,
    type: null,
    slug,
    claims: [...claimIds],
    preset: {
      module: "musai.core",
      contribution: presetContribution,
      moduleRecord: recordId({ marker: "view-list-fixture" }),
    },
    projectCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    overrides: {},
    evaluatorVersion: versionString("1"),
  };
  const [id] = await store.putMany([{ kind: "case", value: caseRecord }]);
  return id!;
}

async function decide(workspace: string, scope: string, claimId: RecordId, choice: string): Promise<void> {
  const asked = await runHandler(gateAsk, { claim: claimId }, { workspace, scope, now });
  await runHandler(
    gateAnswer,
    {
      pending: claimId,
      brief: asked.brief,
      choice,
      reason: "the fixture decides",
    },
    { workspace, scope, now, via: "tty", principalName: "person@example.com" },
  );
}

describe("case.status@2 and view.run@1", () => {
  let workspace: string;
  const scope = "default";

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-view-list-"));
    await initWorkspace(workspace, { now });
    await declareClaimTypes(
      new Store({ ctx: { gitDir: join(workspace, ".musai") }, scope, now, claimTypes: CLAIM_TYPES }),
      [CLAIM_DECLARATION],
    );
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  function ctx() {
    return { workspace, scope, now };
  }

  function storeAt(): Store {
    return new Store({ ctx: { gitDir: join(workspace, ".musai") }, scope, now, claimTypes: CLAIM_TYPES });
  }

  /** A store whose commits carry `instant`, so bookings can be dated apart or alike on purpose. */
  function storeDatedAt(instant: string): Store {
    return new Store({
      ctx: { gitDir: join(workspace, ".musai") },
      scope,
      now: fixedClock(instant),
      claimTypes: CLAIM_TYPES,
    });
  }

  test("case.status@2 finds the first pending gate in playbook order, skipping a decided gate and a non-gate claim, and tallies holds/fails/open across every claim", async () => {
    const store = storeAt();
    const decided = await mintClaim(store, {
      id: "decided",
      rendering: "the fixture already ruled this one",
      gateClass: "judgment",
    });
    const plain = await mintClaim(store, { id: "plain", rendering: "a claim with no gate class at all" });
    const pending = await mintClaim(store, {
      id: "pending",
      rendering: "the fixture leaves this one open",
      gateClass: "evidence",
    });
    await bookCase(store, "counted-case", [decided, plain, pending]);

    await decide(workspace, scope, decided, "holds");

    const output = await runHandler(caseStatus, { case: "counted-case" }, ctx());
    expect(output.next).toEqual({ gate: pending, class: "evidence" });
    expect(output.done).toBe(false);
    expect(output.counts).toEqual({ holds: 1, fails: 0, open: 2, notChosen: 0 });
  }, 30_000);

  test("a case whose claims all hold is done", async () => {
    const store = storeAt();
    const first = await mintClaim(store, { id: "first", rendering: "this one holds", gateClass: "judgment" });
    const second = await mintClaim(store, { id: "second", rendering: "so does this", gateClass: "judgment" });
    await bookCase(store, "held-case", [first, second]);

    await decide(workspace, scope, first, "holds");
    await decide(workspace, scope, second, "holds");

    const output = await runHandler(caseStatus, { case: "held-case" }, ctx());
    expect(output.next).toBeNull();
    expect(output.done).toBe(true);
    expect(output.reason).toBeUndefined();
    expect(output.counts).toEqual({ holds: 2, fails: 0, open: 0, notChosen: 0 });
    expect(caseStatus.renderText!(output).split("\n")[0]).toBe("done");
  }, 30_000);

  test("a failed claim leaves its case open though no gate awaits an answer", async () => {
    const store = storeAt();
    const held = await mintClaim(store, { id: "held", rendering: "this one holds", gateClass: "judgment" });
    const failed = await mintClaim(store, { id: "failed", rendering: "this one fails", gateClass: "judgment" });
    await bookCase(store, "failing-case", [held, failed]);

    await decide(workspace, scope, held, "holds");
    await decide(workspace, scope, failed, "fails");

    const output = await runHandler(caseStatus, { case: "failing-case" }, ctx());
    expect(output.next).toBeNull();
    expect(output.done).toBe(false);
    expect(output.reason).toBe("claim-fails");
    expect(output.counts).toEqual({ holds: 1, fails: 1, open: 0, notChosen: 0 });
    expect(caseStatus.renderText!(output)).toContain("fails");
  }, 30_000);

  async function installCoreModule(): Promise<void> {
    const sourceGitDir = await repoGitDir();
    const store = storeAt();
    const index = new IndexDb(":memory:");
    await index.fold(store);
    await buildModule(CORE_MODULE_DIR, store, {
      blobs: blobStoreOf(workspace),
      index,
      sourceGitDir,
      now: fixedClock("2026-08-30T00:00:00.000Z"),
    });
  }

  /** A menu of `options`, every one an intent gate in the group `the-menu`. */
  async function menuOf(store: Store, options: readonly string[]): Promise<RecordId[]> {
    const ids: RecordId[] = [];
    for (const option of options) {
      ids.push(
        await mintClaim(store, {
          id: option,
          rendering: `the option ${option}`,
          gateClass: "intent",
          exclusiveGroup: "the-menu",
        }),
      );
    }
    return ids;
  }

  test("a decided menu counts its chosen option as holding and each other option as not chosen, never failing", async () => {
    const store = storeAt();
    const [chosen, ...passedOver] = await menuOf(store, ["chosen", "passed-over", "also-passed-over"]);
    await bookCase(store, "menu-case", [chosen!, ...passedOver]);

    await decide(workspace, scope, chosen!, chosen!);

    const output = await runHandler(caseStatus, { case: "menu-case" }, ctx());
    expect(output.counts).toEqual({ holds: 1, fails: 0, open: 0, notChosen: 2 });
    expect(output.done).toBe(true);
    expect(caseStatus.renderText!(output)).toBe("done\nholds 1, fails 0, open 0, not chosen 2");
  }, 30_000);

  test("a case citing no claim is open, and says it cites none", async () => {
    await bookCase(storeAt(), "empty-case", []);

    const output = await runHandler(caseStatus, { case: "empty-case" }, ctx());
    expect(output.done).toBe(false);
    expect(output.reason).toBe("cites-no-claim");
    expect(caseStatus.renderText!(output).split("\n")[0]).toBe("this case cites no claim");
  });

  test("a case whose only open claim answers to no gate is not done, since nothing settled it and no person was asked", async () => {
    const store = storeAt();
    const unbacked = await mintClaim(store, { id: "unbacked", rendering: "a claim no run backs and no gate offers" });
    await bookCase(store, "unbacked-case", [unbacked]);

    const output = await runHandler(caseStatus, { case: "unbacked-case" }, ctx());
    expect(output.next).toBeNull();
    expect(output.counts).toEqual({ holds: 0, fails: 0, open: 1, notChosen: 0 });
    expect(output.done).toBe(false);
    expect(output.reason).toBe("claim-open");
    expect(caseStatus.renderText!(output)).toContain("still open");
  });

  test("case.status@2 refuses a slug no case carries, by name", async () => {
    const error = await runHandler(caseStatus, { case: "no-such-case" }, ctx()).catch((caught: unknown) => caught);
    expect(isOperationError(error)).toBe(true);
    expect((error as { reason: string }).reason).toBe("no-such-record");
  });

  test("a booked case's own record carries no recency field", async () => {
    const store = storeAt();
    const caseId = await bookCase(store, "no-recency-on-record", []);
    const record = (await store.read(caseId, "case")) as unknown as Record<string, unknown>;
    expect(Object.keys(record)).not.toContain("recency");
  });

  describe("view.run@1, run through the distribution's own cases view", () => {
    test("a menu of three nobody has decided counts once as open, and list reads the case as progress --plan does", async () => {
      await installCoreModule();
      const store = storeAt();
      await bookCase(store, "undecided-menu-case", await menuOf(store, ["first", "second", "third"]));

      const previewed = await runHandler(caseStatus, { case: "undecided-menu-case" }, { ...ctx(), mode: "plan" });
      const listed = await runHandler(viewRun, {}, ctx());

      expect(previewed.counts).toEqual({ holds: 0, fails: 0, open: 1, notChosen: 0 });
      expect(previewed.reason).toBe("claim-open");
      expect(listed.rows).toEqual([expect.objectContaining({ status: "open", reason: previewed.reason })]);
    });

    test("a workspace with no cases returns an empty list, the CLI exits 0, and nothing claims the list was withheld", async () => {
      await installCoreModule();
      const output = await runHandler(viewRun, {}, ctx());
      expect(output.rows).toEqual([]);
      expect(output.unlisted).toBeUndefined();
      expect(viewRun.exitCode(output)).toBe(0);
    });

    test("lists a case's slug, kind, status and recency, filters by kind and status, conjoins two filters into one row, and a filter matching nothing returns an empty list", async () => {
      // Three real gate round trips and repeated listings run past the default budget.
      await installCoreModule();
      const store = storeAt();

      const openGate = await mintClaim(store, { id: "open-gate", rendering: "still open", gateClass: "judgment" });
      await bookCase(store, "pending-bugs-case", [openGate], "bugs.pack/triage");

      const heldGate = await mintClaim(store, { id: "held-gate", rendering: "already held", gateClass: "judgment" });
      await bookCase(store, "done-bugs-case", [heldGate], "bugs.pack/triage");
      await decide(workspace, scope, heldGate, "holds");

      const otherGate = await mintClaim(store, {
        id: "other-gate",
        rendering: "a different kind entirely",
        gateClass: "judgment",
      });
      await bookCase(store, "pending-tickets-case", [otherGate], "tickets.pack/fix");

      const all = await runHandler(viewRun, {}, ctx());
      expect(all.rows).toHaveLength(3);

      const bugsOnly = await runHandler(viewRun, { kind: "bugs.pack/triage" }, ctx());
      expect((bugsOnly.rows as Array<{ slug: string }>).map((row) => row.slug).sort()).toEqual([
        "done-bugs-case",
        "pending-bugs-case",
      ]);

      const doneOnly = await runHandler(viewRun, { status: "done" }, ctx());
      expect((doneOnly.rows as Array<{ slug: string }>).map((row) => row.slug)).toEqual(["done-bugs-case"]);

      const both = await runHandler(viewRun, { kind: "bugs.pack/triage", status: "done" }, ctx());
      expect(both.rows).toHaveLength(1);
      expect((both.rows[0] as { slug: string }).slug).toBe("done-bugs-case");

      const nothing = await runHandler(viewRun, { kind: "bugs.pack/triage", status: "does-not-exist" }, ctx());
      expect(nothing.rows).toEqual([]);

      // A window before every booking admits every case; one after the last commit admits none.
      const everySince = await runHandler(viewRun, { since: "2000-01-01T00:00:00.000Z" }, ctx());
      expect(everySince.rows).toHaveLength(3);

      const noneSince = await runHandler(viewRun, { since: "2999-01-01T00:00:00.000Z" }, ctx());
      expect(noneSince.rows).toEqual([]);

      const windowedAndKinded = await runHandler(
        viewRun,
        { since: "2000-01-01T00:00:00.000Z", kind: "tickets.pack/fix" },
        ctx(),
      );
      expect((windowedAndKinded.rows as Array<{ slug: string }>).map((row) => row.slug)).toEqual([
        "pending-tickets-case",
      ]);

      const allThree = await runHandler(
        viewRun,
        { kind: "bugs.pack/triage", status: "done", since: "2000-01-01T00:00:00.000Z" },
        ctx(),
      );
      expect((allThree.rows as Array<{ slug: string }>).map((row) => row.slug)).toEqual(["done-bugs-case"]);
    }, 30_000);

    test("two cases at one head produce byte-identical --json bytes across two runs, and equal recency orders by slug ascending", async () => {
      await installCoreModule();
      const store = storeAt();
      const claimA = await mintClaim(store, { id: "a", rendering: "case a's own claim", gateClass: "judgment" });
      await bookCase(store, "zzz-case", [claimA], "same.kind/here");
      const claimB = await mintClaim(store, { id: "b", rendering: "case b's own claim", gateClass: "judgment" });
      await bookCase(store, "aaa-case", [claimB], "same.kind/here");

      const first = await runHandler(viewRun, {}, ctx());
      const second = await runHandler(viewRun, {}, ctx());
      expect(new TextDecoder().decode(canonicalBytes(first))).toBe(new TextDecoder().decode(canonicalBytes(second)));

      const slugs = (first.rows as Array<{ slug: string; recency: string }>).map((row) => row.slug);
      const recencies = new Set((first.rows as Array<{ recency: string }>).map((row) => row.recency));
      if (recencies.size === 1) {
        expect(slugs).toEqual(["aaa-case", "zzz-case"]);
      }
    }, 15_000);

    test("rows come back most-recently-touched first, with slug ascending between two cases touched at one instant", async () => {
      await installCoreModule();
      // Four cases at three instants: one older, two tied with slugs out of order, one newer.
      await bookCase(storeDatedAt("2026-08-28T00:00:00.000Z"), "oldest-case", []);
      const tied = storeDatedAt("2026-08-29T00:00:00.000Z");
      await bookCase(tied, "zzz-tied-case", []);
      await bookCase(tied, "aaa-tied-case", []);
      await bookCase(storeDatedAt("2026-08-31T00:00:00.000Z"), "newest-case", []);

      const output = await runHandler(viewRun, {}, ctx());
      expect((output.rows as Array<{ slug: string }>).map((row) => row.slug)).toEqual([
        "newest-case",
        "aaa-tied-case",
        "zzz-tied-case",
        "oldest-case",
      ]);
    }, 30_000);

    test("list reads each case as progress does: one citing no claim and one with a failed claim open, one whose claims hold done", async () => {
      await installCoreModule();
      const store = storeAt();
      await bookCase(store, "empty-case", []);

      const held = await mintClaim(store, { id: "held", rendering: "this one holds", gateClass: "judgment" });
      const failed = await mintClaim(store, { id: "failed", rendering: "this one fails", gateClass: "judgment" });
      await bookCase(store, "failing-case", [held, failed]);
      await decide(workspace, scope, held, "holds");
      await decide(workspace, scope, failed, "fails");

      const alone = await mintClaim(store, {
        id: "alone",
        rendering: "the only claim, and it holds",
        gateClass: "judgment",
      });
      await bookCase(store, "held-case", [alone]);
      await decide(workspace, scope, alone, "holds");

      const listed = await runHandler(viewRun, {}, ctx());
      const rows = listed.rows as Array<{ slug: string; status: string; reason?: string }>;
      const bySlug = new Map(rows.map((row) => [row.slug, row]));
      expect(bySlug.get("empty-case")).toMatchObject({ status: "open", reason: "cites-no-claim" });
      expect(bySlug.get("failing-case")).toMatchObject({ status: "open", reason: "claim-fails" });
      expect(bySlug.get("held-case")).toMatchObject({ status: "done" });
      expect(bySlug.get("held-case")).not.toHaveProperty("reason");

      for (const slug of ["empty-case", "failing-case", "held-case"]) {
        const progress = await runHandler(caseStatus, { case: slug }, ctx());
        const row = bySlug.get(slug)!;
        expect(row.status).toBe(progress.done ? "done" : "open");
        expect(row.reason).toBe(progress.reason);
      }
      expect(viewRun.renderText!(listed)).toContain("empty-case\tmusai.core/bare\topen\t");
    }, 30_000);

    test("an explicit --view naming nothing installed refuses by name", async () => {
      await installCoreModule();
      const error = await runHandler(viewRun, { view: "musai.core/does-not-exist" }, ctx()).catch(
        (caught: unknown) => caught,
      );
      expect(isOperationError(error)).toBe(true);
      expect((error as { reason: string }).reason).toBe("no-such-record");
    });

    test("a workspace with no view contribution installed at all still returns an empty list rather than refusing, for the default view", async () => {
      const output = await runHandler(viewRun, {}, ctx());
      expect(output.rows).toEqual([]);
    });
  });

  describe("readers of a case's claims once one is superseded", () => {
    /** Mints a claim at `claimId`'s slot that supersedes it, at `instant` when given. */
    async function supersede(claimId: RecordId, rendering: string, instant?: string): Promise<RecordId> {
      const store = instant === undefined ? storeAt() : storeDatedAt(instant);
      const pinned = (await store.read(claimId, "claim")) as ClaimRecord;
      const [id] = await store.putMany([{ kind: "claim", value: { ...pinned, supersedes: [claimId], rendering } }]);
      return id!;
    }

    test("gate.pending lists a superseded claim's gate under the record that governs its slot", async () => {
      const store = storeAt();
      const pinned = await mintClaim(store, { id: "reworded", rendering: "the first wording", gateClass: "judgment" });
      await bookCase(store, "superseded-gate-case", [pinned]);
      const governing = await supersede(pinned, "the second wording");

      const output = await runHandler(gatePending, { case: "superseded-gate-case" }, ctx());

      expect(output.gates).toEqual([{ case: "superseded-gate-case", claim: governing, gateClass: "judgment" }]);
    });

    test("case.status names a superseded claim's gate as the record that governs its slot", async () => {
      const store = storeAt();
      const pinned = await mintClaim(store, { id: "reworded", rendering: "the first wording", gateClass: "evidence" });
      await bookCase(store, "superseded-next-case", [pinned]);
      const governing = await supersede(pinned, "the second wording");

      const output = await runHandler(caseStatus, { case: "superseded-next-case" }, ctx());

      expect(output.next).toEqual({ gate: governing, class: "evidence" });
    });

    test("a menu is offered over the record governing the slot and refused over a retired one", async () => {
      const store = storeAt();
      const pinned = await mintClaim(store, { id: "reworded", rendering: "the first wording", gateClass: "judgment" });
      await bookCase(store, "superseded-menu-case", [pinned]);
      const governing = await supersede(pinned, "the second wording");
      const opened = await openWorkspace(ctx());
      try {
        expect(askMenu(opened, governing).options).toEqual([
          { claim: governing, value: "holds", description: "the second wording" },
          { claim: governing, value: "fails", description: "not: the second wording" },
        ]);
        expect(() => askMenu(opened, pinned)).toThrow(expect.objectContaining({ reason: "no-such-record" }));
      } finally {
        opened.close();
      }
    });

    test("the gate that gate.pending lists for a superseded claim can be asked and answered", async () => {
      const store = storeAt();
      const pinned = await mintClaim(store, { id: "reworded", rendering: "the first wording", gateClass: "judgment" });
      await bookCase(store, "superseded-ask-case", [pinned]);
      await supersede(pinned, "the second wording");

      const [listed] = (await runHandler(gatePending, { case: "superseded-ask-case" }, ctx())).gates;
      const asked = await runHandler(gateAsk, { claim: listed!.claim }, ctx());
      await runHandler(
        gateAnswer,
        { pending: listed!.claim, brief: asked.brief, choice: "holds", reason: "the fixture decides" },
        { ...ctx(), via: "tty", principalName: "person@example.com" },
      );

      expect(asked.options.map((option) => option.claim)).toEqual([listed!.claim, listed!.claim]);
      expect((await runHandler(caseStatus, { case: "superseded-ask-case" }, ctx())).done).toBe(true);
    }, 30_000);

    test("a claim pinned by one case is found in that case, not in an earlier case pinning the claim it replaced", async () => {
      const store = storeAt();
      const first = await mintClaim(store, { id: "reworded", rendering: "the first wording", gateClass: "judgment" });
      const earlier = await bookCase(store, "replaced-booking", [first]);
      const second = await supersede(first, "the second wording");
      const later = await bookCase(store, "replacing-booking-1", [second]);
      const opened = await openWorkspace(ctx());
      try {
        expect(earlier < later).toBe(true);
        expect((await findCaseForClaim(opened, second)).id).toBe(later);
        expect((await findCaseForClaim(opened, first)).id).toBe(earlier);
      } finally {
        opened.close();
      }
    }, 30_000);

    test("an ask over a superseded claim is refused and mints no run", async () => {
      const store = storeAt();
      const pinned = await mintClaim(store, { id: "reworded", rendering: "the first wording", gateClass: "judgment" });
      await bookCase(store, "superseded-refused-case", [pinned]);
      await supersede(pinned, "the second wording");
      const runsBefore = await storeAt().list("run");

      const error = await runHandler(gateAsk, { claim: pinned }, ctx()).catch((caught: unknown) => caught);

      expect(isOperationError(error)).toBe(true);
      expect(await storeAt().list("run")).toEqual(runsBefore);
    }, 30_000);

    test("the dossier renders a superseded claim as the record that governs its slot", async () => {
      const store = storeAt();
      const pinned = await mintClaim(store, { id: "reworded", rendering: "the first wording", gateClass: "judgment" });
      const caseId = await bookCase(store, "superseded-dossier-case", [pinned]);
      await supersede(pinned, "the second wording");
      const opened = await openWorkspace(ctx());
      try {
        const found = (await findCaseRecord(opened, "superseded-dossier-case"))!;

        const dossier = await renderDossier(opened, caseId, found.record, []);

        expect(dossier).toContain("the second wording");
        expect(dossier).not.toContain("the first wording");
      } finally {
        opened.close();
      }
    });

    test("the dossier prints a claim's sentence as text, never as markup", async () => {
      const store = storeAt();
      const pinned = await mintClaim(store, {
        id: "marked",
        rendering: "a *loud* <b>claim</b>",
        gateClass: "judgment",
      });
      const caseId = await bookCase(store, "escaped-dossier-case", [pinned]);
      const opened = await openWorkspace(ctx());
      try {
        const found = (await findCaseRecord(opened, "escaped-dossier-case"))!;

        const dossier = await renderDossier(opened, caseId, found.record, []);

        expect(dossier).toContain("- a \\*loud\\* \\<b\\>claim\\</b\\> — ");
      } finally {
        opened.close();
      }
    });

    test("a case's recency follows the record that governs its claims' slots", async () => {
      await installCoreModule();
      const store = storeDatedAt("2026-08-28T00:00:00.000Z");
      const pinned = await mintClaim(store, { id: "reworded", rendering: "the first wording", gateClass: "judgment" });
      await bookCase(store, "superseded-recency-case", [pinned]);
      await supersede(pinned, "the second wording", "2026-08-31T00:00:00.000Z");

      const output = await runHandler(viewRun, {}, ctx());

      expect(output.rows).toEqual([
        expect.objectContaining({ slug: "superseded-recency-case", recency: "2026-08-31T00:00:00.000Z" }),
      ]);
    }, 30_000);
  });

  describe("a pack's own second listing, selectable by name with no change under packages/cli/src", () => {
    const FIXTURE_MODULE_NAME = "view-list-fixture-pack";
    const FIXTURE_VIEW_ID = `${FIXTURE_MODULE_NAME}/marker`;

    /** A pack's listing over the folded cases: a kind parameter, and a row per case. */
    const FIXTURE_ENTRY = {
      kind: "query",
      id: FIXTURE_VIEW_ID,
      version: versionString("1"),
      input: {
        type: "object",
        additionalProperties: false,
        properties: { kind: { type: ["string", "null"] } },
        statement: [
          "SELECT cases.id AS id, cases.slug AS slug,",
          "  json_extract(cases.record_json, '$.preset.contribution') AS kind",
          "FROM cases",
          "WHERE :kind IS NULL OR json_extract(cases.record_json, '$.preset.contribution') = :kind",
          "ORDER BY cases.id",
        ].join("\n"),
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
      documentation: "a fixture listing proving view.run@1 resolves any installed listing by name",
    };

    /** A bundle for the module record to name; a query is read from the fold, never invoked. */
    function fixtureBundleSource(): string {
      return [
        "export function invoke(requestBytes) {",
        "  return (async () => {",
        "    const request = JSON.parse(new TextDecoder().decode(requestBytes));",
        "    if (request.contribution === 'describe') {",
        `      const entries = ${JSON.stringify([FIXTURE_ENTRY])};`,
        "      return new TextEncoder().encode(JSON.stringify({ ok: true, output: entries, diagnostics: [] }));",
        "    }",
        "    return new TextEncoder().encode(JSON.stringify({ ok: false, error: { code: 'unknown-contribution', data: {}, message: 'unknown' } }));",
        "  })();",
        "}",
      ].join("\n");
    }

    async function installFixtureListing(): Promise<void> {
      const bundleId = await blobStoreOf(workspace).put(new TextEncoder().encode(fixtureBundleSource()));
      const moduleRecord: ModuleRecord = {
        kind: "module",
        supersedes: [],
        schemaVersion: CURRENT_SCHEMA_VERSIONS.module,
        name: FIXTURE_MODULE_NAME,
        version: versionString("1"),
        manifest: {
          protocolVersion: ENVELOPE_PROTOCOL,
          contributions: [FIXTURE_ENTRY],
          sourceTree: { digest: { gitTree: "a".repeat(40) } },
          toolchain: [{ name: "node", version: versionString("24.0.0") }],
          packages: [],
        },
        bundle: bundleId,
        build: recordId({ marker: "view-list-fixture-pack-build" }),
      };
      await storeAt().putMany([{ kind: "module", value: moduleRecord }]);
    }

    test("view.run@1 with --view naming the fixture's own id answers from it, with no change needed under packages/cli/src", async () => {
      await installFixtureListing();
      await bookCase(storeAt(), "a-case-the-fixture-lists", []);

      const output = await runHandler(viewRun, { view: FIXTURE_VIEW_ID }, ctx());
      expect(output.rows).toHaveLength(1);
      expect((output.rows[0] as { slug: string; kind: string }).slug).toBe("a-case-the-fixture-lists");
      expect((output.rows[0] as { slug: string; kind: string }).kind).toBe("musai.core/bare");
    });
  });
});
