import { join } from "node:path";
import type { OperationPlan, PlannedRecord } from "@musai/modules";
import {
  type ArgumentRecord,
  type ArtifactRecord,
  type ClaimTypeDeclaration,
  CURRENT_SCHEMA_VERSIONS,
  type EvidenceEdge,
  type KernelError,
  KIND_CONTRACTS,
  type ModuleRecord,
  RECORD_KINDS,
  type RecordId,
  type RecordKind,
  type RulingRecord,
  recordId,
  renderSelector,
  type SealedValue,
  slotFor,
  TRIPLE_DECLARATION,
  versionString,
} from "@musai/records";
import { MUSAI_DIR } from "@musai/store";
import {
  fixtureRunRecord,
  installModuleRecord,
  installParserFixture,
  manifestWithContributions,
  PARSER_FIXTURE_MODULE,
  PARSER_FIXTURE_SELECTOR,
  parserFixtureManifest,
  rewriteBlob,
  writeTrustFile,
} from "@musai/test-support";
import { mintAttestation } from "@musai/trust";
import { describe, expect, test } from "vitest";
import { buildAdmissionWorkspace } from "../src/admission.js";
import type { Mode } from "../src/context.js";
import { applyContributedOperation, type DraftAdmission } from "../src/contributed.js";
import { OperationError } from "../src/errors.js";
import { installedModules } from "../src/events.js";
import { verifiedEvidenceEdge } from "../src/evidence.js";
import { openWorkspace } from "../src/open-workspace.js";
import { type AppliedPlan, draftRefusal } from "../src/plan.js";
import { FIXTURE_CLOCK, type FixtureWorkspace, fixtureWorkspace, refusalOf } from "./fixture-distribution.js";

const OBSERVED: ClaimTypeDeclaration = { type: "fixture-contributed/observed@1", identityDimensions: ["subject"] };

const DECLARATION = {
  id: "fixture-pack/drafts",
  version: versionString("1"),
  effect: "write",
  authority: null,
} as const;
const OPERATION = "fixture-pack/drafts@1";

/** Admits every draft, so whatever is refused here the kernel refused on its own. */
const ADMITS_EVERYTHING: DraftAdmission = async () => {};

/** No case record is stored under either: the kernel's refusals never read an artifact's case. */
const CASE = recordId({ fixture: "the case every drafted artifact belongs to" });
const OTHER_CASE = recordId({ fixture: "a case no drafted artifact belongs to" });

const SEALED: SealedValue = {
  $sealed: {
    alg: "aes-256-gcm",
    keyId: "a-key-this-workspace-never-held",
    ciphertext: "bm90LXRleHQtYW55Ym9keS1tZWFudC10by1yZWFk",
    digest: "b".repeat(64),
  },
};

function claimDraft(subject: string, supersedes: readonly RecordId[] = []): Record<string, unknown> {
  return {
    kind: "claim",
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: OBSERVED.type,
    about: [],
    conditions: { subject },
    canonical: { subject },
    rendering: `${subject} is observed`,
    evidence: [],
    exclusiveGroup: null,
    supersedes: [...supersedes],
  };
}

function argumentDraft(target: RecordId, supersedes: readonly RecordId[] = []): ArgumentRecord {
  return {
    kind: "argument",
    schemaVersion: CURRENT_SCHEMA_VERSIONS.argument,
    target,
    reason: "the receipt says otherwise",
    evidence: [],
    premises: [],
    supersedes: [...supersedes],
  };
}

function artifactDraft(caseId: RecordId, content: string, supersedes: readonly RecordId[] = []): ArtifactRecord {
  return {
    kind: "artifact",
    schemaVersion: CURRENT_SCHEMA_VERSIONS.artifact,
    case: caseId,
    lifecycle: "drafted",
    content,
    format: "text",
    supersedes: [...supersedes],
  };
}

function rulingDraft(claim: RecordId, brief: RecordId): RulingRecord {
  return {
    kind: "ruling",
    schemaVersion: CURRENT_SCHEMA_VERSIONS.ruling,
    over: { claim },
    verdict: "holds",
    reason: "the brief bears it out",
    brief,
    supersedes: [],
  };
}

