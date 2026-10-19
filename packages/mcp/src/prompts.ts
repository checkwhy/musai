import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  GetPromptRequestSchema,
  type GetPromptResult,
  ListPromptsRequestSchema,
  type Prompt,
  type PromptArgument,
} from "@modelcontextprotocol/sdk/types.js";
import {
  closingWorkspaces,
  installedManifests,
  invokeContribution,
  type NamedManifest,
  type OperationContext,
  OperationError,
  openWorkspace,
} from "@musai/api-core";
import type { ContributionEntry } from "@musai/records";
import { contributionToolNameFor } from "./project.js";
import { refusalCrossingAsRpcError } from "./refusal.js";

/** A `template` renders text from an input, the one kernel shape a prompt's `get` answers with. */
const PROMPT_CONTRIBUTION_KIND = "template";

function isObjectSchema(
  value: unknown,
): value is { readonly properties?: Record<string, unknown>; readonly required?: readonly string[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)["type"] === "object"
  );
}

function promptArgumentsFrom(entry: ContributionEntry): PromptArgument[] {
  if (!isObjectSchema(entry.input)) {
    return [];
  }
  const required = new Set(entry.input.required ?? []);
  return Object.keys(entry.input.properties ?? {}).map((name) => ({ name, required: required.has(name) }));
}

interface ProjectedPrompt {
  readonly moduleName: string;
  readonly entry: ContributionEntry;
  readonly prompt: Prompt;
}

/** Sorted by contribution id, as the tool list is, so two reads at one head are byte-equal. */
function promptsFromManifests(manifests: readonly NamedManifest[]): ProjectedPrompt[] {
  return manifests
    .flatMap((named) => named.manifest.contributions.map((entry) => ({ moduleName: named.moduleName, entry })))
    .filter(({ entry }) => entry.kind === PROMPT_CONTRIBUTION_KIND)
    .sort((a, b) => (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0))
    .map(({ moduleName, entry }) => ({
      moduleName,
      entry,
      prompt: {
        name: contributionToolNameFor(entry),
        description: entry.documentation,
        arguments: promptArgumentsFrom(entry),
      },
    }));
}

async function getPrompt(
  projected: readonly ProjectedPrompt[],
  context: OperationContext,
  name: string,
  args: Record<string, string>,
): Promise<GetPromptResult> {
  const found = projected.find((candidate) => candidate.prompt.name === name);
  if (found === undefined) {
    throw new OperationError({ reason: "no-such-record", about: [name], detail: `no prompt named ${name}` });
  }
  const opened = await openWorkspace(context);
  const response = await invokeContribution(opened, found.moduleName, found.entry, args);
  if (!response.ok) {
    throw new OperationError({
      reason: "no-such-record",
      about: [name],
      detail: `prompt ${name} refused: ${JSON.stringify(response.error)}`,
    });
  }
  const output = response.output as { readonly content?: unknown } | null;
  const text = output !== null && typeof output.content === "string" ? output.content : JSON.stringify(response.output);
  return {
    description: found.prompt.description,
    messages: [{ role: "user", content: { type: "text", text } }],
  };
}

/** `beforeRead` runs ahead of every list and get, and its refusal is theirs. */
export function registerPromptHandlers(
  server: Server,
  context: OperationContext,
  beforeRead: () => Promise<void> = async () => {},
): void {
  server.setRequestHandler(ListPromptsRequestSchema, () =>
    closingWorkspaces(() =>
      refusalCrossingAsRpcError(async () => {
        await beforeRead();
        const opened = await openWorkspace(context);
        const manifests = await installedManifests(opened);
        return { prompts: promptsFromManifests(manifests).map((projected) => projected.prompt) };
      }),
    ),
  );

  server.setRequestHandler(GetPromptRequestSchema, (request) =>
    closingWorkspaces(() =>
      refusalCrossingAsRpcError(async () => {
        await beforeRead();
        const opened = await openWorkspace(context);
        const manifests = await installedManifests(opened);
        const projected = promptsFromManifests(manifests);
        const args = (request.params.arguments ?? {}) as Record<string, string>;
        return getPrompt(projected, context, request.params.name, args);
      }),
    ),
  );
}
