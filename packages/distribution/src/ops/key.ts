import { join } from "node:path";
import type { OperationDescriptor } from "@musai/api-core";
import { versionString } from "@musai/records";
import { currentKey, LOCAL_DIR, listKeys, MUSAI_DIR, rotateKey } from "@musai/store";

function localDirFor(workspace: string): string {
  return join(workspace, MUSAI_DIR, LOCAL_DIR);
}

export type KeyListInput = Record<string, never>;

export interface KeyListEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly current: boolean;
}

export interface KeyListOutput {
  readonly keys: readonly KeyListEntry[];
}

function renderKeyListText(output: KeyListOutput): string {
  if (output.keys.length === 0) {
    return "no workspace key minted yet";
  }
  return output.keys.map((key) => `${key.id}  ${key.createdAt}${key.current ? "  (current)" : ""}`).join("\n");
}

/** `key.list@1`: every workspace key by id, creation time and whether it is current; never its
 * bytes. */
export const keyList: OperationDescriptor<KeyListInput, KeyListOutput> = {
  id: "key.list",
  version: versionString("1"),
  input: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  output: {
    type: "object",
    additionalProperties: false,
    required: ["keys"],
    properties: {
      keys: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "createdAt", "current"],
          properties: {
            id: { type: "string" },
            createdAt: { type: "string" },
            current: { type: "boolean" },
          },
        },
      },
    },
  },
  effect: "read",
  authority: null,
  plans: true,
  reasons: [],
  documentation: "Lists every workspace key by id, creation time and whether it is current.",
  cli: {
    verb: "list",
    group: "key",
    positional: [],
    flags: [],
    describe: "list every workspace key by id, creation time and whether it is current",
  },
  renderText: renderKeyListText,
  exitCode: () => 0,
  async handler(_input, context) {
    const keys = await listKeys(localDirFor(context.workspace));
    return {
      keys: keys.map((key) => ({ id: key.id, createdAt: key.createdAt, current: key.status === "current" })),
    };
  },
};

export type KeyRotateInput = Record<string, never>;

export interface KeyRotateOutput {
  readonly id: string;
}

/** `key.rotate@1`: mints a new current key, keeping the retired one so secrets hashed under it stay
 * checkable. */
export const keyRotate: OperationDescriptor<KeyRotateInput, KeyRotateOutput> = {
  id: "key.rotate",
  version: versionString("1"),
  input: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  output: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: {
      id: { type: "string" },
    },
  },
  effect: "performs",
  authority: null,
  plans: false,
  reasons: [],
  documentation: "Mints a new current workspace key, retiring the previous one without deleting it.",
  cli: {
    verb: "rotate",
    group: "key",
    positional: [],
    flags: [],
    describe: "rotate the workspace key, retiring the previous one",
  },
  renderText: (output) => output.id,
  exitCode: () => 0,
  async handler(_input, context) {
    const file = await rotateKey(localDirFor(context.workspace), { now: context.now });
    return { id: currentKey(file).id };
  },
};
