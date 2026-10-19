import { join } from "node:path";
import { RESOLUTION_AGE_SLOT_ID } from "@musai/evaluate";
import type { OperationPlan } from "@musai/modules";
import {
  type Audience,
  type ClaimRecord,
  CURRENT_SCHEMA_VERSIONS,
  PACK_IRREVERSIBLE_SLOT_ID,
  pseudonymFor,
  type RecordId,
  type ReleaseGrant,
  recordId,
  slotFor,
  type Timestamp,
  TRIPLE_CLAIM_TYPE,
  TRIPLE_DECLARATION,
  timestamp,
  versionString,
} from "@musai/records";
import { LOCAL_DIR, MUSAI_DIR, workspaceKey } from "@musai/store";
import { fixedClock, fixtureRunRecord, writeTrustFile } from "@musai/test-support";
import { mintAttestation } from "@musai/trust";
import { describe, expect, test, vi } from "vitest";
import { runHandler } from "../src/handler.js";
import { openWorkspace } from "../src/open-workspace.js";
import { type AdmittedDeclaration, admitPlan, perform, realisePlan } from "../src/plan.js";
import type { Workspace } from "../src/workspace.js";
import {
  FIXTURE_CLOCK,
  FIXTURE_INSTANT,
  type FixtureWorkspace,
  fixtureGated,
  fixtureWorkspace,
  fixtureWrite,
  refusalOf,
} from "./fixture-distribution.js";

const GRANT: ReleaseGrant = {
  audience: "public" as Audience,
  extent: "record",
  terms: { form: "bytes", uses: ["review"], from: null, until: null, marking: null },
};

const RULING_PRINCIPAL = `key:SHA256:${"r".repeat(43)}`;

const RECORD_NEED = { kind: "record", id: recordId(fixtureRunRecord("needed")) } as const;

function declaration(overrides: Partial<AdmittedDeclaration>): AdmittedDeclaration {
  return {
    id: "fixture.declared",
    version: versionString("1"),
    effect: "write",
    authority: null,
    contributed: false,
    ...overrides,
  };
}

function plan(overrides: Partial<OperationPlan>): OperationPlan {
  return { put: [], attest: [], needs: [], ...overrides };
}

function opened(workspace: FixtureWorkspace, now = FIXTURE_CLOCK): Promise<Workspace> {
  return openWorkspace({ workspace: workspace.dir, scope: workspace.scope, now });
}

