import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ClaimTypeDeclaration,
  CURRENT_SCHEMA_VERSIONS,
  canonicalBytes,
  EVALUATOR_VERSION,
  isRecordId,
  RECORD_KINDS,
  REFERENCE_TABLE,
  type RecordKind,
  recordId,
  slotFor,
} from "../src/index.js";

export const CONFORMANCE_DIR = fileURLToPath(new URL("../../../conformance", import.meta.url));

const VECTORS_PATH = fileURLToPath(new URL("../src/canonical/vectors.json", import.meta.url));

/** A concrete path with every array index written as `[*]`, the form the table's paths take. */
function normalise(path: string): string {
  return path.replace(/\[\d+\]/g, "[*]");
}

function isUnder(path: string, subtree: string): boolean {
  return path === subtree || path.startsWith(`${subtree}.`) || path.startsWith(`${subtree}[`);
}

/** What the table says a normalised path of a kind holds. */
export function classifyPath(
  kind: RecordKind,
  path: string,
): "reference" | "non-reference" | "blob" | "opaque" | "unlisted" {
  const table = REFERENCE_TABLE.kinds[kind];
  const at = normalise(path);
  if (table.references.some((reference) => reference.path === at && reference.grammar === undefined)) {
    return "reference";
  }
  if (table.nonReferences.some((entry) => entry.path === at)) {
    return "non-reference";
  }
  if (table.blobs.some((entry) => entry.path === at)) {
    return "blob";
  }
  if (table.opaque.some((entry) => isUnder(at, entry.path))) {
    return "opaque";
  }
  return "unlisted";
}

/**
 * Every string in a record that is a record id in its entirety, with its
 * normalised path and a copy of the record with that one string replaced.
 */
export function idShapedStrings(
  record: unknown,
): { path: string; replace: (value: string) => Record<string, unknown> }[] {
  const found: { path: string; replace: (value: string) => Record<string, unknown> }[] = [];
  function walk(value: unknown, path: string, rebuild: (next: unknown) => unknown): void {
    if (typeof value === "string") {
      if (isRecordId(value)) {
        found.push({ path: normalise(path), replace: (next) => rebuild(next) as Record<string, unknown> });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        walk(entry, `${path}[${index}]`, (next) => rebuild(value.map((item, at) => (at === index ? next : item))));
      });
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        walk(entry, `${path}.${key}`, (next) => rebuild({ ...(value as Record<string, unknown>), [key]: next }));
      }
    }
  }
  walk(record, "$", (next) => next);
  return found;
}

interface Vector {
  readonly name: string;
  readonly input: unknown;
}

/** The kernel's canonical vectors, each with its canonical text and id. */
export function canonicalCorpus(): { name: string; input: unknown; canonical: string; id: string }[] {
  const vectors = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as Vector[];
  return vectors.map((vector) => ({
    name: vector.name,
    input: vector.input,
    canonical: new TextDecoder().decode(canonicalBytes(vector.input)),
    id: recordId(vector.input),
  }));
}

/** A 32-bit generator with a fixed seed, so the corpus is the same on every machine. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AWKWARD_NUMBERS = [
  0,
  -0,
  1,
  -1,
  0.1,
  0.2,
  0.30000000000000004,
  1e21,
  1e-7,
  1e-6,
  123456789012345680000,
  5e-324,
  -5e-324,
  1.7976931348623157e308,
  2 ** 53,
  2 ** 53 - 1,
  -(2 ** 53),
  2 ** 53 + 2,
  4.35,
  0.000001,
  333333333.3333333,
  1e-323,
  9.999999999999999e22,
  1e23,
];

/** Characters chosen for how differently escaping, encoding and UTF-16 ordering treat them. */
const AWKWARD_CHARACTERS = [
  "a",
  "Z",
  "0",
  " ",
  '"',
  "\\",
  "/",
  "\b",
  "\f",
  "\n",
  "\r",
  "\t",
  "\u0000",
  "\u0001",
  "\u001f",
  "\u007f",
  "\u0080",
  "é",
  "ß",
  "ÿ",
  "Ā",
  " ",
  " ",
  "﻿",
  "￿",
  "ﬀ",
  "中",
  "😀",
  "𝄞",
  "\u{10ffff}",
  "\u{1f600}",
  "€",
];

