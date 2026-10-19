import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONFORMANCE_DIR,
  classifyPath,
  conformanceFiles,
  frozenCorpus,
  idShapedStrings,
} from "../scripts/conformance.js";
import {
  canonicalBytes,
  claimTypesFrom,
  RECORD_KINDS,
  REFERENCE_TABLE,
  type RecordKind,
  rawId,
  recordId,
  referencesOf,
  validateRecord,
} from "../src/index.js";

const FIXTURE_DIR = fileURLToPath(new URL("../../trust/test/fixtures/previous-versions/records", import.meta.url));

/** Every record file under a directory at any depth, read as the fold receives it. */
function recordFilesUnder(dir: string): { path: string; value: Record<string, unknown> }[] {
  const found: { path: string; value: Record<string, unknown> }[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...recordFilesUnder(path));
    } else if (entry.endsWith(".json")) {
      found.push({ path, value: JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> });
    }
  }
  return found;
}

/** Leaves out the bundles built to carry an id at an unnamed path, which are the table's own
 * counterexamples. */
function bundleRecordFiles(): { path: string; value: Record<string, unknown> }[] {
  let rows: { name: string; codes: string[] }[];
  try {
    rows = JSON.parse(readFileSync(join(CONFORMANCE_DIR, "bundles.json"), "utf8")) as typeof rows;
  } catch {
    return [];
  }
  return rows
    .filter((row) => !row.codes.includes("ref.unlisted"))
    .flatMap((row) => recordFilesUnder(join(CONFORMANCE_DIR, "bundles", row.name, "records")));
}

const ID_A = recordId({ conformance: "a" });
const ID_B = recordId({ conformance: "b" });

/** Every field the kind lets name an id is given one, so the walk sees every reference the current
 * shape can carry. */
function maximalRecords(): Record<string, unknown>[] {
  const byKind = new Map<string, Record<string, unknown>>();
  for (const { value } of recordFilesUnder(FIXTURE_DIR)) {
    byKind.set(value["kind"] as string, value);
  }
  const edge = { run: ID_A, selector: { module: "m", parser: "p", version: "1", key: "k" }, item: ID_B };
  const fill: Record<RecordKind, (record: Record<string, unknown>) => Record<string, unknown>> = {
    claim: (record) => ({ ...record, evidence: [edge], supersedes: [ID_A] }),
    argument: (record) => ({ ...record, evidence: [edge], premises: [ID_A], supersedes: [ID_B] }),
    run: (record) => ({ ...record, supersedes: [ID_A] }),
    ruling: (record) => ({ ...record, supersedes: [ID_A] }),
    rule: (record) => ({ ...record, supersedes: [ID_A] }),
    case: (record) => ({ ...record, claims: [ID_A, ID_B], supersedes: [ID_A] }),
    artifact: (record) => ({ ...record, supersedes: [ID_A] }),
    attestation: (record) => ({ ...record, principal: `key:SHA256:${"k".repeat(43)}`, supersedes: [ID_A] }),
    module: (record) => ({ ...record, bundle: ID_A, build: ID_B, supersedes: [ID_A] }),
  };
  return RECORD_KINDS.map((kind) => {
    const current = validateRecord(byKind.get(kind), { unregisteredClaimTypes: "admit", claimTypes: new Map() });
    if (!current.ok) {
      throw new Error(`the fixture's ${kind} does not read under this kernel: ${current.error}`);
    }
    const filled = fill[kind](current.record as unknown as Record<string, unknown>);
    const checked = validateRecord(filled, { unregisteredClaimTypes: "admit", claimTypes: new Map() });
    if (!checked.ok) {
      throw new Error(`the filled ${kind} does not validate: ${checked.error}`);
    }
    return checked.record as unknown as Record<string, unknown>;
  });
}

