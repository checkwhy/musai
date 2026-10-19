import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHandler } from "@musai/api-core";
import type { DerivationJson } from "@musai/evaluate";
import {
  type CaseRecord,
  type ClaimRecord,
  type ClaimTypeDeclaration,
  CURRENT_SCHEMA_VERSIONS,
  claimTypesFrom,
  type RecordId,
  type RulingRecord,
  recordId,
  slotFor,
  timestamp,
  versionString,
} from "@musai/records";
import { initWorkspace, Store } from "@musai/store";
import {
  declareClaimTypes,
  fixedClock,
  fixWorkspaceKey,
  type NamedCaller,
  namedCaller,
  writeTrustFile,
} from "@musai/test-support";
import { mintAttestation } from "@musai/trust";
import { afterEach, describe, expect, test } from "vitest";
import { briefRender } from "../src/ops/brief.js";
import { caseStatus } from "../src/ops/case-status.js";
import { claimStatus } from "../src/ops/claim.js";
import { gateAnswer, gateAsk, gatePending } from "../src/ops/gate.js";
import { rulingMake } from "../src/ops/ruling.js";
import { claimWhy } from "../src/ops/why.js";

const now = fixedClock(timestamp("2026-01-01T00:00:00.000Z"));

const CLAIM_TYPE = "musai.ruling-supersede-fixture-test/claim@1";
const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: CLAIM_TYPE, identityDimensions: ["id"] };
const CLAIM_TYPES = claimTypesFrom([CLAIM_DECLARATION]);

/** The channel a surface establishes and the name it is launched under. */
type Caller = NamedCaller;

const PERSON: Caller = namedCaller("tty", "person@example.com");
const DELEGATE: Caller = namedCaller("model", "an-agent@example.com");
const OWNER: Caller = namedCaller("tty", "owner@example.com");
const MAINTAINER: Caller = namedCaller("tty", "maintainer@example.com");
const ARBITER: Caller = namedCaller("tty", "arbiter@example.com");

/** Three principals under a roles file; only the owner and the arbiter hold `override-person`. */
const ROLES = [
  `${OWNER.principal} owner any`,
  `${MAINTAINER.principal} maintainer any`,
  `${ARBITER.principal} arbiter any`,
  "",
].join("\n");

/** `ROLES` with the model's principal a delegate, so a delegate ruling is vouched for. */
const ROLES_WITH_DELEGATE = `${ROLES}${DELEGATE.principal} delegate any\n`;

/** A second maintainer: the owner's ruling's peer at person tier, without `override-person`. */
const PEER: Caller = namedCaller("tty", "peer@example.com");
const ROLES_WITH_PEER = `${ROLES}${PEER.principal} maintainer any\n`;

/** A second delegate: the first delegate's peer, at delegate tier. */
const OTHER_DELEGATE: Caller = namedCaller("model", "another-agent@example.com");
const ROLES_WITH_DELEGATES = `${ROLES_WITH_DELEGATE}${OTHER_DELEGATE.principal} delegate any\n`;

interface ClaimSpec {
  readonly id: string;
  readonly exclusiveGroup?: string;
  readonly disposition?: string;
}

const MENU: readonly ClaimSpec[] = [
  { id: "a", exclusiveGroup: "disposition", disposition: "file" },
  { id: "b", exclusiveGroup: "disposition", disposition: "comment" },
  { id: "c", exclusiveGroup: "disposition", disposition: "withdraw" },
];

function claimFor(spec: ClaimSpec): ClaimRecord {
  const conditions: Record<string, string> = { id: spec.id };
  if (spec.disposition !== undefined) {
    conditions["disposition"] = spec.disposition;
    conditions["gateClass"] = "intent";
  }
  return {
    kind: "claim",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: CLAIM_TYPE,
    about: [],
    slot: slotFor(CLAIM_DECLARATION, conditions),
    conditions,
    canonical: conditions,
    rendering: `the claim ${spec.id}`,
    evidence: [],
    exclusiveGroup: spec.exclusiveGroup ?? null,
  };
}

