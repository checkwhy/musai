import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type ComputedRunRecord,
  CURRENT_SCHEMA_VERSIONS,
  canonicalBytes,
  EVALUATOR_VERSION,
  hexOfRecordId,
  type RecordId,
  readEntryFor,
  recipeReadKey,
  recordId,
  recordPath,
  timestamp,
} from "@musai/records";
import { createScope, initWorkspace, type RecordStore, Store, scopeRefName } from "@musai/store";
import { describe, expect, onTestFinished, test } from "vitest";
import { type Admission, IndexDb } from "../src/index-db.js";
import { KERNEL_INDEX_TABLES } from "../src/schema.js";
import { openIndexProvider } from "../src/sqlite-provider.js";

const now = () => timestamp("2026-10-08T00:00:00.000Z");

function runReading(label: string, reads: readonly RecordId[] = []): ComputedRunRecord {
  return {
    kind: "run",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
    runKind: "evaluation",
    performer: { kind: "runner", version: EVALUATOR_VERSION },
    determinism: "deterministic",
    recipe: { command: ["evaluate", label], substrates: [] },
    observation: { output: "{}", reads: reads.map((id) => readEntryFor(id)), cost: {} },
  };
}

/** A reader of `read` whose path sorts before it, so a walk in path order meets it first. */
function readerSortingBefore(read: RecordId): ComputedRunRecord {
  for (let attempt = 0; ; attempt += 1) {
    const reader = runReading(`reader ${attempt}`, [read]);
    if (recordId(reader) < read) {
      return reader;
    }
  }
}

/** `length` runs, each reading the one before; the first reads `root`. */
function chainReading(root: RecordId, length: number): ComputedRunRecord[] {
  const chain: ComputedRunRecord[] = [];
  let previous = root;
  for (let depth = 0; depth < length; depth += 1) {
    const link = runReading(`link ${depth}`, [previous]);
    chain.push(link);
    previous = recordId(link);
  }
  return chain;
}

/** What a fold holds, in a form two folds of one history can be compared by. */
function rowsOf(path: string): unknown[] {
  const raw = openIndexProvider().open(path);
  try {
    return [
      raw.prepare("SELECT id, kind, commit_sha, position FROM records ORDER BY id").all(),
      raw.prepare("SELECT sha, seq FROM commits ORDER BY seq").all(),
      raw
        .prepare("SELECT commit_sha, position, kind, about, record_id FROM events ORDER BY commit_sha, position")
        .all(),
    ];
  } finally {
    raw.close();
  }
}

async function scope(): Promise<{ store: Store; path: string; gitDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "musai-fold-admission-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const { gitDir } = await initWorkspace(dir, { now });
  return { store: new Store({ ctx: { gitDir }, scope: "default", now }), path: join(dir, "index.sqlite"), gitDir };
}

/** Judged under one trust commit throughout; judged again, it answers as it did. */
function judgedOnce(judged: Omit<Admission, "trust" | "trustTip" | "judgedAgain">, trust = "trust"): Admission {
  const admission: Admission = { ...judged, trust, trustTip: async () => trust, judgedAgain: async () => admission };
  return admission;
}

/** `admission` judged under the trust commit `trust` while the trust branch stands at `tip`; judged
 * again, it answers as it did. */
function underTrust(admission: Admission, trust: string, tip = trust): Admission {
  const judged: Admission = { ...admission, trust, trustTip: async () => tip, judgedAgain: async () => judged };
  return judged;
}

/** A commit beside the scope's history, atop `parent`, as the trust branch's commits are. */
function trustCommit(gitDir: string, label: string, parent?: string): string {
  const tree = execFileSync("git", ["--git-dir", gitDir, "mktree"], { input: "" }).toString().trim();
  const parents = parent === undefined ? [] : ["-p", parent];
  const identity = {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  return execFileSync("git", ["--git-dir", gitDir, "commit-tree", tree, ...parents, "-m", label], {
    env: { ...process.env, ...identity },
  })
    .toString()
    .trim();
}

/** Expires every reflog and prunes whatever no ref reaches. */
function prune(gitDir: string): void {
  execFileSync("git", ["--git-dir", gitDir, "reflog", "expire", "--expire=now", "--all"]);
  execFileSync("git", ["--git-dir", gitDir, "gc", "--quiet", "--prune=now"]);
}

/** Withholds `withheld`, and any run that read something this fold did not admit. */
function withholding(withheld: RecordId, through: string | null, digest = `withholding ${withheld}`): Admission {
  return judgedOnce({
    digest,
    through,
    admits: ({ id, record }, admitted) =>
      id !== withheld &&
      (record.kind !== "run" ||
        record.observation.reads.every(({ consumed }) => admitted(`sha256:${consumed.sha256}` as RecordId))),
    withholds: (id) => id === withheld,
    verifies: () => false,
    replaces: () => false,
  });
}

/** Withholds each of `withheld`, and any run that read something this fold did not admit. */
function withholdingAll(withheld: ReadonlySet<RecordId>, through: string | null): Admission {
  return judgedOnce({
    digest: "withholding many",
    through,
    admits: ({ id, record }, admitted) =>
      !withheld.has(id) &&
      (record.kind !== "run" ||
        record.observation.reads.every(({ consumed }) => admitted(`sha256:${consumed.sha256}` as RecordId))),
    withholds: (id) => withheld.has(id),
    verifies: () => false,
    replaces: () => false,
  });
}

/** The first record `make` builds, over attempts, that `suits`. */
function ordered(make: (attempt: number) => ComputedRunRecord, suits: (record: ComputedRunRecord) => boolean) {
  for (let attempt = 0; ; attempt += 1) {
    const candidate = make(attempt);
    if (suits(candidate)) {
      return candidate;
    }
  }
}

/** A repeatable stream in [0, 1). */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
    return state / 0x80000000;
  };
}

