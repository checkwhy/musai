import type { CheckedAuthority } from "@musai/evaluate";
import {
  type ArgumentRecord,
  type ClaimRecord,
  type ClaimTypeDeclaration,
  CURRENT_SCHEMA_VERSIONS,
  type RecordId,
  type RulingRecord,
  recordId,
  slotFor,
  timestamp,
  versionString,
} from "@musai/records";
import { type FixtureRepo, makeFixtureRepo, writeFixtureRecords, writeTrustFile } from "@musai/test-support";
import { mintAttestation } from "@musai/trust";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { openWorkspace } from "../src/open-workspace.js";
import { type Retirement, retirementOf, type WeighedRuling, weighedRulingsFor } from "../src/succession.js";

const CLAIM_TYPE = "musai.succession-test/claim@1";
const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: CLAIM_TYPE, identityDimensions: ["id"] };

/** A principal, the channel it rules through, and the tier the roles below grant it there. */
interface Caller {
  readonly principal: string;
  readonly via: "tty" | "model";
  readonly tier: CheckedAuthority | null;
}

const MAINTAINER: Caller = {
  principal: `key:SHA256:${"m".repeat(43)}`,
  via: "tty",
  tier: "person" as CheckedAuthority,
};
const PEER: Caller = { principal: `key:SHA256:${"p".repeat(43)}`, via: "tty", tier: "person" as CheckedAuthority };
const ARBITER: Caller = { principal: `key:SHA256:${"a".repeat(43)}`, via: "tty", tier: "person" as CheckedAuthority };
const AGENT: Caller = { principal: `key:SHA256:${"g".repeat(43)}`, via: "model", tier: "delegate" as CheckedAuthority };
const STRANGER: Caller = { principal: `key:SHA256:${"s".repeat(43)}`, via: "tty", tier: null };

const ROLES = [
  `${MAINTAINER.principal} maintainer any`,
  `${PEER.principal} maintainer any`,
  `${ARBITER.principal} arbiter any`,
  `${AGENT.principal} delegate any`,
  "",
].join("\n");

let repo: FixtureRepo;
let slots = 0;

function claimAt(id: string): ClaimRecord {
  const slot = slotFor(CLAIM_DECLARATION, { id });
  return {
    kind: "claim",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: CLAIM_TYPE,
    about: [],
    slot,
    conditions: { id },
    canonical: { statement: `${id} holds` },
    rendering: `${id} holds.`,
    evidence: [],
    exclusiveGroup: null,
  };
}

async function freshClaim(): Promise<{ readonly id: RecordId; readonly slot: string }> {
  const claim = claimAt(`claim-${slots++}`);
  const [id] = await writeFixtureRecords(repo, [{ kind: "claim", value: claim }]);
  return { id: id!, slot: claim.slot };
}

/** A ruling written straight into the store and attested, as any writer could. */
async function ruleAs(by: Caller, claim: RecordId, supersedes: readonly RecordId[] = []): Promise<RecordId> {
  const ruling: RulingRecord = {
    kind: "ruling",
    supersedes: [...supersedes],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.ruling,
    over: { claim },
    verdict: "fails",
    reason: `${by.principal} rules, superseding ${supersedes.length}`,
    brief: recordId({ brief: claim, by: by.principal }),
  };
  const [id] = await writeFixtureRecords(repo, [{ kind: "ruling", value: ruling }]);
  const attestation = mintAttestation({
    subject: id!,
    principal: by.principal,
    principalClass: by.via === "model" ? "agent" : "person",
    via: by.via,
    purpose: "made",
    at: timestamp("2026-10-01T00:00:00.000Z"),
  });
  await writeFixtureRecords(repo, [{ kind: "attestation", value: attestation.record }]);
  return id!;
}

async function weighed(slot: string, id: RecordId): Promise<WeighedRuling> {
  const opened = await openWorkspace({ workspace: repo.workspace, scope: repo.scope, now: repo.now });
  return (await weighedRulingsFor(opened, slot)).find((ruling) => ruling.id === id)!;
}

async function predicted(name: RecordId, by: Caller, slot: string): Promise<Retirement> {
  const opened = await openWorkspace({ workspace: repo.workspace, scope: repo.scope, now: repo.now });
  return retirementOf(opened, name, { principal: by.principal, tier: by.tier, slot });
}

/** Rules as `nameBy`, then supersedes it as `successorBy`; answers both readings of the rule. */
async function succession(
  nameBy: Caller,
  successorBy: Caller,
): Promise<{ readonly retiredBy: RecordId | null; readonly successor: RecordId; readonly retires: boolean }> {
  const { id: claim, slot } = await freshClaim();
  const name = await ruleAs(nameBy, claim);
  const { retires } = await predicted(name, successorBy, slot);
  const successor = await ruleAs(successorBy, claim, [name]);
  return { retiredBy: (await weighed(slot, name)).retiredBy, successor, retires };
}

