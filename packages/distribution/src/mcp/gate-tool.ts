import {
  type JsonSchema,
  type OperationContext,
  type OperationDescriptor,
  OperationError,
  openWorkspace,
  principalNameFromEnvironment,
  runHandler,
  validateAgainstSchema,
} from "@musai/api-core";
import {
  type CallToolResult,
  elicitGateAnswer,
  type Server,
  secretBindingNames,
  type Tool,
  titledSingleSelect,
} from "@musai/mcp";
import { askMenu } from "../gate/menu.js";
import { GATE_ANSWER_OUTPUT_SCHEMA } from "../ops/gate.js";
import { structuredResult } from "./result.js";

const GATE_ANSWER_OPERATION_KEY = "gate.answer@2";

/** Deliberately `gate.answer`'s own projected name, so a live session offers a model no tool
 * taking a `choice` to relay as a person's answer. */
export const GATE_ANSWER_ELICITATION_TOOL_NAME = "gate_answer";

/** The model-facing input: never a `choice`, `via` or `principal`, which the handler supplies. */
export interface GateAnswerElicitationInput {
  readonly pending: string;
  readonly brief: string;
  readonly reason?: string;
}

const GATE_ANSWER_ELICITATION_SCHEMA: Tool["inputSchema"] = {
  type: "object",
  additionalProperties: false,
  required: ["pending", "brief"],
  properties: {
    pending: { type: "string", description: "the pending gate claim's own record id, as gate_ask returned it" },
    brief: { type: "string", description: "the brief id gate_ask returned alongside it" },
    reason: {
      type: "string",
      description:
        "optional context for the ruling's own reason; the decisive choice always comes from the person answering the elicited menu, never from this field",
    },
  },
};

/** `gate.answer`'s output, or the closed non-answer where the person declined or time ran out. */
const GATE_ANSWER_ELICITATION_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  oneOf: [
    GATE_ANSWER_OUTPUT_SCHEMA,
    {
      type: "object",
      additionalProperties: false,
      required: ["answered", "action", "message"],
      properties: {
        answered: { const: false },
        action: { enum: ["decline", "cancel", "expired"] },
        message: { type: "string" },
      },
    },
  ],
};

export const GATE_ANSWER_ELICITATION_TOOL: Tool = {
  name: GATE_ANSWER_ELICITATION_TOOL_NAME,
  description:
    "Answer a pending gate. Presents the gate's own menu as a form the person at the client answers directly — the model never sees or asserts their choice before it is recorded.",
  inputSchema: GATE_ANSWER_ELICITATION_SCHEMA,
  outputSchema: GATE_ANSWER_ELICITATION_OUTPUT_SCHEMA as Tool["outputSchema"],
};

function heldAnswer(answer: unknown): CallToolResult {
  const validation = validateAgainstSchema(GATE_ANSWER_ELICITATION_OUTPUT_SCHEMA, answer);
  if (!validation.ok) {
    throw new OperationError({
      reason: "invalid-output",
      about: [GATE_ANSWER_ELICITATION_TOOL_NAME],
      detail: validation.errors,
    });
  }
  return structuredResult(answer);
}

function nonAnswerResult(action: "decline" | "cancel" | "expired"): CallToolResult {
  const lapsed =
    action === "expired"
      ? "The elicitation's own window closed before it was answered. The gate is still open — ask again, or answer from the terminal."
      : "The menu was declined. The gate is still open, unchanged.";
  return heldAnswer({ answered: false, action, message: lapsed });
}

/** Answers a `gate_answer` call: elicits the person's choice from `gate.ask`'s menu and answers
 * under `via: "elicitation"`; a declined or expired elicitation mints nothing. */
export async function answerGateThroughElicitation(
  registry: ReadonlyMap<string, OperationDescriptor>,
  server: Pick<Server, "elicitInput">,
  context: OperationContext,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const input = args as unknown as GateAnswerElicitationInput;
  const opened = await openWorkspace(context);
  const { options } = askMenu(opened, input.pending as never);

  const field = titledSingleSelect(
    "Disposition",
    options.map((option) => ({ const: option.value, title: option.description })),
  );
  // Refuses every name a run treats as secret: the bindings file's and the project layer's.
  const layerSecretNames = [...opened.layerDeclarations]
    .filter(([, declaration]) => declaration.secret)
    .map(([name]) => name);
  const outcome = await elicitGateAnswer(server, {
    message: "How should this gate be dispositioned?",
    field,
    secretNames: [...(await secretBindingNames(context.workspace)), ...layerSecretNames],
  });

  if (!outcome.answered) {
    return nonAnswerResult(outcome.action);
  }

  const chosen = options.find((option) => option.value === outcome.value);
  const descriptor = registry.get(GATE_ANSWER_OPERATION_KEY);
  if (descriptor === undefined) {
    throw new Error(`no operation registered for ${GATE_ANSWER_OPERATION_KEY}`);
  }

  const output = await runHandler(
    descriptor,
    {
      pending: input.pending,
      brief: input.brief,
      choice: outcome.value,
      reason: input.reason ?? chosen?.description ?? outcome.value,
    },
    // The person answering is the one the server was launched for: its key, else its name.
    { ...context, via: "elicitation", ...principalNameFromEnvironment() },
  );
  return heldAnswer(output);
}