const admitsEverything = (through: string | null, digest: string, trust?: string): Admission =>
  judgedOnce(
    { digest, through, admits: () => true, withholds: () => false, verifies: () => false, replaces: () => false },
    trust,
  );

/** Moves the scope's ref back to `commit`, as a reset of the author's history would. */
function rewind(gitDir: string, commit: string): void {
  execFileSync("git", ["--git-dir", gitDir, "update-ref", scopeRefName("default"), commit]);
}

/** A commit per record atop `parent`, all in one `git fast-import`, so a long history is cheap. */
function commitEach(gitDir: string, parent: string, records: readonly ComputedRunRecord[]): void {
  const stream = records.flatMap((record, index) => {
    const bytes = Buffer.from(canonicalBytes(record));
    const message = `record ${index}`;
    return [
      Buffer.from(
        `commit ${scopeRefName("default")}\ncommitter t <t@t> ${1_700_000_000 + index} +0000\n` +
          `data ${Buffer.byteLength(message)}\n${message}\n${index === 0 ? `from ${parent}\n` : ""}` +
          `M 100644 inline ${recordPath("run", recordId(record))}\ndata ${bytes.length}\n`,
      ),
      bytes,
      Buffer.from("\n"),
    ];
  });
  execFileSync("git", ["--git-dir", gitDir, "fast-import", "--quiet"], { input: Buffer.concat(stream) });
}

/** Empties the fold at `path` and its walk, its stamp kept, as a fold forgetting a history does. */
function emptiedUnderItsStamp(path: string): void {
  const raw = openIndexProvider().open(path);
  try {
    for (const table of KERNEL_INDEX_TABLES.keys()) {
      if (table !== "schema_meta" && table !== "watermark" && table !== "walked") {
        raw.exec(`DELETE FROM ${table}`);
      }
    }
    raw.exec("UPDATE watermark SET commit_sha = NULL WHERE id = 0");
    raw.exec("UPDATE walked SET commit_sha = NULL WHERE id = 0");
  } finally {
    raw.close();
  }
}

/** The admission a fold's file was last stamped with, and where it was judged. */
function stampAt(path: string): unknown {
  const raw = openIndexProvider().open(path);
  try {
    return raw.prepare("SELECT admission, through, trust FROM schema_meta WHERE id = 0").get();
  } finally {
    raw.close();
  }
}

/** Opened here and closed when the test finishes. */
function indexAt(path: string): IndexDb {
  const index = new IndexDb(path);
  onTestFinished(() => index.close());
  return index;
}

