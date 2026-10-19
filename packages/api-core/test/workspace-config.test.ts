import { readdir } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { ArtifactRecord, CaseRecord, RecordId } from "@musai/records";
import {
  BLOB_THRESHOLD_CONFIG_KEY,
  CURRENT_SCHEMA_VERSIONS,
  canonicalBytes,
  recordId,
  versionString,
} from "@musai/records";
import { performFetch } from "@musai/run";
import {
  type GitContext,
  gitRevParse,
  InvalidScopeError,
  readWorkspaceConfig,
  Store,
  scopeRefName,
} from "@musai/store";
import { blobStoreOf, type FixtureRepo, makeFixtureRepo, writeTrustFile } from "@musai/test-support";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace.js";

async function allEntriesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries.map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1)).sort();
}

function caseRecord(slugLength: number): CaseRecord {
  return {
    kind: "case",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.case,
    type: null,
    slug: "x".repeat(slugLength),
    claims: [],
    preset: { module: "p", contribution: "p/default", moduleRecord: recordId({ marker: "preset-module" }) },
    projectCommit: "0".repeat(40),
    overrides: {},
    evaluatorVersion: versionString("1"),
  };
}

async function writeMainConfig(ctx: GitContext, content: string): Promise<void> {
  return writeTrustFile(ctx, "config.json", content);
}

describe("readWorkspaceConfig reads the workspace's own configuration from the trust branch at one pinned commit", () => {
  const repos: FixtureRepo[] = [];

  afterEach(async () => {
    for (const repo of repos.splice(0)) {
      await repo.cleanup();
    }
  });

  async function freshRepo(scope: string): Promise<FixtureRepo> {
    const repo = await makeFixtureRepo(scope);
    repos.push(repo);
    return repo;
  }

  it("returns the seeded values and the commit they were read at", async () => {
    const repo = await freshRepo("config-seeded");
    const config = await readWorkspaceConfig(repo.ctx);
    expect(config.values).toEqual({});
    const expectedTip = await gitRevParse(repo.ctx, "refs/heads/main");
    expect(config.commit).toBe(expectedTip);
  });

  it("two reads against an unchanged trust branch report the same commit", async () => {
    const repo = await freshRepo("config-stable");
    const first = await readWorkspaceConfig(repo.ctx);
    const second = await readWorkspaceConfig(repo.ctx);
    expect(second.commit).toBe(first.commit);
  });

  it("refuses by name a workspace whose configuration file does not parse", async () => {
    const repo = await freshRepo("config-broken");
    await writeMainConfig(repo.ctx, "not json at all\n");
    await expect(readWorkspaceConfig(repo.ctx)).rejects.toThrow(/config\.json/);
  });
});

describe("the programs a workspace's configuration admits for its runs", () => {
  const repos: FixtureRepo[] = [];

  afterEach(async () => {
    for (const repo of repos.splice(0)) {
      await repo.cleanup();
    }
  });

  it("are read at open from the configuration's tools", async () => {
    const repo = await makeFixtureRepo("tools-named");
    repos.push(repo);
    await writeMainConfig(repo.ctx, JSON.stringify({ tools: ["pnpm", "make"] }));

    const opened = await Workspace.open({ dir: repo.workspace, scope: repo.scope, now: repo.now });

    expect(opened.tools).toEqual(["pnpm", "make"]);
  });

  it("refuse the open when an entry is a path rather than a program name", async () => {
    const repo = await makeFixtureRepo("tools-path");
    repos.push(repo);
    await writeMainConfig(repo.ctx, JSON.stringify({ tools: ["./scripts/test.sh"] }));

    await expect(Workspace.open({ dir: repo.workspace, scope: repo.scope, now: repo.now })).rejects.toMatchObject({
      reason: "workspace-incomplete",
      about: ["tools"],
    });
  });
});

