import { IndexDb } from "@musai/fold";
import {
  type ClaimRecord,
  type ClaimTypeDeclaration,
  type Conditions,
  CURRENT_SCHEMA_VERSIONS,
  claimTypesFrom,
  recordId,
  type Selector,
  slotFor,
  type ValidationOptions,
  type ValidationResult,
  validateRecord,
  versionString,
} from "@musai/records";
import { Store } from "@musai/store";
import { makeFixtureRepo, writeFixtureRecords } from "@musai/test-support";
import { describe, expect, it } from "vitest";
import { requirementsFromModules } from "../src/binaries.js";
import { performRecipe } from "../src/spawn.js";

const RUN_ID = recordId({ marker: "run" });
const ITEM_ID = recordId({ marker: "item" });

const CLAIM_TYPE = "musai.demo/claim@1";
const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: CLAIM_TYPE, identityDimensions: ["subject"] };
const CLAIM_CONDITIONS: Conditions = { subject: "one" };

function wellFormedSelector(): Selector {
  return { module: "musai.core", parser: "exit-code", version: versionString("1"), key: "exitCode" };
}

/** Refuses any claim type but the one this file's fixtures are minted as. */
const DEMO_VALIDATION: ValidationOptions = {
  unregisteredClaimTypes: "refuse",
  claimTypes: claimTypesFrom([CLAIM_DECLARATION]),
};

function validated(value: unknown): ValidationResult {
  return validateRecord(value, DEMO_VALIDATION);
}

function wellFormedClaim(): ClaimRecord {
  return {
    kind: "claim",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: CLAIM_TYPE,
    about: ["urn:example:one"],
    slot: slotFor(CLAIM_DECLARATION, CLAIM_CONDITIONS),
    conditions: CLAIM_CONDITIONS,
    canonical: { statement: "a claim a case says is true" },
    rendering: "A claim a case says is true.",
    evidence: [{ run: RUN_ID, selector: wellFormedSelector(), item: ITEM_ID }],
    exclusiveGroup: null,
  };
}

describe("the shapes each record kind honours", () => {
  it("accepts a claim declaring an exclusiveGroup, and two claims naming one group are both readable from the index by that group", async () => {
    const group = `menu-${Math.random()}`;
    const first: ClaimRecord = { ...wellFormedClaim(), exclusiveGroup: group };
    const second: ClaimRecord = {
      ...wellFormedClaim(),
      canonical: { statement: "a second sibling in the same group" },
      rendering: "A second sibling in the same group.",
      conditions: { subject: "two" },
      slot: slotFor(CLAIM_DECLARATION, { subject: "two" }),
      exclusiveGroup: group,
    };
    expect(validated(first)).toMatchObject({ ok: true, record: { exclusiveGroup: group } });

    const repo = await makeFixtureRepo("exclusive-group", [CLAIM_DECLARATION]);
    try {
      await writeFixtureRecords(repo, [
        { kind: "claim", value: first },
        { kind: "claim", value: second },
      ]);
      const index = new IndexDb();
      await index.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
      const members = index.claimsInGroup(group);
      expect(members.map((member) => member.slot).sort()).toEqual([first.slot, second.slot].sort());
    } finally {
      await repo.cleanup();
    }
  });
});

describe("validateClaim recomputes a claim's slot from its own type and conditions", () => {
  it("accepts a claim whose slot is computed from its own fields, and it merges with a second record computing the same slot", async () => {
    const repo = await makeFixtureRepo("slot-merge", [CLAIM_DECLARATION]);
    try {
      const first = wellFormedClaim();
      const second: ClaimRecord = {
        ...wellFormedClaim(),
        canonical: { statement: "a second contributor to the same claim" },
        rendering: "A second contributor to the same claim.",
      };

      const [firstId, secondId] = await writeFixtureRecords(repo, [
        { kind: "claim", value: first },
        { kind: "claim", value: second },
      ]);
      expect(firstId).not.toBe(secondId);

      const index = new IndexDb();
      await index.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
      const contributors = index.contributorsAtSlot(first.slot);
      expect(contributors.map((contributor) => contributor.id).sort()).toEqual([firstId, secondId].sort());
    } finally {
      await repo.cleanup();
    }
  });
});

describe("a hand-written claim cannot declare a genuine claim's slot", () => {
  it("is refused through the store's write path, leaving the genuine claim's contributors at that slot unchanged", async () => {
    const repo = await makeFixtureRepo("slot-collision", [CLAIM_DECLARATION]);
    try {
      const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now, claimTypes: repo.claimTypes });
      const genuineClaim = wellFormedClaim();
      await store.putMany([{ kind: "claim", value: genuineClaim }]);

      const index = new IndexDb();
      await index.fold(store);
      const contributorsBefore = index.contributorsAtSlot(genuineClaim.slot);
      expect(contributorsBefore).toHaveLength(1);

      const impostorClaim: ClaimRecord = {
        ...genuineClaim,
        conditions: { subject: "two" },
        slot: genuineClaim.slot,
        canonical: { statement: "an impostor claiming the same slot" },
        rendering: "An impostor claiming the same slot.",
      };

      await expect(store.putMany([{ kind: "claim", value: impostorClaim }])).rejects.toThrow();

      await index.fold(store);
      const contributorsAfter = index.contributorsAtSlot(genuineClaim.slot);
      expect(contributorsAfter).toEqual(contributorsBefore);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("a run record splits into a recipe and an observation, every field required", () => {
  it("mints a command's receipt through performRecipe carrying an empty reads, written by the runner itself", async () => {
    const registry = requirementsFromModules([
      {
        moduleName: "test.fixture",
        entry: {
          kind: "requirement",
          id: "test.fixture/true",
          version: versionString("1"),
          input: { binary: "true", versionPredicate: null, neededBy: "this fixture", install: "already present" },
          output: true,
          documentation: "true, needed by this fixture",
        },
      },
    ]);
    const { observation } = await performRecipe(
      {
        command: ["true"],
        workingDirectory: "/",
        environment: {},
        declared: [],
        substrates: [],
        isolation: "hygiene",
      },
      { requirementRegistry: registry },
    );
    expect(observation.reads).toEqual([]);
  });
});
