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

export function operationTool(descriptor: OperationDescriptor): Tool {
  const outputSchema = objectSchemaOrUndefined(descriptor.output);
  return {
    name: toolNameFor(descriptor),
    description: descriptor.documentation,
    inputSchema: descriptor.input as Tool["inputSchema"],
    ...(outputSchema === undefined ? {} : { outputSchema }),
  };
}

export interface ProjectedOperation {
  readonly key: string;
  readonly descriptor: OperationDescriptor;
  readonly tool: Tool;
}

/** Keyed by tool name, which drops the version and folds `.` into `_`, so two operations can claim
 * one; that is refused rather than dispatched to either. */
export function operationProjections(
  registry: ReadonlyMap<string, OperationDescriptor>,
): ReadonlyMap<string, ProjectedOperation> {
  const projections = new Map<string, ProjectedOperation>();
  for (const [key, descriptor] of registry) {
    const tool = operationTool(descriptor);
    const claimed = projections.get(tool.name);
    if (claimed !== undefined) {
      throw new DuplicateToolNameError(tool.name, claimed.key, key);
    }
    projections.set(tool.name, { key, descriptor, tool });
  }
  return projections;
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
  constructor(name: string, claimantA: string, claimantB: string) {
    super(`refusing to project a tool named ${name}: both ${claimantA} and ${claimantB} project to it`);
    this.name = "DuplicateToolNameError";
  }
}

export interface ProjectedContribution {
  readonly moduleName: string;
  readonly entry: ContributionEntry;
  readonly tool: Tool;
}

/** A tool name two or more claim, with every claimant, since preferring one would hide the
 * collision from the others. */
export interface ToolNameCollision {
  readonly name: string;
  readonly claimants: readonly string[];
}

export interface ContributionProjections {
  readonly projected: readonly ProjectedContribution[];
  readonly collisions: readonly ToolNameCollision[];
}

interface Candidate {
  readonly moduleName: string;
  readonly entry: ContributionEntry;
}

function claimantOf(candidate: Candidate): string {
  return `${candidate.moduleName}'s ${candidate.entry.id}`;
}

/** Sorted by contribution id, so two reads at one head are byte-equal; a name two contributions
 * claim projects neither. */
export function manifestContributionProjections(manifests: readonly NamedManifest[]): ContributionProjections {
  const claimed = new Map<string, { readonly first: Candidate; readonly claimants: string[] }>();
  const entries = manifests
    .flatMap((named) => named.manifest.contributions.map((entry) => ({ moduleName: named.moduleName, entry })))
    .sort((a, b) => (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0));
  for (const candidate of entries) {
    if (isMcpObjectSchema(candidate.entry.input)) {
      const name = contributionToolNameFor(candidate.entry);
      const held = claimed.get(name);
      if (held === undefined) {
        claimed.set(name, { first: candidate, claimants: [claimantOf(candidate)] });
      } else {
        held.claimants.push(claimantOf(candidate));
      }
    }
  }

  const projections: ProjectedContribution[] = [];
  const collisions: ToolNameCollision[] = [];
  for (const [name, { first, claimants }] of claimed) {
    if (claimants.length > 1) {
      collisions.push({ name, claimants });
      continue;
    }
    const { moduleName, entry } = first;
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
  return { projected: projections, collisions };
}

/** A contribution never shadows a built-in tool a caller already trusts: the operation keeps the
 * name, and the claim is reported as a collision. */
export function contributionProjections(
  registry: ReadonlyMap<string, OperationDescriptor>,
  manifests: readonly NamedManifest[],
): ContributionProjections {
  const { projected, collisions } = manifestContributionProjections(manifests);
  const operations = operationProjections(registry);
  const operationClaim = (name: string): string[] => {
    const operation = operations.get(name);
    return operation === undefined ? [] : [`the distribution's own operation ${operation.key}`];
  };
  return {
    projected: projected.filter((projection) => !operations.has(projection.tool.name)),
    collisions: [
      ...collisions.map(({ name, claimants }) => ({ name, claimants: [...operationClaim(name), ...claimants] })),
      ...projected
        .filter((projection) => operations.has(projection.tool.name))
        .map((projection) => ({
          name: projection.tool.name,
          claimants: [...operationClaim(projection.tool.name), claimantOf(projection)],
        })),
    ],
  };
}
