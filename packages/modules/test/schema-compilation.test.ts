import type { ContributionEntry } from "@musai/records";
import { versionString } from "@musai/records";
import { Ajv } from "ajv";
import { afterEach, describe, expect, test, vi } from "vitest";
import { claimTypeDeclarationFromEntry } from "../src/module/claim-type-registry.js";
import { pointRegistryFrom } from "../src/module/point-registry.js";
import { ENVELOPE_PROTOCOL, kernelPoint, validateEnvelopeInput } from "../src/rule/envelope.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function claimTypeEntry(): ContributionEntry {
  return {
    kind: "claim-type",
    id: "bugs/reproduces",
    version: versionString("1"),
    input: {
      identityDimensions: ["repository"],
      canonical: { type: "object", required: ["statement"], properties: { statement: { type: "string" } } },
    },
    output: true,
    documentation: "a bug reproduces",
  };
}

function pointEntry(): ContributionEntry {
  return {
    kind: "point",
    id: "greeter/greets",
    version: versionString("1"),
    input: {
      input: { type: "string" },
      output: { type: "object", properties: { text: { type: "string" } } },
      role: "invoke",
    },
    output: true,
    documentation: "a greeting",
  };
}

describe("the schemas a manifest declares", () => {
  test("a claim type's canonical schema compiles once however often the fold reads it afresh", () => {
    claimTypeDeclarationFromEntry(claimTypeEntry());
    const compile = vi.spyOn(Ajv.prototype, "compile");
    for (let read = 0; read < 20; read += 1) {
      claimTypeDeclarationFromEntry(claimTypeEntry());
    }
    expect(compile).not.toHaveBeenCalled();
  });

  test("a point's input and output schemas compile once however often the fold reads them afresh", () => {
    pointRegistryFrom([{ entry: pointEntry(), moduleName: "greeter" }]);
    const compile = vi.spyOn(Ajv.prototype, "compile");
    for (let read = 0; read < 20; read += 1) {
      pointRegistryFrom([{ entry: pointEntry(), moduleName: "greeter" }]);
    }
    expect(compile).not.toHaveBeenCalled();
  });

  test("a manifest's declared input schema compiles once however often an invocation reads it afresh", () => {
    const validateOnce = () => {
      const entry: ContributionEntry = {
        kind: "rule",
        id: "pack/rule",
        version: versionString("1"),
        input: { type: "object", required: ["claimId"] },
        output: true,
        documentation: "a rule",
      };
      const request = {
        protocol: ENVELOPE_PROTOCOL,
        contribution: "rule",
        id: "pack/rule",
        version: versionString("1"),
        input: { claimId: "c1", conditions: {}, evidence: [] },
      };
      return validateEnvelopeInput({ entry, point: kernelPoint("rule")! }, request);
    };
    validateOnce();
    const compile = vi.spyOn(Ajv.prototype, "compile");
    for (let invocation = 0; invocation < 20; invocation += 1) {
      expect(validateOnce().ok).toBe(true);
    }
    expect(compile).not.toHaveBeenCalled();
  });
});
