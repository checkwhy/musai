import { AsyncLocalStorage } from "node:async_hooks";
import type { RuleOutput } from "@musai/modules";
import { type AttestationRecord, KernelError, type RecordId } from "@musai/records";
import { type Attestation, requireSignature } from "@musai/trust";
import { clearanceAdmission } from "./clearance.js";
import type { OperationContext } from "./context.js";
import { invokeContribution } from "./contribution.js";
import { signatureCheck } from "./signature-check.js";
import { Workspace } from "./workspace.js";

const openedInCall = new AsyncLocalStorage<Workspace[]>();

/** Runs one call, then closes every workspace it opened, so no fold outlives the call. */
export async function closingWorkspaces<T>(call: () => Promise<T>): Promise<T> {
  const opened: Workspace[] = [];
  try {
    return await openedInCall.run(opened, call);
  } finally {
    for (const workspace of opened) {
      workspace.close();
    }
  }
}

/** The one place an operation's context opens a workspace, under the clearance it carries. */
export async function openWorkspace(context: OperationContext): Promise<Workspace> {
  const opened = await openUnderClearance(context);
  openedInCall.getStore()?.push(opened);
  return opened;
}

async function openUnderClearance(context: OperationContext): Promise<Workspace> {
  const { clearance } = context;
  return Workspace.open({
    dir: context.workspace,
    scope: context.scope,
    onRefusal: context.reportRefusal,
    onSubscriptionTrace: context.reportSubscription,
    now: context.now,
    subscriptionInvoker: async (opened, subscription, event): Promise<RuleOutput> => {
      // A module's refusal is that subscription's answer, not the write's failure.
      const response = await invokeContribution(opened, subscription.moduleName, subscription.entry, event);
      return response.ok ? (response.output as RuleOutput) : { kind: "error", error: response.error };
    },
    clearance:
      clearance === undefined
        ? undefined
        : { audience: clearance, admission: (author) => clearanceAdmission(author, author.index, clearance) },
  });
}

/** Only a maker's or asserter's attestation qualifies: a re-share never speaks for the
 * principal's own class. */
function attestationsFor(opened: Workspace, subject: RecordId, principal?: string): readonly Attestation[] {
  const found: Attestation[] = [];
  for (const { id, record } of opened.index.attestationsBySubject(subject, principal)) {
    if (record.purpose !== "made" && record.purpose !== "asserted") {
      continue;
    }
    found.push({ id, record });
  }
  return found;
}

function attestationFor(opened: Workspace, subject: RecordId, principal?: string): Attestation | null {
  const found = attestationsFor(opened, subject, principal);
  return found[0] ?? null;
}

/** A missing or bad signature is `workspace-incomplete`: the bytes are sound, and what the
 * workspace lacks is a signature its owner can supply. */
async function verifyOne(opened: Workspace, attestation: Attestation): Promise<AttestationRecord> {
  if (!requireSignature(opened.signingLevel, attestation.record.principalClass)) {
    return attestation.record;
  }
  const checked = await signatureCheck(opened, attestation);
  if (checked.good) {
    return attestation.record;
  }
  throw new KernelError({
    reason: "workspace-incomplete",
    about: [attestation.id],
    detail:
      checked.failure === null
        ? `attestation ${attestation.id} by ${attestation.record.principal} carries no signature, and the signing level ${opened.signingLevel} requires one`
        : `attestation ${attestation.id} by ${attestation.record.principal} does not verify (${checked.failure}) against the allowed signers at ${opened.matrix.commit}`,
  });
}

export async function verifiedAttestationsFor(
  opened: Workspace,
  subject: RecordId,
  principal?: string,
): Promise<readonly AttestationRecord[]> {
  const found = attestationsFor(opened, subject, principal);
  const verified: AttestationRecord[] = [];
  for (const attestation of found) {
    verified.push(await verifyOne(opened, attestation));
  }
  return verified;
}

export async function verifiedAttestationFor(
  opened: Workspace,
  subject: RecordId,
  principal?: string,
): Promise<AttestationRecord | null> {
  const attestation = attestationFor(opened, subject, principal);
  if (attestation === null) {
    return null;
  }
  return verifyOne(opened, attestation);
}
