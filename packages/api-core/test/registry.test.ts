import { DEPRECATED_REASONS, type Reason, versionString } from "@musai/records";
import { Ajv } from "ajv";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildRegistry,
  DuplicateOperationError,
  lookupOperation,
  type OperationDescriptor,
  validateOperationInput,
  validateOperationOutput,
} from "../src/registry.js";
import {
  FIXTURE_OPERATIONS,
  fixtureDistribution,
  fixtureMisanswers,
  fixtureRead,
  fixtureTool,
  fixtureWrite,
} from "./fixture-distribution.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a registry built from a distribution's descriptors", () => {
  test("enumerates its operations in ascending id@version order whatever order they were declared in", () => {
    const secondRead = { ...fixtureRead, version: versionString("2") };
    const ascending = [
      "fixture.gated@1",
      "fixture.misanswers@1",
      "fixture.read@1",
      "fixture.read@2",
      "fixture.tool@1",
      "fixture.write@1",
    ];
    const reversed = [secondRead, ...[...FIXTURE_OPERATIONS].reverse()];

    expect([...fixtureDistribution([secondRead]).registry.keys()]).toEqual(ascending);
    expect([...buildRegistry(reversed, DEPRECATED_REASONS).keys()]).toEqual(ascending);
  });

  test("refuses two descriptors sharing one id@version, naming both", () => {
    const second = { ...fixtureWrite, documentation: "a second declaration of the write" };

    expect(() => fixtureDistribution([second])).toThrow(DuplicateOperationError);
    expect(() => fixtureDistribution([second])).toThrow(
      'two operations declare fixture.write@1: "drafts one run record carrying the label" and "a second declaration of the write"',
    );
  });

  test("refuses a descriptor carrying no CLI projection", () => {
    const { cli: _cli, ...unprojected } = { ...fixtureTool, id: "fixture.unprojected" };

    expect(() => fixtureDistribution([unprojected as OperationDescriptor])).toThrow(
      "operation fixture.unprojected@1 declares no CLI projection",
    );
  });

  test("refuses a descriptor declaring a reason outside the closed vocabulary or one deprecated, naming the operation and the reason", () => {
    const unknown = { ...fixtureRead, id: "fixture.unknown-reason", reasons: ["no-such-reason" as Reason] };
    const deprecated = { ...fixtureRead, id: "fixture.deprecated-reason", reasons: ["recipe-changed" as const] };

    expect(() => fixtureDistribution([unknown])).toThrow(
      "operation fixture.unknown-reason@1 declares a reason outside the kernel's closed vocabulary: no-such-reason",
    );
    expect(() => buildRegistry([deprecated], new Set<Reason>(["recipe-changed"]))).toThrow(
      "operation fixture.deprecated-reason@1 declares a deprecated reason, never newly declarable: recipe-changed",
    );
    expect([...buildRegistry([deprecated], DEPRECATED_REASONS).keys()]).toEqual(["fixture.deprecated-reason@1"]);
  });

  test("validates an operation's input and output against its own schemas, naming what each refuses", () => {
    expect(validateOperationInput(fixtureWrite, { label: "a" })).toEqual({ ok: true });
    expect(validateOperationInput(fixtureWrite, {})).toEqual({
      ok: false,
      errors: "data must have required property 'label'",
    });
    expect(validateOperationInput(fixtureWrite, { label: "a", extra: true })).toEqual({
      ok: false,
      errors: "data must NOT have additional properties",
    });
    expect(validateOperationInput(fixtureRead, { label: "a" })).toEqual({
      ok: false,
      errors: "data must NOT have additional properties",
    });

    expect(validateOperationOutput(fixtureMisanswers, { answer: "a string" })).toEqual({ ok: true });
    expect(validateOperationOutput(fixtureMisanswers, { answer: 42 })).toEqual({
      ok: false,
      errors: "data/answer must be string",
    });
  });

  test("compiles an operation's schemas once however often a manifest read hands them back as fresh objects", () => {
    const read = () => ({
      ...fixtureWrite,
      input: structuredClone(fixtureWrite.input),
      output: structuredClone(fixtureWrite.output),
    });
    validateOperationInput(read(), { label: "a" });
    validateOperationOutput(read(), {});
    const compile = vi.spyOn(Ajv.prototype, "compile");
    for (let times = 0; times < 20; times += 1) {
      const fresh = read();
      validateOperationInput(fresh, { label: "a" });
      validateOperationOutput(fresh, {});
    }
    expect(compile).not.toHaveBeenCalled();
  });

  test("lookupOperation refuses an operation the registry does not hold", () => {
    const { registry } = fixtureDistribution();

    expect(lookupOperation(registry, "fixture.write", versionString("1"))).toBe(fixtureWrite);
    expect(() => lookupOperation(registry, "fixture.write", versionString("2"))).toThrow(
      "no operation registered at fixture.write@2",
    );
    expect(() => lookupOperation(registry, "fixture.absent", versionString("1"))).toThrow(
      "no operation registered at fixture.absent@1",
    );
  });
});
