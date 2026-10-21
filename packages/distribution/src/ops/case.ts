import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Workspace } from "@musai/api-core";
import {
  definedOperation,
  installedModules,
  invokeContribution,
  type JsonSchema,
  MINTED_ARRAY_SCHEMA,
  type OperationDescriptor,
  OperationError,
  type OperationHandler,
  openWorkspace,
  SALT_INPUT_SCHEMA,
  saltAsked,
  validateAgainstSchema,
  type WriteResult,
} from "@musai/api-core";
import {
  type CaseRecord,
  type ClaimRecord,
  type ClaimTypeDeclaration,
  type ClaimTypes,
  CURRENT_SCHEMA_VERSIONS,
  EVALUATOR_VERSION,
  type KindClaim,
  type KindOutput,
  type PresetReference,
  type RecordId,
  recordId,
  slotFor,
  TRIPLE_CLAIM_TYPE,
  TRIPLE_DECLARATION,
  versionString,
} from "@musai/records";
import { LOCAL_DIR, listKeys } from "@musai/store";
import { citedClaims, type FoundCase, findCase, findCaseRecord } from "../cases.js";
import { labelledClaim } from "../claim.js";
import { checkSpelling } from "../claim-ref.js";
import { optionValue } from "../gate/menu.js";

export interface CaseSoundcheckInput {
  readonly case: string;
}

export interface CaseSoundcheckOutput {
  readonly claims: ReadonlyArray<{
    readonly slot: string;
    readonly label: "holds" | "fails" | "open";
    readonly reason: string | null;
  }>;
}

function renderCaseSoundcheckText(output: CaseSoundcheckOutput): string {
  if (output.claims.length === 0) {
    return "this case cites no claim";
  }
  return output.claims
    .map((claim) => `${claim.slot}: ${claim.label}${claim.reason !== null ? ` (${claim.reason})` : ""}`)
    .join("\n");
}

/** `case.soundcheck@1`: the status of every claim a case cites. */
export const caseSoundcheck: OperationDescriptor<CaseSoundcheckInput, CaseSoundcheckOutput> = {
  id: "case.soundcheck",
  version: versionString("1"),
  input: {
    type: "object",
    additionalProperties: false,
    required: ["case"],
    properties: {
      case: { type: "string" },
    },
  },
  output: {
    type: "object",
    additionalProperties: false,
    required: ["claims"],
    properties: {
      claims: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["slot", "label", "reason"],
          properties: {
            slot: { type: "string" },
            label: { enum: ["holds", "fails", "open"] },
            reason: { type: ["string", "null"] },
          },
        },
      },
    },
  },
  effect: "performs",
  authority: null,
  plans: true,
  reasons: ["declaration-conflict", "invalid-input", "no-such-record", "sibling-conflict"],
  documentation: "Prints the status of every claim a case cites.",
  statements: ["case"],
  cli: {
    verb: "soundcheck",
    positional: ["case"],
    flags: [],
    describe: "print the status of every claim a case cites",
  },
  renderText: renderCaseSoundcheckText,
  exitCode: () => 0,
  async handler(input, context) {
    const opened = await openWorkspace(context);
    const caseRecord = await findCase(opened, input.case);
    const claims: CaseSoundcheckOutput["claims"][number][] = [];
    for (const { record } of citedClaims(opened, caseRecord)) {
      const claim = record as ClaimRecord;
      const { status } = await labelledClaim(opened, claim.slot, context.mode === "plan" ? "recorded" : "perform");
      claims.push({
        slot: claim.slot,
        label: status.label,
        reason: status.label === "open" ? status.reason : null,
      });
    }
    return { claims };
  },
};

export interface CaseBookInput {
  readonly slug: string;
  readonly kind?: string;
  readonly about?: readonly string[];
  readonly preset?: string;
  readonly overrides?: Readonly<Record<string, unknown>>;
  readonly salt?: boolean;
}

export interface CaseBookOutput extends WriteResult {
  readonly case: RecordId;
}

