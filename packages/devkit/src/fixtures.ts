import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { RuleInput } from "@musai/modules";
import type { PerformedRunRecord, RunRecord } from "@musai/records";
import {
  canonicalBytes,
  isPlainObject,
  KernelError,
  performedRun,
  type RecordId,
  readArrivingRecord,
  recordId,
  recordPath,
  validateRecord,
} from "@musai/records";

/** Derived from where its input file sits: a contribution id with a slash nests as directories. */
export interface FixtureCase {
  readonly contributionId: string;
  readonly name: string;
  readonly path: string;
}

/** `contribution` is the kind exercised, `rule` when absent; a kind other than a rule runs once. */
export interface FixtureInput {
  readonly version: string;
  readonly input: RuleInput | unknown;
  readonly contribution?: string;
}

/** Records beside a module in the store's layout, read by the store's reader so a receipt the
 * store would refuse fails here. */
export interface FixtureStore {
  readonly dir: string;
  readonly cases: readonly FixtureCase[];
  input(fixtureCase: FixtureCase): Promise<FixtureInput>;
  storedReceiptForRecipe(recipeId: RecordId): StoredReceipt | undefined;
}

/** A receipt as its file holds it, with the id those bytes digest to. */
export interface StoredReceipt {
  readonly id: RecordId;
  readonly bytes: Uint8Array;
  readonly record: PerformedRunRecord;
}

const receiptsByStore = new WeakMap<FixtureStore, Map<string, StoredReceipt>>();

async function walkJsonFiles(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const files: string[] = [];
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkJsonFiles(entryPath)));
    } else if (entry.name.endsWith(".json")) {
      files.push(entryPath);
    }
  }
  return files;
}

function caseFromPath(fixturesDir: string, filePath: string): FixtureCase {
  const relativePath = relative(fixturesDir, filePath);
  const segments = relativePath.split(sep);
  const name = segments[segments.length - 1]!.replace(/\.json$/, "");
  const contributionId = segments.slice(0, -1).join("/");
  return { contributionId, name, path: filePath };
}

function compareCases(a: FixtureCase, b: FixtureCase): number {
  if (a.contributionId !== b.contributionId) {
    return a.contributionId < b.contributionId ? -1 : 1;
  }
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

async function collectRunReceipts(runDir: string): Promise<Map<string, StoredReceipt>> {
  const receipts = new Map<string, StoredReceipt>();
  const files = await walkJsonFiles(runDir);
  for (const filePath of files) {
    const bytes = await readFile(filePath);
    const match = /([0-9a-f]{64})\.json$/.exec(filePath);
    if (match === null) {
      throw new KernelError({
        reason: "invalid-input",
        detail: `refusing to read a fixture receipt at ${filePath}: its name is not a record digest`,
        about: [filePath],
      });
    }
    const id: RecordId = `sha256:${match[1]}`;
    const stored = new Uint8Array(bytes);
    const record = performedRun(id, readArrivingRecord(stored, id, "run") as RunRecord);
    receipts.set(recordId(record.recipe), { id, bytes: stored, record });
  }
  return receipts;
}

/** A file under `fixtures/` may be a record committed as evidence rather than a case to drive. */
function looksLikeFixtureInput(value: unknown): value is FixtureInput {
  if (!isPlainObject(value)) {
    return false;
  }
  return typeof value["version"] === "string" && "input" in value;
}

const RECEIPTS_DIR = "records";
const GOLDENS_DIR = "goldens";

/** The directories beside a module's source that recording writes its receipts and goldens into. */
export function fixtureRecordDirs(store: FixtureStore): string[] {
  return [join(store.dir, RECEIPTS_DIR), join(store.dir, GOLDENS_DIR)];
}

/** Reads a module's fixture cases, by contribution id then name, and its recorded run receipts. */
export async function readFixtureStore(dir: string): Promise<FixtureStore> {
  const fixturesDir = join(dir, "fixtures");
  const caseFiles = await walkJsonFiles(fixturesDir);
  const caseCandidates = caseFiles.map((filePath) => caseFromPath(fixturesDir, filePath));
  const shapeChecks = await Promise.all(
    caseCandidates.map(async (fixtureCase) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(fixtureCase.path, "utf8"));
      } catch {
        return false;
      }
      return looksLikeFixtureInput(parsed);
    }),
  );
  const cases = caseCandidates.filter((_, index) => shapeChecks[index] === true).sort(compareCases);
  const receipts = await collectRunReceipts(join(dir, RECEIPTS_DIR, "run"));

  const store: FixtureStore = {
    dir,
    cases,
    async input(fixtureCase) {
      const text = await readFile(fixtureCase.path, "utf8");
      return JSON.parse(text) as FixtureInput;
    },
    storedReceiptForRecipe(recipeId) {
      return receiptsByStore.get(store)?.get(recipeId);
    },
  };
  receiptsByStore.set(store, receipts);
  return store;
}

/** Writes a receipt as the store would, then reads it back so none unreadable stays on disk. */
export async function writeFixtureReceipt(store: FixtureStore, record: PerformedRunRecord): Promise<StoredReceipt> {
  const validation = validateRecord(record);
  if (!validation.ok) {
    throw new KernelError({
      reason: "invalid-input",
      detail: `refusing to write a fixture receipt: ${validation.error}`,
    });
  }
  const validated = validation.record as PerformedRunRecord;
  const bytes = canonicalBytes(validated);
  const id = recordId(validated);
  const path = join(store.dir, recordPath("run", id));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  readArrivingRecord(bytes, id, "run");

  let receipts = receiptsByStore.get(store);
  if (receipts === undefined) {
    receipts = new Map();
    receiptsByStore.set(store, receipts);
  }
  const stored: StoredReceipt = { id, bytes, record: validated };
  receipts.set(recordId(validated.recipe), stored);
  return stored;
}

/** One round of a fixture's invocation, so a golden's replay answers the rounds a real run did. */
export interface GoldenRound {
  readonly output: unknown;
  readonly reads: readonly string[];
}

/** `response` and `reads` are what a mismatch compares; `rounds` is what a replay answers from. */
export interface Golden {
  readonly response: unknown;
  readonly reads: readonly string[];
  readonly rounds: readonly GoldenRound[];
}

function goldenPath(store: FixtureStore, fixtureCase: FixtureCase): string {
  return join(store.dir, GOLDENS_DIR, fixtureCase.contributionId, `${fixtureCase.name}.json`);
}

export async function readGolden(store: FixtureStore, fixtureCase: FixtureCase): Promise<Golden | undefined> {
  try {
    const text = await readFile(goldenPath(store, fixtureCase), "utf8");
    return JSON.parse(text) as Golden;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** Pretty-printed so a person reviewing a diff reads it directly. */
export async function writeGolden(store: FixtureStore, fixtureCase: FixtureCase, golden: Golden): Promise<void> {
  const path = goldenPath(store, fixtureCase);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(golden, null, 2)}\n`);
}
