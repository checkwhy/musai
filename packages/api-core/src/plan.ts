import { ageLimitMsFromSlot, type NeedOutcome, satisfyNeeds } from "@musai/evaluate";
import {
  invocationLimitsFromSlots,
  type Need,
  type OperationPlan,
  type PlannedRecord,
  readSlotDeclarations,
} from "@musai/modules";
import {
  ANY_SCOPE,
  type AttestationRecord,
  isKernelError,
  isPlainObject,
  isRelayedChannel,
  type MusaiRecord,
  PACK_ATTEST_PURPOSES,
  PACK_IRREVERSIBLE_SLOT_ID,
  type PrincipalClass,
  type RecordId,
  type RecordKind,
  recordId,
  resolveSlot,
  slotFor,
  type ViaChannel,
  validateRecord,
} from "@musai/records";
import { type PutItem, SLOTS_CONFIG_KEY } from "@musai/store";
import { type Attestation, may, mintAttestation } from "@musai/trust";
import { buildAdmissionWorkspace } from "./admission.js";
import type { OperationContext } from "./context.js";
import { OperationError } from "./errors.js";
import { installedModules } from "./events.js";
import { actingPrincipal, NO_PRINCIPAL_REMEDY, noPrincipal, type PrincipalSources } from "./principal.js";
import type { OperationDescriptor } from "./registry.js";
import { signatureFor } from "./signing.js";
import type { Workspace } from "./workspace.js";
import type { MintedRecord, WriteResult } from "./write-result.js";

/** Minted in the order `[...put, ...attest]`, receipts in the order their needs were answered. */
export interface AppliedPlan extends WriteResult {
  readonly receipts: readonly RecordId[];
}

/** Only the channel decides the class; no field of a plan or an input overrides it. */
export function principalClassForVia(via: ViaChannel): PrincipalClass {
  return isRelayedChannel(via) ? "agent" : "person";
}

interface AttestingChannel {
  readonly via: ViaChannel;
  readonly principal: string;
}

/** No input field stands in for the channel the surface established or the principal resolved. */
function attestingAs(via: ViaChannel | undefined, principal: string | undefined): AttestingChannel {
  if (via === undefined) {
    throw new OperationError({
      reason: "invalid-input",
      about: ["via"],
      detail:
        "this call asks for an attestation, and the surface it arrived through established no via to attest under",
    });
  }
  if (principal === undefined) {
    throw noPrincipal("principal");
  }
  return { via, principal };
}

/** The channel and the principal an attestation is minted under, `named` being the key the call
 * names to sign with. */
export async function establishedChannel(
  context: OperationContext,
  view: PrincipalSources,
  named: string | undefined,
): Promise<AttestingChannel> {
  return attestingAs(context.via, await actingPrincipal(view, context.principalName, named));
}

/** The principal a plan acts as, resolved only where its authority or an attestation asks. */
export async function planPrincipal(
  plan: OperationPlan,
  declaration: Pick<AdmittedDeclaration, "authority">,
  view: PrincipalSources,
  context: OperationContext,
  named: string | undefined,
): Promise<string | undefined> {
  if (declaration.authority === null && plan.attest.length === 0) {
    return undefined;
  }
  return actingPrincipal(view, context.principalName, named);
}

export function invalidDraft(operation: string, index: number, kind: RecordKind, detail: string): OperationError {
  return new OperationError({
    reason: "invalid-output",
    about: [operation, `put/${index}`],
    detail: `${operation} drafts a ${kind} at put ${index} that ${detail}`,
  });
}

/** A workspace or requirement refusal, or a throw with no reason, is answered as raised: blaming
 * the pack's output would send its caller to the wrong place. */
export function draftRefusal(
  error: unknown,
  operation: string,
  index: number,
  kind: RecordKind,
  refusedBy: string,
): unknown {
  if (!isKernelError(error) || error.code === "workspace" || error.code === "requirement") {
    return error;
  }
  return invalidDraft(operation, index, kind, `${refusedBy}: ${error.detail}`);
}

/** The n-th record this plan puts, or a record the store already holds. */
function subjectOf(
  subject: OperationPlan["attest"][number]["subject"],
  putIds: readonly RecordId[],
  view: Workspace,
): RecordId {
  if ("record" in subject) {
    view.read(subject.record);
    return subject.record;
  }
  const id = putIds[subject.put];
  if (id === undefined) {
    throw new OperationError({
      reason: "invalid-input",
      about: [String(subject.put)],
      detail: `an attestation names put entry ${subject.put}, and this plan puts ${putIds.length} record${putIds.length === 1 ? "" : "s"}`,
    });
  }
  return id;
}

