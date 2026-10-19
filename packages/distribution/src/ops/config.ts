import { join } from "node:path";
import {
  actingPrincipal,
  type OperationContext,
  type OperationDescriptor,
  OperationError,
  refusedThroughRelay,
} from "@musai/api-core";
import { FLOOR_CONFIG_KEY, floorFrom } from "@musai/evaluate";
import { BLOB_THRESHOLD_CONFIG_KEY, isRelayedChannel, versionString } from "@musai/records";
import {
  DECLARED_NAMES_CONFIG_KEY,
  layerDeclarationsFromConfig,
  STATION_IMAGE_CONFIG_KEY,
  stationImageFromConfig,
  TOOLS_CONFIG_KEY,
  workspaceToolsFromConfig,
} from "@musai/run";
import {
  editedConfig,
  LOCAL_DIR,
  MUSAI_DIR,
  projectLayerSlots,
  readTrustBranch,
  readWorkspaceConfig,
  SLOTS_CONFIG_KEY,
  type TrustBranch,
  type WorkspaceConfig,
  writeMainFiles,
} from "@musai/store";
import {
  assertMayConfigure,
  parseAllowedSigners,
  parseRoles,
  roleMatrix,
  SIGNING_LEVEL_CONFIG_KEY,
  signingLevelOf,
} from "@musai/trust";

export interface ConfigGetInput {
  readonly key: string;
}

export interface ConfigSetInput extends ConfigGetInput {
  readonly value: string;
}

/** `value` is `null` where the key is not set, which no key accepts as a value. */
export interface ConfigValue {
  readonly key: string;
  readonly value: unknown;
}

type KeyReader = (config: WorkspaceConfig) => unknown;

/** Each key the kernel reads, with the reader that refuses a value it cannot use. */
const KEY_READERS: ReadonlyMap<string, KeyReader> = new Map<string, KeyReader>([
  [
    BLOB_THRESHOLD_CONFIG_KEY,
    (config) => {
      const threshold = config.values[BLOB_THRESHOLD_CONFIG_KEY];
      if (typeof threshold !== "number" || !Number.isSafeInteger(threshold) || threshold < 0) {
        throw new RangeError(`${BLOB_THRESHOLD_CONFIG_KEY} must be a whole number of bytes, zero or more`);
      }
    },
  ],
  [DECLARED_NAMES_CONFIG_KEY, layerDeclarationsFromConfig],
  [FLOOR_CONFIG_KEY, floorFrom],
  [SIGNING_LEVEL_CONFIG_KEY, signingLevelOf],
  [SLOTS_CONFIG_KEY, projectLayerSlots],
  [STATION_IMAGE_CONFIG_KEY, stationImageFromConfig],
  [TOOLS_CONFIG_KEY, workspaceToolsFromConfig],
]);

const CONFIG_VALUE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["key", "value"],
  properties: { key: { type: "string" }, value: {} },
} as const;

function renderConfigValue(output: ConfigValue): string {
  if (output.value === null) {
    return `${output.key} is not set`;
  }
  return typeof output.value === "string" ? output.value : JSON.stringify(output.value);
}

function knownKey(key: string): KeyReader {
  const read = KEY_READERS.get(key);
  if (read === undefined) {
    throw new OperationError({
      reason: "invalid-input",
      about: [key],
      detail: `${key} is no configuration key; the known keys are ${[...KEY_READERS.keys()].join(", ")}`,
    });
  }
  return read;
}

/** JSON where the text is JSON, else the text itself, so `person` and `["sh"]` are spelled bare. */
function parsedValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** `config.get@1`: a key of the trust branch's configuration, `null` where it is not set. */
export const configGet: OperationDescriptor<ConfigGetInput, ConfigValue> = {
  id: "config.get",
  version: versionString("1"),
  input: {
    type: "object",
    additionalProperties: false,
    required: ["key"],
    properties: { key: { type: "string" } },
  },
  output: CONFIG_VALUE_OUTPUT_SCHEMA,
  effect: "read",
  authority: null,
  authorOnly: true,
  plans: true,
  reasons: ["invalid-input", "workspace-incomplete"],
  documentation: "Reads one key of the configuration on the trust branch, null where it is not set.",
  cli: {
    verb: "get",
    group: "config",
    positional: ["key"],
    flags: [],
    describe: "print a key of the trust branch's configuration",
  },
  renderText: renderConfigValue,
  exitCode: () => 0,
  async handler(input, context) {
    knownKey(input.key);
    const config = await readWorkspaceConfig({ gitDir: join(context.workspace, MUSAI_DIR) });
    return { key: input.key, value: config.values[input.key] ?? null };
  },
};

