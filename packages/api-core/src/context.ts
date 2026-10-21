import type { EnvelopeError, EventPayload } from "@musai/modules";
import {
  type Audience,
  type Clock,
  isAudience,
  isTimestamp,
  type Timestamp,
  timestamp,
  type ViaChannel,
} from "@musai/records";
import { OperationError } from "./errors.js";

/** A file a fold found under `records/` and left out of the index. */
export interface WorkspaceRefusal {
  readonly id: string | null;
  readonly commit: string;
  readonly path: string;
  readonly reason: string;
}

/** What a write that landed does not carry back: a subscription's error answer, or a need of its
 * run the kernel refused. */
export interface SubscriptionTrace {
  readonly subscription: string;
  readonly version: string;
  readonly event: EventPayload;
  readonly error: EnvelopeError;
}

/** `plan` returns what an operation would mint without writing anything. */
export const MODES = ["perform", "plan"] as const;

export type Mode = (typeof MODES)[number];

export interface OperationContext {
  readonly workspace: string;
  readonly scope: string;
  readonly expectHead?: string;
  readonly mode?: Mode;
  /** Handed identically to a plan and the perform that follows it, so both mint the same id. */
  readonly now: Clock;
  /** Set by the surface, never the caller; an attestation takes its channel from it alone. */
  readonly via?: ViaChannel;
  /** The name the surface was launched under; a key the call signs with outranks it, and a record
   * carries it only as a pseudonym. */
  readonly principalName?: string;
  /** Fixed where the surface is launched, never by a call; absent, every record is read. */
  readonly clearance?: Audience;
  /** How long each run `check` performs may take; one outliving it ends the call, unreceipted. */
  readonly runTimeoutMs?: number;
  reportRefusal?(refusal: WorkspaceRefusal): void | Promise<void>;
  /** Where a subscription's refused answer is left, since a write that landed cannot carry it. */
  reportSubscription?(trace: SubscriptionTrace): Promise<void>;
}

/** The one place "now" is decided: `MUSAI_NOW` when set, else the machine's clock. */
export function clockFromEnvironment(): Clock {
  const pinned = process.env["MUSAI_NOW"];
  if (pinned === undefined) {
    return (): Timestamp => timestamp(new Date().toISOString());
  }
  if (!isTimestamp(pinned)) {
    throw new OperationError({
      reason: "invalid-input",
      about: ["MUSAI_NOW"],
      detail: `MUSAI_NOW is ${pinned}, which is not an RFC 3339 instant with an explicit offset or Z: set it to one, or unset it to read the machine's clock`,
    });
  }
  return (): Timestamp => pinned;
}

/** `MUSAI_PRINCIPAL` as a context names it, when set; it grants no authority, which the role matrix
 * alone decides. */
export function principalNameFromEnvironment(): Pick<OperationContext, "principalName"> {
  const principalName = process.env["MUSAI_PRINCIPAL"];
  return principalName === undefined ? {} : { principalName };
}

/** The audience a surface is launched under, read from the flag or variable `source`; whether the
 * workspace declares it is judged as the workspace opens. */
export function clearanceNamedBy(source: string, named: string | undefined): Audience | undefined {
  if (named === undefined || isAudience(named)) {
    return named;
  }
  throw new OperationError({
    reason: "invalid-input",
    about: [source],
    detail: `${source} is ${JSON.stringify(named)}, which is no audience: name public, key:SHA256:<fingerprint>, identity:<https issuer>#<subject> or a name the audiences file declares`,
  });
}

/** `MUSAI_CLEARANCE` when set; unset, the surface reads every record. */
export function clearanceFromEnvironment(): Audience | undefined {
  return clearanceNamedBy("MUSAI_CLEARANCE", process.env["MUSAI_CLEARANCE"]);
}
