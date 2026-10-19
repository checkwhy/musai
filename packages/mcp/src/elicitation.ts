import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  type ElicitRequestFormParams,
  type ElicitResult,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { assertNoSecretField } from "@musai/api-core";

export interface TitledSingleSelectOption {
  readonly const: string;
  readonly title: string;
}

/** `oneOf` of `{const, title}`, since the pinned SDK types mark `enum`-plus-names for removal. */
export function titledSingleSelect(
  title: string,
  options: readonly TitledSingleSelectOption[],
): Record<string, unknown> {
  return {
    type: "string",
    title,
    oneOf: options.map((option) => ({ const: option.const, title: option.title })),
  };
}

/** `expired` means nobody chose, kept apart from a person's `decline`; neither is an answer. */
export type ElicitationOutcome =
  | { readonly answered: true; readonly value: string }
  | { readonly answered: false; readonly action: "decline" | "cancel" | "expired" };

export interface ElicitGateAnswerOptions {
  readonly message: string;
  readonly field: Record<string, unknown>;
  readonly secretNames?: readonly string[];
}

const ANSWER_PROPERTY = "answer";

/** Matched by error code, never by message text a later SDK release might reword. */
function isElicitationTimeout(error: unknown): boolean {
  return error instanceof McpError && error.code === ErrorCode.RequestTimeout;
}

/** A client's timeout answers `expired`; none is set from this side, since the window is the
 * client's and a receipt must not depend on transport patience. */
export async function elicitGateAnswer(
  server: Pick<Server, "elicitInput">,
  options: ElicitGateAnswerOptions,
): Promise<ElicitationOutcome> {
  const requestedSchema = {
    type: "object" as const,
    properties: { [ANSWER_PROPERTY]: options.field },
    required: [ANSWER_PROPERTY],
  };
  assertNoSecretField(requestedSchema, options.secretNames ?? []);

  let result: ElicitResult;
  try {
    result = await server.elicitInput({
      mode: "form",
      message: options.message,
      requestedSchema: requestedSchema as unknown as ElicitRequestFormParams["requestedSchema"],
    });
  } catch (error) {
    if (isElicitationTimeout(error)) {
      return { answered: false, action: "expired" };
    }
    throw error;
  }

  if (result.action !== "accept") {
    return { answered: false, action: result.action };
  }
  const content = result.content ?? {};
  return { answered: true, value: String(content[ANSWER_PROPERTY]) };
}
