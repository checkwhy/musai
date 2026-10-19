import { IndexDb } from "@musai/fold";
import { installModule } from "@musai/modules";
import {
  type ClaimRecord,
  type ClaimTypeDeclaration,
  type ContributionEntry,
  CURRENT_SCHEMA_VERSIONS,
  recordId,
  type ScopeValue,
  slotFor,
  versionString,
} from "@musai/records";
import { Store } from "@musai/store";
import { blobStoreOf, type FixtureRepo, manifestWithContributions } from "@musai/test-support";

export const EXPEDITION = "fixture-expedition";
export const HOLDS = `${EXPEDITION}/holds@1`;
export const HOLDS_DECLARATION: ClaimTypeDeclaration = { type: HOLDS, identityDimensions: ["subject", "holder"] };
const HOURS = 6;

function hours(prefix: string): string[] {
  return Array.from({ length: HOURS }, (_, index) => `${prefix}-${String(index + 1).padStart(2, "0")}`);
}

/** Day 1's hours, then two routes through day 2. */
export const DAY_1 = hours("d1");
export const NORTH = hours("north-d2");
export const SOUTH = hours("south-d2");

export const DAY_ONE = "day-1";
export const NORTH_DAY_TWO = "north-day-2";
export const SOUTH_DAY_TWO = "south-day-2";

/** An edge reads "before": an earlier hour is narrower than every later one it reaches. */
function legEdges(): Record<string, string[]> {
  const edges: Record<string, string[]> = {};
  for (const route of [DAY_1, NORTH, SOUTH]) {
    route.forEach((hour, index) => {
      edges[hour] = index + 1 < route.length ? [route[index + 1]!] : [];
    });
  }
  edges[DAY_1.at(-1)!] = [NORTH[0]!, SOUTH[0]!];
  return edges;
}

/** Each day spans its route's first and last hour. */
const DAYS = {
  [DAY_ONE]: { first: DAY_1[0]!, last: DAY_1.at(-1)! },
  [NORTH_DAY_TWO]: { first: NORTH[0]!, last: NORTH.at(-1)! },
  [SOUTH_DAY_TWO]: { first: SOUTH[0]!, last: SOUTH.at(-1)! },
};

function entry(kind: ContributionEntry["kind"], id: string, input: unknown, output: unknown): ContributionEntry {
  return { kind, id: `${EXPEDITION}/${id}`, version: versionString("1"), input, output, documentation: id };
}

const AS_OF_ROW = {
  type: "object",
  additionalProperties: false,
  required: ["slot", "id", "record_json"],
  properties: { slot: { type: "string" }, id: { type: "string" }, record_json: { type: "string" } },
};

/** One type's live claims for a holder, newest first; which apply at a point is the reader's. */
export const AS_OF: ContributionEntry = entry(
  "query",
  "as-of",
  {
    type: "object",
    additionalProperties: false,
    required: ["type", "holder"],
    properties: { type: { type: "string" }, holder: { type: "string" } },
    statement:
      "SELECT claims.slot AS slot, claims.id AS id, claims.record_json AS record_json FROM claims " +
      "JOIN records ON records.id = claims.id JOIN commits ON commits.sha = records.commit_sha " +
      "WHERE claims.type = :type AND json_extract(claims.record_json, '$.conditions.holder') = :holder " +
      "AND claims.id NOT IN (SELECT predecessor FROM succession) " +
      "ORDER BY commits.seq DESC, records.position DESC",
    tables: ["claims", "records", "commits", "succession"],
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["rows"],
    properties: { rows: { type: "array", items: AS_OF_ROW } },
  },
);

/** Sorted by id, as a manifest holds them. */
const CONTRIBUTIONS: readonly ContributionEntry[] = [
  AS_OF,
  entry("dimension", "holder", { name: "holder", type: "identity", data: {} }, true),
  entry("claim-type", "holds@1", { identityDimensions: HOLDS_DECLARATION.identityDimensions }, true),
  entry("dimension", "leg", { name: "leg", type: "dag", data: { edges: legEdges(), expansions: DAYS } }, true),
];

/** Installs the fixture world's module, data only, through the module installer a pack takes. */
export async function installExpedition(repo: FixtureRepo): Promise<void> {
  const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
  const index = new IndexDb(":memory:");
  await index.fold(store);
  await installModule(
    EXPEDITION,
    versionString("1.0.0"),
    manifestWithContributions([...CONTRIBUTIONS]),
    new TextEncoder().encode(`bundle for ${EXPEDITION}`),
    recordId({ marker: `build-for-${EXPEDITION}` }),
    store,
    blobStoreOf(repo.workspace),
    index,
  );
}

/** A claim that `subject` holds for `holder` over `leg`. */
export function holds(
  subject: string,
  holder: string,
  leg: ScopeValue,
  supersedes: ClaimRecord["supersedes"] = [],
): ClaimRecord {
  const conditions = { subject, holder, leg };
  return {
    kind: "claim",
    supersedes,
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: HOLDS,
    about: [],
    slot: slotFor(HOLDS_DECLARATION, conditions),
    conditions,
    canonical: { statement: `${subject} for ${holder}` },
    rendering: `${subject} holds for ${holder} over ${JSON.stringify(leg)}.`,
    evidence: [],
    exclusiveGroup: null,
  };
}
