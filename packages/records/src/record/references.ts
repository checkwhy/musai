import { isRecordId, type RecordId } from "../canonical/canonicalize.js";
import { parseReceiptsSection } from "./anchors.js";
import type { RecordKind } from "./kinds.js";

/** `grammar` names text the ids are read from: `receipts`, a trailing receipts section; `digest`, a
 * bare hex digest. */
export interface Reference {
  readonly path: string;
  readonly kinds: readonly RecordKind[];
  readonly role: "citation" | "pin";
  readonly grammar?: "receipts" | "digest";
}

export interface Annotated {
  readonly path: string;
  readonly why: string;
}

export interface BlobReference {
  readonly path: string;
  readonly when?: { readonly path: string; readonly equals: string };
}

export interface KindTable {
  readonly references: readonly Reference[];
  readonly nonReferences: readonly Annotated[];
  readonly opaque: readonly Annotated[];
  readonly blobs: readonly BlobReference[];
  /** Subtrees whose every string and key is a statement, held in Unicode NFC. */
  readonly statements: readonly Annotated[];
}

const TEXT = "text a person or a model wrote";

/** Every schema version's paths stay listed, since a verifier reads stored bytes and never
 * normalises. */
export const REFERENCE_TABLE: {
  readonly idPattern: string;
  readonly kinds: { readonly [K in RecordKind]: KindTable };
} = {
  idPattern: "^sha256:[0-9a-f]{64}$",
  kinds: {
    claim: {
      references: [
        { path: "$.evidence[*].run", kinds: ["run"], role: "citation" },
        { path: "$.supersedes[*]", kinds: ["claim"], role: "citation" },
      ],
      nonReferences: [
        { path: "$.slot", why: "the digest that makes two records one claim, never a record" },
        { path: "$.evidence[*].item", why: "the content id of what a parser selected from a run's observation" },
      ],
      opaque: [
        { path: "$.about", why: "what the claim concerns, in the pack's own naming" },
        { path: "$.canonical", why: "the pack's own canonical form of the claim" },
        { path: "$.conditions", why: "the pack's own dimensions and scopes" },
        { path: "$.rendering", why: TEXT },
        { path: "$.evidence[*].selector", why: "a parser's own name and key" },
      ],
      blobs: [],
      statements: [
        { path: "$.about", why: "what the claim concerns, which joins it to a case" },
        { path: "$.canonical", why: "the claim's canonical form, which a second claim must spell alike" },
        { path: "$.conditions", why: "dimension names and values, which decide the slot" },
        { path: "$.rendering", why: "the sentence the claim states" },
      ],
    },
    argument: {
      references: [
        { path: "$.target", kinds: ["claim", "run", "argument"], role: "citation" },
        { path: "$.evidence[*].run", kinds: ["run"], role: "citation" },
        { path: "$.premises[*]", kinds: ["claim"], role: "citation" },
        { path: "$.supersedes[*]", kinds: ["argument"], role: "citation" },
      ],
      nonReferences: [
        { path: "$.evidence[*].item", why: "the content id of what a parser selected from a run's observation" },
      ],
      opaque: [
        { path: "$.reason", why: TEXT },
        { path: "$.evidence[*].selector", why: "a parser's own name and key" },
      ],
      blobs: [],
      statements: [],
    },
    run: {
      references: [
        { path: "$.supersedes[*]", kinds: ["run"], role: "citation" },
        { path: "$.observation.reads[*].consumed.sha256", kinds: [], role: "pin", grammar: "digest" },
        { path: "$.observation.reads[*].digest.sha256", kinds: [], role: "pin", grammar: "digest" },
      ],
      nonReferences: [],
      opaque: [
        {
          path: "$.recipe",
          why: "what the performer ran, in its own arguments, environment and substrates; a substrate's digest may name a record, a file or an image, and is printed by a recipe rather than resolved",
        },
        { path: "$.observation", why: "what the performer saw: its output, binaries and bindings" },
        { path: "$.performer", why: "who performed the run, in their own naming" },
      ],
      blobs: [
        {
          path: "$.observation.output",
          when: { path: "$.observation.resolved[*].annotations.storage", equals: "blob" },
        },
      ],
      statements: [{ path: "$.performer.principal", why: "who performed a foreign run" }],
    },
    ruling: {
      references: [
        { path: "$.claim", kinds: ["claim"], role: "citation" },
        { path: "$.over.claim", kinds: ["claim"], role: "citation" },
        { path: "$.brief", kinds: ["run"], role: "citation" },
        { path: "$.supersedes[*]", kinds: ["ruling"], role: "citation" },
      ],
      nonReferences: [],
      opaque: [
        { path: "$.reason", why: TEXT },
        { path: "$.over.scope", why: "the dimensions a policy ruling covers" },
      ],
      blobs: [],
      statements: [{ path: "$.over.scope", why: "dimension names and values a policy covers" }],
    },
    rule: {
      references: [{ path: "$.supersedes[*]", kinds: ["rule"], role: "citation" }],
      nonReferences: [],
      opaque: [{ path: "$.scope", why: "the dimensions the rule applies under" }],
      blobs: [],
      statements: [{ path: "$.scope", why: "dimension names and values the rule applies under" }],
    },
    case: {
      references: [
        { path: "$.claims[*]", kinds: ["claim"], role: "citation" },
        { path: "$.preset.moduleRecord", kinds: ["module"], role: "pin" },
        { path: "$.supersedes[*]", kinds: ["case"], role: "citation" },
      ],
      nonReferences: [],
      opaque: [{ path: "$.overrides", why: "slot assignments carried verbatim" }],
      blobs: [],
      statements: [{ path: "$.slug", why: "the name a case is booked and found under" }],
    },
    artifact: {
      references: [
        { path: "$.case", kinds: ["case"], role: "citation" },
        { path: "$.content", kinds: [], role: "citation", grammar: "receipts" },
        { path: "$.supersedes[*]", kinds: ["artifact"], role: "citation" },
      ],
      nonReferences: [],
      opaque: [{ path: "$.content", why: TEXT }],
      blobs: [],
      statements: [],
    },
    attestation: {
      references: [
        { path: "$.subject", kinds: [], role: "citation" },
        { path: "$.supersedes[*]", kinds: ["attestation"], role: "citation" },
      ],
      nonReferences: [],
      opaque: [],
      blobs: [],
      statements: [
        { path: "$.principal", why: "who speaks for the subject" },
        { path: "$.audience", why: "who a release or a seal names" },
      ],
    },
    module: {
      references: [
        { path: "$.build", kinds: ["run"], role: "citation" },
        { path: "$.supersedes[*]", kinds: ["module"], role: "citation" },
      ],
      nonReferences: [],
      opaque: [{ path: "$.manifest", why: "the module's own contributions and schemas" }],
      blobs: [{ path: "$.bundle" }],
      statements: [],
    },
  },
};

