import { Ajv, type AnySchema, type ErrorObject, type ValidateFunction } from "ajv";

/** Compiles each distinct schema content once: Ajv keys its cache by object identity, and a
 * manifest's schema is a fresh object per fold read. */
export class SchemaCompiler {
  // No schema is registered under its `$id`: the same content arrives again as another object.
  private readonly ajv = new Ajv({ strict: false, allErrors: true, addUsedSchema: false });
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
    let validate = this.byContent.get(content);
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
