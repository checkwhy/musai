import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { toolsFromRegistry } from "@musai/mcp";
import { describe, expect, test } from "vitest";
import { REGISTRY } from "../../src/index.js";

describe("the tool list a client is handed", () => {
  test("every projected tool carries schemas of the shape the protocol types, so a client accepts the list", () => {
    const parsed = ListToolsResultSchema.safeParse({ tools: toolsFromRegistry(REGISTRY) });
    expect(
      parsed.success ? null : parsed.error.issues,
      "the real registry projects to a tool list a client rejects",
    ).toBe(null);
  });

  test("brief.render projects to the tool name DESIGN.md's own tool list spells", () => {
    expect(toolsFromRegistry(REGISTRY).some((tool) => tool.name === "brief_render")).toBe(true);
  });

  test("an operation that constrains its output to nothing declares no output schema, rather than a boolean one", () => {
    const [closed] = REGISTRY.values();
    const unconstrained = { ...closed!, id: "unconstrained.output", output: true };

    const [tool] = toolsFromRegistry(new Map([["unconstrained.output@1", unconstrained]]));

    expect(tool?.name).toBe("unconstrained_output");
    expect(Object.hasOwn(tool as object, "outputSchema"), "a boolean output schema projects a key").toBe(false);
  });
});
