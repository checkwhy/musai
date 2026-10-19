import type { DraftAdmission } from "./contributed.js";
import type { OperationDescriptor } from "./registry.js";

/** What a surface is handed, so it holds nothing of any one distribution's own. */
export interface Distribution {
  readonly name: string;
  /** The binary a person types, where it differs from the distribution's name. */
  readonly command?: string;
  readonly version: string;
  /** Built by `buildRegistry`, which sorts it so every projected list is byte-stable. */
  readonly registry: ReadonlyMap<string, OperationDescriptor>;
  /** Required, so a distribution cannot write a pack's drafts unadmitted. */
  readonly admitDrafts: DraftAdmission;
  /** The operations, by `id@version`, a surface offers outside `lab`; absent, every one. */
  readonly publicOperations?: ReadonlySet<string>;
  /** Printed after the verbs a bare invocation lists, naming where a stranger starts. */
  readonly startHere?: string;
}
