import { join } from "node:path";
import { type OperationDescriptor, openWorkspace } from "@musai/api-core";
import { type RecordId, versionString } from "@musai/records";
import { assertScopeAt, dropScope, listScopes, MUSAI_DIR, type ScopeTip, Store } from "@musai/store";

const SCOPE_TIP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["scope", "tip"],
  properties: { scope: { type: "string" }, tip: { type: "string" } },
};

function gitDirOf(workspace: string): { gitDir: string } {
  return { gitDir: join(workspace, MUSAI_DIR) };
}

export type ScopeListInput = Record<string, never>;

export interface ScopeListOutput {
  readonly scopes: readonly ScopeTip[];
}

/** `scope.list@1`: every scope holding a ref, with its tip. */
export const scopeList: OperationDescriptor<ScopeListInput, ScopeListOutput> = {
  id: "scope.list",
  version: versionString("1"),
  input: { type: "object", additionalProperties: false, properties: {} },
  output: {
    type: "object",
    additionalProperties: false,
    required: ["scopes"],
    properties: { scopes: { type: "array", items: SCOPE_TIP_SCHEMA } },
  },
  effect: "read",
  authority: null,
  authorOnly: true,
  plans: true,
  reasons: ["invalid-input"],
  documentation: "Lists every scope holding a ref, with the commit it is at.",
  cli: { verb: "list", group: "scope", positional: [], flags: [], describe: "list every scope and its tip" },
  renderText: (output) =>
    output.scopes.length === 0
      ? "no scope holds a record"
      : output.scopes.map((at) => `${at.scope} ${at.tip}`).join("\n"),
  exitCode: () => 0,
  async handler(_input, context) {
    return { scopes: await listScopes(gitDirOf(context.workspace)) };
  },
};

export interface ScopeForkInput {
  readonly name: string;
}

/** `scope.fork@1`: a new scope at the commit this scope's fold holds, carrying a copy of it. */
export const scopeFork: OperationDescriptor<ScopeForkInput, ScopeTip> = {
  id: "scope.fork",
  version: versionString("1"),
  input: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: { name: { type: "string", description: "the new scope's name" } },
  },
  output: SCOPE_TIP_SCHEMA,
  effect: "write",
  authority: null,
  authorOnly: true,
  plans: true,
  reasons: ["invalid-input"],
  documentation: "Forks the scope named by --scope into a new one, with a copy of its fold.",
  cli: { verb: "fork", group: "scope", positional: ["name"], flags: [], describe: "fork this scope into a new one" },
  renderText: (output) => `forked ${output.scope} at ${output.tip}`,
  exitCode: () => 0,
  async handler(input, context) {
    const opened = await openWorkspace(context);
    return { scope: input.name, tip: await opened.fork(input.name, context.mode !== "plan") };
  },
};

export interface ScopeMergeInput {
  readonly from: string;
  readonly only?: readonly string[];
}

export interface ScopeMergeOutput {
  /** `null` where nothing landed, or in plan mode. */
  readonly commit: string | null;
  readonly merged: readonly string[];
}

/** `scope.merge@1`: what another scope holds and this one lacks, or the chosen records, as one
 * commit on this scope. */
export const scopeMerge: OperationDescriptor<ScopeMergeInput, ScopeMergeOutput> = {
  id: "scope.merge",
  version: versionString("1"),
  input: {
    type: "object",
    additionalProperties: false,
    required: ["from"],
    properties: {
      from: { type: "string", description: "the scope to merge from" },
      only: {
        type: "array",
        items: { type: "string" },
        uniqueItems: true,
        description: "the records to carry, with the attestations over them; none carries every record",
      },
    },
  },
  output: {
    type: "object",
    additionalProperties: false,
    required: ["commit", "merged"],
    properties: { commit: { type: ["string", "null"] }, merged: { type: "array", items: { type: "string" } } },
  },
  effect: "write",
  authority: null,
  authorOnly: true,
  plans: true,
  reasons: ["invalid-input", "no-such-record", "record-corrupted"],
  documentation: "Merges another scope into the scope named by --scope, whole or the records --only names.",
  cli: {
    verb: "merge",
    group: "scope",
    positional: ["from"],
    flags: ["only"],
    describe: "merge another scope into this one",
  },
  renderText: (output) =>
    output.merged.length === 0
      ? "nothing to merge"
      : `${output.commit === null ? "would merge" : "merged"} ${output.merged.length} record${output.merged.length === 1 ? "" : "s"}${output.commit === null ? "" : ` at ${output.commit}`}`,
  exitCode: () => 0,
  async handler(input, context) {
    const store = new Store({ ctx: gitDirOf(context.workspace), scope: context.scope, now: context.now });
    // A surface hands an absent repeated flag over as empty, so empty means the whole merge.
    const ids = input.only === undefined || input.only.length === 0 ? undefined : (input.only as readonly RecordId[]);
    if (context.mode === "plan") {
      return { commit: null, merged: await store.mergePreview(input.from, ids) };
    }
    const { commit, merged } = await store.mergeFrom(input.from, ids === undefined ? {} : { ids });
    return { commit, merged };
  },
};

export interface ScopeDropInput {
  readonly name: string;
  readonly tip: string;
}

/** `scope.drop@1`: a scope's fold and ref removed, only at the tip its caller read. */
export const scopeDrop: OperationDescriptor<ScopeDropInput, ScopeTip> = {
  id: "scope.drop",
  version: versionString("1"),
  input: {
    type: "object",
    additionalProperties: false,
    required: ["name", "tip"],
    properties: {
      name: { type: "string", description: "the scope to drop" },
      tip: { type: "string", description: "the commit the scope is expected at" },
    },
  },
  output: SCOPE_TIP_SCHEMA,
  effect: "irreversible",
  authority: null,
  authorOnly: true,
  plans: true,
  reasons: ["head-moved", "invalid-input"],
  documentation: "Drops a scope's fold and its ref, refusing where it has moved past the tip given.",
  cli: { verb: "drop", group: "scope", positional: ["name"], flags: ["tip"], describe: "drop a scope at its tip" },
  renderText: (output) => `dropped ${output.scope}, which was at ${output.tip}`,
  exitCode: () => 0,
  async handler(input, context) {
    const ctx = gitDirOf(context.workspace);
    await (context.mode === "plan" ? assertScopeAt : dropScope)(ctx, input.name, input.tip);
    return { scope: input.name, tip: input.tip };
  },
};