describe("a fold admitting records by a rule over each record and what it already admitted", () => {
  test("a record landing beside what it read is withheld with it, though the walk meets it first", async () => {
    const { store, path } = await scope();
    const sealed = runReading("sealed");
    const reader = readerSortingBefore(recordId(sealed));
    const unrelated = runReading("unrelated");
    await store.putMany([
      { kind: "run", value: sealed },
      { kind: "run", value: reader },
      { kind: "run", value: unrelated },
    ]);
    const index = indexAt(path);

    await index.fold(store, undefined, undefined, withholding(recordId(sealed), await store.tip()));

    expect(index.recordById(recordId(sealed))).toBeUndefined();
    expect(index.recordById(recordId(reader))).toBeUndefined();
    expect(index.recordById(recordId(unrelated))).toBeDefined();
  });

  test("a fold built under one admission is refolded from nothing under another", async () => {
    const { store, path } = await scope();
    const sealed = runReading("sealed");
    await store.put("run", sealed);
    const index = indexAt(path);
    await index.fold(store, undefined, undefined, withholding(recordId(sealed), await store.tip()));

    await index.fold(store, undefined, undefined, admitsEverything(await store.tip(), "everything"));
    expect(index.recordById(recordId(sealed))).toBeDefined();

    await index.fold(store, undefined, undefined, withholding(recordId(sealed), await store.tip()));
    expect(index.recordById(recordId(sealed))).toBeUndefined();
  });

  test("a fold built under an admission refuses to be folded without it, and keeps what it held", async () => {
    const { store, path } = await scope();
    const sealed = runReading("sealed");
    await store.put("run", sealed);
    const index = indexAt(path);
    await index.fold(store, undefined, undefined, withholding(recordId(sealed), await store.tip()));

    await expect(index.fold(store)).rejects.toThrow("without an admission");
    expect(indexAt(path).recordById(recordId(sealed))).toBeUndefined();
  });

  test("a commit the admission admits nothing of leaves no row, and the fold walks on past it", async () => {
    const { store, path } = await scope();
    await store.put("run", runReading("first"));
    const first = (await store.tip())!;
    const sealed = runReading("sealed");
    await store.put("run", sealed);
    const index = indexAt(path);

    await index.fold(store, undefined, undefined, withholding(recordId(sealed), await store.tip()));
    expect(index.watermark()).toBe(first);
    expect(index.eventsAfter({ commit: first })).toEqual([]);

    const later = await store.put("run", runReading("later"));
    await index.fold(store, undefined, undefined, withholding(recordId(sealed), await store.tip()));
    expect(index.watermark()).toBe(await store.tip());
    expect(index.eventsAfter({ commit: first })!.map((event) => event.recordId)).toEqual([later]);
  });

  test("an admission judged before the fold's stamp is judged again, and never restamps the fold", async () => {
    const { store, path } = await scope();
    const sealed = runReading("sealed");
    await store.put("run", sealed);
    const before = await store.tip();
    await store.put("run", runReading("later"));
    const index = indexAt(path);
    await index.fold(store, undefined, undefined, withholding(recordId(sealed), await store.tip()));
    const judged: string[] = [];
    const stale: Admission = {
      ...admitsEverything(before, "everything"),
      judgedAgain: async () => {
        judged.push("again");
        return withholding(recordId(sealed), await store.tip());
      },
    };

    await index.fold(store, undefined, undefined, stale);

    expect(judged).toEqual(["again"]);
    expect(index.holds(recordId(sealed))).toBe(false);
  });

  test("an admission judged under a trust commit the fold's stamp descends from is judged again", async () => {
    const { store, path } = await scope();
    const sealed = runReading("sealed");
    await store.put("run", sealed);
    const olderTrust = (await store.tip())!;
    await store.put("run", runReading("later"));
    const tip = (await store.tip())!;
    const index = indexAt(path);
    await index.fold(store, undefined, undefined, underTrust(withholding(recordId(sealed), tip), tip));
    const judged: string[] = [];
    const stale: Admission = {
      ...underTrust(admitsEverything(tip, "everything"), olderTrust, tip),
      judgedAgain: async () => {
        judged.push("again");
        return underTrust(withholding(recordId(sealed), tip), tip);
      },
    };

    await index.fold(store, undefined, undefined, stale);

    expect(judged).toEqual(["again"]);
    expect(index.holds(recordId(sealed))).toBe(false);
  });

  test("an admission still behind the fold's stamp once judged again is refused, and the fold keeps what it held", async () => {
    const { store, path } = await scope();
    const sealed = runReading("sealed");
    await store.put("run", sealed);
    const before = await store.tip();
    await store.put("run", runReading("later"));
    const index = indexAt(path);
    await index.fold(store, undefined, undefined, withholding(recordId(sealed), await store.tip()));

    await expect(index.fold(store, undefined, undefined, admitsEverything(before, "everything"))).rejects.toMatchObject(
      { reason: "head-moved" },
    );
    expect(index.holds(recordId(sealed))).toBe(false);
    expect(index.watermark()).toBe(await store.tip());
  });

  test("a fold whose stamp another fold moves past while it is judged refuses rather than restamp", async () => {
    const { store, path } = await scope();
    const sealed = runReading("sealed");
    await store.put("run", sealed);
    const first = (await store.tip())!;
    await store.put("run", runReading("second"));
    const second = (await store.tip())!;
    await store.put("run", runReading("third"));
    const index = indexAt(path);
    await index.fold(store, undefined, undefined, withholding(recordId(sealed), first));
    const other = indexAt(path);
    // Another process folds to the tip each time this fold asks where its stamp lies.
    const racing: RecordStore = Object.assign(Object.create(store) as Store, {
      descends: async (from: string, to: string) => {
        await other.fold(store, undefined, undefined, withholding(recordId(sealed), await store.tip()));
        return store.descends(from, to);
      },
    });

    await expect(
      index.fold(racing, undefined, undefined, admitsEverything(second, "everything")),
    ).rejects.toMatchObject({ reason: "head-moved" });
    expect(index.holds(recordId(sealed))).toBe(false);
  });

  test("a fold whose file another fold restamps between batches refuses to fold on", async () => {
    const { store, path } = await scope();
    await store.put("run", runReading("first"));
    const index = indexAt(path);

    const restamping = index.fold(
      store,
      ({ phase }) => {
        if (phase === "before-commit") {
          const other = openIndexProvider().open(path);
          other.exec("UPDATE schema_meta SET admission = 'another' WHERE id = 0");
          other.close();
        }
      },
      undefined,
      admitsEverything(await store.tip(), "this one"),
    );

    await expect(restamping).rejects.toMatchObject({ reason: "head-moved" });
    expect(index.watermark()).toBeNull();
  });

  test("a cleared fold over a rewound author history refolds from nothing and holds only what its clearance admits", async () => {
    const { store, path, gitDir } = await scope();
    const sealed = runReading("sealed");
    const kept = runReading("kept");
    await store.putMany([
      { kind: "run", value: sealed },
      { kind: "run", value: kept },
    ]);
    const rewoundTo = (await store.tip())!;
    const dropped = await store.put("run", runReading("dropped"));
    const index = indexAt(path);
    await index.fold(store, undefined, undefined, withholding(recordId(sealed), await store.tip()));
    rewind(gitDir, rewoundTo);

    await index.fold(store, undefined, undefined, withholding(recordId(sealed), rewoundTo));

    expect([index.holds(recordId(kept)), index.holds(recordId(sealed)), index.holds(dropped)]).toEqual([
      true,
      false,
      false,
    ]);
    expect(index.watermark()).toBe(rewoundTo);
  });

  test("a cleared fold over a rewritten author history refolds from nothing and holds only what its clearance admits", async () => {
    const { store, path, gitDir } = await scope();
    const sealed = runReading("sealed");
    await store.put("run", sealed);
    const rewoundTo = (await store.tip())!;
    const dropped = await store.put("run", runReading("dropped"));
    const index = indexAt(path);
    await index.fold(store, undefined, undefined, withholding(recordId(sealed), await store.tip()));
    rewind(gitDir, rewoundTo);
    const rewritten = await store.put("run", runReading("rewritten"));

    await index.fold(store, undefined, undefined, withholding(recordId(sealed), await store.tip()));

    expect([index.holds(rewritten), index.holds(recordId(sealed)), index.holds(dropped)]).toEqual([true, false, false]);
  });

  test("a cleared fold over a rewritten author history the repository pruned refolds from nothing", async () => {
    const { store, path, gitDir } = await scope();
    const sealed = runReading("sealed");
    await store.put("run", sealed);
    const rewoundTo = (await store.tip())!;
    const dropped = await store.put("run", runReading("dropped"));
    const index = indexAt(path);
    await index.fold(store, undefined, undefined, withholding(recordId(sealed), await store.tip()));
    rewind(gitDir, rewoundTo);
    const rewritten = await store.put("run", runReading("rewritten"));
    execFileSync("git", ["--git-dir", gitDir, "reflog", "expire", "--expire=now", "--all"]);
    execFileSync("git", ["--git-dir", gitDir, "gc", "--quiet", "--prune=now"]);

    await index.fold(store, undefined, undefined, withholding(recordId(sealed), await store.tip()));

    expect([index.holds(rewritten), index.holds(recordId(sealed)), index.holds(dropped)]).toEqual([true, false, false]);
  });

  test("a cleared fold whose stamp left the author's history is refused while its admission is judged short of the tip", async () => {
    const { store, path, gitDir } = await scope();
    const sealed = runReading("sealed");
    await store.put("run", sealed);
    const rewoundTo = (await store.tip())!;
    const dropped = await store.put("run", runReading("dropped"));
    const index = indexAt(path);
    await index.fold(store, undefined, undefined, withholding(recordId(sealed), await store.tip()));
    rewind(gitDir, rewoundTo);
    await store.put("run", runReading("past the judgement"));

    await expect(
      index.fold(store, undefined, undefined, withholding(recordId(sealed), rewoundTo)),
    ).rejects.toMatchObject({ reason: "head-moved" });
    expect(index.holds(dropped)).toBe(true);
  });

  test("a cleared fold whose stamp moved onto a history the scope left is refused short of the tip, and refolded at it", async () => {
    const { store, path, gitDir } = await scope();
    const sealed = runReading("sealed");
    await store.put("run", sealed);
    const rewoundTo = (await store.tip())!;
    const dropped = await store.put("run", runReading("dropped"));
    const index = indexAt(path);
    await index.fold(store, undefined, undefined, withholding(recordId(sealed), await store.tip()));
    rewind(gitDir, rewoundTo);
    const first = await store.put("run", runReading("first rewritten"));
    const judgedShort = (await store.tip())!;
    const second = await store.put("run", runReading("second rewritten"));

    await expect(
      index.fold(store, undefined, undefined, withholding(recordId(sealed), judgedShort)),
    ).rejects.toMatchObject({ reason: "head-moved" });
    await index.fold(store, undefined, undefined, withholding(recordId(sealed), await store.tip()));

    expect([first, second, recordId(sealed), dropped].map((id) => index.holds(id))).toEqual([true, true, false, false]);
  });

  test("a cleared fold over a rewound trust branch refolds at both tips and holds only what the trust it stands at admits", async () => {
    const { store, path, gitDir } = await scope();
    const sealed = runReading("sealed");
    const kept = runReading("kept");
    await store.putMany([
      { kind: "run", value: sealed },
      { kind: "run", value: kept },
    ]);
    const tip = (await store.tip())!;
    const standing = trustCommit(gitDir, "standing");
    const rewound = trustCommit(gitDir, "rewound", standing);
    const index = indexAt(path);
    await index.fold(store, undefined, undefined, underTrust(admitsEverything(tip, "everything"), rewound));

    await index.fold(store, undefined, undefined, underTrust(withholding(recordId(sealed), tip), standing));

    expect([index.holds(recordId(kept)), index.holds(recordId(sealed)), index.watermark()]).toEqual([true, false, tip]);
  });

  test("a cleared fold over a rewritten trust branch refolds at both tips and holds only what the trust it stands at admits", async () => {
    const { store, path, gitDir } = await scope();
    const sealed = runReading("sealed");
    const kept = runReading("kept");
    await store.putMany([
      { kind: "run", value: sealed },
      { kind: "run", value: kept },
    ]);
    const tip = (await store.tip())!;
    const base = trustCommit(gitDir, "base");
    const left = trustCommit(gitDir, "left", base);
    const rewritten = trustCommit(gitDir, "rewritten", base);
    const index = indexAt(path);
    await index.fold(store, undefined, undefined, underTrust(admitsEverything(tip, "everything"), left));

    await index.fold(store, undefined, undefined, underTrust(withholding(recordId(sealed), tip), rewritten));

    expect([index.holds(recordId(kept)), index.holds(recordId(sealed)), index.watermark()]).toEqual([true, false, tip]);
  });

  test("a cleared fold whose stamp's trust commit was pruned refolds at both tips rather than wedge", async () => {
    const { store, path, gitDir } = await scope();
    const sealed = runReading("sealed");
    const kept = runReading("kept");
    await store.putMany([
      { kind: "run", value: sealed },
      { kind: "run", value: kept },
    ]);
    const tip = (await store.tip())!;
    const index = indexAt(path);
    await index.fold(
      store,
      undefined,
      undefined,
      underTrust(admitsEverything(tip, "everything"), trustCommit(gitDir, "pruned")),
    );
    prune(gitDir);
    const standing = trustCommit(gitDir, "standing");

    await index.fold(store, undefined, undefined, underTrust(withholding(recordId(sealed), tip), standing));

    expect([index.holds(recordId(kept)), index.holds(recordId(sealed)), index.watermark()]).toEqual([true, false, tip]);
  });

  test("a cleared fold whose stamp's trust commit left the trust branch is refused short of either tip, and keeps its stamp", async () => {
    const { store, path, gitDir } = await scope();
    const sealed = runReading("sealed");
    await store.put("run", sealed);
    const short = (await store.tip())!;
    const later = await store.put("run", runReading("later"));
    const tip = (await store.tip())!;
    const base = trustCommit(gitDir, "base");
    const left = trustCommit(gitDir, "left", base);
    const standing = trustCommit(gitDir, "standing", base);
    const index = indexAt(path);
    await index.fold(store, undefined, undefined, underTrust(admitsEverything(tip, "everything"), left));
    const stamped = stampAt(path);
    const judgedShort = [
      underTrust(withholding(recordId(sealed), tip), base, standing),
      underTrust(withholding(recordId(sealed), short), standing),
    ];

    for (const judged of judgedShort) {
      await expect(index.fold(store, undefined, undefined, judged)).rejects.toMatchObject({ reason: "head-moved" });
    }

    expect([stampAt(path), index.holds(recordId(sealed)), index.holds(later)]).toEqual([stamped, true, true]);
  });

  test.each([
    ["rewound", (gitDir: string, standing: string) => trustCommit(gitDir, "left", standing)],
    ["rewritten", (gitDir: string) => trustCommit(gitDir, "left")],
  ])(
    "a fold judged under a trust commit a %s trust branch left cannot reset a file folded at its tip",
    async (_, leave) => {
      const { store, path, gitDir } = await scope();
      const sealed = runReading("sealed");
      await store.put("run", sealed);
      const tip = (await store.tip())!;
      const standing = trustCommit(gitDir, "standing");
      const left = leave(gitDir, standing);
      const current = indexAt(path);
      await current.fold(store, undefined, undefined, underTrust(withholding(recordId(sealed), tip), standing));
      const stamped = stampAt(path);
      const stale = indexAt(path);

      const looser = stale.fold(
        store,
        undefined,
        undefined,
        underTrust(admitsEverything(tip, "everything"), left, standing),
      );

      await expect(looser).rejects.toMatchObject({
        reason: "head-moved",
        detail: expect.stringContaining("open the workspace again"),
      });
      expect([stampAt(path), current.holds(recordId(sealed))]).toEqual([stamped, false]);
    },
  );

  test("a fold judged under a trust the branch has since advanced past neither stamps nor walks the shared file", async () => {
    const { store, path, gitDir } = await scope();
    await store.put("run", runReading("first"));
    const first = (await store.tip())!;
    const later = await store.put("run", runReading("later"));
    const older = trustCommit(gitDir, "older");
    const advanced = trustCommit(gitDir, "advanced", older);
    const index = indexAt(path);
    await index.fold(store, undefined, undefined, underTrust(admitsEverything(first, "everything"), older));
    const stamped = stampAt(path);

    const walked = index.fold(
      store,
      undefined,
      undefined,
      underTrust(admitsEverything(await store.tip(), "everything"), older, advanced),
    );

    await expect(walked).rejects.toMatchObject({
      reason: "head-moved",
      detail: expect.stringContaining("open the workspace again"),
    });
    expect([stampAt(path), index.watermark(), index.holds(later)]).toEqual([stamped, first, false]);
  });

  test("a fold judged under a trust the branch has since advanced past stamps no fresh file", async () => {
    const { store, path, gitDir } = await scope();
    await store.put("run", runReading("first"));
    const older = trustCommit(gitDir, "older");
    const index = indexAt(path);

    const stamping = index.fold(
      store,
      undefined,
      undefined,
      underTrust(admitsEverything(await store.tip(), "everything"), older, trustCommit(gitDir, "advanced", older)),
    );

    await expect(stamping).rejects.toMatchObject({ reason: "head-moved" });
    expect([stampAt(path), index.watermark()]).toEqual([{ admission: null, through: null, trust: null }, null]);
  });

  test("a judgement made again at a trust tip the branch moves past meanwhile is refused and moves nothing in the file", async () => {
    const { store, path, gitDir } = await scope();
    await store.put("run", runReading("first"));
    const first = (await store.tip())!;
    const later = await store.put("run", runReading("later"));
    const older = trustCommit(gitDir, "older");
    const advanced = trustCommit(gitDir, "advanced", older);
    const index = indexAt(path);
    await index.fold(store, undefined, undefined, underTrust(admitsEverything(first, "everything"), older));
    const stamped = stampAt(path);
    const judgedAtAdvanced = underTrust(
      admitsEverything(await store.tip(), "everything"),
      advanced,
      trustCommit(gitDir, "moved meanwhile", advanced),
    );

    const walked = index.fold(store, undefined, undefined, {
      ...underTrust(admitsEverything(await store.tip(), "everything"), older, advanced),
      judgedAgain: async () => judgedAtAdvanced,
    });

    await expect(walked).rejects.toMatchObject({
      reason: "head-moved",
      detail: expect.stringContaining(`the trust commit ${advanced}`),
    });
    expect([stampAt(path), index.watermark(), index.holds(later)]).toEqual([stamped, first, false]);
  });

  test("a fold judged under a trust commit the trust branch left walks the file no further, though it folded the file", async () => {
    const { store, path, gitDir } = await scope();
    await store.put("run", runReading("first"));
    const first = (await store.tip())!;
    const later = await store.put("run", runReading("later"));
    const left = trustCommit(gitDir, "left");
    const standing = trustCommit(gitDir, "standing");
    const index = indexAt(path);
    await index.fold(store, undefined, undefined, underTrust(admitsEverything(first, "everything"), left));

    const walked = index.fold(
      store,
      undefined,
      undefined,
      underTrust(admitsEverything(await store.tip(), "everything"), left, standing),
    );

    await expect(walked).rejects.toMatchObject({ reason: "head-moved" });
    expect([index.watermark(), index.holds(later)]).toEqual([first, false]);
  });

  test("a fold under the admission it was built under keeps its rows and walks only what is new", async () => {
    const { store, path } = await scope();
    const sealed = runReading("sealed");
    await store.put("run", sealed);
    const index = indexAt(path);
    await index.fold(store, undefined, undefined, withholding(recordId(sealed), await store.tip(), "the rule"));

    const later = runReading("later");
    await store.put("run", later);
    await index.fold(store, undefined, undefined, admitsEverything(await store.tip(), "the rule"));

    expect(index.recordById(recordId(sealed))).toBeUndefined();
    expect(index.recordById(recordId(later))).toBeDefined();
  });

  test("a fold under an admission stops at the commit the admission was judged at", async () => {
    const { store, path } = await scope();
    await store.put("run", runReading("first"));
    const judgedAt = await store.tip();
    const second = runReading("second");
    await store.put("run", second);
    const index = indexAt(path);

    await index.fold(store, undefined, undefined, admitsEverything(judgedAt, "everything"));

    expect(index.watermark()).toBe(judgedAt);
    expect(index.recordById(recordId(second))).toBeUndefined();
  });

  test("a record held answers whether it landed by a commit, in the log's order", async () => {
    const { store, path } = await scope();
    const first = await store.put("run", runReading("first"));
    const firstCommit = (await store.tip())!;
    const second = await store.put("run", runReading("second"));
    const index = indexAt(path);
    await index.fold(store);

    expect(index.landedBy(first, firstCommit)).toBe(true);
    expect(index.landedBy(second, firstCommit)).toBe(false);
    expect(index.landedBy(recordId({ never: "written" }), (await store.tip())!)).toBe(false);
  });

  test("a receipt landing in its reader's commit moves no read of its recipe, whatever their paths", async () => {
    const { store, path } = await scope();
    const receipt = runReading("the receipt");
    const read = {
      key: recipeReadKey(recordId(receipt.recipe)),
      consumed: { sha256: hexOfRecordId(recordId(receipt)) },
    };
    const readers = Array.from({ length: 16 }, (_, attempt) => {
      const reader = runReading(`reader ${attempt}`);
      return { ...reader, observation: { ...reader.observation, reads: [read] } };
    });
    const before = readers.find((reader) => recordId(reader) < recordId(receipt))!;
    const after = readers.find((reader) => recordId(reader) > recordId(receipt))!;
    await store.putMany([receipt, before, after].map((value) => ({ kind: "run" as const, value })));
    const index = indexAt(path);
    await index.fold(store);
    const moved = () => [before, after].map((reader) => index.readMoved(recordId(reader), read));

    expect(moved()).toEqual([false, false]);
    await store.put("run", { ...receipt, observation: { ...receipt.observation, output: '{"again":true}' } });
    await index.fold(store);
    expect(moved()).toEqual([true, true]);
  });

  test("a merge landing a reader beside a newer receipt of its recipe it never read moves its read, whatever their paths", async () => {
    const { store, path, gitDir } = await scope();
    const first = runReading("the receipt read");
    const newer = { ...first, observation: { ...first.observation, output: '{"newer":true}' } };
    const read = {
      key: recipeReadKey(recordId(first.recipe)),
      consumed: { sha256: hexOfRecordId(recordId(first)) },
    };
    const readers = Array.from({ length: 16 }, (_, attempt) => {
      const reader = runReading(`reader ${attempt}`);
      return { ...reader, observation: { ...reader.observation, reads: [read] } };
    });
    const before = readers.find((reader) => recordId(reader) < recordId(newer))!;
    const after = readers.find((reader) => recordId(reader) > recordId(newer))!;
    await store.put("run", runReading("the base"));
    await createScope({ gitDir }, "fork", (await store.tip())!);
    const fork = new Store({ ctx: { gitDir }, scope: "fork", now });
    for (const run of [first, before, after, newer]) {
      await fork.put("run", run);
    }
    await store.mergeFrom("fork");
    const index = indexAt(path);
    await index.fold(store);

    expect(index.commitOf(recordId(newer))).toBe(index.commitOf(recordId(before)));
    expect([before, after].map((reader) => index.readMoved(recordId(reader), read))).toEqual([true, true]);
  });

  test("a record held answers the commit it landed in, and one never written answers none", async () => {
    const { store, path } = await scope();
    const first = await store.put("run", runReading("first"));
    const firstCommit = (await store.tip())!;
    const second = await store.put("run", runReading("second"));
    const index = indexAt(path);
    await index.fold(store);

    expect([first, second, recordId({ never: "written" })].map((id) => index.commitOf(id))).toEqual([
      firstCommit,
      await store.tip(),
      undefined,
    ]);
  });

  test("a long chain landed beside the record it read is judged in a number of questions linear in its length", async () => {
    const { store, path } = await scope();
    const root = runReading("root");
    const chain = chainReading(recordId(root), 2_000);
    await store.putMany([root, ...chain].map((value) => ({ kind: "run", value })));
    const base = withholding(recordId(root), await store.tip());
    let questions = 0;
    const counting: Admission = {
      ...base,
      admits: (record, admitted) => {
        questions += 1;
        return base.admits(record, admitted);
      },
    };
    const index = indexAt(path);

    await index.fold(store, undefined, undefined, counting);

    expect(chain.some((link) => index.holds(recordId(link)))).toBe(false);
    expect(questions).toBeLessThan(3 * chain.length);
  });

  test("a fold made commit by commit holds the rows a fold made in one pass holds", async () => {
    const { store, path } = await scope();
    const root = runReading("root");
    const chain = chainReading(recordId(root), 40);
    const steps = [
      [root, ...chain.slice(0, 12), runReading("first unrelated")],
      [...chain.slice(12, 26), runReading("second unrelated")],
      chain.slice(26),
    ];
    const warm = indexAt(path);
    for (const step of steps) {
      await store.putMany(step.map((value) => ({ kind: "run", value })));
      await warm.fold(store, undefined, undefined, withholding(recordId(root), await store.tip()));
    }
    const cold = indexAt(join(dirname(path), "cold.sqlite"));

    await cold.fold(store, undefined, undefined, withholding(recordId(root), await store.tip()));

    expect(rowsOf(path)).toEqual(rowsOf(join(dirname(path), "cold.sqlite")));
    expect(warm.holds(recordId(chain[0]!))).toBe(false);
    expect(warm.holds(recordId(chain[39]!))).toBe(false);
    expect(chain.every((link) => !warm.holds(recordId(link)))).toBe(true);
    expect(
      steps
        .flat()
        .filter((value) => warm.holds(recordId(value)))
        .map((value) => value.recipe.command[1]),
    ).toEqual(["first unrelated", "second unrelated"]);
  });

  test("a run read from any one admitted record stays admitted until the last of them is withheld", async () => {
    const { store, path } = await scope();
    // The walk meets the reader, the middle run, what it read, then what the reader asked about.
    const [lastRead, lastWithheld] = [runReading("first read"), runReading("second read")].sort((a, b) =>
      recordId(a) < recordId(b) ? -1 : 1,
    ) as [ComputedRunRecord, ComputedRunRecord];
    const middle = ordered(
      (attempt) => runReading(`middle ${attempt}`, [recordId(lastRead)]),
      (candidate) => recordId(candidate) < recordId(lastRead),
    );
    const reader = ordered(
      (attempt) => runReading(`reader ${attempt}`, [recordId(lastWithheld), recordId(middle)]),
      (candidate) => recordId(candidate) < recordId(middle),
    );
    const untouched = runReading("untouched");
    const keeper = runReading("keeper", [recordId(lastWithheld), recordId(untouched)]);
    const runs = [lastRead, lastWithheld, middle, reader, untouched, keeper];
    await store.putMany(runs.map((value) => ({ kind: "run", value })));
    const gone = new Set([recordId(lastRead), recordId(lastWithheld)]);
    const admission = judgedOnce({
      digest: "any one",
      through: await store.tip(),
      admits: ({ id, record }, admitted) =>
        !gone.has(id) &&
        (record.kind !== "run" ||
          record.observation.reads.length === 0 ||
          record.observation.reads.some(({ consumed }) => admitted(`sha256:${consumed.sha256}` as RecordId))),
      withholds: (id) => gone.has(id),
      verifies: () => false,
      replaces: () => false,
    });
    const index = indexAt(path);

    await index.fold(store, undefined, undefined, admission);

    expect(runs.map((value) => index.holds(recordId(value)))).toEqual([false, false, false, false, true, true]);
  });

  test("a fold of many runs landed in one commit holds exactly the runs none of whose support is withheld", async () => {
    for (const seed of [1, 2, 3]) {
      const { store, path } = await scope();
      const random = seeded(seed);
      const runs: ComputedRunRecord[] = [];
      for (let index = 0; index < 300; index += 1) {
        const reads = Array.from({ length: Math.floor(random() * 4) }, () =>
          index === 0 ? undefined : recordId(runs[Math.floor(random() * index)]!),
        ).filter((id) => id !== undefined);
        runs.push(runReading(`run ${seed} ${index}`, reads));
      }
      const gone = new Set(runs.filter(() => random() < 0.08).map((value) => recordId(value)));
      await store.putMany(runs.map((value) => ({ kind: "run", value })));
      const expected = new Set(runs.map((value) => recordId(value)).filter((id) => !gone.has(id)));
      for (let changed = true; changed; ) {
        changed = false;
        for (const value of runs) {
          const id = recordId(value);
          const supported = value.observation.reads.every(({ consumed }) => expected.has(`sha256:${consumed.sha256}`));
          if (expected.has(id) && !supported) {
            expected.delete(id);
            changed = true;
          }
        }
      }
      const index = indexAt(path);

      await index.fold(store, undefined, undefined, withholdingAll(gone, await store.tip()));

      expect(runs.filter((value) => index.holds(recordId(value))).map((value) => recordId(value))).toEqual(
        runs.map((value) => recordId(value)).filter((id) => expected.has(id)),
      );
    }
  });
});

