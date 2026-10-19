import type { Audience } from "@musai/records";
import type { OperationContext } from "./context.js";
import { OperationError } from "./errors.js";
import type { JsonSchema, OperationDescriptor } from "./registry.js";

type ObjectSchema = { readonly properties?: Record<string, JsonSchema>; readonly required?: readonly string[] };

function objectSchema(schema: JsonSchema | undefined): ObjectSchema | undefined {
  return typeof schema === "object" && schema !== null ? (schema as ObjectSchema) : undefined;
}

/** Whether the input must carry `path`: each of its segments required where it is declared. */
function requires(schema: JsonSchema, path: string): boolean {
  let at: JsonSchema | undefined = schema;
  for (const segment of path.split(".")) {
    const object = objectSchema(at);
    if (object?.required?.includes(segment) !== true) {
      return false;
    }
    at = object.properties?.[segment];
  }
  return true;
}

function present(input: unknown, path: string): boolean {
  let at = input;
  for (const segment of path.split(".")) {
    if (typeof at !== "object" || at === null || !(segment in at)) {
      return false;
    }
    at = (at as Record<string, unknown>)[segment];
  }
  return at !== undefined;
}

function withoutField(schema: JsonSchema, path: string): JsonSchema {
  const object = objectSchema(schema);
  const [segment, ...rest] = path.split(".");
  const field = object?.properties?.[segment!];
  if (object === undefined || field === undefined) {
    return schema;
  }
  const { [segment!]: _, ...others } = object.properties!;
  const properties = rest.length === 0 ? others : { ...others, [segment!]: withoutField(field, rest.join(".")) };
  return { ...object, properties };
}

/** A clearance hides records from a station's fold, not files from its process, so a station is
 * handed no file by path and nothing this machine keeps for its author. */
export function refuseUnderClearance(descriptor: OperationDescriptor, input: unknown, context: OperationContext): void {
  const { clearance } = context;
  if (clearance === undefined) {
    return;
  }
  const key = `${descriptor.id}@${descriptor.version}`;
  if (descriptor.authorOnly === true) {
    throw new OperationError({
      reason: "invalid-input",
      about: [key],
      detail: `${key} works in what this machine keeps for its author, and a surface cleared to ${clearance} is handed none: call it from a surface launched with no clearance`,
    });
  }
  const given = descriptor.paths?.find((path) => present(input, path));
  if (given !== undefined) {
    throw pathRefusal(key, given, clearance);
  }
}

/** `--input <file>` is read from this machine by path, so the CLI refuses it before opening the
 * file; `-` names standard input. */
export function refuseInputFileUnderClearance(
  descriptor: OperationDescriptor,
  file: string,
  context: OperationContext,
): void {
  if (context.clearance !== undefined && file !== "-") {
    throw pathRefusal(`${descriptor.id}@${descriptor.version}`, "--input", context.clearance);
  }
}

function pathRefusal(key: string, field: string, clearance: Audience): OperationError {
  return new OperationError({
    reason: "invalid-input",
    about: [key, field],
    detail: `${key} reads ${field} from this machine by path, and a surface cleared to ${clearance} is handed no file or directory: call it from a surface launched with no clearance`,
  });
}

/** The operations a surface cleared to an audience offers: none that must be handed a path or
 * works for the author alone, and no optional path field on the rest. */
export function operationsUnderClearance(
  registry: ReadonlyMap<string, OperationDescriptor>,
  clearance: Audience | undefined,
): ReadonlyMap<string, OperationDescriptor> {
  if (clearance === undefined) {
    return registry;
  }
  const offered = new Map<string, OperationDescriptor>();
  for (const [key, descriptor] of registry) {
    const paths = descriptor.paths ?? [];
    if (descriptor.authorOnly !== true && !paths.some((path) => requires(descriptor.input, path))) {
      offered.set(key, { ...descriptor, input: paths.reduce(withoutField, descriptor.input) });
    }
  }
  return offered;
}
