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
import { noWorkspaceRefusal, type ReadGuard, refusalCrossingAsRpcError } from "./refusal.js";

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

/** The server must declare the `resources` capability first, or the SDK refuses the handlers;
 * where no workspace stands, none is listed and a read is refused before `read` runs. */
export function registerResourceHandlers(
  server: Server,
  resources: McpResources,
  session: McpResourceSession,
  guard: ReadGuard,
): void {
  server.setRequestHandler(ListResourcesRequestSchema, () =>
    refusalCrossingAsRpcError(() =>
      guard(async (makers) => ({ resources: makers === undefined ? [...resources.resources] : [] })),
    ),
  );

  server.setRequestHandler(ListResourceTemplatesRequestSchema, () =>
    refusalCrossingAsRpcError(() =>
      guard(async (makers) => ({ resourceTemplates: makers === undefined ? [...resources.templates] : [] })),
    ),
  );

  server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
    closingWorkspaces(() =>
      refusalCrossingAsRpcError(() =>
        guard(async (makers) => {
          const { uri } = request.params;
          if (makers !== undefined) {
            throw noWorkspaceRefusal("no-such-record", uri, session.context.workspace, makers);
          }
          return resources.read(session, uri);
        }),
      ),
    ),
  );
}
