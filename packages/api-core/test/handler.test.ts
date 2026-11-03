import { type Reason, recordId } from "@musai/records";
import { fixtureRunRecord } from "@musai/test-support";
import { describe, expect, test } from "vitest";
import { OperationError } from "../src/errors.js";
import { runHandler } from "../src/handler.js";
import type { OperationDescriptor } from "../src/registry.js";
import {
  fixtureMisanswers,
  fixtureTool,
  fixtureWorkspace,
  fixtureWrite,
  type LabelInput,
  refusalOf,
} from "./fixture-distribution.js";

describe("runHandler, the one entry point every surface calls an operation through", () => {
  test("composes a statement a person typed to NFC before the handler, and hands any other input as typed", async () => {
    const workspace = await fixtureWorkspace();
    const decomposed = "cafe\u0301";
    const received: string[] = [];
    const listening = (statements?: readonly string[]): OperationDescriptor<LabelInput, unknown> => ({
      ...fixtureTool,
      ...(statements === undefined ? {} : { statements }),
      handler: async (input) => {
        received.push(input.label);
        return { minted: [] };
      },
    });

    await runHandler(listening(["label"]), { label: decomposed }, workspace.context());
    await runHandler(listening(), { label: decomposed }, workspace.context());

    expect(received).toEqual(["caf\u00e9", decomposed]);
  });

  test("refuses input its descriptor's schema refuses before the handler is reached, and writes nothing", async () => {
    const workspace = await fixtureWorkspace();
    const before = await workspace.head();
    let reached = 0;
    const counted: OperationDescriptor<LabelInput, unknown> = {
      ...fixtureWrite,
      handler: (input, context) => {
        reached++;
        return fixtureWrite.handler(input, context);
      },
    };
    const refused = { label: "valid but for the property beside it", extra: true } as LabelInput;

    const refusal = await refusalOf(() => runHandler(counted, refused, workspace.context()));

    expect(refusal).toMatchObject({ name: "OperationError", reason: "invalid-input", about: ["fixture.write@1"] });
    expect(refusal.message).toContain("must NOT have additional properties");
    expect(reached).toBe(0);
    expect(await workspace.head()).toBe(before);
  });

  test("refuses plan mode for a descriptor declaring it cannot plan, by name", async () => {
    const workspace = await fixtureWorkspace();
    const before = await workspace.head();

    const refusal = await refusalOf(() =>
      runHandler(fixtureTool, { label: "previewed" }, workspace.context({ mode: "plan" })),
    );

    expect(refusal).toMatchObject({ name: "OperationError", reason: "invalid-input", about: ["fixture.tool@1"] });
    expect(refusal.message).toContain("fixture.tool@1 drives a kernel primitive and has nothing to preview");
    expect(await workspace.head()).toBe(before);

    const performed = await runHandler(fixtureTool, { label: "performed" }, workspace.context());
    expect(performed.minted.map((item) => item.id)).toEqual([recordId(fixtureRunRecord("performed"))]);
    expect(await workspace.head()).not.toBe(before);
  });

  test("refuses an answer its descriptor's output schema refuses as invalid-output", async () => {
    const workspace = await fixtureWorkspace();

    const refusal = await refusalOf(() => runHandler(fixtureMisanswers, {}, workspace.context()));

    expect(refusal).toMatchObject({
      name: "OperationError",
      reason: "invalid-output",
      code: "bug",
      about: ["fixture.misanswers@1"],
    });
    expect(refusal.message).toContain("data/answer must be string");
  });

  test("reports a refusal its handler raises outside the declared reasons as a defect, naming the reason", async () => {
    const workspace = await fixtureWorkspace();
    const refusing = (reason: Reason): OperationDescriptor<LabelInput, unknown> => ({
      ...fixtureTool,
      handler: async () => {
        throw new OperationError({ reason, about: ["the label"], detail: "refused by the handler" });
      },
    });

    const undeclared = await refusalOf(() =>
      runHandler(refusing("no-such-record"), { label: "x" }, workspace.context()),
    );

    expect(undeclared).toMatchObject({ reason: "invalid-output", code: "bug", about: ["fixture.tool@1"] });
    expect(undeclared.message).toContain("fixture.tool@1 refused no-such-record, which it does not declare");
    expect(undeclared.cause).toMatchObject({ reason: "no-such-record", about: ["the label"] });
  });

  test("passes a declared refusal, and one the kernel raises beneath every operation, through as raised", async () => {
    const workspace = await fixtureWorkspace();
    for (const reason of ["head-moved", "workspace-incomplete"] as const) {
      const refusing: OperationDescriptor<LabelInput, unknown> = {
        ...fixtureTool,
        handler: async () => {
          throw new OperationError({ reason, about: ["the label"], detail: "refused by the handler" });
        },
      };

      const refusal = await refusalOf(() => runHandler(refusing, { label: "x" }, workspace.context()));

      expect(refusal).toMatchObject({ reason, about: ["the label"] });
    }
  });

  test("answers in plan mode with what performing would mint, and moves no head", async () => {
    const workspace = await fixtureWorkspace();
    const before = await workspace.head();
    const drafted = fixtureRunRecord("planned");
    const expectedId = recordId(drafted);

    const planned = await runHandler(fixtureWrite, { label: "planned" }, workspace.context({ mode: "plan" }));

    expect(planned.minted).toEqual([{ id: expectedId, kind: "run", record: drafted }]);
    expect(await workspace.head()).toBe(before);

    const performed = await runHandler(fixtureWrite, { label: "planned" }, workspace.context());

    expect(performed.minted).toEqual([{ id: expectedId, kind: "run", record: drafted }]);
    expect(await workspace.head()).not.toBe(before);
    expect(await workspace.store().read(expectedId, "run")).toEqual(drafted);
  });
});
