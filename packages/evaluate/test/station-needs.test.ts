import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { IndexDb } from "@musai/fold";
import type { Need } from "@musai/modules";
import { type Audience, type RecordId, type RunRecipe, timestamp } from "@musai/records";
import { StationRefusedError } from "@musai/run";
import { Store } from "@musai/store";
import { type FixtureRepo, fixtureRunRecord, makeFixtureRepo } from "@musai/test-support";
import { afterEach, describe, expect, test, vi } from "vitest";
import { satisfyNeeds } from "../src/evaluator/restart.js";

const OCI_IMAGE_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";

const IMAGELESS: RunRecipe = {
  command: ["node", "-e", ""],
  workingDirectory: "/",
  environment: {},
  declared: [],
  substrates: [],
  isolation: "hygiene",
};

const DECLARING_AN_IMAGE: RunRecipe = {
  ...IMAGELESS,
  substrates: [
    {
      uri: "registry.example/declared",
      digest: { sha256: "a".repeat(64) },
      mediaType: OCI_IMAGE_MEDIA_TYPE,
    },
  ],
  isolation: "container",
};

const SIBLING_FETCH: Need = { kind: "fetch", recipe: { locator: "https://example.test/data", headers: [], names: [] } };

const MINTED = `sha256:${"0".repeat(64)}` as RecordId;

