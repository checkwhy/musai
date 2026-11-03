import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openWorkspace, runHandler } from "@musai/api-core";
import { type CaseRecord, type ClaimRecord, type RecordId, timestamp } from "@musai/records";
import { initWorkspace } from "@musai/store";
import { fixedClock } from "@musai/test-support";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { findCaseRecord } from "../src/cases.js";
import { shortIdOf } from "../src/claim-ref.js";
import { briefRender } from "../src/ops/brief.js";
import { caseBook, caseSoundcheck } from "../src/ops/case.js";
import { caseStatus } from "../src/ops/case-status.js";
import { claimStatus } from "../src/ops/claim.js";
import { doctorRun } from "../src/ops/doctor.js";
import { gateAnswer, gateAsk, gatePending } from "../src/ops/gate.js";
import { forkKeep } from "../src/ops/keep.js";
import { moduleBuild } from "../src/ops/module.js";
import { caseOpen } from "../src/ops/open.js";
import { caseSave } from "../src/ops/save.js";
import { scopeFork, scopeMerge } from "../src/ops/scope.js";

const now = fixedClock(timestamp("2026-01-01T00:00:00.000Z"));
const scope = "default";
const CORE_MODULE_DIR = fileURLToPath(new URL("../../core-module", import.meta.url));
const CASEBOOK_MODULE_DIR = fileURLToPath(new URL("../../scenarios/casebook/modules/casebook", import.meta.url));
const CASEBOOK_KIND = "fixture-casebook/report";

