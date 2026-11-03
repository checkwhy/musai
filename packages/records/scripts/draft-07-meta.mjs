#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { standaloneAjv, standaloneModule, writeOrCheck } from "./standalone-validators.mjs";

const TARGET = fileURLToPath(new URL("../src/conditions/draft-07-meta.js", import.meta.url));
const DECLARATION = fileURLToPath(new URL("../src/conditions/draft-07-meta.d.ts", import.meta.url));

const META_SCHEMA_ID = "http://json-schema.org/draft-07/schema";

const ajv = standaloneAjv();

const DECLARATION_TEXT = `import type { ValidateFunction } from "ajv";

declare const validate: ValidateFunction;
export default validate;
`;

writeOrCheck(
  [
    [TARGET, standaloneModule(ajv, ajv.getSchema(META_SCHEMA_ID))],
    [DECLARATION, DECLARATION_TEXT],
  ],
  "node scripts/draft-07-meta.mjs",
);
