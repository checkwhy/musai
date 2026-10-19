import { IndexDb } from "@musai/fold";
import type { ClaimRecord, RunRecord } from "@musai/records";
import {
  type ClaimTypeDeclaration,
  CURRENT_SCHEMA_VERSIONS,
  canonicalBytes,
  type RecordId,
  RecordRefusedError,
  rawId,
  readStoredRecord,
  recordId,
  recordPath,
  slotFor,
  timestamp,
  versionString,
} from "@musai/records";
import { RecordNotFoundError, Store } from "@musai/store";
import { commitAroundTheStore, type FixtureRepo, makeFixtureRepo, writeFixtureRecords } from "@musai/test-support";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { RUNNER_PERFORMER } from "../src/performer.js";

const CLAIM_TYPE = "musai.demo/claim@1";
const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: CLAIM_TYPE, identityDimensions: ["id"] };
const FIXED_INSTANT = timestamp("2026-01-01T00:00:00.000Z");

const RECEIPT: RunRecord = {
  kind: "run",
  supersedes: [],
  schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
  runKind: "run",
  determinism: "nondeterministic",
  performer: RUNNER_PERFORMER,
  recipe: {
    command: ["true"],
    workingDirectory: "/",
    environment: {},
    declared: [],
    substrates: [],
    isolation: "hygiene",
  },
  observation: {
    resolved: [],
    isolationHeld: "hygiene",
    binaries: [],
    bindings: [],
    output: "ok",
    outputLossy: false,
    exitCode: 0,
    scrubbed: [],
    startedAt: FIXED_INSTANT,
    finishedAt: FIXED_INSTANT,
    reads: [],
    cost: {},
  },
};

/** A ruling carrying an authority field, which only the attestation signing it may carry. */
function floorTierRuling(claim: RecordId): Record<string, unknown> {
  return {
    kind: "ruling",
    schemaVersion: CURRENT_SCHEMA_VERSIONS.ruling,
    claim,
    authority: "floor",
    verdict: "fails",
    reason: "a tier only the trust branch's configuration can produce",
    brief: recordId({ example: "a brief this ruling cites" }),
  };
}

