import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OperationDescriptor } from "@musai/api-core";
import { versionString } from "@musai/records";
import { MUSAI_DIR, ONE_LEVEL_REF_PREFIX, type Relayout, relayoutScope, scopeIndexPath } from "@musai/store";

export type StoreRelayoutInput = Record<string, never>;

/** `store.relayout@1`: a scope's history rewritten with every record two levels deep, or none. */
export const storeRelayout: OperationDescriptor<StoreRelayoutInput, Relayout> = {
  id: "store.relayout",
  version: versionString("1"),
  input: { type: "object", additionalProperties: false, properties: {} },
  output: {
    type: "object",
    additionalProperties: false,
    required: ["commits", "records"],
    properties: { commits: { type: "integer" }, records: { type: "integer" } },
  },
  effect: "performs",
  authority: null,
  authorOnly: true,
  plans: true,
  reasons: ["record-corrupted", "head-moved", "invalid-input"],
  documentation:
    "Rewrites a scope's history written with record paths one level deep, commit by commit, moving each record two levels deep under the same id.",
  cli: {
    verb: "relayout",
    group: "store",
    positional: [],
    flags: [],
    describe: `rewrite a scope written with one-level record paths; the old history stays at ${ONE_LEVEL_REF_PREFIX}<scope>`,
  },
  renderText: (output) =>
    output.records === 0
      ? "every record path is two levels deep; nothing was rewritten"
      : `moved ${output.records} record${output.records === 1 ? "" : "s"} two levels deep across ${output.commits} commit${output.commits === 1 ? "" : "s"}`,
  exitCode: () => 0,
  async handler(_input, context) {
    const gitDir = join(context.workspace, MUSAI_DIR);
    const relayout = await relayoutScope({ gitDir }, context.scope, { write: context.mode !== "plan" });
    if (context.mode !== "plan" && relayout.records > 0) {
      // The fold's cursor names a commit the rewritten history no longer descends from.
      await rm(dirname(scopeIndexPath(gitDir, context.scope)), { recursive: true, force: true });
    }
    return relayout;
  },
};
