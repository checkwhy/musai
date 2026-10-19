import { isPlainObject } from "@musai/records";
import { OperationError } from "./errors.js";

export class SecretInElicitationError extends OperationError {
  constructor(fieldPath: string) {
    super({
      reason: "invalid-input",
      about: [fieldPath],
      detail: `elicitation requested schema names "${fieldPath}", a field marked secret — form-mode data is visible to the client and the model by specification, so a secret reaching it would be disclosed by design`,
    });
    this.name = "SecretInElicitationError";
  }
}

function isMarkedSecret(schema: unknown): boolean {
  return typeof schema === "object" && schema !== null && (schema as Record<string, unknown>)["secret"] === true;
}

function walk(schema: unknown, path: readonly string[], secretNames: ReadonlySet<string>): void {
  if (typeof schema !== "object" || schema === null) {
    return;
  }
  const node = schema as Record<string, unknown>;

  const properties = node["properties"];
  if (isPlainObject(properties)) {
    for (const [name, sub] of Object.entries(properties)) {
      const fieldPath = [...path, name];
      if (secretNames.has(name) || isMarkedSecret(sub)) {
        throw new SecretInElicitationError(fieldPath.join("."));
      }
      walk(sub, fieldPath, secretNames);
    }
  }

  const items = node["items"];
  if (items !== undefined) {
    walk(items, path, secretNames);
  }

  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    const branch = node[key];
    if (Array.isArray(branch)) {
      for (const sub of branch) {
        walk(sub, path, secretNames);
      }
    }
  }
}

/** Refuses a requested schema naming a declared secret or a field annotated `secret`. */
export function assertNoSecretField(requestedSchema: Record<string, unknown>, secretNames: readonly string[]): void {
  walk(requestedSchema, [], new Set(secretNames));
}
