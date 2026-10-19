import type { CallToolResult } from "@musai/mcp";
import { canonicalBytes } from "@musai/records";

/** The same value as canonical text for a client that reads text, and as structured content. */
export function structuredResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: new TextDecoder().decode(canonicalBytes(value)) }],
    structuredContent: value as Record<string, unknown>,
  };
}
