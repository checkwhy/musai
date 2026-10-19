import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSIONS, canonicalBytes, validateRecord } from "../src/index.js";

/** The run draft the Go verifier writes for the passing conformance bundle, held as its golden. */
const DRAFT = fileURLToPath(new URL("../../../verify/internal/report/testdata/draft.json", import.meta.url));

describe("the Go verifier's report", () => {
  it("is a run the kernel admits with nothing dropped once it is given the current schema version", () => {
    const draft = JSON.parse(readFileSync(DRAFT, "utf8")) as Record<string, unknown>;
    const record = { ...draft, schemaVersion: CURRENT_SCHEMA_VERSIONS.run };
    const validated = validateRecord(record);
    if (!validated.ok) {
      throw new Error(validated.error);
    }
    expect(new TextDecoder().decode(canonicalBytes(validated.record))).toBe(
      new TextDecoder().decode(canonicalBytes(record)),
    );
  });

  it("names a foreign performer, the tool musai-verify, and the bundle by digest", () => {
    const draft = JSON.parse(readFileSync(DRAFT, "utf8")) as {
      performer: { kind: string; tool: string };
      recipe: { substrates: { name?: string; digest?: Record<string, string> }[] };
    };
    expect(draft.performer).toMatchObject({ kind: "foreign", tool: "musai-verify" });
    expect(draft.recipe.substrates.find((substrate) => substrate.name === "bundle")?.digest?.["sha256"]).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});
