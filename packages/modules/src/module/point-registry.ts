import type { IndexDb, IndexedContribution } from "@musai/fold";
import { type ContributionEntry, isPointName, KernelError, SchemaCompiler } from "@musai/records";
import { type ContributionPoint, isPointRole, kernelPoint } from "../rule/envelope.js";
import { onFirstUse } from "./on-first-use.js";

export type PointRegistry = ReadonlyMap<string, ContributionPoint>;

/** Raised when a `point` contribution cannot become a point, or one name is declared twice. */
export class PointRefusedError extends KernelError {
  constructor(message: string, about?: readonly string[]) {
    super({ reason: "invalid-input", detail: message, about });
    this.name = "PointRefusedError";
  }
}

const schemas = new SchemaCompiler();

interface PointOperand {
  readonly input: unknown;
  readonly output: unknown;
  readonly role: unknown;
}

const pointOperand = onFirstUse(() =>
  schemas.compile<PointOperand>(kernelPoint("point")!.input as Record<string, unknown> | boolean),
);

/** The `point` operand admits any value, so one that does not compile is refused here. */
function compilesAsSchema(value: unknown): value is ContributionPoint["input"] {
  try {
    schemas.compile(value as Record<string, unknown> | boolean);
    return true;
  } catch {
    return false;
  }
}

/** A point's name is its contribution id; its `input` carries `{ input, output, role }`. */
function pointDeclarationFromEntry(entry: ContributionEntry): ContributionPoint {
  if (!isPointName(entry.id)) {
    throw new PointRefusedError(
      `refusing to register ${entry.id}: a point's name, its contribution id, must carry no whitespace`,
    );
  }
  const operand = entry.input;
  const validatePointOperand = pointOperand();
  if (!validatePointOperand(operand) || !isPointRole(operand.role)) {
    throw new PointRefusedError(
      `refusing to register ${entry.id}: a point's input must declare its input and output schemas and its role: ${schemas.errorsText(validatePointOperand.errors ?? [])}`,
    );
  }
  if (!compilesAsSchema(operand.input) || !compilesAsSchema(operand.output)) {
    throw new PointRefusedError(
      `refusing to register ${entry.id}: its declared input and output must each be a JSON Schema an exchange can be validated against`,
    );
  }
  return { name: entry.id, input: operand.input, output: operand.output, role: operand.role };
}

export function pointRegistryFrom(
  declarations: readonly Pick<IndexedContribution, "entry" | "moduleName">[],
): PointRegistry {
  const registry = new Map<string, ContributionPoint>();
  for (const { entry } of declarations) {
    const point = pointDeclarationFromEntry(entry);
    if (registry.has(point.name)) {
      const declarers = [
        ...new Set(declarations.filter((each) => each.entry.id === point.name).map((each) => each.moduleName)),
      ].sort();
      throw new PointRefusedError(
        `refusing to register ${point.name}: it is declared more than once, by ${declarers.join(", ")}`,
        [point.name, ...declarers],
      );
    }
    registry.set(point.name, point);
  }
  return registry;
}

/** The contributed points, read from manifests in the fold, so no module code runs. */
export function readPointDeclarations(index: IndexDb): PointRegistry {
  return pointRegistryFrom(index.contributionsOf("point"));
}

/** The kernel table first, then the fold. A kernel name never reads the fold and cannot be
 * shadowed, since a contributed name always carries a `/`. */
export function pointFor(name: string, index: IndexDb): ContributionPoint | undefined {
  return kernelPoint(name) ?? readPointDeclarations(index).get(name);
}