function renderCaseBookText(output: CaseBookOutput): string {
  return output.case;
}

/** Splits on the first slash, so a contribution id carrying a slash still round-trips. */
function parsePresetReference(value: string): { readonly module: string; readonly contribution: string } {
  const slash = value.indexOf("/");
  if (slash === -1) {
    throw new OperationError({
      reason: "no-such-record",
      about: [value],
      detail: `a preset reference must be spelled <module>/<contribution>, got ${value}`,
    });
  }
  return { module: value.slice(0, slash), contribution: value.slice(slash + 1) };
}

/** The preset a booking naming none pins; it assigns no slot. */
const DEFAULT_PRESET = "musai.core/bare";

/** The preset reference a booking pins, its module record the one this workspace installed. Only
 * the module is checked, not that it contributes the preset. */
async function resolvePreset(opened: Workspace, requested: string | undefined): Promise<PresetReference> {
  const contribution = requested ?? DEFAULT_PRESET;
  const { module } = parsePresetReference(contribution);
  const installed = await installedModules(opened);
  const entry = installed.byName.get(module);
  if (entry === undefined) {
    throw new OperationError({
      reason: "no-such-record",
      about: [module],
      detail: `no module named ${module} is installed`,
    });
  }
  return { module, contribution, moduleRecord: entry.moduleRecordId };
}

/** A base triple claim that `uri` concerns the case being booked. */
function tripleClaim(uri: string, slug: string): ClaimRecord {
  const conditions = { subject: uri, predicate: "concerns", object: slug };
  return {
    kind: "claim",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: TRIPLE_CLAIM_TYPE,
    about: [uri],
    slot: slotFor(TRIPLE_DECLARATION, conditions),
    conditions,
    canonical: conditions,
    rendering: `${uri} concerns ${slug}`,
    evidence: [],
    exclusiveGroup: null,
  };
}

interface Booking {
  readonly slug: string;
  readonly kind: string | null;
  readonly about: readonly string[];
  readonly overrides: Readonly<Record<string, unknown>>;
}

/** The claims a kind names for this booking. The kind answers with data; the kernel computes each
 * slot, and a claim arrives resting on nothing. */
async function setlistFor(opened: Workspace, kindId: string, booking: Booking): Promise<ClaimRecord[]> {
  const contribution = opened.index.contributionById(kindId);
  if (contribution === undefined) {
    const kinds = opened.index
      .contributionsOf("kind")
      .map((row) => row.entry.id)
      .sort();
    throw new OperationError({
      reason: "no-such-record",
      about: [kindId],
      detail: `no installed module contributes ${kindId}; the kinds installed here: ${kinds.join(", ") || "none"}`,
    });
  }
  if (contribution.entry.kind !== "kind") {
    const judged =
      contribution.entry.kind === "rule" ? `; a claim is judged by it through ${checkSpelling(kindId)}` : "";
    throw new OperationError({
      reason: "invalid-input",
      about: [kindId],
      detail: `refusing to book against ${kindId}: it is a ${contribution.entry.kind} contribution, not a kind${judged}`,
    });
  }
  const response = await invokeContribution(opened, contribution.moduleName, contribution.entry, {
    slug: booking.slug,
    about: [...booking.about],
    overrides: { ...booking.overrides },
  });
  if (!response.ok) {
    throw new OperationError({
      reason: "invalid-input",
      about: [kindId],
      detail: `${kindId} refused to open a setlist for ${booking.slug}: ${response.error.message}`,
    });
  }

  const setlist = response.output as KindOutput;
  return setlist.claims.map((claim) => claimFromSetlist(claim, kindId, opened.claimTypes));
}

/** The declaration a claim's type carries, with the claim checked against it. Every drafter admits
 * claims through this, so a claim of a type means one thing whoever drafted it. */