/** Derives a claim's missing slot as a booking's claims are; a slot the draft names is kept, so
 * the validator refuses a wrong one rather than silently correcting it. */
function withDerivedSlot(entry: PlannedRecord, view: Workspace, operation: string, index: number): unknown {
  const { value } = entry;
  if (
    entry.kind !== "claim" ||
    !isPlainObject(value) ||
    Object.hasOwn(value, "slot") ||
    typeof value["type"] !== "string"
  ) {
    return value;
  }
  const declaration = view.claimTypes.get(value["type"]);
  if (declaration === undefined) {
    throw invalidDraft(
      operation,
      index,
      "claim",
      `names no slot and a type the workspace declares no identity for, so there is no slot to derive: ${value["type"]}`,
    );
  }
  const conditions = value["conditions"];
  if (!isPlainObject(conditions)) {
    throw invalidDraft(
      operation,
      index,
      "claim",
      "names no slot and conditions that are not an object, so there is no slot to derive",
    );
  }
  return { ...value, slot: slotFor(declaration, conditions) };
}

/** A case's citations of the claims this plan salts, as their salted ids, so a pack names the
 * derivation it can compute. */
function withSaltedCitations(
  value: unknown,
  entry: PlannedRecord,
  saltedIds: ReadonlyMap<RecordId, RecordId>,
): unknown {
  if (entry.kind !== "case" || !isPlainObject(value) || !Array.isArray(value["claims"])) {
    return value;
  }
  const cited = value["claims"].map((id) => (typeof id === "string" ? (saltedIds.get(id as RecordId) ?? id) : id));
  return { ...value, claims: cited };
}

/** The draft, salted where it asks, keeping any salt it names, since the module boundary refuses a
 * pack's and a distribution's own verb salts only through the kernel. */
async function draftedRecord(
  entry: PlannedRecord,
  record: MusaiRecord,
  view: Workspace,
  operation: string,
  index: number,
): Promise<MusaiRecord> {
  if (entry.salt !== true) {
    return record;
  }
  try {
    return await view.store.salted(record);
  } catch (error) {
    throw draftRefusal(error, operation, index, entry.kind, "the kernel refuses to salt it");
  }
}

/** A salted claim's id is noted in `saltedIds` for the cases that cite it. */
async function draftPut(
  entry: PlannedRecord,
  index: number,
  view: Workspace,
  operation: string,
  saltedIds: Map<RecordId, RecordId>,
): Promise<MintedRecord> {
  // The store hashes the validated form, so the raw value would digest to an id never written.
  const drafted = withSaltedCitations(withDerivedSlot(entry, view, operation, index), entry, saltedIds);
  const validation = validateRecord(drafted, {
    unregisteredClaimTypes: "refuse",
    claimTypes: view.claimTypes,
  });
  if (!validation.ok) {
    throw invalidDraft(operation, index, entry.kind, `is not a valid record: ${validation.error}`);
  }
  if (validation.record.kind !== entry.kind) {
    throw invalidDraft(operation, index, entry.kind, `is a ${validation.record.kind} record`);
  }
  const record = await draftedRecord(entry, validation.record, view, operation, index);
  if (entry.salt === true) {
    saltedIds.set(recordId(validation.record), recordId(record));
  }
  return { id: recordId(record), kind: entry.kind, record };
}

/** Computes what a plan would mint, writing no record, signing and spawning nothing (a salted draft
 * may create the workspace key), once per call, since a second would mint a second attestation. */
