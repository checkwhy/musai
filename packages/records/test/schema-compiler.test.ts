import { Ajv } from "ajv";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SchemaCompiler } from "../src/conditions/schema-compiler.js";
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
