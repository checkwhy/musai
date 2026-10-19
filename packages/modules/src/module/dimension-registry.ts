import type { FoldRefusal, IndexDb, IndexedContribution } from "@musai/fold";
import type { ContributionEntry } from "@musai/records";
import {
  compareValues,
  type Dimension,
  type DimensionRegistry,
  isDimensionOrder,
  isPlainObject,
  KernelError,
} from "@musai/records";
import { Ajv, type ValidateFunction } from "ajv";
import { kernelPoint } from "../rule/envelope.js";
import { onFirstUse } from "./on-first-use.js";

/** Raised when a `dimension` contribution cannot become a dimension. */
export class DimensionRefusedError extends KernelError {
  constructor(message: string, about?: readonly string[]) {
    super({ reason: "invalid-input", detail: message, about });
    this.name = "DimensionRefusedError";
  }
}

const ajv = new Ajv({ strict: false, allErrors: true, addUsedSchema: false });

/** A declaration's `input` as canonical JSON carries it, before it becomes a `Dimension`. */
type DimensionOperand =
  | { readonly name: string; readonly type: "ordered" | "interval"; readonly data: { readonly order: string } }
  | {
      readonly name: string;
      readonly type: "dag";
      readonly data: {
        readonly edges: Record<string, string[]>;
        readonly expansions?: Record<string, { readonly first: string; readonly last: string }>;
      };
    }
  | {
      readonly name: string;
      readonly type: "hierarchical";
      readonly data: { readonly parentOf: Record<string, string | null> };
    }
  | { readonly name: string; readonly type: "identity"; readonly data: Record<string, never> };

/** One validator per dimension type, so a refusal names a clause of the type declared. */
const dimensionBranches = onFirstUse(
  (): ReadonlyMap<string, ValidateFunction<DimensionOperand>> =>
    new Map(
      (kernelPoint("dimension")!.input as { readonly oneOf: readonly Record<string, unknown>[] }).oneOf.map(
        (branch) => [
          (branch["properties"] as { readonly type: { readonly const: string } }).type.const,
          ajv.compile<DimensionOperand>(branch),
        ],
      ),
    ),
);

/** Builds the dimension one entry declares into the shape the comparison reads. */
export function dimensionFromEntry(entry: ContributionEntry): Dimension {
  const declaredType = isPlainObject(entry.input) ? entry.input["type"] : undefined;
  const branches = dimensionBranches();
  const validate = typeof declaredType === "string" ? branches.get(declaredType) : undefined;
  if (validate === undefined) {
    throw new DimensionRefusedError(
      `refusing to register ${entry.id}: a dimension must declare its type as one of ` +
        `${[...branches.keys()].join(", ")}, and this one declares ${JSON.stringify(declaredType)}`,
      [entry.id],
    );
  }
  if (!validate(entry.input)) {
    throw new DimensionRefusedError(
      `refusing to register ${entry.id}: a dimension of type ${declaredType} must declare its name and the data that ` +
        `type compares by: ${ajv.errorsText(validate.errors ?? [], { dataVar: "declaration" })}`,
      [entry.id],
    );
  }
  const declared = entry.input;
  if (declared.type === "ordered" || declared.type === "interval") {
    const { order } = declared.data;
    if (!isDimensionOrder(order)) {
      throw new DimensionRefusedError(
        `refusing to register ${entry.id}: it compares ${declared.name} under ${JSON.stringify(order)}, which is no order this kernel implements`,
        [entry.id, declared.name],
      );
    }
    return declared.type === "ordered"
      ? { name: declared.name, type: "ordered", data: { order } }
      : { name: declared.name, type: "interval", data: { order } };
  }
  if (declared.type === "dag") {
    const edges = new Map(Object.entries(declared.data.edges).map(([from, to]) => [from, new Set(to)]));
    const graph: Dimension = { name: declared.name, type: "dag", data: { edges } };
    if (declared.data.expansions === undefined) {
      return graph;
    }
    const nodes = new Set([...edges.keys(), ...[...edges.values()].flatMap((to) => [...to])]);
    for (const [coarse, { first, last }] of Object.entries(declared.data.expansions)) {
      const refuse = (why: string) =>
        new DimensionRefusedError(
          `refusing to register ${entry.id}: ${declared.name} expands ${coarse} to ${first} through ${last}, but ${why}`,
          [entry.id, coarse],
        );
      if (nodes.has(coarse)) {
        throw refuse(`${coarse} is a node of its order, and only a value outside it expands`);
      }
      const absent = [first, last].find((end) => !nodes.has(end));
      if (absent !== undefined) {
        throw refuse(`${absent} is no node of its order`);
      }
      if (!["equal", "narrower"].includes(compareValues(graph, first, last))) {
        throw refuse(`${first} cannot reach ${last}`);
      }
    }
    return { ...graph, data: { edges, expansions: new Map(Object.entries(declared.data.expansions)) } };
  }
  if (declared.type === "hierarchical") {
    return {
      name: declared.name,
      type: "hierarchical",
      data: { parentOf: new Map(Object.entries(declared.data.parentOf)) },
    };
  }
  return { name: declared.name, type: "identity", data: {} };
}

/** One entry, parsed or refused; a collision is decided over the whole set. */
type ReadDimension =
  | { readonly row: IndexedContribution; readonly dimension: Dimension; readonly reason?: undefined }
  | { readonly row: IndexedContribution; readonly dimension?: undefined; readonly reason: string };

/** The dimensions that stand, and one refusal per declaration that cannot. */
export interface DimensionDeclarations {
  readonly dimensions: DimensionRegistry;
  readonly refused: readonly FoldRefusal[];
}

/** Every declared dimension, keyed by its bare name. Nothing is thrown for the set, and a name
 * declared twice refuses every declaration of it, leaving the algebra's default. */
export function readDimensionDeclarations(index: IndexDb): DimensionDeclarations {
  const read: ReadDimension[] = index.contributionsOf("dimension").map((row) => {
    try {
      return { row, dimension: dimensionFromEntry(row.entry) };
    } catch (error) {
      if (!(error instanceof DimensionRefusedError)) {
        throw error;
      }
      return { row, reason: error.detail };
    }
  });
  const declaredBy = new Map<string, ReadDimension[]>();
  for (const each of read) {
    if (each.dimension !== undefined) {
      declaredBy.set(each.dimension.name, [...(declaredBy.get(each.dimension.name) ?? []), each]);
    }
  }
  const dimensions = new Map<string, Dimension>();
  const refused: FoldRefusal[] = [];
  for (const each of read) {
    const { entry, moduleRecord } = each.row;
    if (each.dimension === undefined) {
      refused.push({
        name: entry.id,
        contributionId: entry.id,
        moduleRecord,
        version: entry.version,
        reason: each.reason,
        settled: true,
      });
      continue;
    }
    const others = declaredBy
      .get(each.dimension.name)!
      .filter((other) => other !== each)
      .map(
        (other) => `${other.row.entry.id} at version ${other.row.entry.version}, declared by ${other.row.moduleName}`,
      );
    if (others.length === 0) {
      dimensions.set(each.dimension.name, each.dimension);
      continue;
    }
    refused.push({
      name: entry.id,
      contributionId: entry.id,
      moduleRecord,
      version: entry.version,
      reason:
        `refusing to register ${entry.id} at version ${entry.version}: it declares the dimension ${each.dimension.name}, ` +
        `which is also declared at ${others.join("; ")}, and a value compared under two declarations of one dimension ` +
        `has no one answer; every declaration of it is refused until the collision is resolved`,
      settled: true,
    });
  }
  return { dimensions, refused };
}