/** A record id a stored record names, with the table path it was read at. */
export interface ReferenceTarget {
  readonly path: string;
  readonly id: RecordId;
  readonly kinds: readonly RecordKind[];
}

/** A citation's absence breaks the record; a pin may be held by a distribution in place of a scope.
 * */
export interface RecordReferences {
  readonly citations: readonly ReferenceTarget[];
  readonly pins: readonly ReferenceTarget[];
  readonly blobs: readonly RecordId[];
}

/** `.name` steps into an object and `[*]` into every entry of an array. */
function valuesAt(value: unknown, path: string): unknown[] {
  let reached: unknown[] = [value];
  for (const step of path.slice(1).match(/\.[^.[]+|\[\*\]/g) ?? []) {
    reached = reached.flatMap((current) => {
      if (step === "[*]") {
        return Array.isArray(current) ? current : [];
      }
      if (current === null || typeof current !== "object" || Array.isArray(current)) {
        return [];
      }
      const key = step.slice(1);
      return Object.hasOwn(current, key) ? [(current as Record<string, unknown>)[key]] : [];
    });
  }
  return reached;
}

/** The record ids a reference's value stands for, read through its grammar. */
function idsIn(reference: Reference, value: unknown): RecordId[] {
  if (typeof value !== "string") {
    return [];
  }
  switch (reference.grammar) {
    case "receipts":
      return [...parseReceiptsSection(value).values()];
    case "digest": {
      const id = `sha256:${value}`;
      return isRecordId(id) ? [id] : [];
    }
    default:
      return isRecordId(value) ? [value] : [];
  }
}

/** A value at a listed path that is not an id is passed over: whether it is well formed is the kind
 * contract's question. */
export function referencesOf(record: {
  readonly kind: RecordKind;
  readonly [field: string]: unknown;
}): RecordReferences {
  const table = REFERENCE_TABLE.kinds[record.kind];
  const citations: ReferenceTarget[] = [];
  const pins: ReferenceTarget[] = [];
  for (const reference of table.references) {
    for (const value of valuesAt(record, reference.path)) {
      for (const id of idsIn(reference, value)) {
        (reference.role === "citation" ? citations : pins).push({ path: reference.path, id, kinds: reference.kinds });
      }
    }
  }
  const blobs: RecordId[] = [];
  for (const blob of table.blobs) {
    if (blob.when !== undefined && !valuesAt(record, blob.when.path).includes(blob.when.equals)) {
      continue;
    }
    for (const value of valuesAt(record, blob.path)) {
      if (typeof value === "string" && isRecordId(value)) {
        blobs.push(value);
      }
    }
  }
  return { citations, pins, blobs };
}

function uncomposed(value: unknown): boolean {
  if (typeof value === "string") {
    return value.normalize("NFC") !== value;
  }
  if (Array.isArray(value)) {
    return value.some(uncomposed);
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([key, entry]) => key.normalize("NFC") !== key || uncomposed(entry));
  }
  return false;
}

/** The first statement path holding a string or key outside NFC, or `null`. */
export function uncomposedStatement(record: {
  readonly kind: RecordKind;
  readonly [field: string]: unknown;
}): string | null {
  const found = REFERENCE_TABLE.kinds[record.kind].statements.find((entry) =>
    valuesAt(record, entry.path).some(uncomposed),
  );
  return found?.path ?? null;
}