describe("the conformance corpus", () => {
  it("is exactly what the generator writes, byte for byte", () => {
    for (const [name, bytes] of conformanceFiles()) {
      expect(readFileSync(join(CONFORMANCE_DIR, name), "utf8"), name).toBe(bytes);
    }
  });

  it("holds a record of every frozen kind the kernel mints today, unchanged, at its text and id", () => {
    const { claimType, cases } = frozenCorpus();
    expect([...new Set(cases.map((row) => row.kind))].sort()).toEqual(["attestation", "claim", "run"]);
    for (const row of cases) {
      const validated = validateRecord(row.record, {
        unregisteredClaimTypes: "refuse",
        claimTypes: claimTypesFrom([claimType]),
      });
      expect(validated.ok && validated.record, row.name).toEqual(row.record);
      expect(new TextDecoder().decode(canonicalBytes(row.record)), row.name).toBe(row.canonical);
      expect(recordId(row.record), row.name).toBe(row.id);
    }
  });

  it("gives every canonical row the kernel's id of its input", () => {
    const rows = JSON.parse(readFileSync(join(CONFORMANCE_DIR, "canonical.json"), "utf8")) as {
      input: unknown;
      id: string;
    }[];
    expect(rows.length).toBeGreaterThanOrEqual(20);
    for (const row of rows) {
      expect(row.id).toBe(recordId(row.input));
    }
  });

  it("gives every differential case the id its canonical text digests to", () => {
    const corpus = JSON.parse(readFileSync(join(CONFORMANCE_DIR, "differential.json"), "utf8")) as {
      cases: { text: string; canonical: string; id: string }[];
    };
    expect(corpus.cases.length).toBeGreaterThanOrEqual(2000);
    for (const entry of corpus.cases) {
      expect(rawId(new TextEncoder().encode(entry.canonical))).toBe(entry.id);
    }
  });
});

describe("the reference table", () => {
  it("names a kind table for every record kind and no other", () => {
    expect(Object.keys(REFERENCE_TABLE.kinds).sort()).toEqual([...RECORD_KINDS].sort());
  });

  it("places every id-shaped string of every fixture record at a path it names", () => {
    const records = [...recordFilesUnder(FIXTURE_DIR), ...bundleRecordFiles()];
    expect(records.length).toBeGreaterThanOrEqual(9);
    for (const { path, value } of records) {
      for (const { path: at } of idShapedStrings(value)) {
        expect(classifyPath(value["kind"] as RecordKind, at), `${path} ${at}`).not.toBe("unlisted");
      }
    }
  });

  it("places every id-shaped string of a record carrying every reference its kind admits at a path it names", () => {
    for (const record of maximalRecords()) {
      const kind = record["kind"] as RecordKind;
      for (const { path } of idShapedStrings(record)) {
        expect(classifyPath(kind, path), `${kind} ${path}`).not.toBe("unlisted");
      }
    }
  });

  it("lists as a reference, a non-reference or a blob every field the kernel refuses anything but an id at", () => {
    for (const record of maximalRecords()) {
      const kind = record["kind"] as RecordKind;
      for (const { path, replace } of idShapedStrings(record)) {
        const refused = !validateRecord(replace("not-an-id"), {
          unregisteredClaimTypes: "admit",
          claimTypes: new Map(),
        }).ok;
        if (refused) {
          expect(["reference", "non-reference", "blob"], `${kind} ${path}`).toContain(classifyPath(kind, path));
        }
      }
    }
  });

  it("reads an id inside free text as opaque, never as unlisted", () => {
    const brief = recordFilesUnder(FIXTURE_DIR).find(({ value }) => value["runKind"] === "brief")!.value;
    const command = idShapedStrings(brief).filter(({ path }) => path === "$.recipe.command[*]");
    expect(command).toHaveLength(1);
    expect(classifyPath("run", "$.recipe.command[*]")).toBe("opaque");
  });

  it("follows a run's read-set, the records a brief showed, by the bare digests it consumed", () => {
    expect(REFERENCE_TABLE.kinds.run.references).toContainEqual({
      path: "$.observation.reads[*].consumed.sha256",
      kinds: [],
      role: "pin",
      grammar: "digest",
    });
    expect(REFERENCE_TABLE.kinds.run.references).toContainEqual({
      path: "$.observation.reads[*].digest.sha256",
      kinds: [],
      role: "pin",
      grammar: "digest",
    });
  });

  it("follows an artifact's receipts anchors as references", () => {
    const artifact = recordFilesUnder(FIXTURE_DIR).find(({ value }) => value["kind"] === "artifact")!.value;
    const anchors = referencesOf(artifact as { kind: RecordKind }).citations.filter(({ path }) => path === "$.content");
    expect(anchors.map(({ id }) => id)).toEqual([
      "sha256:946cb831732cdcf0a2fe465c7acb49e48fdb4015c92d7efc86ea930b4385e679",
    ]);
    expect(REFERENCE_TABLE.kinds.artifact.references).toContainEqual(
      expect.objectContaining({ path: "$.content", grammar: "receipts" }),
    );
  });
});
