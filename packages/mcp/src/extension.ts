import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  type CallToolResult,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplate,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { closingWorkspaces, type Distribution, type OperationContext } from "@musai/api-core";
import { refusalCrossingAsRpcError } from "./refusal.js";

/** Frozen, each read a copy: an extension cannot register over the generic dispatch or change the
 * principal a later projected call runs under. */
export type McpExtensionServer = Pick<Server, "elicitInput" | "getClientCapabilities" | "getClientVersion">;

/** Built once and frozen, and shared rather than copied: the server reads the same distribution
 * and context for every later call. */
export interface McpResourceSession {
  readonly distribution: McpDistribution;
  readonly context: OperationContext;
}

export interface McpToolSession extends McpResourceSession {
  readonly server: McpExtensionServer;
}

/** Listed in place of any projected tool of its name; its arguments are validated against its
 * `inputSchema` and its call logged, and the server adds it no `via` or principal. */
export interface McpExtensionTool {
  readonly tool: Tool;
  call(session: McpToolSession, args: Record<string, unknown>): Promise<CallToolResult>;
}

export interface McpResources {
  readonly resources: readonly Resource[];
  readonly templates: readonly ResourceTemplate[];
  read(session: McpResourceSession, uri: string): Promise<ReadResourceResult>;
}

/** The server declares the resources capability only when resources are here. */
export interface McpExtension {
  readonly tools: readonly McpExtensionTool[];
  readonly resources?: McpResources;
}

export interface McpDistribution extends Distribution {
  readonly extensions?: { readonly mcp?: McpExtension };
}

/** The server must declare the `resources` capability first, or the SDK refuses the handlers.
 * `beforeRead` runs ahead of every read, and its refusal is the read's. */
export function registerResourceHandlers(
  server: Server,
  resources: McpResources,
  session: McpResourceSession,
  beforeRead: () => Promise<void> = async () => {},
): void {
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [...resources.resources] }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [...resources.templates],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
    closingWorkspaces(() =>
      refusalCrossingAsRpcError(async () => {
        await beforeRead();
        return resources.read(session, request.params.uri);
      }),
    ),
  );
}
