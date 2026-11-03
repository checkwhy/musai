import { Ajv, type AnySchema, type ErrorObject, type ValidateFunction } from "ajv";
import validateDraft07 from "./draft-07-meta.js";
import { SCHEMA_COMPILER_OPTIONS } from "./schema-compiler-options.js";

/** Checks a schema with no `$schema` of its own against the draft-07 meta-schema compiled at build
 * time, which Ajv otherwise compiles in every process that compiles a schema. */
class PrecompiledMetaAjv extends Ajv {
  override validateSchema(schema: AnySchema, throwOrLogError?: boolean): boolean | Promise<unknown> {
    if (typeof schema === "boolean" || schema.$schema !== undefined) {
      return super.validateSchema(schema, throwOrLogError);
    }
    const valid = validateDraft07(schema);
    this.errors = validateDraft07.errors ?? null;
    if (!valid && throwOrLogError) {
      throw new Error(`schema is invalid: ${this.errorsText()}`);
    }
    return valid;
  }
}

let sharedAjv: PrecompiledMetaAjv | undefined;

/** Validators Ajv's standalone code built, each under its schema's `JSON.stringify` text. */
const precompiled = new Map<string, ValidateFunction>();

/** Lets every compiler answer a schema of one of these contents without compiling it. */
export function admitPrecompiledValidators(validators: ReadonlyMap<string, ValidateFunction>): void {
  for (const [content, validate] of validators) {
    precompiled.set(content, validate);
  }
}

/** Compiles each distinct schema content once: Ajv keys its cache by object identity, and a
 * manifest's schema is a fresh object per fold read. */
export class SchemaCompiler {
  // One Ajv for every compiler, made at the first compile, so loading a package builds none.
  private get ajv(): PrecompiledMetaAjv {
    sharedAjv ??= new PrecompiledMetaAjv(SCHEMA_COMPILER_OPTIONS);
    return sharedAjv;
  }
  private readonly byIdentity = new WeakMap<object, ValidateFunction>();
  private readonly byContent = new Map<string, ValidateFunction>();

  compile<T = unknown>(schema: AnySchema): ValidateFunction<T> {
    if (typeof schema === "boolean") {
      return this.ajv.compile<T>(schema);
    }
    const known = this.byIdentity.get(schema);
    if (known !== undefined) {
      return known as ValidateFunction<T>;
    }
    const content = JSON.stringify(schema);
    let validate = this.byContent.get(content) ?? precompiled.get(content);
    if (validate === undefined) {
      try {
        validate = this.ajv.compile(schema);
      } catch (error) {
        if (typeof schema === "object" && schema !== null) {
          this.ajv.removeSchema(schema);
        }
        throw error;
      }
      this.byContent.set(content, validate);
    }
    this.byIdentity.set(schema, validate);
    return validate as ValidateFunction<T>;
  }

  errorsText(errors: ErrorObject[] | null | undefined, options?: { readonly dataVar?: string }): string {
    return this.ajv.errorsText(errors, options);
  }
}
