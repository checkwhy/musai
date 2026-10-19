import {
  type Action,
  type EffectClass,
  isReason,
  type Reason,
  SchemaCompiler,
  type VersionString,
} from "@musai/records";
import type { OperationContext } from "./context.js";

export type { Mode, OperationContext, WorkspaceRefusal } from "./context.js";

export type JsonSchema = boolean | Record<string, unknown>;

export interface CliProjection {
  readonly verb: string;
  readonly positional: readonly string[];
  readonly flags: readonly string[];
  readonly describe: string;
  /** The noun a two-word verb hangs off, set only where the bare verb would be ambiguous. */
  readonly group?: string;
  /** The array input that takes every word after the positionals, `--` and options included,
   * and may be left out where the input does not require it. */
  readonly rest?: string;
  /** The object input `--input <file>` fills with the file's JSON, `-` reading standard input. */
  readonly input?: string;
}

/** One kernel verb, declared once and projected onto every transport. */
export interface OperationDescriptor<TInput = unknown, TOutput = unknown> {
  readonly id: string;
  readonly version: VersionString;
  readonly input: JsonSchema;
  readonly output: JsonSchema;
  readonly effect: EffectClass;
  /** Checked by `perform` before any plan applies; a finer check, such as a ruling's tier, is the
   * minting verb's own. */
  readonly authority: Action | null;
  /** `false` for a verb driving a kernel primitive with nothing to preview. */
  readonly plans: boolean;
  /** The closed set of refusals it may emit. */
  readonly reasons: readonly Reason[];
  readonly documentation: string;
  /** Its input fields, dotted, that name a file or directory on this machine. */
  readonly paths?: readonly string[];
  /** Its top-level input fields a person types as text a record states, composed to NFC first. */
  readonly statements?: readonly string[];
  /** It works in what this machine keeps for its author, so no surface launched with a clearance
   * offers it. */
  readonly authorOnly?: boolean;
  readonly cli: CliProjection;
  renderText(output: TOutput): string;
  /** A failing report says so through its output, so an exit code stays a rendering concern. */
  exitCode(output: TOutput): number;
  handler(input: TInput, context: OperationContext): Promise<TOutput>;
}

export class DuplicateOperationError extends Error {
  constructor(first: OperationDescriptor, second: OperationDescriptor) {
    super(
      `two operations declare ${first.id}@${first.version}: "${first.documentation}" and "${second.documentation}"`,
    );
    this.name = "DuplicateOperationError";
  }
}

function registryKey(descriptor: Pick<OperationDescriptor, "id" | "version">): string {
  return `${descriptor.id}@${descriptor.version}`;
}

/** The lookup every surface projects from, in ascending `id@version` order so listings are
 * byte-stable. */
export function buildRegistry(
  descriptors: readonly OperationDescriptor[],
  deprecated: ReadonlySet<Reason>,
): ReadonlyMap<string, OperationDescriptor> {
  const sorted = [...descriptors].sort((a, b) => {
    const keyA = registryKey(a);
    const keyB = registryKey(b);
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });
  const registry = new Map<string, OperationDescriptor>();
  for (const descriptor of sorted) {
    const key = registryKey(descriptor);
    const existing = registry.get(key);
    if (existing !== undefined) {
      throw new DuplicateOperationError(existing, descriptor);
    }
    if (descriptor.cli === undefined) {
      throw new Error(`operation ${key} declares no CLI projection`);
    }
    for (const reason of descriptor.reasons) {
      if (!isReason(reason)) {
        throw new Error(`operation ${key} declares a reason outside the kernel's closed vocabulary: ${String(reason)}`);
      }
      if (deprecated.has(reason)) {
        throw new Error(`operation ${key} declares a deprecated reason, never newly declarable: ${reason}`);
      }
    }
    registry.set(key, descriptor);
  }
  return registry;
}

export function lookupOperation(
  registry: ReadonlyMap<string, OperationDescriptor>,
  id: string,
  version: VersionString,
): OperationDescriptor {
  const key = `${id}@${version}`;
  const found = registry.get(key);
  if (found === undefined) {
    throw new Error(`no operation registered at ${key}`);
  }
  return found;
}

const schemas = new SchemaCompiler();

export type OperationInputValidation = { readonly ok: true } | { readonly ok: false; readonly errors: string };
export type OperationOutputValidation = { readonly ok: true } | { readonly ok: false; readonly errors: string };

export function validateOperationInput(descriptor: OperationDescriptor, input: unknown): OperationInputValidation {
  const validate = schemas.compile(descriptor.input);
  if (validate(input)) {
    return { ok: true };
  }
  return { ok: false, errors: schemas.errorsText(validate.errors) };
}

export function validateOperationOutput(descriptor: OperationDescriptor, output: unknown): OperationOutputValidation {
  const validate = schemas.compile(descriptor.output);
  if (validate(output)) {
    return { ok: true };
  }
  return { ok: false, errors: schemas.errorsText(validate.errors) };
}

export type SchemaValidation = { readonly ok: true } | { readonly ok: false; readonly errors: string };

export function validateAgainstSchema(schema: JsonSchema, value: unknown): SchemaValidation {
  const validate = schemas.compile(schema);
  if (validate(value)) {
    return { ok: true };
  }
  return { ok: false, errors: schemas.errorsText(validate.errors) };
}