let workspace: string | undefined;

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = undefined;
  }
});

/** A workspace with one case over `specs`, and a roles file where given: without one, every
 * principal holds `override-person`. */
async function musai(slug: string, specs: readonly ClaimSpec[], roles?: string) {
  workspace = await mkdtemp(join(tmpdir(), "musai-ruling-supersede-test-"));
  const dir = workspace;
  await initWorkspace(dir, { now });
  await fixWorkspaceKey(dir);
  if (roles !== undefined) {
    await writeTrustFile({ gitDir: join(dir, ".musai") }, "roles", roles);
  }
  const scope = "default";
  const store = new Store({ ctx: { gitDir: join(dir, ".musai") }, scope, now, claimTypes: CLAIM_TYPES });
  await declareClaimTypes(store, [CLAIM_DECLARATION]);

  const ids = new Map<string, RecordId>();
  for (const spec of specs) {
    const [id] = await store.putMany([{ kind: "claim", value: claimFor(spec) }]);
    ids.set(spec.id, id!);
  }
  const caseRecord: CaseRecord = {
    kind: "case",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.case,
    type: null,
    slug,
    claims: [...ids.values()],
    preset: {
      module: "musai.core",
      contribution: "musai.core/bare",
      moduleRecord: recordId({ marker: "ruling-supersede-fixture" }),
    },
    projectCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    overrides: {},
    evaluatorVersion: versionString("1"),
  };
  await store.putMany([{ kind: "case", value: caseRecord }]);

  const reader = { workspace: dir, scope, now };
  const specById = new Map(specs.map((spec) => [spec.id, spec]));
  let rulingsMade = 0;

  function idOf(specId: string): RecordId {
    return ids.get(specId)!;
  }
  function slotOf(specId: string): string {
    return claimFor(specById.get(specId)!).slot;
  }
  async function briefFor(claim: RecordId): Promise<RecordId> {
    return (await runHandler(briefRender, { claim }, reader)).brief;
  }

  return {
    dir,
    scope,
    store,
    reader,
    idOf,
    slotOf,
    briefFor,
    /** Rules a claim against `brief` or a fresh one, with a unique reason; answers the mint. */
    async ruleOutput(
      specId: string,
      verdict: "holds" | "fails",
      by: Caller,
      supersedes: readonly RecordId[] = [],
      brief?: RecordId,
    ) {
      rulingsMade += 1;
      return runHandler(
        rulingMake,
        {
          claim: idOf(specId),
          verdict,
          reason: `ruling ${rulingsMade}: ${verdict}`,
          brief: brief ?? (await briefFor(idOf(specId))),
          supersedes,
        },
        { ...reader, ...by },
      );
    },
    async rule(
      specId: string,
      verdict: "holds" | "fails",
      by: Caller,
      supersedes: readonly RecordId[] = [],
      brief?: RecordId,
    ): Promise<RecordId> {
      const output = await this.ruleOutput(specId, verdict, by, supersedes, brief);
      return output.minted.find((item) => item.kind === "ruling")!.id as RecordId;
    },
    /** What `rule` is refused with, against a brief rendered before the caller read the head. */
    async refusal(
      specId: string,
      verdict: "holds" | "fails",
      by: Caller,
      supersedes: readonly RecordId[],
      brief: RecordId,
    ): Promise<unknown> {
      return this.rule(specId, verdict, by, supersedes, brief).catch((caught: unknown) => caught);
    },
    async status(specId: string) {
      return runHandler(claimStatus, { claim: slotOf(specId) }, reader);
    },
    async why(specId: string): Promise<DerivationJson> {
      const output = await runHandler(claimWhy, { claim: slotOf(specId), full: true }, reader);
      if (output.derivation === undefined) {
        throw new Error(`claim ${specId} reads open (${output.reason}) with nothing to walk`);
      }
      return output.derivation;
    },
    async answer(specId: string, choice: string, by: Caller) {
      const brief = (await runHandler(gateAsk, { claim: idOf(specId) }, reader)).brief;
      return runHandler(
        gateAnswer,
        { pending: idOf(specId), brief, choice, reason: `answered ${choice}` },
        { ...reader, ...by },
      );
    },
    async pending(): Promise<readonly RecordId[]> {
      return (await runHandler(gatePending, {}, reader)).gates.map((gate) => gate.claim);
    },
    async commitsSince(before: string | null): Promise<number> {
      const after = await store.tip();
      const count = execFileSync("git", [
        "--git-dir",
        join(dir, ".musai"),
        "rev-list",
        "--count",
        `${before}..${after}`,
      ]);
      return Number(count.toString().trim());
    },
  };
}