function randomNumber(next: () => number): number {
  const pick = next();
  if (pick < 0.3) {
    return AWKWARD_NUMBERS[Math.floor(next() * AWKWARD_NUMBERS.length)]!;
  }
  if (pick < 0.55) {
    return Math.floor((next() - 0.5) * 2 ** Math.floor(next() * 60));
  }
  const mantissa = (next() - 0.5) * 2;
  const exponent = Math.floor(next() * 630) - 320;
  const value = scaled(mantissa, exponent);
  return Number.isFinite(value) ? value : mantissa;
}

/** One correctly rounded parse: `**` is not correctly rounded on every platform, so the corpus
 * would differ by machine. A mantissa printed with its own exponent folds it in. */
function scaled(mantissa: number, exponent: number): number {
  const [digits, own = "0"] = String(mantissa).split("e");
  return Number(`${digits}e${Number(own) + exponent}`);
}

function randomString(next: () => number): string {
  const length = Math.floor(next() * 8);
  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += AWKWARD_CHARACTERS[Math.floor(next() * AWKWARD_CHARACTERS.length)]!;
  }
  return text;
}

function randomValue(next: () => number, depth: number): unknown {
  const pick = next();
  if (depth > 3 || pick < 0.35) {
    const leaf = next();
    if (leaf < 0.4) {
      return randomNumber(next);
    }
    if (leaf < 0.8) {
      return randomString(next);
    }
    return leaf < 0.87 ? true : leaf < 0.93 ? false : null;
  }
  if (pick < 0.6) {
    return Array.from({ length: Math.floor(next() * 5) }, () => randomValue(next, depth + 1));
  }
  const object: Record<string, unknown> = {};
  const size = Math.floor(next() * 6);
  for (let index = 0; index < size; index += 1) {
    object[randomString(next)] = randomValue(next, depth + 1);
  }
  return object;
}

/** A spelling of a number other than the canonical one that parses to the same double. */
function spellNumber(value: number, next: () => number): string {
  const pick = next();
  if (Object.is(value, -0)) {
    return pick < 0.5 ? "-0" : "-0.0e0";
  }
  if (pick < 0.3) {
    return String(value);
  }
  if (pick < 0.6) {
    return value.toPrecision(17);
  }
  if (pick < 0.85) {
    return value.toExponential(16).replace("e+", pick < 0.7 ? "E+" : "e");
  }
  return Number.isInteger(value) && Math.abs(value) < 1e21 ? `${value}.000` : String(value);
}

function spellString(text: string, next: () => number): string {
  let spelled = '"';
  for (const character of text) {
    if (character === '"' || character === "\\") {
      spelled += `\\${character}`;
    } else if (character.charCodeAt(0) < 0x20 || next() < 0.2) {
      const upper = next() < 0.5;
      for (let index = 0; index < character.length; index += 1) {
        const hex = character.charCodeAt(index).toString(16).padStart(4, "0");
        spelled += `\\u${upper ? hex.toUpperCase() : hex}`;
      }
    } else if (character === "/" && next() < 0.5) {
      spelled += "\\/";
    } else {
      spelled += character;
    }
  }
  return `${spelled}"`;
}

/** Surrogate pairs are escaped as pairs or written whole, never split, since both sides refuse a
 * lone surrogate. */
function spell(value: unknown, next: () => number): string {
  const gap = next() < 0.3 ? " " : "";
  if (typeof value === "number") {
    return spellNumber(value, next);
  }
  if (typeof value === "string") {
    return spellString(value, next);
  }
  if (Array.isArray(value)) {
    return `[${gap}${value.map((entry) => spell(entry, next)).join(`,${gap}`)}${gap}]`;
  }
  if (value !== null && typeof value === "object") {
    const members = Object.entries(value).map(
      ([key, entry]) => `${spellString(key, next)}${gap}:${gap}${spell(entry, next)}`,
    );
    return `{${gap}${members.join(`,${gap}`)}${gap}}`;
  }
  return JSON.stringify(value);
}

export const DIFFERENTIAL_SEED = 20260929;
export const DIFFERENTIAL_COUNT = 3000;

/** Texts come from the value, never parsed back: V8's JSON.parse, warmed on a key `"\\"`, misreads
 * a later `"\u001f"`. */
