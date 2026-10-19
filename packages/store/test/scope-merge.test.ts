import {
  type AttestationRecord,
  type ClaimRecord,
  type ClaimTypeDeclaration,
  CURRENT_SCHEMA_VERSIONS,
  type RecordId,
  recordPath,
  sidecarPath,
  slotFor,
  timestamp,
} from "@musai/records";
import { commitAroundTheStore, type FixtureRepo, makeFixtureRepo } from "@musai/test-support";
import { execa } from "execa";
import { afterEach, describe, expect, test } from "vitest";
import { createScope } from "../src/scopes.js";
import { Store } from "../src/store.js";

const CLAIM_TYPE = "musai.scope-merge-test/claim@1";
const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: CLAIM_TYPE, identityDimensions: ["id"] };
const SIGNATURE = "-----BEGIN SSH SIGNATURE-----\nnot checked by the store\n-----END SSH SIGNATURE-----\n";

let repo: FixtureRepo | undefined;

afterEach(async () => {
  await repo?.cleanup();
  repo = undefined;
});

function claimAt(id: string): ClaimRecord {
  const conditions = { id };
  return {
    kind: "claim",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: CLAIM_TYPE,
    about: [],
    slot: slotFor(CLAIM_DECLARATION, conditions),
    conditions,
    canonical: { statement: `${id} holds` },
    rendering: `${id} holds.`,
    evidence: [],
    exclusiveGroup: null,
  };
}

function madeOver(subject: RecordId): AttestationRecord {
  return {
    kind: "attestation",
    schemaVersion: CURRENT_SCHEMA_VERSIONS.attestation,
    subject,
    principal: `key:SHA256:${"m".repeat(43)}`,
    principalClass: "person",
    via: "tty",
    purpose: "made",
    at: timestamp("2026-10-07T00:00:00.000Z"),
    supersedes: [],
  };
}

interface Forked {
  readonly repo: FixtureRepo;
  readonly canon: Store;
  readonly fork: Store;
}

async function canonAndFork(): Promise<Forked> {
  const made = await makeFixtureRepo("canon", [CLAIM_DECLARATION]);
  repo = made;
  const storeOf = (scope: string) => new Store({ ctx: made.ctx, scope, now: made.now, claimTypes: made.claimTypes });
  const canon = storeOf("canon");
  await canon.put("claim", claimAt("base"));
  await createScope(made.ctx, "fork", (await canon.tip())!);
  return { repo: made, canon, fork: storeOf("fork") };
}

async function filesAt(repo: FixtureRepo, tip: string): Promise<string[]> {
  const { stdout } = await execa("git", ["--git-dir", repo.ctx.gitDir, "ls-tree", "-r", "--name-only", tip]);
  return stdout.split("\n").filter((line) => line.length > 0);
}

async function parentsOf(repo: FixtureRepo, commit: string): Promise<string[]> {
  const { stdout } = await execa("git", ["--git-dir", repo.ctx.gitDir, "rev-list", "--parents", "-n", "1", commit]);
  return stdout.split(" ").slice(1);
}

