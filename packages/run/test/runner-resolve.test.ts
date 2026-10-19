import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexDb } from "@musai/fold";
import type { RunRecipe } from "@musai/records";
import { Store } from "@musai/store";
import { type FixtureRepo, fixedClock, makeFixtureRepo } from "@musai/test-support";
import { afterEach, describe, expect, test } from "vitest";
import {
  type Reference,
  type ResolutionMethod,
  ResolutionRefusedError,
  type ResolutionTable,
  resolveReference,
} from "../src/resolve.js";

function runRecipeFor(command: readonly string[], workingDirectory: string): RunRecipe {
  return {
    command: [...command],
    workingDirectory,
    environment: {},
    declared: [],
    substrates: [],
    isolation: "hygiene",
  };
}

/** Prints the bytes a scratch file holds, so a test can change the answer by rewriting it. */
function digestFileOracle(digestFile: string, counterFile?: string): ResolutionMethod {
  const bump = counterFile ? `require("node:fs").appendFileSync(${JSON.stringify(counterFile)}, "1");` : "";
  return {
    kind: "run",
    recipe: runRecipeFor(
      [
        "node",
        "-e",
        `${bump}process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(digestFile)}, "utf8"))`,
      ],
      "/",
    ),
  };
}

describe("resolveReference: a moving reference obtained once per evaluation, and a local one never obtained at all", () => {
  const repos: FixtureRepo[] = [];
  const scratchDirs: string[] = [];

  afterEach(async () => {
    for (const repo of repos.splice(0)) {
      await repo.cleanup();
    }
    scratchDirs.length = 0;
  });

  async function freshRepo(scope: string): Promise<FixtureRepo> {
    const repo = await makeFixtureRepo(scope);
    repos.push(repo);
    return repo;
  }

  async function scratchFile(name: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "musai-resolve-"));
    scratchDirs.push(dir);
    return join(dir, name);
  }

  test("two runs citing one moving reference in one evaluation produce exactly one resolution receipt", async () => {
    const repo = await freshRepo("resolve-dedup");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const index = new IndexDb();
    const counterFile = await scratchFile("counter");
    await writeFile(counterFile, "");
    const digestFile = await scratchFile("digest.txt");
    await writeFile(digestFile, "a".repeat(64));
    const method = digestFileOracle(digestFile, counterFile);
    const table: ResolutionTable = new Map();
    const reference: Reference = { declared: { uri: "example/image:latest" } };

    const first = await resolveReference(reference, table, { index, store, method, now: repo.now });
    const second = await resolveReference(reference, table, { index, store, method, now: repo.now });

    expect(await readFile(counterFile, "utf8")).toBe("1");
    expect(first.resolutionReceipt).not.toBeNull();
    expect(first.resolutionReceipt).toBe(second.resolutionReceipt);
  });

  test("two concurrent resolutions of one reference converge on one receipt", async () => {
    const repo = await freshRepo("resolve-concurrent");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const index = new IndexDb();
    const counterFile = await scratchFile("counter");
    await writeFile(counterFile, "");
    const digestFile = await scratchFile("digest.txt");
    await writeFile(digestFile, "b".repeat(64));
    const method = digestFileOracle(digestFile, counterFile);
    const table: ResolutionTable = new Map();
    const reference: Reference = { declared: { uri: "example/image:latest" } };

    const [a, b] = await Promise.all([
      resolveReference(reference, table, { index, store, method, now: repo.now }),
      resolveReference(reference, table, { index, store, method, now: repo.now }),
    ]);

    expect(a.resolutionReceipt).toBe(b.resolutionReceipt);
    expect(await readFile(counterFile, "utf8")).toBe("1");
  });

  test("a reference that is already a digest produces no resolution receipt", async () => {
    const repo = await freshRepo("resolve-already-digest");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const index = new IndexDb();
    const counterFile = await scratchFile("counter");
    await writeFile(counterFile, "");
    const method = digestFileOracle(await scratchFile("unused.txt"), counterFile);
    const table: ResolutionTable = new Map();
    const digest = "c".repeat(64);
    const reference: Reference = { declared: { uri: "example/image@sha256:pinned", digest: { sha256: digest } } };

    const result = await resolveReference(reference, table, { index, store, method, now: repo.now });

    expect(result.resolutionReceipt).toBeNull();
    expect(result.descriptor.digest?.sha256).toBe(digest);
    expect(await readFile(counterFile, "utf8")).toBe("");
  });

  test("a local file digest is computed in the kernel and produces no resolution receipt", async () => {
    const repo = await freshRepo("resolve-local-file");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const index = new IndexDb();
    const filePath = await scratchFile("local.txt");
    await writeFile(filePath, "local bytes nobody had to ask anyone about");
    const table: ResolutionTable = new Map();
    const reference: Reference = { declared: { uri: `file://${filePath}` } };

    const result = await resolveReference(reference, table, { index, store, now: repo.now });

    expect(result.resolutionReceipt).toBeNull();
    expect(result.descriptor.digest?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect([...result.reads]).toEqual([`substrate:file://${filePath}`]);
  });

  test("a resolution redone after the age limit leaves the earlier receipt in the store", async () => {
    const repo = await freshRepo("resolve-age-limit");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const index = new IndexDb();
    const digestFile = await scratchFile("digest.txt");
    await writeFile(digestFile, "d".repeat(64));
    const method = digestFileOracle(digestFile);
    const reference: Reference = { declared: { uri: "example/image:latest" } };

    const old = await resolveReference(reference, new Map(), {
      index,
      store,
      method,
      now: fixedClock("2020-01-01T00:00:00.000Z"),
    });
    await index.fold(store);

    const redone = await resolveReference(reference, new Map(), {
      index,
      store,
      method,
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
    const index = new IndexDb();
    const digestFile = await scratchFile("digest.txt");
    await writeFile(digestFile, "e".repeat(64));
    const method = digestFileOracle(digestFile);
    const reference: Reference = { declared: { uri: "example/image:latest" } };

    const first = await resolveReference(reference, new Map(), {
      index,
      store,
      method,
      now: fixedClock("2020-01-01T00:00:00.000Z"),
    });
    await index.fold(store);

    const unchanged = await resolveReference(reference, new Map(), {
      index,
      store,
      method,
      ageLimitMs: 1000,
      now: fixedClock("2021-01-01T00:00:00.000Z"),
    });
    expect(unchanged.descriptor.digest).toEqual(first.descriptor.digest);
    await index.fold(store);

    await writeFile(digestFile, "f".repeat(64));
    const changed = await resolveReference(reference, new Map(), {
      index,
      store,
      method,
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
    const index = new IndexDb();
    const digest = "1".repeat(64);
    const reference: Reference = { declared: { uri: "example/image@sha256:pinned", digest: { sha256: digest } } };

    const first = await resolveReference(reference, new Map(), {
      index,
      store,
      ageLimitMs: 0,
      now: fixedClock("2020-01-01T00:00:00.000Z"),
    });
    const second = await resolveReference(reference, new Map(), {
      index,
      store,
      ageLimitMs: 0,
      now: fixedClock("2030-01-01T00:00:00.000Z"),
    });

    expect(first.descriptor.digest).toEqual(second.descriptor.digest);
    expect(first.resolutionReceipt).toBeNull();
    expect(second.resolutionReceipt).toBeNull();
  });

  test("an unresolvable reference is refused with an error naming the reference", async () => {
    const repo = await freshRepo("resolve-unresolvable");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const index = new IndexDb();
    const table: ResolutionTable = new Map();
    const reference: Reference = { declared: { uri: "example/image:latest" } };

    await expect(resolveReference(reference, table, { index, store, now: repo.now })).rejects.toThrow(
      ResolutionRefusedError,
    );
    await expect(resolveReference(reference, table, { index, store, now: repo.now })).rejects.toThrow(
      /example\/image:latest/,
    );
  });

  test("the resolved descriptor carries both the declared reference and the resolution receipt's id", async () => {
    const repo = await freshRepo("resolve-both-halves");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const index = new IndexDb();
    const digestFile = await scratchFile("digest.txt");
    await writeFile(digestFile, "9".repeat(64));
    const method = digestFileOracle(digestFile);
    const reference: Reference = { declared: { uri: "example/image:latest" } };

    const result = await resolveReference(reference, new Map(), { index, store, method, now: repo.now });

    expect(result.descriptor.uri).toBe(reference.declared.uri);
    expect(result.descriptor.annotations?.resolvedBy).toBe(result.resolutionReceipt);
  });

  test("a fetch method's resolution is the retrieved body's own content digest", async () => {
    const repo = await freshRepo("resolve-fetch-method");
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const index = new IndexDb();
    const body = "a nightly pointer's current answer";

    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected the test server to bind a numeric port");
    }
    try {
      const locator = `http://127.0.0.1:${address.port}/nightly`;
      const method: ResolutionMethod = { kind: "fetch", recipe: { locator, headers: [], names: [] } };
      const reference: Reference = { declared: { uri: "nightly-build" } };

      const result = await resolveReference(reference, new Map(), {
        index,
        store,
        method,
        now: repo.now,
      });

      expect(result.resolutionReceipt).not.toBeNull();
      expect(result.descriptor.digest?.sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
