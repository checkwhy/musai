import { join } from "node:path";
import {
  type Audience,
  type ClaimRecord,
  type ClaimTypeDeclaration,
  type Conditions,
  CURRENT_SCHEMA_VERSIONS,
  exactDecimal,
  type RecordId,
  readStoredRecord,
  recordId,
  saltFor,
  slotFor,
} from "@musai/records";
import { type FixtureRepo, makeFixtureRepo } from "@musai/test-support";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { LOCAL_DIR } from "../src/init.js";
import { currentKey, keyMaterial, readKeyFile } from "../src/keys.js";
import { Store, type StoreOptions } from "../src/store.js";

const CLAIM_TYPE = "musai.demo/atom@1";
const CLAIM_DECLARATION: ClaimTypeDeclaration = { type: CLAIM_TYPE, identityDimensions: ["subject"] };
const CLAIM_CONDITIONS: Conditions = { subject: "mara" };

function atom(): ClaimRecord {
  return {
    kind: "claim",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: CLAIM_TYPE,
    about: [],
    slot: slotFor(CLAIM_DECLARATION, CLAIM_CONDITIONS),
    conditions: CLAIM_CONDITIONS,
    canonical: { statement: "mara is the heir" },
    rendering: "Mara is the heir.",
    evidence: [],
    exclusiveGroup: null,
  };
}

const WRITER = "writer" as Audience;
const CREW = "crew" as Audience;

function storeOptions(repo: FixtureRepo): StoreOptions {
  return { ctx: repo.ctx, scope: repo.scope, now: repo.now, claimTypes: repo.claimTypes };
}

function storeOver(repo: FixtureRepo): Store {
  return new Store(storeOptions(repo));
}

async function withRepo(name: string, fn: (repo: FixtureRepo) => Promise<void>): Promise<void> {
  const repo = await makeFixtureRepo(name, [CLAIM_DECLARATION]);
  try {
    await fn(repo);
  } finally {
    await repo.cleanup();
  }
}

async function sha256sum(bytes: Uint8Array): Promise<string> {
  const { stdout } = await execa("sha256sum", { input: Buffer.from(bytes) });
  return `sha256:${stdout.split(" ")[0]}`;
}

describe("a record put with salt asked for carries the salt the workspace key gives it", () => {
  it("mints the salt itself, so the salted atom is another record than the unsalted one", async () => {
    await withRepo("salt-mint", async (repo) => {
      const store = storeOver(repo);
      const [salted] = await store.putMany([{ kind: "claim", value: atom(), salt: true }]);
      const [unsalted] = await store.putMany([{ kind: "claim", value: atom() }]);
      expect(salted).not.toBe(unsalted);
      const record = readStoredRecord(await store.readBytes(salted!, "claim"), salted!, "claim");
      const key = currentKey(await readKeyFile(join(repo.ctx.gitDir, LOCAL_DIR)));
      expect(record).toEqual({ ...atom(), salt: saltFor(keyMaterial(key), atom()) });
    });
  });

  it("writes bytes whose sha256sum is the salted record's id", async () => {
    await withRepo("salt-sha256sum", async (repo) => {
      const store = storeOver(repo);
      const [id] = await store.putMany([{ kind: "claim", value: atom(), salt: true }]);
      expect(await sha256sum(await store.readBytes(id!, "claim"))).toBe(id);
    });
  });

  it("gives two writers in one workspace salting the same atom one id, so they still agree", async () => {
    await withRepo("salt-agreement", async (repo) => {
      const [first] = await storeOver(repo).putMany([{ kind: "claim", value: atom(), salt: true }]);
      const tip = await storeOver(repo).tip();
      const [second] = await storeOver(repo).putMany([{ kind: "claim", value: atom(), salt: true }]);
      expect(second).toBe(first);
      expect(await storeOver(repo).tip()).toBe(tip);
    });
  });

  it("leaves whoever holds the atom's text without the key unable to reproduce its id", async () => {
    await withRepo("salt-guess", async (repo) => {
      const [id] = await storeOver(repo).putMany([{ kind: "claim", value: atom(), salt: true }]);
      const guessedKey = new Uint8Array(32).fill(1);
      expect(recordId(atom())).not.toBe(id);
      expect(recordId({ ...atom(), salt: saltFor(guessedKey, atom()) })).not.toBe(id);
    });
  });

  it("gives a station's salted guess at the atom another id than the author's, one its clearance agrees on", async () => {
    await withRepo("salt-station", async (repo) => {
      const [authors] = await storeOver(repo).putMany([{ kind: "claim", value: atom(), salt: true }]);
      const station = () => new Store({ ...storeOptions(repo), clearance: WRITER });
      const [guess] = await station().putMany([{ kind: "claim", value: atom(), salt: true }]);
      const [again] = await station().putMany([{ kind: "claim", value: atom(), salt: true }]);
      const [crew] = await new Store({ ...storeOptions(repo), clearance: CREW }).putMany([
        { kind: "claim", value: atom(), salt: true },
      ]);
      expect(guess).not.toBe(authors);
      expect(again).toBe(guess);
      expect(crew).not.toBe(guess);
      expect(crew).not.toBe(authors);
      expect(await station().salted(atom())).toEqual(
        readStoredRecord(await station().readBytes(guess!, "claim"), guess!, "claim"),
      );
    });
  });

  it("refuses a draft naming its own salt, writing nothing", async () => {
    await withRepo("salt-named", async (repo) => {
      const store = storeOver(repo);
      const named = { ...atom(), salt: "5a".repeat(32) };
      const tip = await store.tip();
      await expect(store.putMany([{ kind: "claim", value: named, salt: true }])).rejects.toThrow(
        /names a salt.*only the kernel mints/,
      );
      expect(await store.tip()).toBe(tip);
    });
  });

  it("refuses to salt a kind no writer salts, writing nothing", async () => {
    await withRepo("salt-rule", async (repo) => {
      const store = storeOver(repo);
      const rule = {
        kind: "rule",
        supersedes: [],
        schemaVersion: CURRENT_SCHEMA_VERSIONS.rule,
        name: "demo-rule",
        scope: { version: { kind: "from", value: "2.0" } },
        weight: exactDecimal("1"),
        contribution: null,
      };
      const tip = await store.tip();
      await expect(store.putMany([{ kind: "rule", value: rule, salt: true }])).rejects.toThrow(
        /a rule is never salted/,
      );
      expect(await store.tip()).toBe(tip);
    });
  });

  it("keeps the salt of a record arriving whole, so a record seeded from elsewhere holds its id", async () => {
    let arriving: unknown;
    let id: RecordId | undefined;
    await withRepo("salt-source", async (repo) => {
      const store = storeOver(repo);
      const [put] = await store.putMany([{ kind: "claim", value: atom(), salt: true }]);
      id = put!;
      arriving = JSON.parse(new TextDecoder().decode(await store.readBytes(id, "claim")));
    });
    await withRepo("salt-receiver", async (repo) => {
      expect(await storeOver(repo).putMany([{ kind: "claim", value: arriving }])).toEqual([id]);
    });
  });
});
