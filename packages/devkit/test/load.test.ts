import { Ajv } from "ajv";
import { expect, test, vi } from "vitest";

test("loading the devkit compiles no schema, so a verb that builds nothing pays for none", async () => {
  const compile = vi.spyOn(Ajv.prototype, "compile");

  await import("../src/index.js");

  expect(compile).not.toHaveBeenCalled();
});