export function admittedClaimType(
  claim: Pick<KindClaim, "type" | "conditions" | "canonical">,
  drafter: string,
  claimTypes: ClaimTypes,
): ClaimTypeDeclaration {
  const declaration = claimTypes.get(claim.type);
  if (declaration === undefined) {
    // With no declaration nothing is known of the type's identity, so there is no slot to compute.
    throw new OperationError({
      reason: "invalid-input",
      about: [claim.type],
      detail: `claim type has no declared identity dimensions: ${claim.type}`,
    });
  }
  const missing = declaration.identityDimensions.filter((dimension) => claim.conditions[dimension] === undefined);
  if (missing.length > 0) {
    // A slot computed over missing dimensions would merge claims meant to be different.
    throw new OperationError({
      reason: "invalid-input",
      about: [drafter],
      detail: `${drafter} names a ${claim.type} claim whose conditions omit its identity: ${missing.join(", ")}`,
    });
  }
  if (declaration.canonical !== undefined) {
    const payload = validateAgainstSchema(declaration.canonical as JsonSchema, claim.canonical);
    if (!payload.ok) {
      throw new OperationError({
        reason: "invalid-input",
        about: [claim.type],
        detail: `${drafter} names a ${claim.type} claim whose canonical payload does not satisfy the schema that type declares: ${payload.errors}`,
      });
    }
  }
  return declaration;
}

/** A claim a plan writes, under the id the store writes it at. */
export interface PlannedClaim {
  readonly id: RecordId;
  readonly record: ClaimRecord;
}

/** Refuses a claim naming an exclusive group unless its plan opens that group whole. A slot whose
 * contributors name different groups is unreadable for good, since nothing retires a claim. */
export function admitExclusiveGroup(
  claim: PlannedClaim,
  siblings: readonly PlannedClaim[],
  drafter: string,
  opened: Workspace,
): void {
  const group = claim.record.exclusiveGroup;
  if (group === null || opened.index.recordById(claim.id) !== undefined) {
    return;
  }
  const refusal = (detail: string): OperationError =>
    new OperationError({
      reason: "invalid-input",
      about: [claim.id, group],
      detail: `${drafter} names ${claim.id} in the exclusive group ${group}, ${detail}`,
    });

  const members = opened.index.claimsInGroup(group);
  if (members.length > 0) {
    throw refusal(
      `which already has members in the store (${members.map((member) => member.id).join(", ")}), and a group is closed by the commit that opens it`,
    );
  }
  const held = opened.index.contributorsAtSlot(claim.record.slot);
  if (held.length > 0) {
    throw refusal(
      `at a slot ${held.map((contributor) => contributor.id).join(", ")} already contributes to, and a group governs the slot it lands at`,
    );
  }
  const others = siblings.filter((sibling) => sibling.id !== claim.id);
  const rival = others.find(
    (sibling) => sibling.record.slot === claim.record.slot && sibling.record.exclusiveGroup !== group,
  );
  if (rival !== undefined) {
    const named = rival.record.exclusiveGroup === null ? "no group" : `the group ${rival.record.exclusiveGroup}`;
    throw refusal(
      `at the slot where ${rival.id} of the same plan lands under ${named}, and one slot's contributors name one group`,
    );
  }
  const value = optionValue(claim.id, claim.record);
  const twin = others.find(
    (sibling) =>
      sibling.record.exclusiveGroup === group &&
      sibling.record.slot !== claim.record.slot &&
      optionValue(sibling.id, sibling.record) === value,
  );
  if (twin !== undefined) {
    throw refusal(
      `and ${twin.id} of the same plan offers the same menu option ${value} at another slot, so its menu would be refused whole`,
    );
  }
}

function claimFromSetlist(claim: KindClaim, kindId: string, claimTypes: ClaimTypes): ClaimRecord {
  const declaration = admittedClaimType(claim, kindId, claimTypes);
  return {
    kind: "claim",
    supersedes: [],
    schemaVersion: CURRENT_SCHEMA_VERSIONS.claim,
    type: claim.type,
    about: [...(claim.about ?? [])],
    slot: slotFor(declaration, claim.conditions),
    conditions: { ...claim.conditions },
    canonical: claim.canonical,
    rendering: claim.rendering,
    evidence: [],
    exclusiveGroup: claim.exclusiveGroup ?? null,
  };
}

