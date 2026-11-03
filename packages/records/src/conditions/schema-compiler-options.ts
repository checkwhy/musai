import type { Options } from "ajv";

// No schema is registered under its `$id`: the same content arrives again as another object.
export const SCHEMA_COMPILER_OPTIONS = {
  strict: false,
  allErrors: true,
  addUsedSchema: false,
} as const satisfies Options;