beforeAll(async () => {
  repo = await makeFixtureRepo("succession", [CLAIM_DECLARATION]);
  await writeTrustFile(repo.ctx, "roles", ROLES);
});

afterAll(async () => {
  await repo.cleanup();
});

describe("which succession retires a ruling, for any writer", () => {
  test("an argument or a policy naming a ruling retires nothing", async () => {
    const { id: claim, slot } = await freshClaim();
    const name = await ruleAs(AGENT, claim);
    const argument: ArgumentRecord = {
      kind: "argument",
      schemaVersion: CURRENT_SCHEMA_VERSIONS.argument,
      target: claim,
      reason: "an argument naming a ruling as its predecessor",
      evidence: [
        {
          run: recordId({ marker: "argument evidence" }),
          selector: { module: "musai.core", parser: "exit-code", version: versionString("1"), key: "exit-code" },
          item: recordId({ marker: "argument item" }),
        },
      ],
      premises: [],
      supersedes: [name],
    };
    const policy: RulingRecord = {
      kind: "ruling",
      supersedes: [name],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.ruling,
      over: { type: CLAIM_TYPE, scope: {} },
      verdict: "holds",
      reason: "a policy naming a claim's ruling",
      brief: recordId({ marker: "policy brief" }),
    };
    await writeFixtureRecords(repo, [
      { kind: "argument", value: argument },
      { kind: "ruling", value: policy },
    ]);

    expect((await weighed(slot, name)).retiredBy).toBeNull();
  });

  test("a ruling naming a ruling on another slot retires nothing", async () => {
    const named = await freshClaim();
    const other = await freshClaim();
    const name = await ruleAs(AGENT, named.id);
    const { retires } = await predicted(name, MAINTAINER, other.slot);
    await ruleAs(MAINTAINER, other.id, [name]);

    expect((await weighed(named.slot, name)).retiredBy).toBeNull();
    expect(retires).toBe(false);
  });

  test("a higher tier retires a lower", async () => {
    const { retiredBy, successor, retires } = await succession(AGENT, MAINTAINER);
    expect(retiredBy).toBe(successor);
    expect(retires).toBe(true);
  });

  test("a principal retires its own ruling at its own tier", async () => {
    const { retiredBy, successor, retires } = await succession(MAINTAINER, MAINTAINER);
    expect(retiredBy).toBe(successor);
    expect(retires).toBe(true);
  });

  test("a peer at the same tier retires nothing", async () => {
    const { retiredBy, retires } = await succession(MAINTAINER, PEER);
    expect(retiredBy).toBeNull();
    expect(retires).toBe(false);
  });

  test("a person-tier ruling holding override-person retires a peer's ruling and an unvouched one", async () => {
    const overPeer = await succession(MAINTAINER, ARBITER);
    const overUnvouched = await succession(STRANGER, ARBITER);

    expect(overPeer.retiredBy).toBe(overPeer.successor);
    expect(overPeer.retires).toBe(true);
    expect(overUnvouched.retiredBy).toBe(overUnvouched.successor);
    expect(overUnvouched.retires).toBe(true);
  });

  test("a successor nothing vouches for retires nothing", async () => {
    const { retiredBy, retires } = await succession(AGENT, STRANGER);
    expect(retiredBy).toBeNull();
    expect(retires).toBe(false);
  });

  test("of two counting successions of one name, the first to land retires it and the second is a fork", async () => {
    const { id: claim, slot } = await freshClaim();
    const name = await ruleAs(AGENT, claim);
    const first = await ruleAs(MAINTAINER, claim, [name]);
    const { retires, ...refusal } = await predicted(name, PEER, slot);
    await ruleAs(PEER, claim, [name]);

    expect((await weighed(slot, name)).retiredBy).toBe(first);
    expect(retires).toBe(false);
    expect(refusal).toEqual({ why: "retired", by: first });
  });

  test("after a succession that does not count, a later one that does retires the name", async () => {
    const { id: claim, slot } = await freshClaim();
    const name = await ruleAs(MAINTAINER, claim);
    await ruleAs(PEER, claim, [name]);
    const { retires } = await predicted(name, ARBITER, slot);
    const counted = await ruleAs(ARBITER, claim, [name]);

    expect((await weighed(slot, name)).retiredBy).toBe(counted);
    expect(retires).toBe(true);
  });

  test("a retired ruling still reports its tier, and an unvouched one reports none", async () => {
    const { id: claim, slot } = await freshClaim();
    const vouched = await ruleAs(AGENT, claim);
    const unvouched = await ruleAs(STRANGER, claim);
    await ruleAs(MAINTAINER, claim, [vouched]);

    const retired = await weighed(slot, vouched);
    expect(retired.retiredBy).not.toBeNull();
    expect(retired.tier).toBe("delegate");
    expect(retired.principals).toEqual([AGENT.principal]);
    expect((await weighed(slot, unvouched)).tier).toBeNull();
  });
});
