import {
  type ClaimRecord,
  type ClaimTypeDeclaration,
  type Conditions,
  CURRENT_SCHEMA_VERSIONS,
  canonicalBytes,
  EVALUATOR_VERSION,
  rawId,
  recordId,
  type Selector,
  slotFor,
  versionString,
} from "@musai/records";
import { makeFixtureRepo, writeFixtureRecords } from "@musai/test-support";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { Store } from "../src/store.js";

async function countLooseAndPackedObjects(gitDir: string): Promise<number> {
  const { stdout } = await execa("git", ["--git-dir", gitDir, "cat-file", "--batch-check", "--batch-all-objects"]);
  return stdout.split("\n").filter((line) => line.length > 0).length;
}

const RUN_ID = recordId({ marker: "run" });
const ITEM_ID = recordId({ marker: "item" });

const CLAIM_TYPE = "musai.demo/claim@1";
const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: CLAIM_TYPE, identityDimensions: ["subject"] };
const CLAIM_CONDITIONS: Conditions = { subject: "one" };

function wellFormedSelector(): Selector {
  return { module: "musai.core", parser: "exit-code", version: versionString("1"), key: "exitCode" };
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

describe("the store refuses an invalid record before an object is written", () => {
  it("refuses a record whose kind is not one of the nine", async () => {
    const repo = await makeFixtureRepo("invalid-kind");
    try {
      const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now, claimTypes: repo.claimTypes });
      await expect(store.putMany([{ kind: "claim", value: { kind: "not-a-kind" } }])).rejects.toThrow(/not-a-kind/);
      expect(await store.tip()).toBeNull();
    } finally {
      await repo.cleanup();
    }
  });
});

