import { KERNEL_POINT_TABLE } from "@musai/modules";
import { describe, expect, test } from "vitest";
import { REGISTRY } from "../src/index.js";
import { KERNEL_VALIDATORS } from "../src/kernel-schemas.js";

const kernelSchemas = [...REGISTRY.values(), ...KERNEL_POINT_TABLE]
  .flatMap(({ input, output }) => [input, output])
  .filter((schema) => typeof schema !== "boolean");

describe("the kernel's precompiled validators", () => {
  test("hold a validator for every operation's and kernel point's own schema", () => {
    const missing = kernelSchemas.filter((schema) => !KERNEL_VALIDATORS.has(JSON.stringify(schema)));
    expect(missing).toEqual([]);
  });

  test("hold none for a schema the kernel no longer declares", () => {
    const declared = new Set(kernelSchemas.map((schema) => JSON.stringify(schema)));
    expect([...KERNEL_VALIDATORS.keys()].filter((content) => !declared.has(content))).toEqual([]);
  });
});
