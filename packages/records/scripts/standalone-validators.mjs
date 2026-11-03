import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Ajv } from "ajv";
import standaloneCode from "ajv/dist/standalone/index.js";
import { SCHEMA_COMPILER_OPTIONS } from "../src/conditions/schema-compiler-options.ts";

// Ajv's standalone code loads its runtime helpers with `require`, which an ES module lacks.
const EQUAL_REQUIRE = 'require("ajv/dist/runtime/equal").default';
// Inlined, since a default import of this CommonJS module differs between Node and a bundler.
const UCS2LENGTH_REQUIRE = 'require("ajv/dist/runtime/ucs2length").default';
const ucs2length = createRequire(import.meta.url)("ajv/dist/runtime/ucs2length").default;

/** An Ajv compiling as `SchemaCompiler` does, keeping each validator's source. */
export function standaloneAjv() {
  return new Ajv({ ...SCHEMA_COMPILER_OPTIONS, code: { source: true, esm: true } });
}

/** Ajv's standalone code for `refs` as an ES module, its runtime helpers mapped. */
export function standaloneModule(ajv, refs) {
  const code = standaloneCode.default(ajv, refs);
  const equal = code.includes(EQUAL_REQUIRE);
  const mapped = code.replaceAll(EQUAL_REQUIRE, "equal").replaceAll(UCS2LENGTH_REQUIRE, `(${ucs2length.toString()})`);
  if (mapped.includes("require(")) {
    throw new Error("ajv's standalone code loads runtime helpers this script does not map");
  }
  return `${equal ? 'import equal from "fast-deep-equal";' : ""}${mapped}\n`;
}

/** Writes each `[path, text]`, or with `--check` names each whose file differs from its text. */
export function writeOrCheck(files, regenerate) {
  if (process.argv.includes("--check")) {
    const stale = files.filter(([path, text]) => readFileSync(path, "utf8") !== text).map(([path]) => path);
    if (stale.length > 0) {
      console.error(`stale against ajv: ${stale.join(", ")}; run ${regenerate} to regenerate`);
      process.exitCode = 1;
    }
    return;
  }
  for (const [path, text] of files) {
    writeFileSync(path, text);
  }
}