describe("putting the same record twice is a no-op at the object level", () => {
  it("leaves one file at one path, the same id both times, and no new git object", async () => {
    const repo = await makeFixtureRepo("dedup", [CLAIM_DECLARATION]);
    try {
      const claim = wellFormedClaim();

      const [firstId] = await writeFixtureRecords(repo, [{ kind: "claim", value: claim }]);
      const objectCountAfterFirstPut = await countLooseAndPackedObjects(repo.ctx.gitDir);

      const [secondId] = await writeFixtureRecords(repo, [{ kind: "claim", value: claim }]);
      const objectCountAfterSecondPut = await countLooseAndPackedObjects(repo.ctx.gitDir);

      expect(secondId).toBe(firstId);
      expect(objectCountAfterSecondPut).toBe(objectCountAfterFirstPut);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("a record arriving whole is placed by its bytes, at the version it was minted at", () => {
  function claimAt(schemaVersion: number): Uint8Array {
    return canonicalBytes({ ...wellFormedClaim(), schemaVersion });
  }

  it("keeps an older version's bytes and the id they digest to, where a draft would move both", async () => {
    const repo = await makeFixtureRepo("place-older", [CLAIM_DECLARATION]);
    try {
      const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now, claimTypes: repo.claimTypes });
      const bytes = claimAt(CURRENT_SCHEMA_VERSIONS.claim - 1);
      const [placed] = await store.placeMany([{ kind: "claim", bytes }]);
      expect(placed).toBe(rawId(bytes));
      expect(Buffer.from(await store.readBytes(placed!, "claim")).equals(Buffer.from(bytes))).toBe(true);
      const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      const [drafted] = await store.putMany([{ kind: "claim", value }]);
      expect(drafted).not.toBe(placed);
    } finally {
      await repo.cleanup();
    }
  });

  it("refuses bytes at the current version carrying a field its kind does not allow, writing nothing", async () => {
    const repo = await makeFixtureRepo("place-stray", [CLAIM_DECLARATION]);
    try {
      const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now, claimTypes: repo.claimTypes });
      const tip = await store.tip();
      const bytes = canonicalBytes({ ...wellFormedClaim(), stray: true });
      await expect(store.placeMany([{ kind: "claim", bytes }])).rejects.toThrow(/does not allow/);
      expect(await store.tip()).toBe(tip);
    } finally {
      await repo.cleanup();
    }
  });

  it("refuses an older version's bytes carrying a field its kind did not allow at that version, writing nothing", async () => {
    const repo = await makeFixtureRepo("place-older-stray", [CLAIM_DECLARATION]);
    try {
      const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now, claimTypes: repo.claimTypes });
      const tip = await store.tip();
      const older = { ...wellFormedClaim(), schemaVersion: CURRENT_SCHEMA_VERSIONS.claim - 1 };
      for (const stray of [{ stray: true }, { salt: "5a".repeat(32) }]) {
        const bytes = canonicalBytes({ ...older, ...stray });
        await expect(store.placeMany([{ kind: "claim", bytes }])).rejects.toThrow(/does not allow/);
      }
      expect(await store.tip()).toBe(tip);
    } finally {
      await repo.cleanup();
    }
  });

  it("refuses an older version's bytes that are not their own canonical form, writing nothing", async () => {
    const repo = await makeFixtureRepo("place-indented", [CLAIM_DECLARATION]);
    try {
      const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now, claimTypes: repo.claimTypes });
      const tip = await store.tip();
      const value = { ...wellFormedClaim(), schemaVersion: CURRENT_SCHEMA_VERSIONS.claim - 1 };
      const bytes = new TextEncoder().encode(JSON.stringify(value, null, 1));
      await expect(store.placeMany([{ kind: "claim", bytes }])).rejects.toThrow(/not the canonical form/);
      expect(await store.tip()).toBe(tip);
    } finally {
      await repo.cleanup();
    }
  });

  it("refuses a signature beside a record that is not an attestation, writing nothing", async () => {
    const repo = await makeFixtureRepo("place-signature", [CLAIM_DECLARATION]);
    try {
      const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now, claimTypes: repo.claimTypes });
      const tip = await store.tip();
      const bytes = claimAt(CURRENT_SCHEMA_VERSIONS.claim);
      await expect(store.placeMany([{ kind: "claim", bytes, signature: "sig" }])).rejects.toThrow(
        /only an attestation is signed/,
      );
      expect(await store.tip()).toBe(tip);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("writes held back from the scope land together", () => {
  it("reads a held record back before any commit holds it, then lands it with what joins it in one", async () => {
    const repo = await makeFixtureRepo("held", [CLAIM_DECLARATION]);
    try {
      const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now, claimTypes: repo.claimTypes });
      const tip = await store.tip();
      const held = store.held();
      const claim = wellFormedClaim();
      const joining = { ...claim, rendering: "A claim landing beside it." };

      const id = await held.put("claim", claim);
      expect(await store.tip()).toBe(tip);
      expect(await held.read(id, "claim")).toEqual(claim);
      const [joined] = await held.land([{ kind: "claim", value: joining }]);

      expect([id, joined]).toEqual([recordId(claim), recordId(joining)]);
      const landed = (await store.tip())!;
      const { stdout } = await execa("git", ["--git-dir", repo.ctx.gitDir, "rev-parse", `${landed}^`]);
      expect(stdout).toBe(tip);
      expect(await store.read(id, "claim")).toEqual(claim);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("the log a write leaves", () => {
  it("dates a commit as an ISO instant in UTC to the millisecond, whatever git renders", async () => {
    const repo = await makeFixtureRepo("commit-time");
    try {
      const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now, claimTypes: repo.claimTypes });
      await store.put("run", {
        kind: "run",
        supersedes: [],
        schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
        runKind: "evaluation",
        performer: { kind: "runner", version: EVALUATOR_VERSION },
        determinism: "deterministic",
        recipe: { command: ["evaluate", "dated"], substrates: [] },
        observation: { output: "{}", reads: [], cost: {} },
      });
      const times: string[] = [];
      for await (const { committedAt } of store.changesSince(null)) {
        times.push(committedAt);
      }

      expect(times.at(-1)).toBe(new Date(Date.parse(repo.now())).toISOString());
    } finally {
      await repo.cleanup();
    }
  });
});