function assertFromTerminal(operation: string, action: string, context: OperationContext): void {
  if (context.via === undefined || isRelayedChannel(context.via)) {
    throw refusedThroughRelay(
      operation,
      action,
      "the trust branch's configuration is the floor, a person's to change; run it from a terminal",
      context.via ?? "no channel",
    );
  }
}

async function trustHeldToConfigure(key: string, context: OperationContext): Promise<TrustBranch> {
  const gitDir = join(context.workspace, MUSAI_DIR);
  const trust = await readTrustBranch({ gitDir });
  const allowedSigners = parseAllowedSigners(trust.allowedSigners);
  const matrix = roleMatrix(allowedSigners, parseRoles(trust.roles), trust.commit);
  const principal = await actingPrincipal(
    { localDir: join(gitDir, LOCAL_DIR), allowedSigners, now: context.now },
    context.principalName,
    undefined,
  );
  assertMayConfigure(matrix, principal, key);
  return trust;
}

/** `config.set@1`: a key of the trust branch's configuration, as its reader accepts it. */
export const configSet: OperationDescriptor<ConfigSetInput, ConfigValue> = {
  id: "config.set",
  version: versionString("1"),
  input: {
    type: "object",
    additionalProperties: false,
    required: ["key", "value"],
    properties: {
      key: { type: "string" },
      value: { type: "string", description: "JSON, or bare text where the value is a string" },
    },
  },
  output: CONFIG_VALUE_OUTPUT_SCHEMA,
  effect: "write",
  authority: null,
  authorOnly: true,
  plans: true,
  reasons: ["invalid-input", "not-authorised", "workspace-incomplete", "head-moved"],
  documentation:
    "Sets one key of the configuration on the trust branch as a new commit, which only a person holding configure-floor does.",
  cli: {
    verb: "set",
    group: "config",
    positional: ["key", "value"],
    flags: [],
    describe: "set a key of the trust branch's configuration",
  },
  renderText: renderConfigValue,
  exitCode: () => 0,
  async handler(input, context) {
    assertFromTerminal("config.set@1", "set a configuration value", context);
    const read = knownKey(input.key);
    const value = parsedValue(input.value);
    try {
      read({ commit: "the value given", values: { [input.key]: value } });
    } catch (error) {
      throw new OperationError({
        reason: "invalid-input",
        about: [input.key],
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    await trustHeldToConfigure(input.key, context);
    if (context.mode !== "plan") {
      const edit = editedConfig((values) => ({ ...values, [input.key]: value }));
      await writeMainFiles({ gitDir: join(context.workspace, MUSAI_DIR) }, { "config.json": edit }, context.now);
    }
    return { key: input.key, value };
  },
};

/** `config.unset@1`: removes a key of the trust branch configuration; absent is a no-op. */
export const configUnset: OperationDescriptor<ConfigGetInput, ConfigValue> = {
  id: "config.unset",
  version: versionString("1"),
  input: {
    type: "object",
    additionalProperties: false,
    required: ["key"],
    properties: { key: { type: "string" } },
  },
  output: {
    type: "object",
    additionalProperties: false,
    required: ["key", "value"],
    properties: { key: { type: "string" }, value: { type: "null" } },
  },
  effect: "write",
  authority: null,
  authorOnly: true,
  plans: true,
  reasons: ["invalid-input", "not-authorised", "workspace-incomplete", "head-moved"],
  documentation:
    "Removes one key of the configuration on the trust branch as a new commit, which only a person holding configure-floor does.",
  cli: {
    verb: "unset",
    group: "config",
    positional: ["key"],
    flags: [],
    describe: "remove a key of the trust branch's configuration",
  },
  renderText: renderConfigValue,
  exitCode: () => 0,
  async handler(input, context) {
    assertFromTerminal("config.unset@1", "remove a configuration value", context);
    knownKey(input.key);
    const trust = await trustHeldToConfigure(input.key, context);
    if (context.mode !== "plan" && input.key in trust.config.values) {
      const edit = editedConfig(({ [input.key]: _removed, ...rest }) => rest);
      await writeMainFiles({ gitDir: join(context.workspace, MUSAI_DIR) }, { "config.json": edit }, context.now);
    }
    return { key: input.key, value: null };
  },
};