describe("admitPlan and realisePlan, the gates every operation's plan passes", () => {
  test("admitPlan refuses a read whose plan writes or carries needs, as invalid-output", async () => {
    const workspace = await fixtureWorkspace();
    const view = await opened(workspace);
    const read = declaration({ id: "fixture.reads", effect: "read" });
    const run = { kind: "run", value: fixtureRunRecord("written by a read") } as const;

    const putting = await refusalOf(() =>
      admitPlan(plan({ put: [run] }), read, view, workspace.context(), RULING_PRINCIPAL),
    );
    expect(putting).toMatchObject({ reason: "invalid-output", code: "bug", about: ["fixture.reads@1"] });
    expect(putting.message).toContain("fixture.reads@1 declares a read, and its plan writes records");

    const attesting = await refusalOf(() =>
      admitPlan(
        plan({ attest: [{ subject: { put: 0 }, purpose: "made" }] }),
        read,
        view,
        workspace.context(),
        RULING_PRINCIPAL,
      ),
    );
    expect(attesting.message).toContain("fixture.reads@1 declares a read, and its plan writes records");

    const needing = await refusalOf(() =>
      admitPlan(plan({ needs: [RECORD_NEED] }), read, view, workspace.context(), RULING_PRINCIPAL),
    );
    expect(needing).toMatchObject({ reason: "invalid-output", about: ["fixture.reads@1"] });
    expect(needing.message).toContain("fixture.reads@1 declares a read, and its plan carries needs");

    expect(admitPlan(plan({}), read, view, workspace.context(), RULING_PRINCIPAL)).toBeUndefined();
  });

  test("admitPlan refuses needs on an operation whose effect is neither performs nor irreversible", async () => {
    const workspace = await fixtureWorkspace();
    const view = await opened(workspace);
    const needing = plan({ needs: [RECORD_NEED] });

    const refusal = await refusalOf(() =>
      admitPlan(needing, declaration({ effect: "write" }), view, workspace.context(), RULING_PRINCIPAL),
    );
    expect(refusal).toMatchObject({ reason: "invalid-output", about: ["fixture.declared@1"] });
    expect(refusal.message).toContain("fixture.declared@1 declares write, and its plan carries needs");

    expect(
      admitPlan(needing, declaration({ effect: "performs" }), view, workspace.context(), RULING_PRINCIPAL),
    ).toBeUndefined();
    expect(
      admitPlan(needing, declaration({ effect: "irreversible" }), view, workspace.context(), RULING_PRINCIPAL),
    ).toBeUndefined();
  });

  test("admitPlan refuses an operation whose declared authority the acting principal does not hold, not-authorised", async () => {
    const workspace = await fixtureWorkspace();
    const secret = await workspaceKey(join(workspace.dir, MUSAI_DIR, LOCAL_DIR), { now: FIXTURE_CLOCK });
    const [ruler, bystanding] = [pseudonymFor(secret, "ruler"), pseudonymFor(secret, "bystander")];
    await writeTrustFile({ gitDir: join(workspace.dir, MUSAI_DIR) }, "roles", `${ruler} delegate any\n`);
    const before = await workspace.head();

    const bystander = await refusalOf(() =>
      runHandler(fixtureGated, { label: "by a bystander" }, workspace.context({ principalName: "bystander" })),
    );
    expect(bystander).toMatchObject({ reason: "not-authorised", code: "authority", about: [bystanding, "rule"] });
    expect(bystander.message).toContain(
      `fixture.gated@1 needs rule, and the role matrix does not grant it to ${bystanding}`,
    );

    const previewed = await refusalOf(() =>
      runHandler(fixtureGated, { label: "previewed" }, workspace.context({ principalName: "bystander", mode: "plan" })),
    );
    expect(previewed).toMatchObject({ reason: "not-authorised", about: [bystanding, "rule"] });

    const nobody = await refusalOf(() => runHandler(fixtureGated, { label: "by nobody" }, workspace.context()));
    expect(nobody).toMatchObject({ reason: "not-authorised", about: ["fixture.gated@1", "rule"] });
    expect(nobody.message).toContain("no principal was established to hold it");
    expect(await workspace.head()).toBe(before);

    const ruled = await runHandler(
      fixtureGated,
      { label: "by the ruler" },
      workspace.context({ principalName: "ruler" }),
    );
    expect(ruled.minted.map((item) => item.id)).toEqual([recordId(fixtureRunRecord("by the ruler"))]);
    expect(await workspace.head()).not.toBe(before);
  });

  test("admitPlan refuses a release, a revocation or a re-share from an operation that does not declare publish", async () => {
    const workspace = await fixtureWorkspace();
    const view = await opened(workspace);
    const context = workspace.context({ via: "tty" });
    const subject = { record: recordId(fixtureRunRecord("released")) };
    const moving = [
      { subject, purpose: "released", release: GRANT },
      { subject, purpose: "revoked", supersedes: [recordId({ marker: "a release it withdraws" })] },
      { subject, purpose: "re-shared" },
    ] as const;

    for (const intent of moving) {
      const refusal = await refusalOf(() =>
        admitPlan(plan({ attest: [intent] }), declaration({}), view, context, RULING_PRINCIPAL),
      );
      expect(refusal).toMatchObject({ reason: "not-authorised", about: ["fixture.declared@1", "publish"] });
      expect(refusal.message).toContain(
        `fixture.declared@1 asks for a ${intent.purpose} attestation, which moves a record across the export boundary, and declares no publish authority`,
      );
      expect(
        admitPlan(plan({ attest: [intent] }), declaration({ authority: "publish" }), view, context, RULING_PRINCIPAL),
      ).toBeUndefined();
    }
    expect(
      admitPlan(
        plan({ attest: [{ subject: { put: 0 }, purpose: "made" }] }),
        declaration({}),
        view,
        context,
        RULING_PRINCIPAL,
      ),
    ).toBeUndefined();
  });

  test("admitPlan refuses a seal from an operation that does not declare publish, or relayed through model", async () => {
    const workspace = await fixtureWorkspace();
    const view = await opened(workspace);
    const sealing = plan({
      attest: [
        {
          subject: { record: recordId(fixtureRunRecord("sealed")) },
          purpose: "sealed",
          seal: { audience: "cast" as Audience },
        },
      ],
    });
    const person = workspace.context({ via: "tty" });

    const undeclared = await refusalOf(() => admitPlan(sealing, declaration({}), view, person, RULING_PRINCIPAL));
    expect(undeclared).toMatchObject({ reason: "not-authorised", about: ["fixture.declared@1", "publish"] });
    expect(undeclared.message).toContain(
      "fixture.declared@1 asks for a sealed attestation, which decides what a station sees, and declares no publish authority",
    );

    const relayed = await refusalOf(() =>
      admitPlan(
        sealing,
        declaration({ authority: "publish" }),
        view,
        workspace.context({ via: "model" }),
        RULING_PRINCIPAL,
      ),
    );
    expect(relayed).toMatchObject({ reason: "not-authorised", about: ["fixture.declared@1", "model"] });
    expect(relayed.message).toContain("fixture.declared@1 asks to make a seal through model");

    expect(admitPlan(sealing, declaration({ authority: "publish" }), view, person, RULING_PRINCIPAL)).toBeUndefined();
  });

  test("admitPlan refuses a release relayed through model, and admits a person's", async () => {
    const workspace = await fixtureWorkspace();
    const view = await opened(workspace);
    const releasing = plan({
      attest: [{ subject: { record: recordId(fixtureRunRecord("released")) }, purpose: "released", release: GRANT }],
    });
    const publishing = declaration({ authority: "publish" });
    const by = (via: "model" | "tty") => workspace.context({ via });

    const relayed = await refusalOf(() => admitPlan(releasing, publishing, view, by("model"), RULING_PRINCIPAL));
    expect(relayed).toMatchObject({ reason: "not-authorised", about: ["fixture.declared@1", "model"] });
    expect(relayed.message).toContain("fixture.declared@1 asks to make a release through model");

    expect(admitPlan(releasing, publishing, view, by("tty"), RULING_PRINCIPAL)).toBeUndefined();
  });

  test("admitPlan refuses a making or an asserting over a record the plan does not put", async () => {
    const workspace = await fixtureWorkspace();
    const view = await opened(workspace);
    const context = workspace.context({ via: "tty" });
    const held = recordId(fixtureRunRecord("held"));

    for (const purpose of ["made", "asserted"] as const) {
      const refusal = await refusalOf(() =>
        admitPlan(
          plan({ attest: [{ subject: { record: held }, purpose }] }),
          declaration({ authority: "publish" }),
          view,
          context,
          RULING_PRINCIPAL,
        ),
      );
      expect(refusal).toMatchObject({ reason: "invalid-output", about: ["fixture.declared@1", held] });
      expect(refusal.message).toContain(
        `fixture.declared@1 asks for a ${purpose} attestation over ${held}, a record its plan does not put`,
      );
    }
  });

  test("realisePlan mints an attestation over a record the store already holds", async () => {
    const workspace = await fixtureWorkspace();
    const context = workspace.context({ via: "tty" });
    const written = await runHandler(fixtureWrite, { label: "already held" }, context);
    const held = written.minted[0]!.id;

    const realised = await realisePlan(
      plan({ attest: [{ subject: { record: held }, purpose: "released", release: GRANT }] }),
      await opened(workspace),
      context,
      "fixture.releases@1",
      RULING_PRINCIPAL,
    );
    expect(realised.minted).toHaveLength(1);
    expect(realised.minted[0]!.record).toMatchObject({
      kind: "attestation",
      subject: held,
      purpose: "released",
      audience: "public",
      extent: "record",
    });
  });

  test("realisePlan refuses an attestation over a record the store does not hold, naming it", async () => {
    const workspace = await fixtureWorkspace();
    const view = await opened(workspace);
    const absent = recordId(fixtureRunRecord("never written"));

    const refusal = await refusalOf(() =>
      realisePlan(
        plan({ attest: [{ subject: { record: absent }, purpose: "released", release: GRANT }] }),
        view,
        workspace.context({ via: "tty" }),
        "fixture.attests@1",
        RULING_PRINCIPAL,
      ),
    );
    expect(refusal).toMatchObject({ reason: "no-such-record", about: [absent] });
  });

  test("realisePlan refuses a put entry its kind's validation refuses as invalid-output naming the entry", async () => {
    const workspace = await fixtureWorkspace();
    const view = await opened(workspace);
    const valid = { kind: "run", value: fixtureRunRecord("valid") } as const;
    const malformed = { kind: "run", value: { ...fixtureRunRecord("malformed"), determinism: "sometimes" } } as const;

    const invalid = await refusalOf(() =>
      realisePlan(plan({ put: [valid, malformed] }), view, workspace.context(), "fixture.write@1", RULING_PRINCIPAL),
    );
    expect(invalid).toMatchObject({ reason: "invalid-output", about: ["fixture.write@1", "put/1"] });
    expect(invalid.message).toContain("fixture.write@1 drafts a run at put 1 that is not a valid record");

    const misfiled = await refusalOf(() =>
      realisePlan(
        plan({ put: [{ kind: "claim", value: fixtureRunRecord("filed as a claim") }] }),
        view,
        workspace.context(),
        "fixture.write@1",
        RULING_PRINCIPAL,
      ),
    );
    expect(misfiled).toMatchObject({ reason: "invalid-output", about: ["fixture.write@1", "put/0"] });
    expect(misfiled.message).toContain("fixture.write@1 drafts a claim at put 0 that is a run record");
  });

  test("realisePlan refuses an attestation intent with no principal or no channel, invalid-input", async () => {
    const workspace = await fixtureWorkspace();
    const view = await opened(workspace);
    const attesting = plan({
      put: [{ kind: "run", value: fixtureRunRecord("attested") }],
      attest: [{ subject: { put: 0 }, purpose: "made" }],
    });

    const noPrincipal = await refusalOf(() =>
      realisePlan(attesting, view, workspace.context({ via: "tty" }), "fixture.attests@1", undefined),
    );
    expect(noPrincipal).toMatchObject({ reason: "invalid-input", code: "invocation", about: ["principal"] });
    expect(noPrincipal.message).toContain("it has no principal to attest under");

    const noChannel = await refusalOf(() =>
      realisePlan(attesting, view, workspace.context(), "fixture.attests@1", RULING_PRINCIPAL),
    );
    expect(noChannel).toMatchObject({ reason: "invalid-input", about: ["via"] });
  });

  test("realisePlan mints the same ids twice under one clock", async () => {
    const workspace = await fixtureWorkspace();
    const drafted = fixtureRunRecord("attested");
    const attesting = plan({
      put: [{ kind: "run", value: drafted }],
      attest: [{ subject: { put: 0 }, purpose: "made" }],
    });
    const context = workspace.context({ via: "tty" });
    const attestationAt = (at: Timestamp): RecordId =>
      mintAttestation({
        subject: recordId(drafted),
        principal: RULING_PRINCIPAL,
        principalClass: "person",
        via: "tty",
        purpose: "made",
        at,
      }).id;
    const expected = [recordId(drafted), attestationAt(FIXTURE_INSTANT)];

    const view = await opened(workspace);
    const first = await realisePlan(attesting, view, context, "fixture.attests@1", RULING_PRINCIPAL);
    const second = await realisePlan(attesting, view, context, "fixture.attests@1", RULING_PRINCIPAL);

    expect(first.minted.map((item) => item.id)).toEqual(expected);
    expect(second.minted.map((item) => item.id)).toEqual(expected);

    const later = timestamp("2026-01-02T00:00:00.000Z");
    const underLater = await realisePlan(
      attesting,
      await opened(workspace, fixedClock(later)),
      context,
      "fixture.attests@1",
      RULING_PRINCIPAL,
    );
    expect(underLater.minted.map((item) => item.id)).toEqual([recordId(drafted), attestationAt(later)]);
  });
});

