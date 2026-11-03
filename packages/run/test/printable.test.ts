import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CONFORMANCE_DIR, printableTable } from "../scripts/conformance.js";
import { printable } from "../src/printable.js";

const TABLE = join(CONFORMANCE_DIR, "printable.json");

describe("printable: text a terminal shows as written, on one line and in order", () => {
  test("conformance/printable.json holds byte for byte what the generator derives", () => {
    expect(readFileSync(TABLE, "utf8")).toBe(printableTable());
  });

  const { cases } = JSON.parse(readFileSync(TABLE, "utf8")) as {
    cases: { name: string; text: string; printed: string }[];
  };

  test.each(cases)("prints $name as the verifier does", ({ text, printed }) => {
    expect(printable(text)).toBe(printed);
  });

  test("escapes each character a terminal acts on, and keeps a backslash", () => {
    expect(printable("a\u001b[2K‮\\n")).toBe("a\\u001b[2K\\u202e\\n");
  });
});