/** Writes a claim superseding `spec`'s at its slot straight into the store, as no verb does. */
async function supersedeClaim(fixture: Awaited<ReturnType<typeof musai>>, spec: ClaimSpec): Promise<RecordId> {
  const replacement: ClaimRecord = {
    ...claimFor(spec),
    rendering: `the claim ${spec.id}, restated`,
    supersedes: [fixture.idOf(spec.id)],
  };
  const [id] = await fixture.store.putMany([{ kind: "claim", value: replacement }]);
  return id!;
}

describe("a ruling superseding another", () => {
  test("two same-tier rulings with opposite verdicts read contested, and the second naming the first reads its own verdict", async () => {
    const fixture = await musai("supersession-not-recency", [{ id: "beside" }, { id: "over" }]);

    await fixture.rule("beside", "holds", PERSON);
    await fixture.rule("beside", "fails", PERSON);
    const beside = await fixture.status("beside");
    expect(beside.label).toBe("open");
    expect(beside.reason).toBe("contested-authority");

    const first = await fixture.rule("over", "holds", PERSON);
    await fixture.rule("over", "fails", PERSON, [first]);
    const over = await fixture.status("over");
    expect(over.label).toBe("fails");
  });

  test("a principal corrects its own ruling in one commit holding the ruling and its attestation, and the claim reads the correction", async () => {
    const fixture = await musai("own-correction", [{ id: "only" }]);
    const mistaken = await fixture.rule("only", "holds", PERSON);
    const brief = await fixture.briefFor(fixture.idOf("only"));
    const before = await fixture.store.tip();

    const output = await fixture.ruleOutput("only", "fails", PERSON, [mistaken], brief);

    expect(await fixture.commitsSince(before)).toBe(1);
    expect(output.minted.map((item) => item.kind).sort()).toEqual(["attestation", "ruling"]);
    const correction = output.minted.find((item) => item.kind === "ruling")!.record as RulingRecord;
    expect(correction.supersedes).toEqual([mistaken]);
    expect(correction.verdict).toBe("fails");
    expect((await fixture.status("only")).label).toBe("fails");
  });

  test("a delegate cannot retire a person's ruling, and the refusal names that ruling before anything is minted", async () => {
    const fixture = await musai("delegate-over-person", [{ id: "only" }]);
    const personal = await fixture.rule("only", "holds", PERSON);
    const brief = await fixture.briefFor(fixture.idOf("only"));
    const before = await fixture.store.tip();

    const refusal = await fixture.refusal("only", "fails", DELEGATE, [personal], brief);

    expect(refusal).toMatchObject({ reason: "not-authorised", about: [personal, DELEGATE.principal] });
    expect(await fixture.store.tip()).toBe(before);
    expect((await fixture.status("only")).label).toBe("holds");
  });

  test("a person retires a delegate's ruling", async () => {
    const fixture = await musai("person-over-delegate", [{ id: "only" }]);
    const delegated = await fixture.rule("only", "holds", DELEGATE);

    const correction = await fixture.rule("only", "fails", PERSON, [delegated]);

    const status = await fixture.status("only");
    expect(status.label).toBe("fails");
    expect(status.comparison.winner).toContain(correction);
  });

  test("a maintainer cannot retire the owner's ruling, ruling beside it contests the claim, and the arbiter retires both with one ruling", async () => {
    const fixture = await musai("peers-and-arbiter", [{ id: "only" }], ROLES);
    const owners = await fixture.rule("only", "holds", OWNER);
    const brief = await fixture.briefFor(fixture.idOf("only"));
    const before = await fixture.store.tip();

    const refusal = await fixture.refusal("only", "fails", MAINTAINER, [owners], brief);
    expect(refusal).toMatchObject({ reason: "not-authorised", about: [owners, MAINTAINER.principal] });
    expect(await fixture.store.tip()).toBe(before);

    const maintainers = await fixture.rule("only", "fails", MAINTAINER);
    const contested = await fixture.status("only");
    expect(contested.label).toBe("open");
    expect(contested.reason).toBe("contested-authority");

    await fixture.rule("only", "fails", ARBITER, [owners, maintainers]);
    expect((await fixture.status("only")).label).toBe("fails");
  });

  test("a maintainer corrects its own ruling without holding override-person", async () => {
    const fixture = await musai("maintainer-own-correction", [{ id: "only" }], ROLES);
    const mistaken = await fixture.rule("only", "holds", MAINTAINER);

    await fixture.rule("only", "fails", MAINTAINER, [mistaken]);

    expect((await fixture.status("only")).label).toBe("fails");
  });

  test("a maintainer retires a delegate's ruling by tier alone, without holding override-person", async () => {
    const fixture = await musai("maintainer-over-delegate", [{ id: "only" }], ROLES_WITH_DELEGATE);
    const delegated = await fixture.rule("only", "holds", DELEGATE);

    await fixture.rule("only", "fails", MAINTAINER, [delegated]);

    expect((await fixture.status("only")).label).toBe("fails");
  });

  test("a delegate corrects its own delegate ruling, the one tier override-person never reaches", async () => {
    const fixture = await musai("delegate-own-correction", [{ id: "only" }]);
    const mistaken = await fixture.rule("only", "holds", DELEGATE);

    await fixture.rule("only", "fails", DELEGATE, [mistaken]);

    expect((await fixture.status("only")).label).toBe("fails");
  });

  test("the owner retires a maintainer's ruling alone, holding override-person", async () => {
    const fixture = await musai("owner-over-maintainer", [{ id: "only" }], ROLES);
    const maintainers = await fixture.rule("only", "holds", MAINTAINER);

    await fixture.rule("only", "fails", OWNER, [maintainers]);

    expect((await fixture.status("only")).label).toBe("fails");
  });

  test("a ruling nothing vouches for is retired by a principal holding override-person and by no one without it", async () => {
    const fixture = await musai("unvouched", [{ id: "only" }], ROLES);
    const unvouched: RulingRecord = {
      kind: "ruling",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.ruling,
      over: { claim: fixture.idOf("only") },
      verdict: "holds",
      reason: "committed by a peer, signed by nobody",
      brief: await fixture.briefFor(fixture.idOf("only")),
    };
    const [unvouchedId] = await fixture.store.putMany([{ kind: "ruling", value: unvouched }]);
    const brief = await fixture.briefFor(fixture.idOf("only"));
    const before = await fixture.store.tip();

    const refusal = await fixture.refusal("only", "fails", MAINTAINER, [unvouchedId!], brief);
    expect(refusal).toMatchObject({ reason: "not-authorised", about: [unvouchedId, MAINTAINER.principal] });
    expect((refusal as Error).message).toContain("nothing vouches for");
    expect(await fixture.store.tip()).toBe(before);

    await fixture.rule("only", "fails", ARBITER, [unvouchedId!]);
    expect((await fixture.status("only")).label).toBe("fails");
  });

  test("a ruling already superseded cannot be superseded again, and the refusal names what replaced it", async () => {
    const fixture = await musai("already-superseded", [{ id: "only" }]);
    const first = await fixture.rule("only", "holds", PERSON);
    const second = await fixture.rule("only", "fails", PERSON, [first]);
    const brief = await fixture.briefFor(fixture.idOf("only"));
    const before = await fixture.store.tip();

    const refusal = await fixture.refusal("only", "holds", PERSON, [first], brief);

    expect(refusal).toMatchObject({ reason: "invalid-input", about: [first] });
    expect((refusal as Error).message).toContain(`already superseded by ${second}`);
    expect(await fixture.store.tip()).toBe(before);
  });

  test("a ruling on another claim cannot be superseded from this one, and the refusal names that claim's slot", async () => {
    const fixture = await musai("another-claim", [{ id: "here" }, { id: "there" }]);
    const elsewhere = await fixture.rule("there", "holds", PERSON);

    const refusal = await fixture.refusal(
      "here",
      "fails",
      PERSON,
      [elsewhere],
      await fixture.briefFor(fixture.idOf("here")),
    );

    expect(refusal).toMatchObject({ reason: "invalid-input", about: [elsewhere] });
    expect((refusal as Error).message).toContain(`slot ${fixture.slotOf("there")}`);
  });

  test("a policy over a claim type is not retired by a ruling on one claim", async () => {
    const fixture = await musai("policy", [{ id: "only" }]);
    const policy: RulingRecord = {
      kind: "ruling",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.ruling,
      over: { type: CLAIM_TYPE, scope: {} },
      verdict: "holds",
      reason: "every claim of this type holds",
      brief: await fixture.briefFor(fixture.idOf("only")),
    };
    const [policyId] = await fixture.store.putMany([{ kind: "ruling", value: policy }]);

    const refusal = await fixture.refusal(
      "only",
      "fails",
      PERSON,
      [policyId!],
      await fixture.briefFor(fixture.idOf("only")),
    );

    expect(refusal).toMatchObject({ reason: "invalid-input", about: [policyId] });
    expect((refusal as Error).message).toContain("policy");
  });

  test("a name that is a claim rather than a ruling is refused no-such-record", async () => {
    const fixture = await musai("not-a-ruling", [{ id: "only" }]);

    const refusal = await fixture.refusal(
      "only",
      "fails",
      PERSON,
      [fixture.idOf("only")],
      await fixture.briefFor(fixture.idOf("only")),
    );

    expect(refusal).toMatchObject({ reason: "no-such-record", about: [fixture.idOf("only")] });
  });

  test("a ruling over a claim record a later claim supersedes is refused no-such-record naming the successor and its slot, whatever it supersedes", async () => {
    const spec = { id: "restated" };
    const fixture = await musai("retired-claim", [spec]);
    const retired = fixture.idOf("restated");
    const brief = await fixture.briefFor(retired);
    const replacement = await supersedeClaim(fixture, spec);
    const live = (
      await runHandler(
        rulingMake,
        { claim: replacement, verdict: "holds", reason: "on the restated claim", brief },
        { ...fixture.reader, ...PERSON },
      )
    ).minted.find((item) => item.kind === "ruling")!.id as RecordId;
    const before = await fixture.store.tip();

    for (const supersedes of [[], [live]]) {
      const refusal = await runHandler(
        rulingMake,
        { claim: retired, verdict: "fails", reason: "on the retired record", brief, supersedes },
        { ...fixture.reader, ...PERSON },
      ).catch((caught: unknown) => caught);

      expect(refusal).toMatchObject({ reason: "no-such-record", about: [retired] });
      expect((refusal as Error).message).toContain(
        `superseded by ${replacement} at slot ${fixture.slotOf("restated")}`,
      );
    }
    expect(await fixture.store.tip()).toBe(before);
  });

  test("a bare gate answered under a claim record a later claim supersedes is refused no-such-record naming the successor", async () => {
    const spec = { id: "gate" };
    const fixture = await musai("retired-gate", [spec]);
    const retired = fixture.idOf("gate");
    const brief = await fixture.briefFor(retired);
    const replacement = await supersedeClaim(fixture, spec);
    const before = await fixture.store.tip();

    const refusal = await runHandler(
      gateAnswer,
      { pending: retired, brief, choice: "holds", reason: "answered under the retired id" },
      { ...fixture.reader, ...PERSON },
    ).catch((caught: unknown) => caught);

    expect(refusal).toMatchObject({ reason: "no-such-record", about: [retired] });
    expect((refusal as Error).message).toContain(`superseded by ${replacement}`);
    expect(await fixture.store.tip()).toBe(before);
  });

  test("one correction naming two rulings in either order is one record id, its predecessors written sorted", async () => {
    const fixture = await musai("two-orders", [{ id: "only" }]);
    const one = await fixture.rule("only", "holds", PERSON);
    const other = await fixture.rule("only", "fails", PERSON);
    const brief = await fixture.briefFor(fixture.idOf("only"));
    const plan = { ...fixture.reader, ...PERSON, mode: "plan" as const };
    const input = { claim: fixture.idOf("only"), verdict: "fails" as const, reason: "settling both", brief };

    const forward = await runHandler(rulingMake, { ...input, supersedes: [one, other] }, plan);
    const backward = await runHandler(rulingMake, { ...input, supersedes: [other, one] }, plan);

    const rulingOf = (output: typeof forward) => output.minted.find((item) => item.kind === "ruling")!;
    expect(rulingOf(forward).id).toBe(rulingOf(backward).id);
    expect((rulingOf(forward).record as RulingRecord).supersedes).toEqual([one, other].sort());
  });

  test("a menu's answer moves in two steps: a fails over the holding member's hold reopens the menu, and another member's answer then holds", async () => {
    const fixture = await musai("menu-correction", MENU);
    const answered = (await fixture.answer("a", "file", PERSON)).minted.find((item) => item.kind === "ruling")!
      .id as RecordId;
    expect(await fixture.pending()).toEqual([]);

    const direct = await fixture.refusal("b", "holds", PERSON, [], await fixture.briefFor(fixture.idOf("b")));
    expect(direct).toMatchObject({ reason: "sibling-conflict", about: ["disposition", fixture.slotOf("a")] });

    await fixture.rule("a", "fails", PERSON, [answered]);
    expect(await fixture.pending()).toHaveLength(1);

    await fixture.answer("b", "comment", PERSON);
    expect(await fixture.pending()).toEqual([]);
    const labels = await Promise.all(MENU.map(async (spec) => (await fixture.status(spec.id)).label));
    expect(labels).toEqual(["fails", "holds", "fails"]);
  });

  test("in plan mode a correction is previewed and nothing is written, and performing it mints the ids it previewed", async () => {
    const fixture = await musai("plan-mode", [{ id: "only" }]);
    const mistaken = await fixture.rule("only", "holds", PERSON);
    const brief = await fixture.briefFor(fixture.idOf("only"));
    const input = {
      claim: fixture.idOf("only"),
      verdict: "fails" as const,
      reason: "the correction",
      brief,
      supersedes: [mistaken],
    };
    const before = await fixture.store.tip();

    const previewed = await runHandler(rulingMake, input, { ...fixture.reader, ...PERSON, mode: "plan" });
    expect(await fixture.store.tip()).toBe(before);
    expect((await fixture.status("only")).label).toBe("holds");

    const performed = await runHandler(rulingMake, input, { ...fixture.reader, ...PERSON });
    expect(performed.minted.map((item) => item.id)).toEqual(previewed.minted.map((item) => item.id));
    expect((await fixture.status("only")).label).toBe("fails");
  });

  test("a salted ruling previewed mints the ids performing it writes, and still decides its claim", async () => {
    const fixture = await musai("salted-ruling", [{ id: "only" }]);
    const brief = await fixture.briefFor(fixture.idOf("only"));
    const input = { claim: fixture.idOf("only"), verdict: "fails" as const, reason: "ruled salted", brief, salt: true };

    const previewed = await runHandler(rulingMake, input, { ...fixture.reader, ...PERSON, mode: "plan" });
    const performed = await runHandler(rulingMake, input, { ...fixture.reader, ...PERSON });
    expect(performed.minted.map((item) => item.id)).toEqual(previewed.minted.map((item) => item.id));
    const [ruling, attestation] = performed.minted;
    expect(ruling!.record).toMatchObject({ kind: "ruling", salt: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(attestation!.record).toMatchObject({ subject: ruling!.id });
    expect((await fixture.status("only")).label).toBe("fails");
  });

  test("a fold rebuilt from the log answers the same status for a corrected claim", async () => {
    const fixture = await musai("rebuilt-fold", [{ id: "only" }]);
    const mistaken = await fixture.rule("only", "holds", PERSON);
    await fixture.rule("only", "fails", PERSON, [mistaken]);
    const folded = await fixture.status("only");

    const scopeDir = join(fixture.dir, ".musai", "local", "scopes", fixture.scope);
    for (const entry of await readdir(scopeDir)) {
      if (entry.startsWith("index.sqlite")) {
        await rm(join(scopeDir, entry));
      }
    }
    const rebuilt = await fixture.status("only");

    expect(rebuilt).toEqual(folded);
    expect(rebuilt.label).toBe("fails");
  });
});

/** A derivation's hops as label, id, wording and children. */
function hopsOf(node: DerivationJson): unknown {
  return { label: node.label, id: node.id, decidedBy: node.decidedBy, children: node.children.map(hopsOf) };
}

describe("why walks from a ruling to the rulings it replaced", () => {
  test("a corrected claim's derivation reaches the correction, its brief, and the mistaken ruling as a superseded hop naming its verdict and principal", async () => {
    const fixture = await musai("why-correction", [{ id: "only" }]);
    const mistaken = await fixture.rule("only", "holds", PERSON);
    const brief = await fixture.briefFor(fixture.idOf("only"));
    const correction = await fixture.rule("only", "fails", PERSON, [mistaken], brief);

    const derivation = await fixture.why("only");

    const rulingHop = derivation.children[0]!;
    expect(rulingHop).toMatchObject({ label: "ruling", id: correction });
    expect(rulingHop.children.map((child) => child.id)).toEqual([brief, mistaken]);
    expect(rulingHop.children[0]!.label).toBe("brief");
    expect(hopsOf(rulingHop.children[1]!)).toEqual({
      label: "superseded",
      id: mistaken,
      decidedBy: `holds, person ruling by ${PERSON.principal}`,
      children: [],
    });
  });

  test("a chain of two corrections walks down both retired rulings, each beneath the one that replaced it", async () => {
    const fixture = await musai("why-chain", [{ id: "only" }]);
    const first = await fixture.rule("only", "holds", PERSON);
    const second = await fixture.rule("only", "fails", PERSON, [first]);
    const third = await fixture.rule("only", "holds", PERSON, [second]);

    const rulingHop = (await fixture.why("only")).children[0]!;

    expect(rulingHop).toMatchObject({ label: "ruling", id: third });
    expect(rulingHop.children.map((child) => child.label)).toEqual(["brief", "superseded"]);
    expect(hopsOf(rulingHop.children[1]!)).toEqual({
      label: "superseded",
      id: second,
      decidedBy: `fails, person ruling by ${PERSON.principal}`,
      children: [
        { label: "superseded", id: first, decidedBy: `holds, person ruling by ${PERSON.principal}`, children: [] },
      ],
    });
  });

  test("a ruling that supersedes nothing derives the tree it derived with no correction in the store", async () => {
    const fixture = await musai("why-uncorrected", [{ id: "here" }, { id: "there" }]);
    const brief = await fixture.briefFor(fixture.idOf("here"));
    await fixture.rule("here", "holds", PERSON, [], brief);
    const uncorrected = await fixture.why("here");

    const mistaken = await fixture.rule("there", "holds", PERSON);
    await fixture.rule("there", "fails", PERSON, [mistaken]);
    const beside = await fixture.why("here");

    expect(beside).toEqual(uncorrected);
    expect(beside.children[0]!.children.map((child) => child.id)).toEqual([brief]);
  });
});

/** A ruling and its attestation put straight into the store, as a writer past the mint could. */
async function writeRuling(
  fixture: Awaited<ReturnType<typeof musai>>,
  specId: string,
  verdict: "holds" | "fails",
  by: Caller,
  supersedes: readonly RecordId[],
): Promise<RecordId> {
  const ruling: RulingRecord = {
    kind: "ruling",
    supersedes: [...supersedes],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.ruling,
    over: { claim: fixture.idOf(specId) },
    verdict,
    reason: `${by.principal} writes ${verdict}`,
    brief: await fixture.briefFor(fixture.idOf(specId)),
  };
  const [id] = await fixture.store.putMany([{ kind: "ruling", value: ruling }]);
  const attestation = mintAttestation({
    subject: id!,
    principal: by.principal,
    principalClass: by.via === "model" ? "agent" : "person",
    via: by.via,
    purpose: "made",
    at: now(),
  });
  await fixture.store.putMany([{ kind: "attestation", value: attestation.record }]);
  return id!;
}

function nodesIn(node: DerivationJson): DerivationJson[] {
  return [node, ...node.children.flatMap(nodesIn)];
}

describe("a succession the rule does not admit, written past the mint", () => {
  test("a peer's same-tier succession with a conflicting verdict leaves both rulings live, and status and progress read the claim contested", async () => {
    const fixture = await musai("peer-fork", [{ id: "only" }], ROLES_WITH_PEER);
    const maintainers = await fixture.rule("only", "holds", MAINTAINER);
    await writeRuling(fixture, "only", "fails", PEER, [maintainers]);

    const status = await fixture.status("only");
    const progress = await runHandler(caseStatus, { case: "peer-fork" }, fixture.reader);

    expect(status.label).toBe("open");
    expect(status.reason).toBe("contested-authority");
    expect(progress.counts).toEqual({ holds: 0, fails: 0, open: 1, notChosen: 0 });
    expect(progress.done).toBe(false);
  });

  test("the mint admits a correction of a name whose succession did not count", async () => {
    const fixture = await musai("uncounted-then-corrected", [{ id: "only" }], ROLES_WITH_PEER);
    const maintainers = await fixture.rule("only", "holds", MAINTAINER);
    await writeRuling(fixture, "only", "fails", PEER, [maintainers]);

    await fixture.rule("only", "fails", MAINTAINER, [maintainers]);

    expect((await fixture.status("only")).label).toBe("fails");
  });

  test("why renders a name whose succession did not count with its tier, unmarked, beneath one that did", async () => {
    const fixture = await musai("uncounted-in-why", [{ id: "only" }], ROLES_WITH_DELEGATES);
    const delegated = await fixture.rule("only", "holds", DELEGATE);
    const peers = await writeRuling(fixture, "only", "fails", OTHER_DELEGATE, [delegated]);
    const maintainers = await fixture.rule("only", "fails", MAINTAINER, [peers]);

    const root = await fixture.why("only");
    const maintainerNode = nodesIn(root).find((node) => node.id === maintainers)!;
    const peerNode = maintainerNode.children.find((node) => node.id === peers)!;

    expect(peerNode.label).toBe("superseded");
    expect(peerNode.children.map((node) => [node.id, node.label])).toEqual([[delegated, "ruling"]]);
    expect(peerNode.children[0]!.decidedBy).toContain("delegate");
  });

  test("why walks no name that is not a ruling as a ruling", async () => {
    const fixture = await musai("named-a-run", [{ id: "only" }], ROLES_WITH_PEER);
    const run = await fixture.briefFor(fixture.idOf("only"));
    const ruling = await writeRuling(fixture, "only", "fails", MAINTAINER, [run]);

    const rulingNode = nodesIn(await fixture.why("only")).find((node) => node.id === ruling)!;

    expect(rulingNode.children.filter((node) => node.id === run)).toEqual([]);
  });
});
