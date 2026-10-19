import { type ClaimRecord, type RecordId, scopeAdmits } from "@musai/records";
import { type FixtureRepo, makeFixtureRepo } from "@musai/test-support";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { invokeContribution } from "../src/contribution.js";
import { openWorkspace } from "../src/open-workspace.js";
import type { Workspace } from "../src/workspace.js";
import {
  AS_OF,
  DAY_1,
  DAY_ONE,
  EXPEDITION,
  HOLDS,
  holds,
  installExpedition,
  NORTH,
  NORTH_DAY_TWO,
  SOUTH,
} from "./fixture-expedition.js";

let repo: FixtureRepo;

beforeEach(async () => {
  repo = await makeFixtureRepo("expedition");
  await installExpedition(repo);
});

afterEach(async () => {
  await repo.cleanup();
});

async function opened(): Promise<Workspace> {
  return openWorkspace({ workspace: repo.workspace, scope: repo.scope, now: repo.now });
}

async function put(...claims: ClaimRecord[]): Promise<RecordId[]> {
  const ids: RecordId[] = [];
  for (const claim of claims) {
    ids.push(...(await (await opened()).put([{ kind: "claim", value: claim }])));
  }
  return ids;
}

/** Stands in for loom's verb: the module's query, the kernel's containment, newest per slot. */
async function asOf(holder: string, at: string): Promise<Map<string, string>> {
  const view = await opened();
  const answered = await invokeContribution(view, EXPEDITION, AS_OF, { type: HOLDS, holder });
  const rows = (answered as { output: { rows: { slot: string; id: string; record_json: string }[] } }).output.rows;
  const newest = new Map<string, string>();
  for (const row of rows) {
    const claim = JSON.parse(row.record_json) as ClaimRecord;
    const { leg } = claim.conditions;
    if (!newest.has(row.slot) && leg !== undefined && scopeAdmits({ leg }, { leg: at }, view.dimensions)) {
      newest.set(row.slot, row.id);
    }
  }
  return newest;
}

const range = (from: string, to: string) => ({ kind: "range" as const, from, to });

describe("an as-of read over a branching coordinate, by holder", () => {
  test("two claims differing only in holder fold under two slots, and each holder reads its own", async () => {
    const [ann, bo] = await put(
      holds("camp", "ann", range(DAY_1[0]!, DAY_1[5]!)),
      holds("camp", "bo", range(DAY_1[0]!, DAY_1[5]!)),
    );

    const forAnn = await asOf("ann", DAY_1[2]!);
    const forBo = await asOf("bo", DAY_1[2]!);

    expect([...forAnn.values()]).toEqual([ann]);
    expect([...forBo.values()]).toEqual([bo]);
    expect([...forAnn.keys()]).not.toEqual([...forBo.keys()]);
  });

  test("a claim over an hour span applies at an hour inside it and not at one past its end", async () => {
    const [claim] = await put(holds("camp", "ann", range(DAY_1[1]!, DAY_1[3]!)));

    expect([...(await asOf("ann", DAY_1[2]!)).values()]).toEqual([claim]);
    expect([...(await asOf("ann", DAY_1[4]!)).values()]).toEqual([]);
  });

  test("a span into one route does not apply at an hour on the other, though its name sorts inside", async () => {
    const [south] = await put(holds("camp", "ann", range(DAY_1[3]!, SOUTH[2]!)));

    expect([...(await asOf("ann", SOUTH[1]!)).values()]).toEqual([south]);
    expect(DAY_1[3]! < NORTH[0]! && NORTH[0]! < SOUTH[2]!).toBe(true);
    expect([...(await asOf("ann", NORTH[0]!)).values()]).toEqual([]);
  });

  test("of two claims applicable at one slot, the newer is read", async () => {
    const [older, newer] = await put(
      holds("camp", "ann", range(DAY_1[0]!, DAY_1[5]!)),
      holds("camp", "ann", range(DAY_1[2]!, DAY_1[5]!)),
    );

    expect([...(await asOf("ann", DAY_1[3]!)).values()]).toEqual([newer]);
    expect([...(await asOf("ann", DAY_1[1]!)).values()]).toEqual([older]);
  });

  test("a claim superseded within the span is not read", async () => {
    const [first] = await put(holds("camp", "ann", range(DAY_1[0]!, DAY_1[5]!)));
    await put(holds("camp", "ann", range(DAY_1[0]!, DAY_1[2]!), [first!]));

    expect([...(await asOf("ann", DAY_1[4]!)).values()]).toEqual([]);
  });
});

describe("days that contain their hours", () => {
  test("a claim over day 1's range applies at each of day 1's hours", async () => {
    const [claim] = await put(holds("camp", "ann", range(DAY_ONE, DAY_ONE)));

    for (const hour of DAY_1) {
      expect([...(await asOf("ann", hour)).values()]).toEqual([claim]);
    }
    expect([...(await asOf("ann", NORTH[0]!)).values()]).toEqual([]);
  });

  test("a claim from one route's day 2 applies at that route's first hour and not on the other route", async () => {
    const [north] = await put(holds("camp", "ann", { kind: "from", value: NORTH_DAY_TWO }));

    expect([...(await asOf("ann", NORTH[0]!)).values()]).toEqual([north]);
    expect([...(await asOf("ann", SOUTH[0]!)).values()]).toEqual([]);
  });

  test("asked as of a day, the read answers as at that day's last hour", async () => {
    await put(holds("camp", "ann", range(NORTH[0]!, NORTH[2]!)), holds("tent", "ann", range(NORTH[3]!, NORTH[5]!)));

    expect(await asOf("ann", NORTH_DAY_TWO)).toEqual(await asOf("ann", NORTH.at(-1)!));
    expect((await asOf("ann", NORTH_DAY_TWO)).size).toBe(1);
  });
});
