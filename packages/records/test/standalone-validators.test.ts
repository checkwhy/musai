import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Ajv, type ValidateFunction } from "ajv";
import { afterAll, describe, expect, test } from "vitest";
import { SCHEMA_COMPILER_OPTIONS } from "../src/conditions/schema-compiler-options.js";

const { standaloneAjv, standaloneModule } = (await import(
  new URL("../scripts/standalone-validators.mjs", import.meta.url).href
)) as {
  readonly standaloneAjv: () => Ajv;
  readonly standaloneModule: (ajv: Ajv, refs: Record<string, string>) => string;
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "mode"],
  properties: {
    name: { type: "string", minLength: 2, maxLength: 3, pattern: "^[a-z\\u{1F600}]+$" },
    mode: { enum: [{ kind: "a" }, { kind: "b" }] },
    tags: { type: "array", uniqueItems: true },
  },
};

const VALUES: readonly unknown[] = [
  { name: "ab", mode: { kind: "a" } },
  { name: "\u{1F600}\u{1F600}", mode: { kind: "b" } },
  { name: "\u{1F600}", mode: { kind: "a" } },
  { name: "abcd", mode: { kind: "c" }, extra: 1 },
  { name: "ab", mode: { kind: "a" }, tags: [{ x: 1 }, { x: 1 }] },
  { mode: "a" },
  "not an object",
];

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("standaloneModule", () => {
  test("writes a validator answering every value with the verdict and errors Ajv's compile gives", async () => {
    const ajv = standaloneAjv();
    ajv.addSchema(SCHEMA, "v0");
    const dir = await mkdtemp(join(tmpdir(), "musai-standalone-"));
    dirs.push(dir);
    const path = join(dir, "validators.mjs");
    await writeFile(path, standaloneModule(ajv, { v0: "v0" }));
    const { v0 } = (await import(pathToFileURL(path).href)) as { readonly v0: ValidateFunction };
    const compiled = new Ajv(SCHEMA_COMPILER_OPTIONS).compile(SCHEMA);
    for (const value of VALUES) {
      expect(v0(value)).toBe(compiled(value));
      expect(v0.errors).toEqual(compiled.errors);
    }
  });
});