/** Refuses a drafted case unless it is the case `case.book` would mint for the same booking, so a
 * case a pack writes rests on the claims its kind derives. */
export async function admitDraftedCase(
  id: RecordId,
  drafted: CaseRecord,
  about: readonly string[],
  known: (claimId: RecordId) => boolean,
  opened: Workspace,
): Promise<void> {
  const refusal = (detail: string): OperationError =>
    new OperationError({ reason: "invalid-input", about: [id], detail: `case ${drafted.slug}: ${detail}` });

  const booked = await findCaseRecord(opened, drafted.slug);
  if (booked !== null && booked.id !== id) {
    throw refusal(`the slug is already booked as ${booked.id}`);
  }
  const preset = await resolvePreset(opened, drafted.preset.contribution);
  if (preset.module !== drafted.preset.module || preset.moduleRecord !== drafted.preset.moduleRecord) {
    throw refusal(
      `its preset names ${drafted.preset.moduleRecord}, and ${preset.module} is installed as ${preset.moduleRecord}`,
    );
  }
  if (drafted.projectCommit !== opened.matrix.commit) {
    throw refusal(
      `its project commit is ${drafted.projectCommit}, and the workspace is pinned at ${opened.matrix.commit}`,
    );
  }
  if (drafted.evaluatorVersion !== EVALUATOR_VERSION) {
    throw refusal(`its evaluator version is ${drafted.evaluatorVersion}, and this kernel's is ${EVALUATOR_VERSION}`);
  }

  const derived = await derivedSetlist(opened, {
    slug: drafted.slug,
    kind: drafted.type,
    about,
    overrides: drafted.overrides,
  });
  const derivedIds = derived.map((claim) => recordId(claim));
  const sameLength = derivedIds.length === drafted.claims.length;
  if (!sameLength || !drafted.claims.every((claimId, at) => claimId === derivedIds[at])) {
    // With no key minted yet no id can be salted, and a refusal never mints one.
    const keyed = (await listKeys(join(opened.ctx.gitDir, LOCAL_DIR))).length > 0;
    const saltedIds = keyed ? (await saltedClaims(opened, derived)).map((claim) => recordId(claim)) : derivedIds;
    if (
      !sameLength ||
      !drafted.claims.every((claimId, at) => claimId === derivedIds[at] || claimId === saltedIds[at])
    ) {
      throw refusal(`it cites ${drafted.claims.join(", ")}, and its booking derives ${saltedIds.join(", ")}`);
    }
  }
  const missing = drafted.claims.filter((claimId) => !known(claimId));
  if (missing.length > 0) {
    throw refusal(`it cites ${missing.join(", ")}, which neither the store nor its plan holds`);
  }
}

/** The claims a booking derives: its kind's setlist, or one base triple per `about` URI. */
async function derivedSetlist(opened: Workspace, booking: Booking): Promise<ClaimRecord[]> {
  return booking.kind === null
    ? booking.about.map((uri) => tripleClaim(uri, booking.slug))
    : await setlistFor(opened, booking.kind, booking);
}

/** A slug names one case, so booking it again with another kind, subject or preset is refused
 * rather than answered with the case that slug already holds. */
function refuseAnotherBooking(
  existing: FoundCase,
  input: CaseBookInput,
  claims: readonly ClaimRecord[],
  preset: CaseRecord["preset"],
): void {
  const asked = {
    type: input.kind ?? null,
    claims: claims.map((claim) => recordId(claim)),
    preset,
    overrides: { ...(input.overrides ?? {}) },
  };
  const held = {
    type: existing.record.type,
    claims: existing.record.claims,
    preset: existing.record.preset,
    overrides: existing.record.overrides,
  };
  if (!isDeepStrictEqual(asked, held)) {
    const heldSalted = existing.record.salt !== undefined;
    const onlyClaimsDiffer = isDeepStrictEqual({ ...asked, claims: null }, { ...held, claims: null });
    const how =
      heldSalted !== (input.salt === true)
        ? heldSalted
          ? "salted"
          : "unsalted"
        : heldSalted && onlyClaimsDiffer
          ? "salted under another key"
          : "otherwise";
    throw new OperationError({
      reason: "invalid-input",
      about: [input.slug],
      detail: `refusing to book ${input.slug}: case ${existing.id} already holds that slug, booked ${how}; book this under another slug`,
    });
  }
}

