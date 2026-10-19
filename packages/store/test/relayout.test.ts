import {
  type ClaimRecord,
  type ClaimTypeDeclaration,
  CURRENT_SCHEMA_VERSIONS,
  type RecordId,
  recordId,
  recordPath,
  slotFor,
  versionString,
} from "@musai/records";
import {
  commitFilesAroundTheStore,
  type FixtureRepo,
  makeFixtureRepo,
  type RawFile,
  writeFixtureRecords,
} from "@musai/test-support";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitCatFile, gitLsTree, gitRevParse } from "../src/git.js";
import { ONE_LEVEL_REF_PREFIX, oneLevelRecordCount, relayoutScope } from "../src/relayout.js";
import { Store, scopeRefName } from "../src/store.js";

const CLAIM_TYPE = "musai.demo/claim@1";
const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: CLAIM_TYPE, identityDimensions: ["subject"] };

function claim(subject: string): ClaimRecord {
  const conditions = { subject };
  return {
    kind: "claim",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: CLAIM_TYPE,
    about: [`urn:example:${subject}`],
    slot: slotFor(CLAIM_DECLARATION, conditions),
    conditions,
    canonical: { statement: `${subject} holds` },
    rendering: `${subject} holds.`,
    evidence: [
      {
        run: recordId({ marker: "run" }),
        selector: { module: "musai.core", parser: "exit-code", version: versionString("1"), key: "exitCode" },
        item: recordId({ marker: "item" }),
      },
    ],
    exclusiveGroup: null,
  };
}

function oneLevelPath(id: RecordId): string {
  const hex = id.slice("sha256:".length);
  return `records/claim/${hex.slice(0, 2)}/${hex}.json`;
}

async function log(repo: FixtureRepo, ref: string): Promise<string[]> {
  const { stdout } = await execa("git", ["--git-dir", repo.ctx.gitDir, "log", "--format=%s|%an|%aI|%cI", ref]);
  return stdout.split("\n");
}

describe("relaying out a scope written before record paths went two levels deep", () => {
  let repo: FixtureRepo;
  let ids: RecordId[];
  let bytes: Uint8Array[];

  /** One commit per entry, around the store, as a musai that sharded on one level wrote them. */
  async function oneLevelHistory(commits: readonly RawFile[][]): Promise<string> {
    let tip = "";
    for (const commit of commits) {
      tip = await commitFilesAroundTheStore(repo, commit);
    }
    return tip;
  }

  beforeEach(async () => {
    const minted = await makeFixtureRepo("minted", [CLAIM_DECLARATION]);
    repo = { ...minted, scope: "test" };
    ids = await writeFixtureRecords(minted, [
      { kind: "claim", value: claim("first") },
      { kind: "claim", value: claim("second") },
    ]);
    bytes = await Promise.all(
      ids.map(
        async (id) =>
          new Uint8Array(await gitCatFile(repo.ctx, `${scopeRefName("minted")}:${recordPath("claim", id)}`)),
      ),
    );
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it("rewrites each commit with its records two levels deep, under the same ids and messages", async () => {
    const before = await oneLevelHistory([
      [{ path: oneLevelPath(ids[0]!), bytes: bytes[0]! }],
      [
        { path: oneLevelPath(ids[1]!), bytes: bytes[1]! },
        { path: `${oneLevelPath(ids[1]!)}.sig`, bytes: new TextEncoder().encode("a signature") },
      ],
    ]);
    const ref = scopeRefName(repo.scope);
    const history = await log(repo, ref);

    const result = await relayoutScope(repo.ctx, repo.scope);

    expect(result).toEqual({ commits: 2, records: 2 });
    expect(await log(repo, ref)).toEqual(history);
    expect((await gitLsTree(repo.ctx, ref)).map((entry) => entry.path).sort()).toEqual(
      [recordPath("claim", ids[0]!), recordPath("claim", ids[1]!), `${recordPath("claim", ids[1]!)}.sig`].sort(),
    );
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now, claimTypes: repo.claimTypes });
    expect((await store.list("claim")).sort()).toEqual([...ids].sort());
    expect(await gitRevParse(repo.ctx, `${ONE_LEVEL_REF_PREFIX}${repo.scope}`)).toBe(before);
  });

  it("names how many records a scope's history holds at one-level paths", async () => {
    await oneLevelHistory([
      [{ path: oneLevelPath(ids[0]!), bytes: bytes[0]! }],
      [{ path: oneLevelPath(ids[1]!), bytes: bytes[1]! }],
    ]);

    expect(await oneLevelRecordCount(repo.ctx, repo.scope)).toBe(2);
    await relayoutScope(repo.ctx, repo.scope);
    expect(await oneLevelRecordCount(repo.ctx, repo.scope)).toBe(0);
  });

  it("refuses a record whose bytes do not digest to its name, and moves no ref", async () => {
    const before = await oneLevelHistory([
      [{ path: oneLevelPath(ids[0]!), bytes: bytes[0]! }],
      [{ path: oneLevelPath(ids[1]!), bytes: bytes[0]! }],
    ]);

    await expect(relayoutScope(repo.ctx, repo.scope)).rejects.toMatchObject({ reason: "record-corrupted" });
    expect(await gitRevParse(repo.ctx, scopeRefName(repo.scope))).toBe(before);
    expect(await gitRevParse(repo.ctx, `${ONE_LEVEL_REF_PREFIX}${repo.scope}`)).toBeNull();
  });

  it("refuses a path under records/ in neither layout, and moves no ref", async () => {
    const before = await oneLevelHistory([
      [{ path: oneLevelPath(ids[0]!), bytes: bytes[0]! }],
      [{ path: "records/claim/stray.json", bytes: bytes[1]! }],
    ]);

    await expect(relayoutScope(repo.ctx, repo.scope)).rejects.toMatchObject({ reason: "record-corrupted" });
    expect(await gitRevParse(repo.ctx, scopeRefName(repo.scope))).toBe(before);
  });

  it("leaves a history already two levels deep as it is", async () => {
    await writeFixtureRecords(repo, [{ kind: "claim", value: claim("third") }]);
    const before = await gitRevParse(repo.ctx, scopeRefName(repo.scope));

    expect(await relayoutScope(repo.ctx, repo.scope)).toEqual({ commits: 0, records: 0 });
    expect(await gitRevParse(repo.ctx, scopeRefName(repo.scope))).toBe(before);
  });

  it("counts what it would rewrite and writes nothing when it only plans", async () => {
    const before = await oneLevelHistory([[{ path: oneLevelPath(ids[0]!), bytes: bytes[0]! }]]);

    expect(await relayoutScope(repo.ctx, repo.scope, { write: false })).toEqual({ commits: 1, records: 1 });
    expect(await gitRevParse(repo.ctx, scopeRefName(repo.scope))).toBe(before);
  });
});