describe("the store enforces the payload bound its workspace configuration declares", () => {
  const repos: FixtureRepo[] = [];

  afterEach(async () => {
    for (const repo of repos.splice(0)) {
      await repo.cleanup();
    }
  });

  async function freshRepo(scope: string): Promise<FixtureRepo> {
    const repo = await makeFixtureRepo(scope);
    repos.push(repo);
    return repo;
  }

  it("writes and reads back a record just under a low configured threshold", async () => {
    const repo = await freshRepo("threshold-under");
    const under = caseRecord(50);
    const size = canonicalBytes(under).byteLength;
    await writeMainConfig(repo.ctx, JSON.stringify({ [BLOB_THRESHOLD_CONFIG_KEY]: size }));

    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const [id] = await store.putMany([{ kind: "case", value: under }]);
    const readBack = await store.read(id!, "case");
    expect(readBack).toEqual(under);
  });

  it("refuses a record whose canonical bytes exceed a low configured threshold, naming the size and the threshold", async () => {
    const repo = await freshRepo("threshold-over");
    const under = caseRecord(50);
    const threshold = canonicalBytes(under).byteLength;
    await writeMainConfig(repo.ctx, JSON.stringify({ [BLOB_THRESHOLD_CONFIG_KEY]: threshold }));

    const over = caseRecord(51);
    const overSize = canonicalBytes(over).byteLength;

    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    try {
      await store.putMany([{ kind: "case", value: over }]);
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("case");
      expect(message).toContain(String(overSize));
      expect(message).toContain(String(threshold));
    }
  });

  it("the refused payload stored as a blob and referenced from a small record is accepted and reads back", async () => {
    const repo = await freshRepo("threshold-blob-route");
    const under = caseRecord(50);

    // Admits the case record and the blob-referencing artifact, far below the oversized payload.
    const threshold = 400;
    await writeMainConfig(repo.ctx, JSON.stringify({ [BLOB_THRESHOLD_CONFIG_KEY]: threshold }));

    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const [caseId] = await store.putMany([{ kind: "case", value: under }]);

    const over = caseRecord(2000);
    const overBytes = canonicalBytes(over);
    expect(overBytes.byteLength).toBeGreaterThan(threshold);
    await expect(store.putMany([{ kind: "case", value: over }])).rejects.toThrow();

    const blobRef = await blobStoreOf(repo.workspace).put(overBytes);

    const artifact: ArtifactRecord = {
      kind: "artifact",
      schemaVersion: CURRENT_SCHEMA_VERSIONS.artifact,
      case: caseId!,
      lifecycle: "drafted",
      content: blobRef,
      format: "markdown",
      supersedes: [],
    };
    const [artifactId] = await store.putMany([{ kind: "artifact", value: artifact }]);
    const readBack = await store.read(artifactId!, "artifact");
    expect(readBack).toEqual(artifact);
  });

  it("the threshold in force comes from the workspace's configuration, not the default", async () => {
    const repo = await freshRepo("threshold-configured-not-default");
    const record = caseRecord(1000);
    const size = canonicalBytes(record).byteLength;
    expect(size).toBeLessThan(2 ** 20);
    await writeMainConfig(repo.ctx, JSON.stringify({ [BLOB_THRESHOLD_CONFIG_KEY]: size - 1 }));

    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    await expect(store.putMany([{ kind: "case", value: record }])).rejects.toThrow();
  });

  it("an opened workspace's writes hold to the threshold its configuration declared when it opened", async () => {
    const repo = await freshRepo("threshold-read-at-open");
    const record = caseRecord(1000);
    const size = canonicalBytes(record).byteLength;
    await writeMainConfig(repo.ctx, JSON.stringify({ [BLOB_THRESHOLD_CONFIG_KEY]: size - 1 }));
    const opened = await Workspace.open({ dir: repo.workspace, scope: repo.scope, now: repo.now });
    try {
      await writeMainConfig(repo.ctx, JSON.stringify({ [BLOB_THRESHOLD_CONFIG_KEY]: size }));

      await expect(opened.store.putMany([{ kind: "case", value: record }])).rejects.toThrow(String(size - 1));
    } finally {
      opened.close();
    }
  });

  it("a workspace's fetches hold a body over its configured threshold on its blobs branch", async () => {
    const repo = await freshRepo("threshold-fetch-blob");
    await writeMainConfig(repo.ctx, JSON.stringify({ [BLOB_THRESHOLD_CONFIG_KEY]: 4 }));
    const body = "a body longer than the workspace's threshold";
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const opened = await Workspace.open({ dir: repo.workspace, scope: repo.scope, now: repo.now });
      const recipe = { locator: `http://127.0.0.1:${port}/body`, headers: [], names: [] };

      const { record } = await performFetch(recipe, {}, opened.fetchStore, { now: repo.now });

      const held = record.observation.output as RecordId;
      expect(new TextDecoder().decode(await blobStoreOf(repo.workspace).read(held))).toBe(body);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("scopeRefName narrows a scope name to a conservative character set before it can become a ref", () => {
  it("produces exactly the ref name the existing race and fold tests already depend on, for an ordinary scope", () => {
    expect(scopeRefName("race")).toBe("refs/heads/scope/race");
    expect(scopeRefName("fold-contributors-forward")).toBe("refs/heads/scope/fold-contributors-forward");
  });

  it("refuses an empty scope", () => {
    expect(() => scopeRefName("")).toThrow(InvalidScopeError);
  });

  it("refuses a scope beginning with a separator", () => {
    expect(() => scopeRefName("-leading")).toThrow(InvalidScopeError);
  });

  it("refuses a scope ending with a separator", () => {
    expect(() => scopeRefName("trailing-")).toThrow(InvalidScopeError);
  });

  it("refuses a scope containing a doubled dot", () => {
    expect(() => scopeRefName("a..b")).toThrow(InvalidScopeError);
  });

  it("refuses a scope containing a line break", () => {
    expect(() => scopeRefName("a\nb")).toThrow(InvalidScopeError);
  });

  it("refuses a scope containing the byte that separates batch ref-update fields, before any subprocess runs, and leaves no ref for it", async () => {
    const repo = await makeFixtureRepo("scope-injection");
    try {
      const malicious = `evil${"\0"}scope`;
      expect(() => scopeRefName(malicious)).toThrow(InvalidScopeError);

      const store = new Store({ ctx: repo.ctx, scope: malicious, now: repo.now });
      await expect(store.put("case", caseRecord(1))).rejects.toThrow(InvalidScopeError);

      const { stdout } = await execa("git", ["--git-dir", repo.ctx.gitDir, "for-each-ref", "refs/heads/scope"]);
      expect(stdout.trim()).toBe("");
    } finally {
      await repo.cleanup();
    }
  });

  it("refuses a scope a path segment could carry out of local/, before a directory or a file is created for it", async () => {
    const repo = await makeFixtureRepo("scope-escape");
    try {
      const escaping = "../escaped";
      expect(() => scopeRefName(escaping)).toThrow(InvalidScopeError);

      const before = await allEntriesUnder(repo.ctx.gitDir);
      await expect(Workspace.open({ dir: repo.workspace, scope: escaping, now: repo.now })).rejects.toThrow(
        InvalidScopeError,
      );
      const after = await allEntriesUnder(repo.ctx.gitDir);
      expect(after).toEqual(before);
    } finally {
      await repo.cleanup();
    }
  });
});
