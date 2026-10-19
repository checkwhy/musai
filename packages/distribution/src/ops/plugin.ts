import type { OperationDescriptor } from "@musai/api-core";
import { openWorkspace } from "@musai/api-core";
import { versionString } from "@musai/records";
import { defaultPluginDir, type SyncSkillsResult, syncSkills } from "../plugin/sync.js";

export interface PluginSyncInput {
  readonly pluginDir?: string;
}

export type PluginSyncOutput = SyncSkillsResult;

/** `plugin.sync@1`: writes every installed module's marked skill into the plugin; mints nothing. */
export const pluginSync: OperationDescriptor<PluginSyncInput, PluginSyncOutput> = {
  id: "plugin.sync",
  version: versionString("1"),
  input: {
    type: "object",
    additionalProperties: false,
    properties: {
      pluginDir: { type: "string" },
    },
  },
  output: {
    type: "object",
    additionalProperties: false,
    required: ["written", "removed", "unchanged"],
    properties: {
      written: { type: "array", items: { type: "string" } },
      removed: { type: "array", items: { type: "string" } },
      unchanged: { type: "array", items: { type: "string" } },
    },
  },
  effect: "performs",
  authority: null,
  plans: false,
  reasons: ["head-moved", "invalid-input"],
  documentation: "Writes every installed module's own marked skill into the plugin's skills directory, idempotently.",
  paths: ["pluginDir"],
  cli: {
    verb: "sync",
    group: "plugin",
    positional: [],
    flags: ["pluginDir"],
    describe: "write every installed module's own marked skill into the plugin's skills directory",
  },
  renderText: (output) =>
    `written ${output.written.length}, removed ${output.removed.length}, unchanged ${output.unchanged.length}`,
  exitCode: () => 0,
  async handler(input, context) {
    const opened = await openWorkspace(context);
    const pluginDir = input.pluginDir ?? defaultPluginDir(context.workspace);
    return syncSkills(opened, pluginDir);
  },
};