describe("the slots a plan is admitted and performed under, over a workspace no installed module of which declares them", () => {
  test("a plan with a need over a workspace no installed module of which declares the resolution-age slot refuses workspace-incomplete naming it", async () => {
    const workspace = await fixtureWorkspace();
    const view = await opened(workspace);
    const needing = plan({ needs: [RECORD_NEED] });
    const realised = await realisePlan(needing, view, workspace.context(), "fixture.needs@1", RULING_PRINCIPAL);
    const before = await workspace.head();

    const refusal = await refusalOf(() => perform(realised, needing.needs, view));

    expect(refusal).toMatchObject({
      reason: "workspace-incomplete",
      code: "workspace",
      about: [RESOLUTION_AGE_SLOT_ID],
    });
    expect(await workspace.head()).toBe(before);
  });

  test("a contributed irreversible operation over a workspace declaring no pack-irreversible slot refuses the same, naming it", async () => {
    const workspace = await fixtureWorkspace();
    const view = await opened(workspace);
    const irreversible = declaration({ id: "fixture-pack/irreversible", effect: "irreversible", contributed: true });

    const refusal = await refusalOf(() =>
      admitPlan(plan({}), irreversible, view, workspace.context(), RULING_PRINCIPAL),
    );

    expect(refusal).toMatchObject({
      reason: "workspace-incomplete",
      code: "workspace",
      about: [PACK_IRREVERSIBLE_SLOT_ID],
    });
  });
});