describe("readStoredRecord admits exactly what the store would have written", () => {
  test("bytes the store wrote read back as the record they encode", () => {
    const bytes = canonicalBytes(RECEIPT);
    const id = rawId(bytes);
    expect(readStoredRecord(bytes, id, "run")).toEqual(RECEIPT);
  });

  test("bytes that do not digest to the id naming them are refused, naming both digests", () => {
    const bytes = canonicalBytes(RECEIPT);
    const claimedId = recordId({ ...RECEIPT, observation: { ...RECEIPT.observation, output: "something else" } });
    let caught: unknown;
    try {
      readStoredRecord(bytes, claimedId, "run");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RecordRefusedError);
    expect((caught as RecordRefusedError).because).toContain(rawId(bytes));
    expect((caught as RecordRefusedError).id).toBe(claimedId);
  });

  test("bytes that are not a JSON document are refused", () => {
    const bytes = new TextEncoder().encode("not a record");
    expect(() => readStoredRecord(bytes, rawId(bytes), "run")).toThrow(RecordRefusedError);
    expect(() => readStoredRecord(bytes, rawId(bytes), "run")).toThrow("not a JSON document");
  });

  test("a refusal for bytes that are not a JSON document repeats nothing the bytes hold", () => {
    const bytes = new TextEncoder().encode('{"canary-4f81c2": undefined-value}');
    const invalidUtf8 = Uint8Array.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]);
    for (const held of [bytes, invalidUtf8]) {
      let caught: unknown;
      try {
        readStoredRecord(held, rawId(held), "run");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RecordRefusedError);
      expect((caught as RecordRefusedError).because).toBe("its bytes are not a JSON document");
    }
  });

  test("a record the kind's contract rejects is refused with the contract's own reason", () => {
    const bytes = canonicalBytes(floorTierRuling(recordId(RECEIPT)));
    expect(() => readStoredRecord(bytes, rawId(bytes), "ruling")).toThrow(
      "ruling.authority no longer belongs on a ruling record: it moved to the attestation that signs it",
    );
  });

  test("a record stored under another kind's directory is refused", () => {
    const bytes = canonicalBytes(RECEIPT);
    expect(() => readStoredRecord(bytes, rawId(bytes), "ruling")).toThrow(
      "it is a run record stored under records/ruling",
    );
  });

  test("canonical bytes carrying a field outside the contract are refused, since their validated form is a different record", () => {
    const bytes = canonicalBytes({ ...RECEIPT, smuggled: true });
    expect(() => readStoredRecord(bytes, rawId(bytes), "run")).toThrow(
      "the bytes carried something the run contract does not allow",
    );
  });

  test("a v2 run's read-set reads at the current version with its id as key", () => {
    const read = rawId(new TextEncoder().encode("a record a brief showed"));
    const hex = read.slice("sha256:".length);
    const bytes = canonicalBytes({
      ...RECEIPT,
      schemaVersion: 2,
      runKind: "brief",
      observation: { ...RECEIPT.observation, reads: [{ digest: { sha256: hex } }] },
    });

    const record = readStoredRecord(bytes, rawId(bytes), "run") as RunRecord;

    expect(record.schemaVersion).toBe(CURRENT_SCHEMA_VERSIONS.run);
    expect(record.observation.reads).toEqual([{ key: read, consumed: { sha256: hex } }]);
  });

  test("bytes at a previous version carrying a field outside the contract are read with the field dropped, never refused", () => {
    const OLDER_VERSION = 1;
    const {
      supersedes: _supersedes,
      performer: _performer,
      determinism: _determinism,
      observation,
      ...rest
    } = RECEIPT as unknown as Record<string, unknown>;
    const { cost: _cost, ...olderObservation } = observation as Record<string, unknown>;
    const bytes = canonicalBytes({
      ...rest,
      schemaVersion: OLDER_VERSION,
      observation: olderObservation,
      smuggled: true,
    });
    const id = rawId(bytes);
    const record = readStoredRecord(bytes, id, "run");
    expect(record).toEqual({ ...RECEIPT, performer: { kind: "runner", version: "unrecorded" } });
    expect(record).not.toHaveProperty("smuggled");
    expect(recordId(record)).not.toBe(id);
  });

  test.each([
    ["a lone surrogate in its recipe", '"command":["true"]', '"command":["\\ud800"]'],
    ["a number past a double's range", '"exitCode":0', '"exitCode":1e999'],
  ])("bytes holding %s are refused at any version, in the reader's words", (_, from, to) => {
    const { supersedes: _supersedes, performer: _performer, determinism: _determinism, ...older } = RECEIPT;
    for (const record of [RECEIPT, { ...older, schemaVersion: 1 }]) {
      const text = new TextDecoder().decode(canonicalBytes(record)).replace(from, to);
      expect(text).toContain(to);
      const bytes = new TextEncoder().encode(text);

      const refused = (() => {
        try {
          readStoredRecord(bytes, rawId(bytes), "run");
        } catch (error) {
          return error;
        }
        return expect.unreachable("a record with no canonical form was read");
      })();

      expect(refused).toBeInstanceOf(RecordRefusedError);
      expect((refused as RecordRefusedError).because).toBe("it holds a value with no RFC 8785 canonical form");
    }
  });

  test("a claim naming a type this process has not registered is admitted on read, while the write path still refuses it", async () => {
    const claim: ClaimRecord = {
      kind: "claim",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
      type: "musai.elsewhere@1",
      about: [],
      slot: "a slot the pack that is not loaded here computed",
      conditions: { id: "elsewhere" },
      canonical: { statement: "elsewhere holds" },
      rendering: "elsewhere holds.",
      evidence: [],
      exclusiveGroup: null,
    };
    const bytes = canonicalBytes(claim);
    expect(readStoredRecord(bytes, rawId(bytes), "claim")).toEqual(claim);

    const repo = await makeFixtureRepo("unregistered-type");
    try {
      const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now, claimTypes: repo.claimTypes });
      await expect(store.put("claim", claim)).rejects.toThrow("claim names an unregistered type: musai.elsewhere@1");
    } finally {
      await repo.cleanup();
    }
  });

  test("bytes that are the record in a non-canonical spelling are refused, since sha256sum on them would not reproduce the id", () => {
    const bytes = new TextEncoder().encode(JSON.stringify(RECEIPT, null, 2));
    expect(() => readStoredRecord(bytes, rawId(bytes), "run")).toThrow("its validated form digests to");
  });
});