/** Salted before the case is drafted, as a salted booking's case cites its claims' salted ids. */
async function saltedClaims(opened: Workspace, claims: readonly ClaimRecord[]): Promise<ClaimRecord[]> {
  const minted: ClaimRecord[] = [];
  for (const claim of claims) {
    minted.push((await opened.store.salted(claim)) as ClaimRecord);
  }
  return minted;
}

const caseBookHandler: OperationHandler<CaseBookInput, CaseBookOutput> = {
  async plan(input, opened) {
    const derived = await derivedSetlist(opened, {
      slug: input.slug,
      kind: input.kind ?? null,
      about: input.about ?? [],
      overrides: input.overrides ?? {},
    });
    const claims = input.salt === true ? await saltedClaims(opened, derived) : derived;
    const preset = await resolvePreset(opened, input.preset);
    const existing = await findCaseRecord(opened, input.slug);
    if (existing !== null) {
      refuseAnotherBooking(existing, input, claims, preset);
      return {
        plan: { put: [{ kind: "case", value: existing.record }], attest: [], needs: [] },
        output: (applied) => ({ minted: applied.minted, case: existing.id }),
      };
    }

    const planned = claims.map((record) => ({ id: recordId(record), record }));
    const drafter = input.kind ?? "case.book";
    for (const claim of planned) {
      admitExclusiveGroup(claim, planned, drafter, opened);
    }
    const claimIds = planned.map((claim) => claim.id);

    const caseRecord: CaseRecord = {
      kind: "case",
      supersedes: [],
      schemaVersion: CURRENT_SCHEMA_VERSIONS.case,
      type: input.kind ?? null,
      slug: input.slug,
      claims: claimIds,
      preset,
      projectCommit: opened.matrix.commit,
      overrides: { ...(input.overrides ?? {}) },
      evaluatorVersion: EVALUATOR_VERSION,
    };
    return {
      plan: {
        put: [
          { kind: "case", value: caseRecord, ...saltAsked(input.salt) },
          ...claims.map((record) => ({ kind: "claim" as const, value: record })),
        ],
        attest: [],
        needs: [],
      },
      output: (applied) => ({ minted: applied.minted, case: applied.minted[0]!.id }),
    };
  },
};

/** `case.book@1`: mints a case citing the claims its kind names, or one triple per `about` URI. */
export const caseBook = definedOperation<CaseBookInput, CaseBookOutput>(
  {
    id: "case.book",
    version: versionString("1"),
    input: {
      type: "object",
      additionalProperties: false,
      required: ["slug"],
      properties: {
        slug: { type: "string" },
        kind: { type: "string" },
        about: { type: "array", items: { type: "string" } },
        preset: { type: "string" },
        overrides: { type: "object" },
        salt: SALT_INPUT_SCHEMA,
      },
    },
    output: {
      type: "object",
      additionalProperties: false,
      required: ["minted", "case"],
      properties: {
        minted: MINTED_ARRAY_SCHEMA,
        case: { type: "string" },
      },
    },
    effect: "write",
    authority: null,
    reasons: ["head-moved", "invalid-input", "no-such-record"],
    documentation:
      "Mints a case citing one base triple claim per about URI, or returns the case a slug holds when booked the same way.",
    statements: ["slug", "about"],
    cli: {
      verb: "book",
      positional: ["slug"],
      flags: ["kind", "about", "preset", "overrides", "salt"],
      describe: "book a case, citing the claims its kind names or one base triple claim per about URI",
    },
    renderText: renderCaseBookText,
    exitCode: () => 0,
  },
  caseBookHandler,
);