export async function realisePlan(
  plan: OperationPlan,
  view: Workspace,
  context: OperationContext,
  operation: string,
  principal: string | undefined,
): Promise<AppliedPlan> {
  const put: MintedRecord[] = [];
  const saltedIds = new Map<RecordId, RecordId>();
  // A case follows the claims it cites, so their salted ids are known when it is drafted.
  const order = [...plan.put.keys()].sort(
    (a, b) => Number(plan.put[a]!.kind === "case") - Number(plan.put[b]!.kind === "case"),
  );
  let firstRefusal: { readonly index: number; readonly error: unknown } | undefined;
  for (const index of order) {
    // Only an earlier entry can still beat the refusal held, and a later draft may create the key.
    if (firstRefusal !== undefined && index > firstRefusal.index) {
      continue;
    }
    try {
      put[index] = await draftPut(plan.put[index]!, index, view, operation, saltedIds);
    } catch (error) {
      if (firstRefusal === undefined || index < firstRefusal.index) {
        firstRefusal = { index, error };
      }
    }
  }
  if (firstRefusal !== undefined) {
    throw firstRefusal.error;
  }
  const putIds = put.map((entry) => entry.id);

  const attest: MintedRecord[] = [];
  if (plan.attest.length > 0) {
    const attesting = attestingAs(context.via, principal);
    for (const intent of plan.attest) {
      const attestation = mintAttestation({
        subject: subjectOf(intent.subject, putIds, view),
        principal: attesting.principal,
        principalClass: principalClassForVia(attesting.via),
        via: attesting.via,
        purpose: intent.purpose,
        at: view.now(),
        ...(intent.release === undefined ? {} : { release: intent.release }),
        ...(intent.seal === undefined ? {} : { seal: intent.seal }),
        ...(intent.supersedes === undefined ? {} : { supersedes: intent.supersedes }),
      });
      attest.push({ id: attestation.id, kind: "attestation", record: attestation.record });
    }
  }

  return { minted: [...put, ...attest], receipts: [] };
}

/** The needs belong to no case, so every slot but the invocation limits takes its default. */
async function performNeeds(needs: readonly Need[], view: Workspace): Promise<readonly RecordId[]> {
  const slotRegistry = readSlotDeclarations(view.index);
  const requirementRegistry = view.requirements();
  const admission = await buildAdmissionWorkspace(view, await installedModules(view));
  const outcomes = await satisfyNeeds({
    needs,
    index: view.index,
    store: view.store,
    localDir: view.localDir,
    layerDeclarations: view.layerDeclarations,
    fetchStore: view.fetchStore,
    evaluationOutcomes: new Map<string, NeedOutcome>(),
    now: view.now,
    slotRegistry,
    requirementRegistry,
    slotLayers: {},
    ageLimitMs: ageLimitMsFromSlot(slotRegistry, {}),
    modulePath: admission.modulePath,
    invocationLimits: invocationLimitsFromSlots(slotRegistry, { project: view.projectSlots }),
    station: view.station,
  });

  const receipts: RecordId[] = [];
  for (const [id, outcome] of outcomes) {
    if (outcome.kind === "refused") {
      throw new OperationError({
        reason: outcome.reason,
        about: [id],
        detail: outcome.error.message,
      });
    }
    if (outcome.kind === "satisfied") {
      receipts.push(outcome.recordId);
    }
  }
  return receipts;
}

/** What `intent` asks that only a person may: to make a release or a seal, or to lift a seal the
 * fold holds. */
function personsAct(intent: OperationPlan["attest"][number], view: Workspace): string | undefined {
  if (intent.purpose === "released" || intent.purpose === "sealed") {
    return `make a ${intent.purpose === "released" ? "release" : "seal"}`;
  }
  const liftsASeal =
    intent.purpose === "revoked" &&
    (intent.supersedes ?? []).some((id) => {
      const held = view.index.recordById(id)?.record;
      return held?.kind === "attestation" && held.purpose === "sealed";
    });
  return liftsASeal ? "lift a seal" : undefined;
}

/** The refusal of a person's act arriving through a relayed channel, or through none. */
export function refusedThroughRelay(operation: string, act: string, why: string, channel: string): OperationError {
  return new OperationError({
    reason: "not-authorised",
    about: [operation, channel],
    detail: `${operation} asks to ${act} through ${channel}: ${why}`,
  });
}

export interface AdmittedDeclaration extends Pick<OperationDescriptor, "id" | "version" | "effect" | "authority"> {
  readonly contributed: boolean;
}

const NEEDING_EFFECTS: ReadonlySet<AdmittedDeclaration["effect"]> = new Set(["performs", "irreversible"]);

/** Checks the plan against its declared effect, a pack's irreversible effect against the project
 * slot, what each attestation may be over, then the authority `principal` holds; it only reads. */
