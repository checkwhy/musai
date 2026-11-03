import type { Audience } from "@musai/records";
import { describe, expect, test } from "vitest";
import { offeredUnderClearance } from "../src/cleared-operations.js";
import type { OperationDescriptor } from "../src/registry.js";
import { fixtureRead } from "./fixture-distribution.js";

const WRITER = "writer" as Audience;

const AUTHORS: OperationDescriptor = { ...fixtureRead, id: "fixture.authors", authorOnly: true };

function readingAFile(required: readonly string[]): OperationDescriptor {
  return {
    ...fixtureRead,
    id: "fixture.reads-a-file",
    input: {
      type: "object",
      additionalProperties: false,
      required,
      properties: { file: { type: "string" }, label: { type: "string" } },
    },
    paths: ["file"],
  };
}

describe("an operation under a clearance", () => {
  test.each([
    ["one working in what the author keeps", AUTHORS, []],
    ["one that must be handed a file by path", readingAFile(["file"]), ["file"]],
  ])("%s is offered as a refusal naming it and the clearance", (_, descriptor, fields) => {
    const key = `${descriptor.id}@${descriptor.version}`;

    const offered = offeredUnderClearance(descriptor, WRITER);

    expect(offered).toMatchObject({ reason: "invalid-input", about: [key, ...fields] });
    expect(offered).toMatchObject({ detail: expect.stringContaining(WRITER) });
  });

  test("one that may be handed a file by path is offered without that field", () => {
    const offered = offeredUnderClearance(readingAFile([]), WRITER) as OperationDescriptor;

    expect(Object.keys((offered.input as { properties: object }).properties)).toEqual(["label"]);
  });

  test("is offered whole to a surface launched with no clearance", () => {
    const optional = readingAFile([]);

    expect(offeredUnderClearance(AUTHORS, undefined)).toBe(AUTHORS);
    expect(offeredUnderClearance(optional, undefined)).toBe(optional);
  });
});