/** Nothing is stored under the preset's module record: the kernel's refusals never read it. */
function caseDraft(supersedes: readonly RecordId[] = []): Record<string, unknown> {
  return {
    kind: "case",
    schemaVersion: CURRENT_SCHEMA_VERSIONS.case,
    slug: "a-case-a-pack-books",
    type: null,
    claims: [],
    preset: {
      module: "fixture-pack",
      contribution: "fixture-pack/preset",
      moduleRecord: recordId({ fixture: "the module record a drafted case names" }),
    },
    projectCommit: "a".repeat(40),
    overrides: {},
    evaluatorVersion: versionString("1"),
    supersedes: [...supersedes],
  };
}

function planOf(...put: PlannedRecord[]): OperationPlan {
  return { put, attest: [], needs: [] };
}

function sealedAt(value: object, path: string): Record<string, unknown> {
  const [field, ...rest] = path.split(".").slice(1);
  const record = value as Record<string, unknown>;
  const replaced = rest.length === 0 ? SEALED : sealedAt(record[field!] as object, `$.${rest.join(".")}`);
  return { ...record, [field!]: replaced };
}

async function applied(
  workspace: FixtureWorkspace,
  plan: OperationPlan,
  mode: Mode,
  admitDrafts: DraftAdmission = ADMITS_EVERYTHING,
): Promise<AppliedPlan> {
  const opened = await openWorkspace({ workspace: workspace.dir, scope: workspace.scope, now: FIXTURE_CLOCK });
  return applyContributedOperation(plan, DECLARATION, opened, workspace.context({ mode }), admitDrafts);
}

/** The refusals `plan` draws previewed and performed, each checked to leave the tip unmoved. */
async function refusedBothWays(
  workspace: FixtureWorkspace,
  plan: OperationPlan,
  admitDrafts: DraftAdmission = ADMITS_EVERYTHING,
): Promise<readonly KernelError[]> {
  const before = await workspace.head();
  const previewed = await refusalOf(() => applied(workspace, plan, "plan", admitDrafts));
  const performed = await refusalOf(() => applied(workspace, plan, "perform", admitDrafts));
  expect(await workspace.head()).toBe(before);
  return [previewed, performed];
}

/** That `refusal` is the kernel's own over `put/<index>`, not a gate's or the distribution's. */
function expectKernelRefusal(refusal: KernelError, index: number, kind: RecordKind, detail: string): void {
  expect(refusal).toMatchObject({ reason: "invalid-output", about: [OPERATION, `put/${index}`] });
  expect(refusal.message).toBe(
    `${OPERATION} drafts a ${kind} at put ${index} that the kernel refuses of every draft: ${detail}`,
  );
}

