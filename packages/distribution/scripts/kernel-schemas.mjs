#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { KERNEL_POINT_TABLE } from "@musai/modules";
import { standaloneAjv, standaloneModule, writeOrCheck } from "@musai/records/standalone-validators";
import { REGISTRY } from "../dist/index.js";

const TARGET = fileURLToPath(new URL("../src/kernel-schemas.js", import.meta.url));
const DECLARATION = fileURLToPath(new URL("../src/kernel-schemas.d.ts", import.meta.url));

const schemas = new Map();
for (const { input, output } of [...REGISTRY.values(), ...KERNEL_POINT_TABLE]) {
  for (const schema of [input, output]) {
    if (typeof schema !== "boolean") {
      schemas.set(JSON.stringify(schema), schema);
    }
  }
}

const ajv = standaloneAjv();
const refs = {};
for (const [index, schema] of [...schemas.values()].entries()) {
  ajv.addSchema(schema, `v${index}`);
  refs[`v${index}`] = `v${index}`;
}
const entries = [...schemas.keys()].map((content, index) => `[${JSON.stringify(content)},v${index}]`);
const code = `${standaloneModule(ajv, refs)}export const KERNEL_VALIDATORS = new Map([${entries.join(",")}]);\n`;

const DECLARATION_TEXT = `import type { admitPrecompiledValidators } from "@musai/records";

export declare const KERNEL_VALIDATORS: Parameters<typeof admitPrecompiledValidators>[0];
`;

writeOrCheck(
  [
    [TARGET, code],
    [DECLARATION, DECLARATION_TEXT],
  ],
  "pnpm build, then node scripts/kernel-schemas.mjs,",
);
