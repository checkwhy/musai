import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { NamedManifest, OperationDescriptor } from "@musai/api-core";
import type { ContributionEntry } from "@musai/records";

/** Spelled as DESIGN.md's tool list spells it: `noun.verb` becomes `noun_verb`. */
export function toolNameFor(descriptor: Pick<OperationDescriptor, "id">): string {
  return descriptor.id.replaceAll(".", "_");
}

/** MCP types a tool's schemas as objects, and a client rejects a list carrying a boolean one. */
function objectSchemaOrUndefined(schema: OperationDescriptor["output"]): Tool["outputSchema"] | undefined {
  return typeof schema === "object" && schema !== null ? (schema as Tool["outputSchema"]) : undefined;
}

export function toolsFromRegistry(registry: ReadonlyMap<string, OperationDescriptor>): Tool[] {
  return [...registry.values()].map((descriptor): Tool => {
    const outputSchema = objectSchemaOrUndefined(descriptor.output);
    return {
      name: toolNameFor(descriptor),
      description: descriptor.documentation,
      inputSchema: descriptor.input as Tool["inputSchema"],
      ...(outputSchema === undefined ? {} : { outputSchema }),
    };
  });
}

export function contributionToolNameFor(entry: Pick<ContributionEntry, "id">): string {
  return entry.id.replaceAll(".", "_").replaceAll("/", "_");
}

/** Shape decides whether a contribution projects, never its kind: some kinds carry plain data. */
function isMcpObjectSchema(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)["type"] === "object"
  );
}

/** Names both claimants, since preferring either would hide the collision from the one who lost. */
export class DuplicateToolNameError extends Error {
  constructor(name: string, moduleA: string, moduleB: string) {
    super(
      `refusing to project a tool named ${name}: both ${moduleA} and ${moduleB} declare a contribution projecting to it`,
    );
    this.name = "DuplicateToolNameError";
  }
}

export interface ProjectedContribution {
  readonly moduleName: string;
  readonly entry: ContributionEntry;
  readonly tool: Tool;
}

/** Sorted by contribution id, so two reads at one head are byte-equal. */
export function manifestContributionProjections(manifests: readonly NamedManifest[]): ProjectedContribution[] {
  const entries = manifests
    .flatMap((named) => named.manifest.contributions.map((entry) => ({ moduleName: named.moduleName, entry })))
    .sort((a, b) => (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0));

  const claimedBy = new Map<string, string>();
  const projections: ProjectedContribution[] = [];
  for (const { moduleName, entry } of entries) {
    if (!isMcpObjectSchema(entry.input)) {
      continue;
    }
    const name = contributionToolNameFor(entry);
    const owner = claimedBy.get(name);
    if (owner !== undefined) {
      throw new DuplicateToolNameError(name, owner, moduleName);
    }
    claimedBy.set(name, moduleName);
    // An operation answers with the applied plan, not the plan its output schema describes.
    const outputSchema =
      entry.kind !== "operation" && isMcpObjectSchema(entry.output)
        ? (entry.output as Tool["outputSchema"])
        : undefined;
    projections.push({
      moduleName,
      entry,
      tool: {
        name,
        description: entry.documentation,
        inputSchema: entry.input as Tool["inputSchema"],
        ...(outputSchema === undefined ? {} : { outputSchema }),
      },
    });
  }
  return projections;
}

/** Refused where a contribution would shadow a built-in tool a caller already trusts. */
export function toolsFromManifests(
  registry: ReadonlyMap<string, OperationDescriptor>,
  manifests: readonly NamedManifest[],
): Tool[] {
  const projections = manifestContributionProjections(manifests);
  for (const descriptor of registry.values()) {
    const name = toolNameFor(descriptor);
    const collision = projections.find((projection) => projection.tool.name === name);
    if (collision !== undefined) {
      throw new DuplicateToolNameError(name, "the distribution's own operations", collision.moduleName);
    }
  }
  return projections.map((projection) => projection.tool);
}
