import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexDb } from "@musai/fold";
import type { FetchRecipe } from "@musai/records";
import { Store } from "@musai/store";
import { type FixtureRepo, fixedClock, makeFixtureRepo } from "@musai/test-support";
import { afterEach, describe, expect, test } from "vitest";
import { type Reference, type ResolutionTable, resolveReference } from "../src/resolve.js";

/** A local endpoint answering every request with the body it holds, counting the requests. */
interface Oracle {
  readonly fetch: FetchRecipe;
  answer(body: string): void;
  hits(): number;
  close(): Promise<void>;
}

async function bodyOracle(initial: string): Promise<Oracle> {
  let body = initial;
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected the test server to bind a numeric port");
  }
  return {
    fetch: { locator: `http://127.0.0.1:${address.port}/nightly`, headers: [], names: [] },
    answer: (next) => {
      body = next;
    },
    hits: () => hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("resolveReference: a moving reference obtained once per evaluation, and a local one never obtained at all", () => {
  const repos: FixtureRepo[] = [];
  const oracles: Oracle[] = [];

  afterEach(async () => {
    for (const repo of repos.splice(0)) {
      await repo.cleanup();
    }
    for (const oracle of oracles.splice(0)) {
      await oracle.close();
    }
  });

  async function freshRepo(scope: string): Promise<FixtureRepo> {
    const repo = await makeFixtureRepo(scope);
    repos.push(repo);
    return repo;
  }

  async function oracle(body: string): Promise<Oracle> {
    const started = await bodyOracle(body);
    oracles.push(started);
    return started;
  }

  test("two runs citing one moving reference in one evaluation produce exactly one resolution receipt", async () => {
    const repo = await freshRepo("resolve-dedup");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    using index = new IndexDb();
    const { fetch, hits } = await oracle("a nightly pointer's current answer");
    const table: ResolutionTable = new Map();
    const reference: Reference = { declared: { uri: "example/image:latest" } };

    const first = await resolveReference(reference, table, { index, store, fetch, now: repo.now });
    const second = await resolveReference(reference, table, { index, store, fetch, now: repo.now });

    expect(hits()).toBe(1);
    expect(first.resolutionReceipt).not.toBeNull();
    expect(first.resolutionReceipt).toBe(second.resolutionReceipt);
  });

  test("two concurrent resolutions of one reference converge on one receipt", async () => {
    const repo = await freshRepo("resolve-concurrent");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    using index = new IndexDb();
    const { fetch, hits } = await oracle("another pointer's answer");
    const table: ResolutionTable = new Map();
    const reference: Reference = { declared: { uri: "example/image:latest" } };

    const [a, b] = await Promise.all([
      resolveReference(reference, table, { index, store, fetch, now: repo.now }),
      resolveReference(reference, table, { index, store, fetch, now: repo.now }),
    ]);

    expect(a.resolutionReceipt).toBe(b.resolutionReceipt);
    expect(hits()).toBe(1);
  });

  test("a reference that is already a digest produces no resolution receipt", async () => {
    const repo = await freshRepo("resolve-already-digest");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    using index = new IndexDb();
    const { fetch, hits } = await oracle("never asked for");
    const table: ResolutionTable = new Map();
    const digest = "c".repeat(64);
    const reference: Reference = { declared: { uri: "example/image@sha256:pinned", digest: { sha256: digest } } };

    const result = await resolveReference(reference, table, { index, store, fetch, now: repo.now });

    expect(result.resolutionReceipt).toBeNull();
    expect(result.descriptor.digest?.sha256).toBe(digest);
    expect(hits()).toBe(0);
  });

  test("a local file digest is computed in the kernel and produces no resolution receipt", async () => {
    const repo = await freshRepo("resolve-local-file");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    using index = new IndexDb();
    const { fetch, hits } = await oracle("never asked for");
    const filePath = join(await mkdtemp(join(tmpdir(), "musai-resolve-")), "local.txt");
    await writeFile(filePath, "local bytes nobody had to ask anyone about");
    const table: ResolutionTable = new Map();
    const reference: Reference = { declared: { uri: `file://${filePath}` } };

    const result = await resolveReference(reference, table, { index, store, fetch, now: repo.now });

    expect(hits()).toBe(0);
    expect(result.resolutionReceipt).toBeNull();
    expect(result.descriptor.digest?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect([...result.reads]).toEqual([`substrate:file://${filePath}`]);
  });

  test("a resolution redone after the age limit leaves the earlier receipt in the store", async () => {
    const repo = await freshRepo("resolve-age-limit");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    using index = new IndexDb();
    const { fetch } = await oracle("the answer of 2020");
    const reference: Reference = { declared: { uri: "example/image:latest" } };

    const old = await resolveReference(reference, new Map(), {
      index,
      store,
      fetch,
      now: fixedClock("2020-01-01T00:00:00.000Z"),
    });
    await index.fold(store);

    const redone = await resolveReference(reference, new Map(), {
      index,
      store,
      fetch,
      ageLimitMs: 1000,
      now: fixedClock("2021-01-01T00:00:00.000Z"),
    });

    expect(redone.resolutionReceipt).not.toBe(old.resolutionReceipt);
    const stillReadable = await store.read(old.resolutionReceipt!, "run");
    expect(stillReadable.kind).toBe("run");
  });

  test("a changed answer differs from what an earlier resolution recorded; an unchanged answer does not", async () => {
    const repo = await freshRepo("resolve-changed-answer");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    using index = new IndexDb();
    const { fetch, answer } = await oracle("the first answer");
    const reference: Reference = { declared: { uri: "example/image:latest" } };

    const first = await resolveReference(reference, new Map(), {
      index,
      store,
      fetch,
      now: fixedClock("2020-01-01T00:00:00.000Z"),
    });
    await index.fold(store);

    const unchanged = await resolveReference(reference, new Map(), {
      index,
      store,
      fetch,
      ageLimitMs: 1000,
      now: fixedClock("2021-01-01T00:00:00.000Z"),
    });
    expect(unchanged.descriptor.digest).toEqual(first.descriptor.digest);
    await index.fold(store);

    answer("a later answer");
    const changed = await resolveReference(reference, new Map(), {
      index,
      store,
      fetch,
      ageLimitMs: 1000,
      now: fixedClock("2022-01-01T00:00:00.000Z"),
    });

    expect(changed.descriptor.digest).not.toEqual(unchanged.descriptor.digest);
    // The declared reference's own read id never depends on what it resolved to.
    expect([...first.reads]).toEqual([...unchanged.reads]);
    expect([...unchanged.reads]).toEqual([...changed.reads]);
  });

  test("a reference that is already a digest is never resolved even after an age limit would otherwise force a redo", async () => {
    const repo = await freshRepo("resolve-digest-never-moves");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    using index = new IndexDb();
    const { fetch, hits } = await oracle("never asked for");
    const digest = "1".repeat(64);
    const reference: Reference = { declared: { uri: "example/image@sha256:pinned", digest: { sha256: digest } } };

    const first = await resolveReference(reference, new Map(), {
      index,
      store,
      fetch,
      ageLimitMs: 0,
      now: fixedClock("2020-01-01T00:00:00.000Z"),
    });
    const second = await resolveReference(reference, new Map(), {
      index,
      store,
      fetch,
      ageLimitMs: 0,
      now: fixedClock("2030-01-01T00:00:00.000Z"),
    });

    expect(first.descriptor.digest).toEqual(second.descriptor.digest);
    expect(first.resolutionReceipt).toBeNull();
    expect(second.resolutionReceipt).toBeNull();
    expect(hits()).toBe(0);
  });

  test("the resolved descriptor carries both the declared reference and the resolution receipt's id", async () => {
    const repo = await freshRepo("resolve-both-halves");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    using index = new IndexDb();
    const { fetch } = await oracle("an answer");
    const reference: Reference = { declared: { uri: "example/image:latest" } };

    const result = await resolveReference(reference, new Map(), { index, store, fetch, now: repo.now });

    expect(result.descriptor.uri).toBe(reference.declared.uri);
    expect(result.descriptor.annotations?.resolvedBy).toBe(result.resolutionReceipt);
  });

  test("a resolution is the retrieved body's own content digest", async () => {
    const repo = await freshRepo("resolve-fetch-method");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    using index = new IndexDb();
    const { fetch } = await oracle("a nightly pointer's current answer");
    const reference: Reference = { declared: { uri: "nightly-build" } };

    const result = await resolveReference(reference, new Map(), { index, store, fetch, now: repo.now });

    expect(result.resolutionReceipt).not.toBeNull();
    expect(result.descriptor.digest?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