describe("a fold of a tip another writer moves", () => {
  test("folds no commit past the tip it read, though a write lands while it folds", async () => {
    const { store, path } = await scope();
    const first = runReading("first");
    await store.put("run", first);
    const movedAfterRead: RecordStore = {
      holdsCommit: (commit) => store.holdsCommit(commit),
      tip: async () => {
        const tip = await store.tip();
        await store.put("run", runReading("second"));
        return tip;
      },
      putMany: (items, hooks) => store.putMany(items, hooks),
      readBytes: (id, kind) => store.readBytes(id, kind),
      readSidecar: (id) => store.readSidecar(id),
      swapRef: (build, hooks) => store.swapRef(build, hooks),
      descends: (from, to) => store.descends(from, to),
      changesSince: (cursor, tip) => store.changesSince(cursor, tip),
    };
    const index = new IndexDb(path);
    onTestFinished(() => index.close());

    await index.fold(movedAfterRead);

    expect(rowsOf(path)[0]).toEqual([expect.objectContaining({ id: recordId(first) })]);
  });
});

describe("folds of one file by two processes", () => {
  /** Lets `other` fold the same file to the tip once this fold has read where it starts. */
  function foldedPastOnceWalked(store: Store, other: () => Promise<void>): RecordStore {
    let raced = false;
    return Object.assign(Object.create(store) as Store, {
      changesSince: async function* (cursor: string | null, tip: string) {
        if (!raced) {
          raced = true;
          await other();
        }
        yield* store.changesSince(cursor, tip);
      },
    });
  }

  test("two processes folding one cleared file both open, whichever folds further first", async () => {
    const { store, path } = await scope();
    const sealed = runReading("sealed");
    await store.put("run", sealed);
    await store.put("run", runReading("second"));
    const second = (await store.tip())!;
    const third = await store.put("run", runReading("third"));
    const tip = (await store.tip())!;
    const index = indexAt(path);
    const other = indexAt(path);
    const racing = foldedPastOnceWalked(store, () =>
      other.fold(store, undefined, undefined, withholding(recordId(sealed), tip)),
    );

    await index.fold(racing, undefined, undefined, withholding(recordId(sealed), second));

    expect([index.watermark(), index.holds(third), index.holds(recordId(sealed))]).toEqual([tip, true, false]);
  });

  test("a fold refuses to take over a file another process folded under another admission", async () => {
    const { store, path } = await scope();
    const sealed = runReading("sealed");
    await store.put("run", sealed);
    await store.put("run", runReading("second"));
    const second = (await store.tip())!;
    await store.put("run", runReading("third"));
    const tip = (await store.tip())!;
    const index = indexAt(path);
    const alike = indexAt(path);
    const looser = indexAt(path);
    let raced = 0;
    // One fold under this admission walks past it, then one under a looser one refolds the file.
    const racing: RecordStore = Object.assign(Object.create(store) as Store, {
      changesSince: async function* (cursor: string | null, until: string) {
        if (raced === 0) {
          raced = 1;
          await alike.fold(store, undefined, undefined, withholding(recordId(sealed), tip));
        }
        yield* store.changesSince(cursor, until);
      },
      descends: async (from: string, to: string) => {
        if (raced === 1) {
          raced = 2;
          await looser.fold(store, undefined, undefined, admitsEverything(tip, "everything"));
        }
        return store.descends(from, to);
      },
    });

    const taken = index.fold(racing, undefined, undefined, withholding(recordId(sealed), second));

    await expect(taken).rejects.toMatchObject({ reason: "head-moved" });
  });

  test("a fold another process empties between two batches walks again from nothing", async () => {
    const { store, path, gitDir } = await scope();
    await store.put("run", runReading("root"));
    const runs = Array.from({ length: 260 }, (_, at) => runReading(`run ${at}`));
    commitEach(gitDir, (await store.tip())!, runs);
    const tip = (await store.tip())!;
    const index = indexAt(path);
    let emptied = false;
    let seen = 0;

    await index.fold(
      store,
      ({ phase }) => {
        if (phase === "before-commit" && !emptied && ++seen === 257) {
          emptied = true;
          emptiedUnderItsStamp(path);
        }
      },
      undefined,
      admitsEverything(tip, "everything"),
    );

    expect([index.watermark(), runs.every((run) => index.holds(recordId(run)))]).toEqual([tip, true]);
  });

  test("two processes folding one author file both open, whichever folds further first", async () => {
    const { store, path } = await scope();
    await store.put("run", runReading("first"));
    const index = indexAt(path);
    const other = indexAt(path);
    let later: RecordId | undefined;
    const racing = foldedPastOnceWalked(store, async () => {
      later = await store.put("run", runReading("later"));
      await other.fold(store);
    });

    await index.fold(racing);

    expect([index.watermark(), index.holds(later!)]).toEqual([await store.tip(), true]);
  });

  test("an open with nothing to fold takes no write lock", async () => {
    const { store, path } = await scope();
    await store.put("run", runReading("first"));
    const tip = (await store.tip())!;
    const clearedPath = join(dirname(path), "cleared.sqlite");
    await indexAt(path).fold(store);
    await indexAt(clearedPath).fold(store, undefined, undefined, admitsEverything(tip, "everything"));
    for (const held of [path, clearedPath]) {
      const writer = openIndexProvider().open(held);
      writer.exec("BEGIN IMMEDIATE");
      onTestFinished(() => {
        writer.exec("ROLLBACK");
        writer.close();
      });
    }

    await indexAt(path).fold(store);
    await indexAt(clearedPath).fold(store, undefined, undefined, admitsEverything(tip, "everything"));

    expect([indexAt(path).watermark(), indexAt(clearedPath).watermark()]).toEqual([tip, tip]);
  });
});