describe("what git holds under records/ is read through the write path's contract", () => {
  let repo: FixtureRepo;

  beforeEach(async () => {
    repo = await makeFixtureRepo("stored-record", [CLAIM_DECLARATION]);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  function claimOver(runId: RecordId): ClaimRecord {
    return {
      kind: "claim",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
      type: CLAIM_TYPE,
      about: [],
      slot: slotFor(CLAIM_DECLARATION, { id: "guarded" }),
      conditions: { id: "guarded" },
      canonical: { statement: "guarded holds" },
      rendering: "guarded holds.",
      evidence: [
        {
          run: runId,
          selector: { module: "musai.core", parser: "exit-code", version: versionString("1"), key: "result" },
          item: recordId({ runId, key: "result" }),
        },
      ],
      exclusiveGroup: null,
    };
  }

  test("the store refuses to read bytes committed under an id they do not digest to", async () => {
    const [runId] = await writeFixtureRecords(repo, [{ kind: "run", value: RECEIPT }]);
    const tampered = canonicalBytes({
      ...RECEIPT,
      observation: { ...RECEIPT.observation, output: "rewritten after the fact" },
    });
    await commitAroundTheStore(repo, recordPath("run", runId!), tampered);

    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now, claimTypes: repo.claimTypes });
    await expect(store.read(runId!, "run")).rejects.toThrow(RecordRefusedError);
    await expect(store.read(runId!, "run")).rejects.toThrow(`its bytes digest to ${rawId(tampered)}`);
  });

  test("a ruling committed around the store at the floor's own tier is left out of the index and listed as refused, while the records beside it index", async () => {
    const [runId] = await writeFixtureRecords(repo, [{ kind: "run", value: RECEIPT }]);
    const claim = claimOver(runId!);
    const [claimId] = await writeFixtureRecords(repo, [{ kind: "claim", value: claim }]);

    const bytes = canonicalBytes(floorTierRuling(claimId!));
    const id = rawId(bytes);
    const path = recordPath("ruling", id);
    const commit = await commitAroundTheStore(repo, path, bytes);

    const index = new IndexDb();
    await index.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));

    expect(index.claimAtSlot(claim.slot)?.id).toBe(claimId);
    expect(index.rulingsFor(claim.slot, new Map())).toEqual([]);
    expect(index.refusals()).toEqual([
      {
        id,
        commit,
        path,
        reason: "ruling.authority no longer belongs on a ruling record: it moved to the attestation that signs it",
      },
    ]);
  });

  test("a path under records/ that names no record is listed as refused without stopping the fold", async () => {
    const [runId] = await writeFixtureRecords(repo, [{ kind: "run", value: RECEIPT }]);
    const path = "records/ruling/not-a-record";
    const commit = await commitAroundTheStore(repo, path, new TextEncoder().encode("{}"));
    await writeFixtureRecords(repo, [{ kind: "claim", value: claimOver(runId!) }]);

    const index = new IndexDb();
    await index.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));

    expect(index.claimAtSlot(slotFor(CLAIM_DECLARATION, { id: "guarded" }))).toBeDefined();
    expect(index.refusals()).toEqual([{ id: null, commit, path, reason: `not a record path: ${path}` }]);
  });

  test("a refusal stays listed across a second fold and survives an index rebuilt from scratch", async () => {
    const [runId] = await writeFixtureRecords(repo, [{ kind: "run", value: RECEIPT }]);
    const [claimId] = await writeFixtureRecords(repo, [{ kind: "claim", value: claimOver(runId!) }]);
    const bytes = canonicalBytes(floorTierRuling(claimId!));
    await commitAroundTheStore(repo, recordPath("ruling", rawId(bytes)), bytes);

    const index = new IndexDb();
    await index.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
    await index.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
    expect(index.refusals()).toHaveLength(1);

    index.rebuild();
    expect(index.refusals()).toEqual([]);
    await index.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));
    expect(index.refusals()).toHaveLength(1);
  });
});

describe("a record the scope does not hold", () => {
  test("is a miss naming the id, whether the scope is empty or merely does not carry it", async () => {
    const repo = await makeFixtureRepo("absent-record");
    try {
      const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now, claimTypes: repo.claimTypes });
      const absent = recordId({ example: "a record nobody minted" });

      const empty = await store.read(absent, "run").catch((error: unknown) => error);
      expect(empty).toBeInstanceOf(RecordNotFoundError);
      expect((empty as RecordNotFoundError).id).toBe(absent);
      expect((empty as Error).message).toContain("holds no records yet");
      await expect(store.readBytes(absent, "run")).rejects.toBeInstanceOf(RecordNotFoundError);

      await store.putMany([{ kind: "run", value: RECEIPT }]);

      const populated = await store.read(absent, "run").catch((error: unknown) => error);
      expect(populated).toBeInstanceOf(RecordNotFoundError);
      expect((populated as Error).message).not.toContain("holds no records yet");
      await expect(store.readBytes(absent, "run")).rejects.toBeInstanceOf(RecordNotFoundError);
    } finally {
      await repo.cleanup();
    }
  });
});