describe("the kernel refuses what no distribution's admission may admit of a pack's drafts, whatever their kind", () => {
  test("refuses a draft superseding a record, whatever the distribution admits", async () => {
    const workspace = await fixtureWorkspace({ claimTypes: [OBSERVED] });
    const [retired] = await workspace.store().putMany([{ kind: "run", value: fixtureRunRecord("retired") }]);
    const superseding: readonly PlannedRecord[] = [
      { kind: "claim", value: claimDraft("superseding", [retired!]) },
      { kind: "argument", value: argumentDraft(retired!, [retired!]) },
      { kind: "case", value: caseDraft([retired!]), about: [] },
    ];

    for (const entry of superseding) {
      for (const refusal of await refusedBothWays(workspace, planOf(entry))) {
        expectKernelRefusal(
          refusal,
          0,
          entry.kind,
          `a ${entry.kind} that supersedes a record retires it, and that is an act its own verb asks authority for`,
        );
      }
    }

    const refusesEveryDraft: DraftAdmission = async () => {
      throw new OperationError({
        reason: "invalid-output",
        about: [OPERATION, "put/0"],
        detail: "the distribution refuses every draft",
      });
    };
    const admittedFirst = planOf({ kind: "argument", value: argumentDraft(retired!) }, superseding[0]!);
    for (const refusal of await refusedBothWays(workspace, admittedFirst, refusesEveryDraft)) {
      expectKernelRefusal(
        refusal,
        1,
        "claim",
        "a claim that supersedes a record retires it, and that is an act its own verb asks authority for",
      );
    }
  });

  test("refuses a pack's draft of a run for its kind before its succession or its sealed values", async () => {
    const workspace = await fixtureWorkspace();
    const [retired] = await workspace.store().putMany([{ kind: "run", value: fixtureRunRecord("retired") }]);
    const drafted = fixtureRunRecord("a run a pack says it ran");
    const runs: readonly object[] = [
      drafted,
      { ...drafted, supersedes: [retired!] },
      sealedAt(drafted, "$.observation.output"),
    ];

    for (const run of runs) {
      for (const refusal of await refusedBothWays(workspace, planOf({ kind: "run", value: run }))) {
        expectKernelRefusal(
          refusal,
          0,
          "run",
          "a pack drafts no run, since its kind's contract lets no pack draft one",
        );
      }
    }
  });

  test("refuses a pack's draft of an attestation, which the kernel alone mints under a key the workspace holds", async () => {
    const workspace = await fixtureWorkspace();
    const [run] = await workspace.store().putMany([{ kind: "run", value: fixtureRunRecord("attested") }]);
    const attestation = mintAttestation({
      subject: run!,
      principal: `key:SHA256:${"k".repeat(43)}`,
      principalClass: "person",
      via: "tty",
      purpose: "asserted",
      at: FIXTURE_CLOCK(),
    }).record;
    const plan = planOf({ kind: "attestation", value: attestation });

    for (const refusal of await refusedBothWays(workspace, plan)) {
      expectKernelRefusal(
        refusal,
        0,
        "attestation",
        "a pack drafts no attestation, since its kind's contract lets no pack draft one",
      );
    }
  });

  test("refuses a pack's draft of a module record, which only an install mints and which would re-pin the module of its name", async () => {
    const workspace = await fixtureWorkspace();
    const plan = planOf({
      kind: "module",
      value: {
        kind: "module",
        schemaVersion: CURRENT_SCHEMA_VERSIONS.module,
        name: "musai.core",
        version: versionString("1.0.0"),
        manifest: manifestWithContributions([]),
        bundle: null,
        build: null,
        supersedes: [],
      },
    });

    for (const refusal of await refusedBothWays(workspace, plan)) {
      expectKernelRefusal(
        refusal,
        0,
        "module",
        "a pack drafts no module, since its kind's contract lets no pack draft one",
      );
    }
  });

  test("refuses a pack's draft of a rule record, which nothing mints", async () => {
    const workspace = await fixtureWorkspace();
    const plan = planOf({
      kind: "rule",
      value: {
        kind: "rule",
        schemaVersion: CURRENT_SCHEMA_VERSIONS.rule,
        name: "a rule a pack states",
        scope: {},
        weight: "1",
        supersedes: [],
        contribution: null,
      },
    });

    for (const refusal of await refusedBothWays(workspace, plan)) {
      expectKernelRefusal(
        refusal,
        0,
        "rule",
        "a pack drafts no rule, since its kind's contract lets no pack draft one",
      );
    }
  });

  test("refuses a pack's draft of a ruling, which a distribution's own verb mints under its authority check", async () => {
    const workspace = await fixtureWorkspace();
    const [run] = await workspace.store().putMany([{ kind: "run", value: fixtureRunRecord("ruled over") }]);
    const plan = planOf({ kind: "ruling", value: rulingDraft(run!, run!) });

    for (const refusal of await refusedBothWays(workspace, plan)) {
      expectKernelRefusal(
        refusal,
        0,
        "ruling",
        "a pack drafts no ruling, since its kind's contract lets no pack draft one",
      );
    }
  });

  test("refuses an artifact standing in for anything but one artifact of its own case", async () => {
    const workspace = await fixtureWorkspace();
    const [run, own, ownAgain, elsewhere] = await workspace.store().putMany([
      { kind: "run", value: fixtureRunRecord("not an artifact") },
      { kind: "artifact", value: artifactDraft(CASE, "the first draft") },
      { kind: "artifact", value: artifactDraft(CASE, "a second draft beside it") },
      { kind: "artifact", value: artifactDraft(OTHER_CASE, "another case's draft") },
    ]);
    const unheld = recordId({ fixture: "a record this workspace does not hold" });
    const cases: readonly (readonly [readonly RecordId[], string])[] = [
      [[run!], `an artifact stands in for an artifact of its own case, and ${run} is a run record`],
      [
        [elsewhere!],
        `an artifact stands in for an artifact of its own case, and ${elsewhere} belongs to case ${OTHER_CASE}`,
      ],
      [[own!, ownAgain!], "an artifact stands in for one artifact, and this one names 2"],
      [[unheld], `no record ${unheld} in scope ${workspace.scope}`],
    ];

    for (const [supersedes, detail] of cases) {
      const standingIn = planOf({ kind: "artifact", value: artifactDraft(CASE, "the next draft", supersedes) });
      for (const refusal of await refusedBothWays(workspace, standingIn)) {
        expectKernelRefusal(refusal, 0, "artifact", detail);
      }
    }
  });

  test("refuses a sealed value at every path the contract of a kind a pack may draft declares sealable", async () => {
    const workspace = await fixtureWorkspace({ claimTypes: [OBSERVED] });
    const cited = recordId(fixtureRunRecord("cited"));
    const unsealed: Readonly<Partial<Record<RecordKind, object>>> = {
      argument: argumentDraft(cited),
      artifact: artifactDraft(CASE, "a draft to seal"),
      claim: claimDraft("sealed"),
    };
    const sealable = RECORD_KINDS.filter((kind) => KIND_CONTRACTS[kind].packMayDraft).flatMap((kind) =>
      [...KIND_CONTRACTS[kind].sealedPaths].map((path) => ({ kind, path })),
    );
    expect([...new Set(sealable.map(({ kind }) => kind))].sort()).toEqual(Object.keys(unsealed).sort());

    for (const { kind, path } of sealable) {
      const sealed = planOf({ kind, value: sealedAt(unsealed[kind]!, path) });
      for (const refusal of await refusedBothWays(workspace, sealed)) {
        expectKernelRefusal(
          refusal,
          0,
          kind,
          `its ${path.slice("$.".length)} is sealed, and a value a pack hands over was sealed under no key this workspace holds`,
        );
      }
    }
  });

  test("refuses a pack's draft naming its own salt, which only the kernel mints, even of a record it holds", async () => {
    const workspace = await fixtureWorkspace();
    const named = { ...artifactDraft(CASE, "a guessable draft"), salt: "5a".repeat(32) };
    await workspace.store().putMany([{ kind: "artifact", value: named }]);

    for (const refusal of await refusedBothWays(workspace, planOf({ kind: "artifact", value: named }))) {
      expectKernelRefusal(
        refusal,
        0,
        "artifact",
        "a pack names no salt: the kernel mints one where a draft asks for it",
      );
    }
  });

  test("salts a pack's draft that asks, previewed and performed under one id", async () => {
    const workspace = await fixtureWorkspace();
    const plan = planOf({ kind: "artifact", value: artifactDraft(CASE, "a draft to salt"), salt: true });

    const previewed = await applied(workspace, plan, "plan");
    const performed = await applied(workspace, plan, "perform");
    expect(performed.minted).toEqual(previewed.minted);
    expect(performed.minted[0]!.record).toMatchObject({ salt: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  test("admits an artifact standing in for one artifact of its own case, and performs it", async () => {
    const workspace = await fixtureWorkspace();
    const [predecessor] = await workspace
      .store()
      .putMany([{ kind: "artifact", value: artifactDraft(CASE, "the first draft") }]);
    const successor = artifactDraft(CASE, "the next draft", [predecessor!]);
    const plan = planOf({ kind: "artifact", value: successor });
    const before = await workspace.head();

    const previewed = await applied(workspace, plan, "plan");
    expect(previewed.minted).toEqual([{ id: recordId(successor), kind: "artifact", record: successor }]);
    expect(await workspace.head()).toBe(before);

    const performed = await applied(workspace, plan, "perform");
    expect(performed.minted).toEqual(previewed.minted);
    expect(await workspace.head()).not.toBe(before);
    expect(await workspace.store().read(recordId(successor), "artifact")).toEqual(successor);
  });
});

function tripleClaimDraft(subject: string, evidence: readonly EvidenceEdge[]): Record<string, unknown> {
  const conditions = { subject, predicate: "rests-on", object: "the-edges-it-cites" };
  return {
    kind: "claim",
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: TRIPLE_DECLARATION.type,
    about: [],
    slot: slotFor(TRIPLE_DECLARATION, conditions),
    conditions,
    canonical: conditions,
    rendering: `${subject} rests on the edges it cites`,
    evidence: [...evidence],
    exclusiveGroup: null,
    supersedes: [],
  };
}

function argumentCiting(evidence: readonly EvidenceEdge[]): ArgumentRecord {
  return { ...argumentDraft(evidence[0]!.run), evidence: [...evidence] };
}

/** The parser fixture selects a run's exit code, so every edge on it admits that code's id. */
const CITED_RUN = fixtureRunRecord("the receipt a drafted edge cites");

const ADMITTED_ITEM = recordId(CITED_RUN.observation.exitCode);

async function workspaceCitingARun(
  install: (workspace: FixtureWorkspace) => Promise<void> = (workspace) =>
    installParserFixture(workspace.dir, workspace.scope, FIXTURE_CLOCK),
): Promise<{ readonly workspace: FixtureWorkspace; readonly admitted: EvidenceEdge }> {
  const workspace = await fixtureWorkspace();
  await install(workspace);
  const [run] = await workspace.store().putMany([{ kind: "run", value: CITED_RUN }]);
  return { workspace, admitted: { run: run!, selector: PARSER_FIXTURE_SELECTOR, item: ADMITTED_ITEM } };
}

/** Stores a person's unsigned attestation, then raises the signing level to `person`. */
async function unsignedPersonAttestationOf(workspace: FixtureWorkspace, subject: RecordId): Promise<RecordId> {
  const [attestation] = await workspace.store().putMany([
    {
      kind: "attestation",
      value: mintAttestation({
        subject,
        principal: `key:SHA256:${"u".repeat(43)}`,
        principalClass: "person",
        via: "tty",
        purpose: "asserted",
        at: FIXTURE_CLOCK(),
      }).record,
    },
  ]);
  await writeTrustFile(
    { gitDir: join(workspace.dir, MUSAI_DIR) },
    "config.json",
    JSON.stringify({ signing: "person" }),
  );
  return attestation!;
}

describe("the kernel re-admits every evidence edge a pack's draft cites, whatever the distribution admits", () => {
  test("refuses a drafted claim whose evidence edge names an item its selector does not admit", async () => {
    const { workspace, admitted } = await workspaceCitingARun();
    const forged = recordId({ fixture: "an item no selector admitted" });
    const plan = planOf({ kind: "claim", value: tripleClaimDraft("forged", [{ ...admitted, item: forged }]) });

    for (const refusal of await refusedBothWays(workspace, plan)) {
      expectKernelRefusal(
        refusal,
        0,
        "claim",
        `the edge on ${admitted.run} names item ${forged}, and its selector admits ${ADMITTED_ITEM}`,
      );
    }
  });

  test("refuses a drafted argument whose evidence edge names an item its selector does not admit", async () => {
    const { workspace, admitted } = await workspaceCitingARun();
    const forged = recordId({ fixture: "an item no selector admitted" });
    const plan = planOf({ kind: "argument", value: argumentCiting([{ ...admitted, item: forged }]) });

    for (const refusal of await refusedBothWays(workspace, plan)) {
      expectKernelRefusal(
        refusal,
        0,
        "argument",
        `the edge on ${admitted.run} names item ${forged}, and its selector admits ${ADMITTED_ITEM}`,
      );
    }
  });

  test("refuses a drafted claim citing a run whose attestation carries no signature, workspace-incomplete, naming the attestation", async () => {
    const { workspace, admitted } = await workspaceCitingARun();
    const attestation = await unsignedPersonAttestationOf(workspace, admitted.run);
    const plan = planOf({ kind: "claim", value: tripleClaimDraft("unsigned", [admitted]) });

    for (const refusal of await refusedBothWays(workspace, plan)) {
      expect(refusal).toMatchObject({ reason: "workspace-incomplete", code: "workspace", about: [attestation] });
    }
  });

  test("refuses a drafted argument citing a run whose attestation carries no signature, workspace-incomplete, naming the attestation", async () => {
    const { workspace, admitted } = await workspaceCitingARun();
    const attestation = await unsignedPersonAttestationOf(workspace, admitted.run);
    const plan = planOf({ kind: "argument", value: argumentCiting([admitted]) });

    for (const refusal of await refusedBothWays(workspace, plan)) {
      expect(refusal).toMatchObject({ reason: "workspace-incomplete", code: "workspace", about: [attestation] });
    }
  });

  test("refuses a drafted claim whose selector names a module installed with no bundle, workspace-incomplete, naming the module", async () => {
    const { workspace, admitted } = await workspaceCitingARun((bundleless) =>
      installModuleRecord(
        bundleless.dir,
        bundleless.scope,
        PARSER_FIXTURE_MODULE,
        parserFixtureManifest().contributions,
        FIXTURE_CLOCK,
      ),
    );
    const plan = planOf({ kind: "claim", value: tripleClaimDraft("bundleless", [admitted]) });

    for (const refusal of await refusedBothWays(workspace, plan)) {
      expect(refusal).toMatchObject({
        reason: "workspace-incomplete",
        code: "workspace",
        about: [PARSER_FIXTURE_MODULE],
      });
    }
  });

  test("admits a drafted claim resting on an edge its selector admits, and performs it", async () => {
    const { workspace, admitted } = await workspaceCitingARun();
    const claim = tripleClaimDraft("admitted", [admitted]);
    const plan = planOf({ kind: "claim", value: claim });
    const before = await workspace.head();

    const previewed = await applied(workspace, plan, "plan");
    expect(previewed.minted).toEqual([{ id: recordId(claim), kind: "claim", record: claim }]);
    expect(await workspace.head()).toBe(before);

    const performed = await applied(workspace, plan, "perform");
    expect(performed.minted).toEqual(previewed.minted);
    expect(await workspace.head()).not.toBe(before);
    expect(await workspace.store().read(recordId(claim), "claim")).toEqual(claim);
  });
});

describe("a throw carrying no reason leaves an admission's refusal as it was thrown, and an edge's admission names the selector and the run", () => {
  test("an admission answering a reasonless throw through draftRefusal leaves it as it was thrown, previewed and performed", async () => {
    const workspace = await fixtureWorkspace({ claimTypes: [OBSERVED] });
    const defect = new Error("a defect in the distribution's admission");
    const answersADefect: DraftAdmission = async (_plan, _realised, operation) => {
      throw draftRefusal(defect, operation, 0, "claim", "the distribution");
    };
    const plan = planOf({ kind: "claim", value: claimDraft("defective") });

    for (const mode of ["plan", "perform"] as const) {
      await expect(applied(workspace, plan, mode, answersADefect)).rejects.toBe(defect);
    }
  });

  test("an edge whose selector's module path throws with no reason is refused invalid-input, naming the selector and the run", async () => {
    const { workspace, admitted } = await workspaceCitingARun();
    const opened = await openWorkspace({ workspace: workspace.dir, scope: workspace.scope, now: FIXTURE_CLOCK });
    const admissionWorkspace = {
      ...(await buildAdmissionWorkspace(opened, await installedModules(opened))),
      modulePath(): string {
        throw new Error("a defect in resolving the module's path");
      },
    };

    const refusal = await refusalOf(() =>
      verifiedEvidenceEdge(opened, admissionWorkspace, admitted.run, admitted.selector),
    );

    expect(refusal).toMatchObject({
      reason: "invalid-input",
      about: [renderSelector(admitted.selector), admitted.run],
      detail: "a defect in resolving the module's path",
    });
  });
});

describe("the kernel's pass loads no bundle for a plan citing no evidence edge", () => {
  test("a drafted claim citing no edge performs over a workspace one of whose installed bundles is missing from the blob store", async () => {
    const { workspace } = await workspaceCitingARun();
    const opened = await openWorkspace({ workspace: workspace.dir, scope: workspace.scope, now: FIXTURE_CLOCK });
    const installed = (await installedModules(opened)).byName.get(PARSER_FIXTURE_MODULE)!;
    const bundle = (opened.read(installed.moduleRecordId) as ModuleRecord).bundle!;
    await rewriteBlob(workspace.dir, bundle, null);
    const claim = tripleClaimDraft("citing nothing", []);
    const before = await workspace.head();

    const performed = await applied(workspace, planOf({ kind: "claim", value: claim }), "perform");

    expect(performed.minted).toEqual([{ id: recordId(claim), kind: "claim", record: claim }]);
    expect(await workspace.head()).not.toBe(before);
  });
});
