import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { IndexDb } from "@musai/fold";
import type { RunRecord } from "@musai/records";
import {
  CURRENT_SCHEMA_VERSIONS,
  idFromPath,
  kindFromPath,
  type RecordId,
  readStoredRecord,
  recordId,
  recordPath,
} from "@musai/records";
import { Store } from "@musai/store";
import { commitAroundTheStore, type FixtureRepo, makeFixtureRepo } from "@musai/test-support";
import { afterEach, describe, expect, test } from "vitest";
import { verifyAttestation } from "../src/verify.js";

/** Nine records written by an earlier kernel, read as git hands them to a fold. Never regenerate
 * them to make this suite pass. */
const TREE = fileURLToPath(new URL("./fixtures/previous-versions/", import.meta.url));
/** The same attestation's stored bytes signed under this kernel's namespace. */
const SIGNED = fileURLToPath(new URL("./fixtures/signature/", import.meta.url));

const CLAIM = "sha256:921e892da524cdff8699d6025fc8fd4c3b735fec451ab5c2b0c7e90fee7d3f68" as RecordId;
const BRIEF_RUN = "sha256:946cb831732cdcf0a2fe465c7acb49e48fdb4015c92d7efc86ea930b4385e679" as RecordId;
const RULING = "sha256:4c006fc58e70d4e7df0d10469cd874f7897a6920edeaf35140949b954c5f539f" as RecordId;
const ATTESTATION = "sha256:42eb14cc43763a1d89f80dd81def025b9bda99a2e7b4d0b128d06569ba365b28" as RecordId;
const ARTIFACT = "sha256:810671302cf14df600c391400eee4e9a09ec8b28e79879b00efc6a8aa4517085" as RecordId;
const RULE = "sha256:052cb330723067db76271a8d69f83e6cee0ca211676249d7a3b7cfe86229bee4" as RecordId;
const ARGUMENT = "sha256:90ca79676a1bb8d8a3b0826df3bd8ae9de7768a02dd715f6d9317ec40b863c17" as RecordId;
const SLOT = "sha256:a36ae0e2c47ca4d55d26b48ebece9ad17991daac11252be004973cbf6b0c198d";

interface StoredFile {
  readonly path: string;
  readonly id: RecordId;
  readonly bytes: Uint8Array;
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walk(full)));
    } else if (entry.name.endsWith(".json")) {
      found.push(full);
    }
  }
  return found.sort();
}

async function storedFiles(): Promise<StoredFile[]> {
  const paths = await walk(join(TREE, "records"));
  return Promise.all(
    paths.map(async (full) => {
      const path = relative(TREE, full).split(/[\\/]/).join("/");
      return { path, id: idFromPath(path), bytes: new Uint8Array(await readFile(full)) };
    }),
  );
}

let repos: FixtureRepo[] = [];

afterEach(async () => {
  await Promise.all(repos.map((repo) => repo.cleanup()));
  repos = [];
});