describe("a slug two live cases hold", () => {
  let workspace: string;
  const context = (at = scope) => ({ workspace, scope: at, now });

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "musai-forked-slug-"));
    await initWorkspace(workspace, { now });
    for (const dir of [CORE_MODULE_DIR, CASEBOOK_MODULE_DIR]) {
      await runHandler(moduleBuild, { dir }, context());
    }
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  /** The slug booked here and in a fork of this scope about different things, then merged. */
  async function bookedTwice(slug: string): Promise<readonly [RecordId, RecordId]> {
    const elsewhere = `${slug}-elsewhere`;
    await runHandler(scopeFork, { name: elsewhere }, context());
    const here = await runHandler(caseBook, { slug, about: [`urn:${slug}:here`] }, context());
    const there = await runHandler(caseBook, { slug, about: [`urn:${slug}:there`] }, context(elsewhere));
    await runHandler(scopeMerge, { from: elsewhere }, context());
    return [here.case, there.case];
  }

  test("a scope merge landing a second case under a held slug forks the slug, naming each case", async () => {
    const cases = await bookedTwice("merged-twice");

    const refused = await runHandler(caseStatus, { case: "merged-twice" }, context()).catch((error: unknown) => error);
    const doctor = await runHandler(doctorRun, {}, context());

    expect(refused).toMatchObject({ reason: "invalid-input" });
    for (const id of cases) {
      expect((refused as Error).message).toContain(id);
    }
    expect((refused as Error).message).toContain("`lab keep <case>`");
    expect(doctor.local).toContainEqual(
      expect.objectContaining({
        name: "forked-slugs",
        ok: false,
        detail: expect.stringContaining(`live cases ${cases.map(shortIdOf).sort().join(", ")} hold one slug`),
      }),
    );
    expect(JSON.stringify(doctor.local)).not.toContain("merged-twice");
  });

  test("every live case under a forked slug answers by its own id", async () => {
    const cases = await bookedTwice("named-by-id");

    const opened = await openWorkspace(context());
    const answered: (RecordId | undefined)[] = [];
    const slots: string[] = [];
    for (const id of cases) {
      answered.push((await findCaseRecord(opened, id))?.id);
      const [claim] = (opened.read(id) as CaseRecord).claims;
      slots.push((opened.read(claim!) as ClaimRecord).slot);
    }
    opened.close();

    expect(answered).toEqual([...cases]);
    for (const [at, id] of cases.entries()) {
      const { claims } = await runHandler(caseSoundcheck, { case: id }, { ...context(), mode: "plan" });
      expect(claims.map(({ slot }) => slot)).toEqual([slots[at]]);
    }
  });

  test("the author closes a forked slug by keeping one case, and the slug answers the successor alone", async () => {
    const [kept, other] = await bookedTwice("kept-once");

    const output = await runHandler(forkKeep, { record: shortIdOf(kept) }, context());
    const opened = await openWorkspace(context());
    const successor = opened.read(output.successor) as CaseRecord;
    const keptRecord = opened.read(kept) as CaseRecord;
    const live = opened.index.casesAtSlug("kept-once").map(({ id }) => id);
    opened.close();
    const doctor = await runHandler(doctorRun, {}, context());

    expect([...output.supersedes].sort()).toEqual([kept, other].sort());
    expect(output.slug).toBe("kept-once");
    expect(successor).toEqual({ ...keptRecord, supersedes: [...output.supersedes] });
    expect(live).toEqual([output.successor]);
    await expect(runHandler(caseStatus, { case: "kept-once" }, context())).resolves.toMatchObject({ done: false });
    expect(JSON.stringify(doctor.local)).not.toContain("kept-once");
  });

  test("keeping a case under a slug no fork splits is refused, and mints nothing", async () => {
    const { case: alone } = await runHandler(caseBook, { slug: "booked-once", about: ["urn:booked-once"] }, context());

    await expect(runHandler(forkKeep, { record: alone }, context())).rejects.toMatchObject({
      reason: "invalid-input",
      message: expect.stringContaining("holds no fork"),
    });
    const opened = await openWorkspace(context());
    const live = opened.index.casesAtSlug("booked-once").map(({ id }) => id);
    opened.close();
    expect(live).toEqual([alone]);
  });

  test("keeping a case a successor already retired is refused", async () => {
    const [kept, retired] = await bookedTwice("retired-case");
    await runHandler(forkKeep, { record: kept }, context());

    await expect(runHandler(forkKeep, { record: retired }, context())).rejects.toMatchObject({
      reason: "no-such-record",
    });
  });

  test("a brief over a claim both cases of a forked slug cite is refused, naming each case", async () => {
    const slug = "briefed-twice";
    await runHandler(scopeFork, { name: `${slug}-elsewhere` }, context());
    const about = [`urn:${slug}`];
    const here = await runHandler(caseBook, { slug, about }, context());
    const there = await runHandler(
      caseBook,
      { slug, about, overrides: { side: "there" } },
      context(`${slug}-elsewhere`),
    );
    await runHandler(scopeMerge, { from: `${slug}-elsewhere` }, context());
    const opened = await openWorkspace(context());
    const [claim] = (opened.read(here.case) as CaseRecord).claims;
    const shared = (opened.read(there.case) as CaseRecord).claims;
    opened.close();

    const refused = await runHandler(briefRender, { claim: claim! }, context()).catch((error: unknown) => error);

    expect(shared).toEqual([claim]);
    expect(refused).toMatchObject({ reason: "invalid-input" });
    for (const id of [here.case, there.case]) {
      expect((refused as Error).message).toContain(id);
    }
    expect((refused as Error).message).toContain("`lab keep <case>`");
  });
  test("a gate both cases of a forked slug cite is pending once, its row naming the fork", async () => {
    const slug = "pending-twice";
    await runHandler(scopeFork, { name: `${slug}-elsewhere` }, context());
    const here = await runHandler(caseBook, { slug, kind: CASEBOOK_KIND }, context());
    const overrides = { suite: "process.exit(1)" };
    const there = await runHandler(caseBook, { slug, kind: CASEBOOK_KIND, overrides }, context(`${slug}-elsewhere`));
    await runHandler(scopeMerge, { from: `${slug}-elsewhere` }, context());

    const pending = await runHandler(gatePending, { case: slug }, { ...context(), mode: "plan" });
    const claims = pending.gates.map(({ claim }) => claim);

    expect(claims.length).toBeGreaterThan(0);
    expect(new Set(claims).size).toBe(claims.length);
    for (const gate of pending.gates) {
      expect(gate.forked).toEqual([here.case, there.case].sort());
    }
    expect(gatePending.renderText(pending)).toContain("`lab keep <case>`");
  });

  test("a forked slug whose cases name different menus at one slot lists each menu, never one by id", async () => {
    const slug = "pending-two-menus";
    const here = await runHandler(caseBook, { slug, kind: CASEBOOK_KIND }, context());
    const opened = await openWorkspace(context());
    const booked = opened.read(here.case) as CaseRecord;
    const [filed] = booked.claims
      .map((id) => ({ id, record: opened.read(id) as ClaimRecord }))
      .filter(({ record }) => record.exclusiveGroup !== null);
    const [otherMenu] = await opened.put([
      { kind: "claim", value: { ...filed!.record, exclusiveGroup: `${slug}/another-menu` } },
    ]);
    const claims = booked.claims.map((id) => (id === filed!.id ? (otherMenu as RecordId) : id));
    const [there] = await opened.put([{ kind: "case", value: { ...booked, claims, overrides: { menu: "another" } } }]);
    opened.close();

    const { gates } = await runHandler(gatePending, { case: slug }, { ...context(), mode: "plan" });

    expect(gates.map(({ claim }) => claim)).toContain(otherMenu);
    expect(gates.some(({ claim }) => claim !== otherMenu)).toBe(true);
    for (const gate of gates) {
      expect(gate.forked).toEqual([here.case, there as RecordId].sort());
    }
  });

  test("opening the view of a forked slug is refused by either case's id, since the view is the slug's", async () => {
    const cases = await bookedTwice("opened-twice");

    for (const id of cases) {
      const refused = await runHandler(caseOpen, { case: id }, context()).catch((error: unknown) => error);
      expect(refused).toMatchObject({ reason: "invalid-input" });
      expect((refused as Error).message).toContain("`lab keep <case>`");
    }
  });

  test("saving a view opened before a merge forked its slug is refused, and mints nothing", async () => {
    const slug = "saved-after-the-fork";
    await runHandler(scopeFork, { name: `${slug}-elsewhere` }, context());
    const here = await runHandler(caseBook, { slug, about: [`urn:${slug}:here`] }, context());
    await runHandler(caseOpen, { case: here.case }, context());
    const there = await runHandler(caseBook, { slug, about: [`urn:${slug}:there`] }, context(`${slug}-elsewhere`));
    await runHandler(scopeMerge, { from: `${slug}-elsewhere` }, context());

    for (const id of [here.case, there.case]) {
      const refused = await runHandler(caseSave, { case: id }, context()).catch((error: unknown) => error);
      expect(refused).toMatchObject({ reason: "invalid-input" });
      expect((refused as Error).message).toContain("`lab keep <case>`");
    }
    const opened = await openWorkspace(context());
    const artifacts = [here.case, there.case].flatMap((id) => opened.index.artifactsOfCase(id));
    opened.close();
    expect(artifacts).toEqual([]);
  });

  /** A judgment gate answered over the case booked here, beside a case booked under the slug with
   * other overrides in each of `beside` fresh scopes, none merged yet. */
  async function answeredBeside(slug: string, beside: number) {
    const scopes = Array.from({ length: beside }, (_, at) => `${slug}-elsewhere-${at}`);
    for (const name of scopes) {
      await runHandler(scopeFork, { name }, context());
    }
    const here = await runHandler(caseBook, { slug, kind: CASEBOOK_KIND }, context());
    const { gates } = await runHandler(gatePending, { case: slug }, { ...context(), mode: "plan" });
    const gate = gates.find(({ gateClass }) => gateClass === "judgment")!.claim;
    const asked = await runHandler(gateAsk, { claim: gate }, context());
    await runHandler(
      gateAnswer,
      { pending: gate, brief: asked.brief, choice: "holds", reason: "worth fixing" },
      { ...context(), via: "tty", principalName: "person@example.com" },
    );
    const there: RecordId[] = [];
    for (const [at, name] of scopes.entries()) {
      const overrides = { suite: `process.exit(${at + 1})` };
      there.push((await runHandler(caseBook, { slug, kind: CASEBOOK_KIND, overrides }, context(name))).case);
    }
    return { here: here.case, there, gate, scopes };
  }

  /** As `answeredBeside` with one other case, merged so it forks the slug. */
  async function answeredThenForked(slug: string) {
    const { here, there, gate, scopes } = await answeredBeside(slug, 1);
    await runHandler(scopeMerge, { from: scopes[0]! }, context());
    return { here, there: there[0]!, gate };
  }

  test("a gate answered over the case keep carries stays current once the keep closes its slug", async () => {
    const slug = "answered-then-kept";
    const { here, gate } = await answeredThenForked(slug);

    await runHandler(forkKeep, { record: here }, context());

    const status = await runHandler(claimStatus, { claim: gate }, context());
    const pending = await runHandler(gatePending, { case: slug }, { ...context(), mode: "plan" });
    expect(status.label).toBe("holds");
    expect(status).not.toHaveProperty("decidedOnStaleEvidence");
    expect(pending.flagged ?? []).toEqual([]);
  });

  test("a gate a case under another slug shares stays current once a keep closes the fork of the case its brief read", async () => {
    const slug = "answered-shared-then-kept";
    const { here, gate, scopes } = await answeredBeside(slug, 1);
    const opened = await openWorkspace(context());
    await opened.put([{ kind: "case", value: { ...(opened.read(here) as CaseRecord), slug: `${slug}-sharing` } }]);
    opened.close();
    await runHandler(scopeMerge, { from: scopes[0]! }, context());
    const forked = await runHandler(claimStatus, { claim: gate }, context());

    await runHandler(forkKeep, { record: here }, context());

    const kept = await runHandler(claimStatus, { claim: gate }, context());
    expect(forked).toMatchObject({ label: "holds", decidedOnStaleEvidence: true });
    expect(kept.label).toBe("holds");
    expect(kept).not.toHaveProperty("decidedOnStaleEvidence");
  });

  test("a gate answered over a case keep supersedes without carrying reads decided on stale evidence", async () => {
    const slug = "answered-then-dropped";
    const { there, gate } = await answeredThenForked(slug);

    await runHandler(forkKeep, { record: there }, context());

    const status = await runHandler(claimStatus, { claim: gate }, context());
    expect(status).toMatchObject({ label: "holds", decidedOnStaleEvidence: true });
  });

  test("a gate answered over a case reads stale under a copy of that case that does not descend from it", async () => {
    const slug = "answered-then-copied";
    const { here, gate } = await answeredBeside(slug, 0);
    const unrelated = await runHandler(caseBook, { slug: `${slug}-unrelated`, about: [`urn:${slug}`] }, context());
    const opened = await openWorkspace(context());
    const booked = opened.read(here) as CaseRecord;
    await opened.put([{ kind: "case", value: { ...booked, claims: [], supersedes: [here] } }]);
    await opened.put([{ kind: "case", value: { ...booked, supersedes: [unrelated.case] } }]);
    opened.close();

    const status = await runHandler(claimStatus, { claim: gate }, context());

    expect(status).toMatchObject({ label: "holds", decidedOnStaleEvidence: true });
  });

  test("a gate answered over a case stays current through two keeps that each carry it", async () => {
    const slug = "answered-then-kept-twice";
    const { here, gate, scopes } = await answeredBeside(slug, 2);
    await runHandler(scopeMerge, { from: scopes[0]! }, context());
    const { successor } = await runHandler(forkKeep, { record: here }, context());
    await runHandler(scopeMerge, { from: scopes[1]! }, context());

    await runHandler(forkKeep, { record: successor }, context());

    const status = await runHandler(claimStatus, { claim: gate }, context());
    expect(status.label).toBe("holds");
    expect(status).not.toHaveProperty("decidedOnStaleEvidence");
  });

  test("a gate answered over a case reads stale once a second keep carries another case", async () => {
    const slug = "answered-then-kept-elsewhere";
    const { here, there, gate, scopes } = await answeredBeside(slug, 2);
    await runHandler(scopeMerge, { from: scopes[0]! }, context());
    await runHandler(forkKeep, { record: here }, context());
    await runHandler(scopeMerge, { from: scopes[1]! }, context());

    await runHandler(forkKeep, { record: there[1]! }, context());

    const status = await runHandler(claimStatus, { claim: gate }, context());
    expect(status).toMatchObject({ label: "holds", decidedOnStaleEvidence: true });
  });
});