describe("a plan asks the kernel to salt a draft, and never names the salt", () => {
  function atom(): ClaimRecord {
    const conditions = { subject: "urn:loom:mara", predicate: "is", object: "the heir" };
    return {
      kind: "claim",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
      type: TRIPLE_CLAIM_TYPE,
      about: [],
      slot: slotFor(TRIPLE_DECLARATION, conditions),
      conditions,
      canonical: conditions,
      rendering: "Mara is the heir.",
      evidence: [],
      exclusiveGroup: null,
    };
  }

  test("realisePlan salts a draft that asks, and the perform after it writes the id the plan showed", async () => {
    const workspace = await fixtureWorkspace();
    const view = await opened(workspace);
    const context = workspace.context({ via: "tty" });
    const salting = plan({
      put: [{ kind: "claim", value: atom(), salt: true }],
      attest: [{ subject: { put: 0 }, purpose: "made" }],
    });

    const realised = await realisePlan(salting, view, context, "fixture.salts@1", RULING_PRINCIPAL);
    const [claim, attestation] = realised.minted;
    expect(claim!.id).not.toBe(recordId(atom()));
    expect(claim!.record).toEqual({ ...atom(), salt: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(attestation!.record).toMatchObject({ subject: claim!.id });

    const again = await realisePlan(salting, view, context, "fixture.salts@1", RULING_PRINCIPAL);
    expect(again.minted.map((item) => item.id)).toEqual(realised.minted.map((item) => item.id));

    await perform(realised, [], view);
    expect(view.read(claim!.id)).toEqual(claim!.record);
  });

  test("realisePlan refuses the first invalid draft in plan order, whether a case or a claim", async () => {
    const workspace = await fixtureWorkspace();
    const view = await opened(workspace);
    const invalidCase = { kind: "case", value: { kind: "case" } } as const;
    const invalidClaim = { kind: "claim", value: { kind: "claim" } } as const;

    const caseFirst = await refusalOf(() =>
      realisePlan(
        plan({ put: [invalidCase, invalidClaim] }),
        view,
        workspace.context(),
        "fixture.drafts@1",
        RULING_PRINCIPAL,
      ),
    );
    const claimFirst = await refusalOf(() =>
      realisePlan(
        plan({ put: [invalidClaim, invalidCase] }),
        view,
        workspace.context(),
        "fixture.drafts@1",
        RULING_PRINCIPAL,
      ),
    );

    expect(caseFirst).toMatchObject({ reason: "invalid-output", about: ["fixture.drafts@1", "put/0"] });
    expect(caseFirst.message).toContain("drafts a case at put 0");
    expect(claimFirst).toMatchObject({ reason: "invalid-output", about: ["fixture.drafts@1", "put/0"] });
    expect(claimFirst.message).toContain("drafts a claim at put 0");
  });

  test("realisePlan salts nothing once an earlier draft of the plan is refused", async () => {
    const workspace = await fixtureWorkspace();
    const view = await opened(workspace);
    const salted = vi.spyOn(view.store, "salted");
    const invalidClaim = { kind: "claim", value: { kind: "claim" } } as const;

    await refusalOf(() =>
      realisePlan(
        plan({ put: [invalidClaim, { kind: "claim", value: atom(), salt: true }] }),
        view,
        workspace.context(),
        "fixture.drafts@1",
        RULING_PRINCIPAL,
      ),
    );

    expect(salted).not.toHaveBeenCalled();
  });

  test("realisePlan refuses a draft asking for a salt and naming one, as invalid-output naming the entry", async () => {
    const workspace = await fixtureWorkspace();
    const view = await opened(workspace);
    const named = { kind: "claim", value: { ...atom(), salt: "5a".repeat(32) }, salt: true } as const;

    const refusal = await refusalOf(() =>
      realisePlan(plan({ put: [named] }), view, workspace.context(), "fixture.salts@1", RULING_PRINCIPAL),
    );
    expect(refusal).toMatchObject({ reason: "invalid-output", about: ["fixture.salts@1", "put/0"] });
    expect(refusal.message).toContain("names a salt");
  });

  test("realisePlan puts a salted record the fold already holds as it stands", async () => {
    const workspace = await fixtureWorkspace();
    const view = await opened(workspace);
    const context = workspace.context();
    const first = await realisePlan(
      plan({ put: [{ kind: "claim", value: atom(), salt: true }] }),
      view,
      context,
      "fixture.salts@1",
      RULING_PRINCIPAL,
    );
    await perform(first, [], view);
    const held = first.minted[0]!;

    const again = await realisePlan(
      plan({ put: [{ kind: "claim", value: held.record }] }),
      view,
      context,
      "fixture.salts@1",
      RULING_PRINCIPAL,
    );
    expect(again.minted.map((item) => item.id)).toEqual([held.id]);
  });

  test("realisePlan refuses to salt a kind no writer salts, as invalid-output naming the entry", async () => {
    const workspace = await fixtureWorkspace();
    const view = await opened(workspace);
    const refusal = await refusalOf(() =>
      realisePlan(
        plan({ put: [{ kind: "run", value: fixtureRunRecord("salted"), salt: true }] }),
        view,
        workspace.context(),
        "fixture.salts@1",
        RULING_PRINCIPAL,
      ),
    );
    expect(refusal).toMatchObject({ reason: "invalid-output", about: ["fixture.salts@1", "put/0"] });
    expect(refusal.message).toContain("a run is never salted");
  });
});