describe("records minted at previous schema versions", () => {
  test("each reads back normalised into the shape this kernel writes, under the id its bytes digest to", async () => {
    const files = await storedFiles();
    expect(files).toHaveLength(9);
    for (const file of files) {
      const kind = kindFromPath(file.path);
      const record = readStoredRecord(file.bytes, file.id, kind);
      expect(record.kind).toBe(kind);
      expect(record.schemaVersion).toBe(CURRENT_SCHEMA_VERSIONS[kind]);
      // A record written before succession existed replaced nothing.
      expect(record.supersedes).toEqual([]);
    }
  });

  test("a rule minted before a scope was a per-dimension map reads back with that map intact", async () => {
    const path = recordPath("rule", RULE);
    const bytes = new Uint8Array(await readFile(join(TREE, path)));
    const record = readStoredRecord(bytes, RULE, "rule");
    if (record.kind !== "rule") {
      throw new Error("the rule fixture is not a rule");
    }
    expect(record.scope).toEqual({ platform: "linux" });
    expect(record.weight).toBe("1");
    expect(record.contribution).toBeNull();
  });

  test("a claim minted before conditions could hold a scope reads back with its strings as points", async () => {
    const path = recordPath("claim", CLAIM);
    const bytes = new Uint8Array(await readFile(join(TREE, path)));
    const record = readStoredRecord(bytes, CLAIM, "claim");
    if (record.kind !== "claim") {
      throw new Error("the claim fixture is not a claim");
    }
    for (const value of Object.values(record.conditions)) {
      expect(typeof value).toBe("string");
    }
    expect(record.slot).toBe(SLOT);
  });

  test("a ruling minted before an extent existed reads back as a ruling over the one claim it named", async () => {
    const path = recordPath("ruling", RULING);
    const bytes = new Uint8Array(await readFile(join(TREE, path)));
    const record = readStoredRecord(bytes, RULING, "ruling");
    if (record.kind !== "ruling") {
      throw new Error("the ruling fixture is not a ruling");
    }
    expect(record.over).toEqual({ claim: CLAIM });
    expect(record.verdict).toBe("holds");
    expect(record).not.toHaveProperty("claim");
  });

  test("an argument minted before premises existed reads back resting on nothing but its own evidence", async () => {
    const path = recordPath("argument", ARGUMENT);
    const bytes = new Uint8Array(await readFile(join(TREE, path)));
    const record = readStoredRecord(bytes, ARGUMENT, "argument");
    if (record.kind !== "argument") {
      throw new Error("the argument fixture is not an argument");
    }
    expect(record.premises).toEqual([]);
    expect(record.target).toBe(CLAIM);
  });

  test("a receipt minted before a performer was recorded reads back naming the runner, with the version it ran unrecorded", async () => {
    const path = recordPath("run", BRIEF_RUN);
    const bytes = new Uint8Array(await readFile(join(TREE, path)));
    const record = readStoredRecord(bytes, BRIEF_RUN, "run");
    if (record.kind !== "run") {
      throw new Error("the run fixture is not a run");
    }
    expect(record.performer).toEqual({ kind: "runner", version: "unrecorded" });
    // A brief is computed, so it reads as deterministic whatever its version left unwritten.
    expect(record.determinism).toBe("deterministic");
    expect(record.observation.cost).toEqual({});
    // The normaliser never infers the unwritten performer from the recipe's kernel version.
    expect(record.recipe.substrates.some((substrate) => substrate.name === "kernel-version")).toBe(true);
  });

  test("a signature made over stored bytes still verifies once the kernel's schema versions have moved", async () => {
    const path = recordPath("attestation", ATTESTATION);
    const bytes = new Uint8Array(await readFile(join(TREE, path)));
    const signature = await readFile(`${join(SIGNED, path)}.sig`, "utf8");
    const record = readStoredRecord(bytes, ATTESTATION, "attestation");
    if (record.kind !== "attestation") {
      throw new Error("the attestation fixture is not an attestation");
    }

    const result = await verifyAttestation({
      attestation: { id: ATTESTATION, record },
      signedBytes: bytes,
      signature,
      allowedSignersPath: join(SIGNED, "allowed-signers"),
    });

    expect(result.good).toBe(true);
    expect(result.principal).toBe("florin");
  });

  test("a scope folded from them answers every query this kernel asks of a scope", async () => {
    const repo = await makeFixtureRepo("default");
    repos.push(repo);
    for (const file of await storedFiles()) {
      await commitAroundTheStore(repo, file.path, file.bytes);
    }

    const index = new IndexDb();
    await index.fold(new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now }));

    expect(index.refusals()).toEqual([]);
    expect(index.claimAtSlot(SLOT)?.id).toBe(CLAIM);
    expect(index.rulingsFor(SLOT, new Map()).map((ruling) => ruling.id)).toEqual([RULING]);
    expect(index.anchorsOf(ARTIFACT)).toEqual([{ label: "946cb831732c", fullId: BRIEF_RUN }]);
    expect(index.contributionsOf("parser").map((found) => found.entry.id)).toEqual([
      "lineup.previous-versions/exit-code",
    ]);
    expect(index.evidenceEdgesOf(SLOT)).toEqual([]);

    const store = new Store({ ctx: repo.ctx, scope: repo.scope, now: repo.now });
    const brief = (await store.read(BRIEF_RUN, "run")) as RunRecord;
    expect(brief.runKind).toBe("brief");
    expect(index.receiptByRecipe(recordId(brief.recipe))?.recordId).toBe(BRIEF_RUN);
  });
});