export function admitPlan(
  plan: OperationPlan,
  declaration: AdmittedDeclaration,
  view: Workspace,
  context: OperationContext,
  principal: string | undefined,
): void {
  const operation = `${declaration.id}@${declaration.version}`;

  // Every later gate is chosen by the declared effect, and a pack writes its own declaration.
  const writes = plan.put.length > 0 || plan.attest.length > 0;
  if (declaration.effect === "read" && (writes || plan.needs.length > 0)) {
    throw new OperationError({
      reason: "invalid-output",
      about: [operation],
      detail: `${operation} declares a read, and its plan ${writes ? "writes records" : "carries needs"}: a read answers with an empty plan`,
    });
  }
  if (plan.needs.length > 0 && !NEEDING_EFFECTS.has(declaration.effect)) {
    throw new OperationError({
      reason: "invalid-output",
      about: [operation],
      detail: `${operation} declares ${declaration.effect}, and its plan carries needs: only an operation declaring performs or irreversible has anything performed for it`,
    });
  }

  if (declaration.contributed && declaration.effect === "irreversible") {
    const allowed = resolveSlot(PACK_IRREVERSIBLE_SLOT_ID, readSlotDeclarations(view.index), {
      project: view.projectSlots,
    });
    if (allowed.value !== true) {
      const moduleName = declaration.id.slice(0, declaration.id.indexOf("/"));
      throw new OperationError({
        reason: "not-authorised",
        about: [operation, PACK_IRREVERSIBLE_SLOT_ID],
        detail: `${operation}, contributed by module ${moduleName}, declares an irreversible effect, and ${PACK_IRREVERSIBLE_SLOT_ID} is not true for this project: only the project's own configuration grants it, as {"${SLOTS_CONFIG_KEY}": {"${PACK_IRREVERSIBLE_SLOT_ID}": true}} in the trust branch's config.json`,
      });
    }
  }

  for (const intent of plan.attest) {
    const moves = !(PACK_ATTEST_PURPOSES as readonly string[]).includes(intent.purpose);
    if (moves && declaration.authority !== "publish") {
      const decides =
        intent.purpose === "sealed" ? "decides what a station sees" : "moves a record across the export boundary";
      throw new OperationError({
        reason: "not-authorised",
        about: [operation, "publish"],
        detail: `${operation} asks for a ${intent.purpose} attestation, which ${decides}, and declares no publish authority`,
      });
    }
    const act = context.via === "model" ? personsAct(intent, view) : undefined;
    if (act !== undefined) {
      throw refusedThroughRelay(
        operation,
        act,
        "a release or a seal is a person's, signed, and never made or lifted by a model's relay",
        "model",
      );
    }
    if (!moves && "record" in intent.subject) {
      throw new OperationError({
        reason: "invalid-output",
        about: [operation, intent.subject.record],
        detail: `${operation} asks for a ${intent.purpose} attestation over ${intent.subject.record}, a record its plan does not put: a making or an asserting is only over what the operation drafts`,
      });
    }
  }

  if (declaration.authority !== null) {
    if (principal === undefined || !may(view.matrix, principal, declaration.authority, ANY_SCOPE)) {
      throw new OperationError({
        reason: "not-authorised",
        about: [principal ?? operation, declaration.authority],
        detail: `${operation} needs ${declaration.authority}, and ${principal === undefined ? `no principal was established to hold it: ${NO_PRINCIPAL_REMEDY}` : `the role matrix does not grant it to ${principal}`}`,
      });
    }
  }
}

/** Takes the realised answer, so the ids and instants written are those a preview showed. Signs
 * here and never in realisation, so a preview spawns no signer. */
export async function perform(
  realised: AppliedPlan,
  needs: readonly Need[],
  view: Workspace,
  key?: string,
): Promise<AppliedPlan> {
  const receipts = needs.length > 0 ? await performNeeds(needs, view) : [];

  if (realised.minted.length > 0) {
    const items: PutItem[] = [];
    for (const item of realised.minted) {
      if (item.kind !== "attestation") {
        items.push({ kind: item.kind, value: item.record });
        continue;
      }
      const attestation: Attestation = { id: item.id, record: item.record as AttestationRecord };
      const signature = await signatureFor(view, attestation, key);
      items.push({ kind: "attestation", value: item.record, ...(signature === undefined ? {} : { signature }) });
    }
    await view.put(items);
  }

  return { minted: realised.minted, receipts };
}