export function differentialCorpus(
  seed: number,
  count: number,
): { seed: number; count: number; cases: { text: string; canonical: string; id: string }[] } {
  const next = mulberry32(seed);
  const cases = Array.from({ length: count }, () => {
    const value = randomValue(next, 0);
    const text = spell(value, next);
    return { text, canonical: new TextDecoder().decode(canonicalBytes(value)), id: recordId(value) };
  });
  return { seed, count, cases };
}

/** The claim type the frozen claims are minted as, which a reader of the vectors registers. */
export const FROZEN_CLAIM_TYPE: ClaimTypeDeclaration = {
  type: "conformance.frozen/claim@1",
  identityDimensions: ["subject"],
};

const AT = "2026-01-01T00:00:00.000Z";
const KEY = "key:SHA256:Wvg1P7BiLh3uNN2N0Ujsg8lHAAxsPBdB0kxKgQlTuuE";

function frozenRecords(): { name: string; record: Record<string, unknown> }[] {
  const conditions = { subject: "the parser", platform: "linux" };
  const claim = {
    kind: "claim",
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: FROZEN_CLAIM_TYPE.type,
    about: ["urn:example:parser"],
    slot: slotFor(FROZEN_CLAIM_TYPE, conditions),
    conditions,
    canonical: { statement: "the parser accepts every caf\u00e9 it is given" },
    rendering: "The parser accepts every caf\u00e9 it is given.",
    evidence: [],
    exclusiveGroup: null,
    supersedes: [],
  };
  const run = {
    kind: "run",
    schemaVersion: CURRENT_SCHEMA_VERSIONS.run,
    runKind: "run",
    determinism: "nondeterministic",
    performer: { kind: "runner", version: EVALUATOR_VERSION },
    recipe: {
      command: ["node", "--test"],
      workingDirectory: "/work",
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
      output: "ok\n",
      outputLossy: false,
      exitCode: 0,
      scrubbed: [],
      startedAt: AT,
      finishedAt: AT,
      reads: [],
      cost: {},
    },
    supersedes: [],
  };
  const attestation = {
    kind: "attestation",
    schemaVersion: CURRENT_SCHEMA_VERSIONS.attestation,
    subject: recordId(claim),
    principal: KEY,
    principalClass: "person",
    via: "tty",
    purpose: "made",
    at: AT,
    supersedes: [],
  };
  return [
    { name: "claim", record: claim },
    { name: "claim-salted", record: { ...claim, salt: "5e".repeat(32) } },
    { name: "run", record: run },
    {
      name: "run-measured",
      record: {
        ...run,
        observation: {
          ...run.observation,
          cost: { cpuMs: "1200", tokens: "3", money: { amount: "0.25", currency: "EUR" } },
        },
      },
    },
    { name: "attestation-by-key", record: attestation },
    {
      name: "attestation-by-pseudonym",
      record: {
        ...attestation,
        principal: `pseudonym:workspace-key:${"0f".repeat(32)}`,
        supersedes: [recordId(attestation)],
      },
    },
  ];
}

/** One record of each kind whose bytes are frozen, at its current version, with its text and id. */
export function frozenCorpus(): {
  claimType: ClaimTypeDeclaration;
  cases: { name: string; kind: string; record: Record<string, unknown>; canonical: string; id: string }[];
} {
  const cases = frozenRecords().map(({ name, record }) => ({
    name,
    kind: String(record["kind"]),
    record,
    canonical: new TextDecoder().decode(canonicalBytes(record)),
    id: recordId(record),
  }));
  return { claimType: FROZEN_CLAIM_TYPE, cases };
}

/** Every file of the corpus by its name under conformance/, with the exact text written there. */
export function conformanceFiles(): Map<string, string> {
  const asFile = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
  return new Map([
    ["canonical.json", asFile(canonicalCorpus())],
    ["differential.json", asFile(differentialCorpus(DIFFERENTIAL_SEED, DIFFERENTIAL_COUNT))],
    ["references.json", asFile(REFERENCE_TABLE)],
    ["frozen.json", asFile(frozenCorpus())],
  ]);
}

/** Writes the corpus under a directory, creating it where absent. */
export function writeConformance(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of conformanceFiles()) {
    writeFileSync(join(dir, name), text);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeConformance(CONFORMANCE_DIR);
  process.stdout.write(`wrote ${RECORD_KINDS.length} kind tables and the corpus to ${CONFORMANCE_DIR}\n`);
}
