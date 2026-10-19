import {
  type JsonSchema,
  type OperationContext,
  type OperationDescriptor,
  OperationError,
  runHandler,
  validateAgainstSchema,
} from "@musai/api-core";
import { type CallToolResult, elicitGateAnswer, type Server, type Tool, titledSingleSelect } from "@musai/mcp";
import { RERUN_OUTPUT_SCHEMA, type RerunOutput } from "../ops/rerun.js";
import { commandText } from "../text.js";
import { structuredResult } from "./result.js";

const RERUN_OPERATION_KEY = "bundle.rerun@3";

/** `bundle.rerun`'s own projected name, so no session offers a tool that runs unconfirmed. */
export const RERUN_CONFIRMATION_TOOL_NAME = "bundle_rerun";

export interface RerunConfirmationInput {
  readonly bundle: string;
  readonly yes?: boolean;
}

/** Rerun's answer; where the person was asked and nothing ran, `confirmation` says why. */
const RERUN_CONFIRMATION_OUTPUT_SCHEMA: JsonSchema = {
  ...RERUN_OUTPUT_SCHEMA,
  properties: { ...RERUN_OUTPUT_SCHEMA.properties, confirmation: { enum: ["keep", "decline", "cancel", "expired"] } },
};

export const RERUN_CONFIRMATION_TOOL: Tool = {
  name: RERUN_CONFIRMATION_TOOL_NAME,
  description:
    "Check a bundle and show what it would run here. With yes, the person at the client is shown each command and confirms before anything runs.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["bundle"],
    properties: {
      bundle: { type: "string", description: "a bundle's .tar.gz, by path or https URL" },
      yes: { type: "boolean", description: "ask the person to confirm running each recipe here" },
    },
  },
  outputSchema: RERUN_CONFIRMATION_OUTPUT_SCHEMA as Tool["outputSchema"],
};

function confirmedResult(answer: RerunOutput & { readonly confirmation?: string }): CallToolResult {
  const validation = validateAgainstSchema(RERUN_CONFIRMATION_OUTPUT_SCHEMA, answer);
  if (!validation.ok) {
    throw new OperationError({
      reason: "invalid-output",
      about: [RERUN_CONFIRMATION_TOOL_NAME],
      detail: validation.errors,
    });
  }
  return structuredResult(answer);
}

function confirmationMessage(bundle: string, shown: RerunOutput): string {
  const runs = [...shown.claims, ...(shown.rules ?? []).flatMap((rule) => rule.runs)];
  const commands = runs.map((run) => {
    const tree =
      run.tree === null ? "" : run.tree.here === run.tree.recorded ? ", on the tree it recorded" : ", on another tree";
    return `- ${commandText(run.command)}${tree}`;
  });
  return [`Run these commands from ${bundle} in this checkout?`, ...commands].join("\n");
}

/** The bundle is always checked and shown first; with `yes`, only the person's choice runs it. */
export async function rerunWithConfirmation(
  registry: ReadonlyMap<string, OperationDescriptor>,
  server: Pick<Server, "elicitInput">,
  context: OperationContext,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const input = args as unknown as RerunConfirmationInput;
  const descriptor = registry.get(RERUN_OPERATION_KEY) as OperationDescriptor<RerunConfirmationInput, RerunOutput>;
  const shown = await runHandler(descriptor, { bundle: input.bundle }, context);
  if (input.yes !== true) {
    return confirmedResult(shown);
  }
  const outcome = await elicitGateAnswer(server, {
    message: confirmationMessage(input.bundle, shown),
    field: titledSingleSelect("Run here?", [
      { const: "run", title: "Run each command here" },
      { const: "keep", title: "Run nothing" },
    ]),
  });
  if (!outcome.answered || outcome.value !== "run") {
    return confirmedResult({ ...shown, confirmation: outcome.answered ? outcome.value : outcome.action });
  }
  return confirmedResult(await runHandler(descriptor, { bundle: input.bundle, yes: true }, context));
}