describe("a station's needs asked in one call", () => {
  const repos: FixtureRepo[] = [];
  const directories: string[] = [];
  const path = process.env["PATH"];

  afterEach(async () => {
    process.env["PATH"] = path;
    for (const repo of repos.splice(0)) {
      await repo.cleanup();
    }
    for (const directory of directories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  /** A PATH holding a `docker` that answers `info` always, only the first time, or never. */
  async function engineOnPath(answering: boolean | "once"): Promise<void> {
    const bin = await mkdtemp(join(tmpdir(), "musai-station-engine-"));
    directories.push(bin);
    if (answering !== false) {
      const script =
        answering === true
          ? "exit 0"
          : `count="${join(bin, "calls")}"; n=0; [ -f "$count" ] && read -r n < "$count"; echo $((n + 1)) > "$count"; [ "$n" -lt 1 ]`;
      await writeFile(join(bin, "docker"), `#!/bin/sh\n${script}\n`);
      await chmod(join(bin, "docker"), 0o755);
    }
    process.env["PATH"] = bin;
  }

  /** Asks `needs` beside a fetch that would mint, and says what was minted before the answer. */
  async function askedBesideAFetch(
    needs: readonly Need[],
    options: {
      readonly engine?: boolean | "once";
      readonly stationRefusalsAnswer?: boolean;
      readonly concurrency?: number;
      readonly fetchLast?: boolean;
      readonly inProject?: boolean;
    } = {},
  ): Promise<{ answer: Promise<unknown>; minted: () => number; performed: RunRecipe[] }> {
    const { engine, stationRefusalsAnswer = false, concurrency, fetchLast = false, inProject = false } = options;
    const repo = await makeFixtureRepo("station-needs");
    repos.push(repo);
    if (engine !== undefined) {
      await engineOnPath(engine);
    }
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const placed = (need: Need): Need =>
      inProject && need.kind === "run"
        ? { kind: "run", recipe: { ...need.recipe, workingDirectory: dirname(repo.ctx.gitDir) } }
        : need;
    const performed: RunRecipe[] = [];
    let fetches = 0;
    const answer = satisfyNeeds({
      needs: [...(fetchLast ? [] : [SIBLING_FETCH]), ...needs.map(placed), ...(fetchLast ? [SIBLING_FETCH] : [])],
      index: new IndexDb(),
      store,
      evaluationOutcomes: new Map(),
      ageLimitMs: Number.POSITIVE_INFINITY,
      now: repo.now,
      station: { clearance: "writer" as Audience, image: undefined, musaiDir: repo.ctx.gitDir },
      stationRefusalsAnswer,
      concurrency,
      performFetchNeed: async () => {
        fetches += 1;
        return MINTED;
      },
      ...(stationRefusalsAnswer
        ? {
            performRun: async (recipe) => {
              performed.push(recipe);
              return MINTED;
            },
          }
        : {}),
    });
    return { answer, minted: () => fetches + performed.length, performed };
  }

  test("are refused together before a sibling mints when one declares no image and the station names none", async () => {
    const { answer, minted } = await askedBesideAFetch([
      { kind: "run", recipe: DECLARING_AN_IMAGE },
      { kind: "run", recipe: IMAGELESS },
    ]);

    await expect(answer).rejects.toThrow(StationRefusedError);
    expect(minted()).toBe(0);
  });

  test.each([
    ["outside the project", () => "/"],
    ["inside the workspace's own directory", (musaiDir: string) => musaiDir],
  ])("are refused before a sibling mints when one's working directory is %s", async (_, directory) => {
    const repo = await makeFixtureRepo("station-needs-mount");
    repos.push(repo);
    await engineOnPath(true);
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    let fetches = 0;

    const asked = satisfyNeeds({
      needs: [
        SIBLING_FETCH,
        { kind: "run", recipe: { ...DECLARING_AN_IMAGE, workingDirectory: directory(repo.ctx.gitDir) } },
      ],
      index: new IndexDb(),
      store,
      evaluationOutcomes: new Map(),
      ageLimitMs: Number.POSITIVE_INFINITY,
      now: repo.now,
      station: { clearance: "writer" as Audience, image: undefined, musaiDir: repo.ctx.gitDir },
      performFetchNeed: async () => {
        fetches += 1;
        return MINTED;
      },
    });

    await expect(asked).rejects.toThrow(StationRefusedError);
    expect(fetches).toBe(0);
  });

  test("are refused before a sibling mints when no engine answers", async () => {
    const { answer, minted } = await askedBesideAFetch([{ kind: "run", recipe: DECLARING_AN_IMAGE }], {
      engine: false,
    });

    await expect(answer).rejects.toThrow(StationRefusedError);
    expect(minted()).toBe(0);
  });

  test("answer the refused one and perform the rest where a refusal answers its need", async () => {
    const { answer, minted, performed } = await askedBesideAFetch(
      [
        { kind: "run", recipe: DECLARING_AN_IMAGE },
        { kind: "run", recipe: IMAGELESS },
      ],
      { stationRefusalsAnswer: true },
    );

    const outcomes = (await answer) as ReadonlyMap<string, { kind: string }>;

    expect([...outcomes.values()].map((outcome) => outcome.kind)).toEqual(["satisfied", "satisfied", "refused"]);
    expect(performed).toEqual([DECLARING_AN_IMAGE]);
    expect(minted()).toBe(2);
  });

  test("keep a receipt's reuse as the preflight decided it, though the receipt has aged by the time it is used", async () => {
    const repo = await makeFixtureRepo("station-needs-aged");
    repos.push(repo);
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const startedAt = Date.parse("2026-10-09T00:00:00.000Z");
    const held = fixtureRunRecord("an earlier run");
    const [receipt] = await store.putMany([
      {
        kind: "run",
        value: {
          ...held,
          recipe: DECLARING_AN_IMAGE,
          observation: {
            ...held.observation,
            resolved: DECLARING_AN_IMAGE.substrates,
            isolationHeld: "container",
            startedAt: timestamp(new Date(startedAt).toISOString()),
          },
        },
      },
    ]);
    const index = new IndexDb();
    await index.fold(store);
    await engineOnPath(false);
    let reads = 0;
    let fetches = 0;
    const clock = () => timestamp(new Date(startedAt + (reads++ === 0 ? 500 : 3_600_000)).toISOString());

    const outcomes = await satisfyNeeds({
      needs: [SIBLING_FETCH, { kind: "run", recipe: DECLARING_AN_IMAGE }],
      index,
      store,
      evaluationOutcomes: new Map(),
      ageLimitMs: 1000,
      now: clock,
      station: { clearance: "writer" as Audience, image: undefined, musaiDir: repo.ctx.gitDir },
      performFetchNeed: async () => {
        fetches += 1;
        return MINTED;
      },
    });

    expect([...outcomes.values()]).toEqual([
      { kind: "satisfied", recordId: MINTED },
      { kind: "satisfied", recordId: receipt },
    ]);
    expect(fetches).toBe(1);
  });

  test("end the call before any need starts when a reuse check fails for another reason than a refusal", async () => {
    const repo = await makeFixtureRepo("station-needs-reuse-fails");
    repos.push(repo);
    await engineOnPath(false);
    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const index = new IndexDb();
    vi.spyOn(index, "receiptsByRecipe").mockImplementationOnce(() => {
      throw new Error("the index is locked");
    });
    let fetches = 0;

    const asked = satisfyNeeds({
      needs: [SIBLING_FETCH, { kind: "run", recipe: DECLARING_AN_IMAGE }],
      index,
      store,
      evaluationOutcomes: new Map(),
      ageLimitMs: Number.POSITIVE_INFINITY,
      now: repo.now,
      station: { clearance: "writer" as Audience, image: undefined, musaiDir: repo.ctx.gitDir },
      performFetchNeed: async () => {
        fetches += 1;
        return MINTED;
      },
    });

    await expect(asked).rejects.toThrow("the index is locked");
    expect(fetches).toBe(0);
  });

  test("start no need once a refusal is held, under bounded concurrency", async () => {
    const { answer, minted } = await askedBesideAFetch([{ kind: "run", recipe: DECLARING_AN_IMAGE }], {
      engine: "once",
      concurrency: 1,
      fetchLast: true,
      inProject: true,
    });

    await expect(answer).rejects.toThrow(StationRefusedError);
    expect(minted()).toBe(0);
  });
});