describe("a whole merge", () => {
  test("lands one commit whose only parent is the target's prior tip, holding the target's files and the difference", async () => {
    const { repo, canon, fork } = await canonAndFork();
    const [forked] = await fork.putMany([{ kind: "claim", value: claimAt("forked") }]);
    const [attestation] = await fork.putMany([{ kind: "attestation", value: madeOver(forked!), signature: SIGNATURE }]);
    const before = (await canon.tip())!;

    const merged = await canon.mergeFrom("fork");

    const after = (await canon.tip())!;
    expect(merged.commit).toBe(after);
    expect(await parentsOf(repo, after)).toEqual([before]);
    expect([...merged.merged].sort()).toEqual([forked!, attestation!].sort());
    expect(await filesAt(repo, after)).toEqual(
      [
        ...(await filesAt(repo, before)),
        recordPath("claim", forked!),
        recordPath("attestation", attestation!),
        sidecarPath(attestation!),
      ].sort(),
    );
  });

  test("a second merge of the same scope mints no commit", async () => {
    const { canon, fork } = await canonAndFork();
    await fork.put("claim", claimAt("forked"));
    await canon.mergeFrom("fork");
    const tip = await canon.tip();

    const again = await canon.mergeFrom("fork");

    expect(again.commit).toBeNull();
    expect(again.merged).toEqual([]);
    expect(await canon.tip()).toBe(tip);
  });

  test("a target that moved mid-merge is retried and keeps both writers' records", async () => {
    const { repo, canon, fork } = await canonAndFork();
    const [forked] = await fork.putMany([{ kind: "claim", value: claimAt("forked") }]);
    const writer = new Store({ ctx: repo.ctx, scope: "canon", now: repo.now, claimTypes: repo.claimTypes });
    let concurrent: RecordId | undefined;

    await canon.mergeFrom(
      "fork",
      {},
      {
        beforeSwap: async (_tip, attempt) => {
          if (attempt === 1) {
            concurrent = await writer.put("claim", claimAt("written meanwhile"));
          }
        },
      },
    );

    const files = await filesAt(repo, (await canon.tip())!);
    expect(files).toContain(recordPath("claim", forked!));
    expect(files).toContain(recordPath("claim", concurrent!));
  });

  test("a path both tips hold with different record bytes is refused", async () => {
    const { repo, canon } = await canonAndFork();
    const base = await canon.list("claim");
    const path = recordPath("claim", base[0]!);
    await commitAroundTheStore({ ctx: repo.ctx, scope: "fork", now: repo.now }, path, new TextEncoder().encode("{}"));

    await expect(canon.mergeFrom("fork")).rejects.toMatchObject({ reason: "record-corrupted", about: [path] });
  });
});

describe("a merge in part", () => {
  test("carries the chosen records and the attestations over them, with their sidecars, and nothing else", async () => {
    const { repo, canon, fork } = await canonAndFork();
    const [chosen, left] = await fork.putMany([
      { kind: "claim", value: claimAt("chosen") },
      { kind: "claim", value: claimAt("left behind") },
    ]);
    const [attestation] = await fork.putMany([{ kind: "attestation", value: madeOver(chosen!), signature: SIGNATURE }]);

    const merged = await canon.mergeFrom("fork", { ids: [chosen!] });

    const files = await filesAt(repo, (await canon.tip())!);
    expect([...merged.merged].sort()).toEqual([chosen!, attestation!].sort());
    expect(files).toContain(sidecarPath(attestation!));
    expect(files).not.toContain(recordPath("claim", left!));
  });

  test("an id the source lacks is refused by name, and so is a citation neither scope's merge would hold", async () => {
    const { canon, fork } = await canonAndFork();
    const [subject] = await fork.putMany([{ kind: "claim", value: claimAt("only in the fork") }]);
    const [attestation] = await fork.putMany([{ kind: "attestation", value: madeOver(subject!) }]);
    const elsewhere = new Store({ ctx: repo!.ctx, scope: "elsewhere", now: repo!.now });
    const absent = await elsewhere.put("attestation", {
      ...madeOver(subject!),
      principal: `key:SHA256:${"e".repeat(43)}`,
    });

    await expect(canon.mergeFrom("fork", { ids: [absent] })).rejects.toMatchObject({
      reason: "no-such-record",
      about: [absent],
    });
    await expect(canon.mergeFrom("fork", { ids: [attestation!] })).rejects.toMatchObject({
      reason: "invalid-input",
      about: [subject!],
    });
  });

  test("records the caller puts land in the merge's own commit", async () => {
    const { canon, fork } = await canonAndFork();
    const [chosen] = await fork.putMany([{ kind: "claim", value: claimAt("chosen") }]);
    const before = await canon.tip();

    const merged = await canon.mergeFrom("fork", {
      ids: [chosen!],
      with: [{ kind: "attestation", value: { ...madeOver(chosen!), principal: `key:SHA256:${"l".repeat(43)}` } }],
    });

    expect(merged.put).toHaveLength(1);
    expect(await canon.list("attestation")).toEqual(merged.put);
    expect(await parentsOf(repo!, (await canon.tip())!)).toEqual([before]);
  });
});
