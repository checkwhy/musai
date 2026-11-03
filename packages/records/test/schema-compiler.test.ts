import { Ajv, type ValidateFunction } from "ajv";
import { afterEach, describe, expect, test, vi } from "vitest";
import { admitPrecompiledValidators, SchemaCompiler } from "../src/conditions/schema-compiler.js";
import { SCHEMA_COMPILER_OPTIONS } from "../src/conditions/schema-compiler-options.js";
import { type SlotDeclaration, validateSlotValue } from "../src/conditions/slot-contribution.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const freshObjectSchema = () => ({ type: "object", required: ["name"], properties: { name: { type: "string" } } });

describe("SchemaCompiler", () => {
  test("compiles a schema of one content once however many fresh objects carry it", () => {
    const compile = vi.spyOn(Ajv.prototype, "compile");
    const compiler = new SchemaCompiler();
    const validators = Array.from({ length: 50 }, () => compiler.compile(freshObjectSchema()));
    expect(compile).toHaveBeenCalledTimes(1);
    expect(new Set(validators).size).toBe(1);
  });

  test("keeps schemas of different content apart", () => {
    const compiler = new SchemaCompiler();
    const needsName = compiler.compile(freshObjectSchema());
    const needsNothing = compiler.compile({ type: "object" });
    expect(needsName({})).toBe(false);
    expect(needsNothing({})).toBe(true);
  });

  test("keeps no entry for a schema that does not compile", () => {
    const compiler = new SchemaCompiler();
    compiler.compile({ type: "string" });
    const cache = (compiler as unknown as { readonly ajv: { readonly _cache: ReadonlyMap<unknown, unknown> } }).ajv
      ._cache;
    const before = cache.size;
    expect(() => compiler.compile({ type: "not-a-type" })).toThrow();
    expect(cache.size).toBe(before);
  });
});

describe("SchemaCompiler's precompiled validators", () => {
  test("answers a schema of an admitted content with its admitted validator, compiling nothing", () => {
    const content = { type: "object", required: ["admitted"] };
    const admitted = (() => true) as unknown as ValidateFunction;
    admitPrecompiledValidators(new Map([[JSON.stringify(content), admitted]]));
    const compile = vi.spyOn(Ajv.prototype, "compile");
    expect(new SchemaCompiler().compile({ type: "object", required: ["admitted"] })).toBe(admitted);
    expect(compile).not.toHaveBeenCalled();
  });

  test("compiles a schema whose content differs from every admitted one by a key's order", () => {
    const admitted = (() => true) as unknown as ValidateFunction;
    admitPrecompiledValidators(new Map([[JSON.stringify({ type: "string", minLength: 2 }), admitted]]));
    expect(new SchemaCompiler().compile({ minLength: 2, type: "string" })("a")).toBe(false);
  });
});

describe("SchemaCompiler errors and reuse", () => {
  test("reports a schema that is neither an object nor a boolean as Ajv does", () => {
    const compiler = new SchemaCompiler();
    expect(() => compiler.compile(5 as unknown as boolean)).toThrow(/object or boolean/);
  });

  test("serialises a schema object only the first time it is compiled", () => {
    const compiler = new SchemaCompiler();
    const schema = freshObjectSchema();
    compiler.compile(schema);
    const stringify = vi.spyOn(JSON, "stringify");
    for (let call = 0; call < 50; call += 1) {
      compiler.compile(schema);
    }
    expect(stringify).not.toHaveBeenCalled();
  });
});

const INVALID_SCHEMAS: readonly Record<string, unknown>[] = [
  { type: "not-a-type" },
  { type: ["string", 3] },
  { minLength: -1 },
  { maxItems: 1.5 },
  { required: "name" },
  { required: ["a", "a"] },
  { properties: { name: { type: "nope" } }, additionalProperties: 4 },
  { items: [{ type: "string" }, { enum: [] }] },
  { pattern: 7, format: 3, $comment: 5 },
  { allOf: [] },
  { definitions: { a: { multipleOf: 0 } }, dependencies: { a: 3 } },
];

describe("SchemaCompiler's meta-schema check", () => {
  test("refuses each invalid schema with the message Ajv's own meta-schema check gives", () => {
    for (const schema of INVALID_SCHEMAS) {
      const ours = (() => {
        try {
          new SchemaCompiler().compile(schema);
        } catch (error) {
          return (error as Error).message;
        }
        return "compiled";
      })();
      expect(() => new Ajv(SCHEMA_COMPILER_OPTIONS).compile(schema)).toThrow(ours);
      expect(ours).toMatch(/^schema is invalid: /);
    }
  });

  test("compiles no meta-schema at run time for a schema that names none", () => {
    const getSchema = vi.spyOn(Ajv.prototype, "getSchema");
    new SchemaCompiler().compile(freshObjectSchema());
    expect(getSchema).not.toHaveBeenCalled();
  });

  test("checks a schema that names its own $schema the way Ajv does", () => {
    const schema = { $schema: "http://json-schema.org/draft-07/schema#", type: "not-a-type" };
    expect(() => new SchemaCompiler().compile(schema)).toThrow(/^schema is invalid: data\/type /);
    expect(() => new SchemaCompiler().compile({ $schema: "https://example.org/unknown", type: "string" })).toThrow(
      'no schema with key or ref "https://example.org/unknown"',
    );
  });
});

describe("validateSlotValue", () => {
  test("compiles a slot schema once however often the fold hands it back as a fresh object", () => {
    const compile = vi.spyOn(Ajv.prototype, "compile");
    for (let read = 0; read < 20; read += 1) {
      const declaration: SlotDeclaration = {
        id: "pack/limit",
        schema: { type: "string" },
        hasDefault: false,
        default: undefined,
        documentation: "a limit",
        layers: ["project"],
      };
      validateSlotValue(declaration, "ten");
    }
    expect(compile).toHaveBeenCalledTimes(1);
  });
});
