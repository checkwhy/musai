import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, test } from "vitest";
import { type ClaimTypeDeclaration, claimTypesFrom, slotFor } from "../src/record/claim-types.js";

const REPRODUCES: ClaimTypeDeclaration = {
  type: "bugs.reproduces@1",
  identityDimensions: ["repository", "issue"],
};

describe("claimTypesFrom", () => {
  test("a declared type answers with the identity dimensions it was declared under", () => {
    const claimTypes = claimTypesFrom([REPRODUCES]);
    expect(claimTypes.get("bugs.reproduces@1")?.identityDimensions).toEqual(["repository", "issue"]);
  });

  test("a claim type declaring no identity dimensions is refused, naming the type", () => {
    expect(() => claimTypesFrom([{ type: "bugs.reproduces@1", identityDimensions: [] }])).toThrow(/bugs\.reproduces@1/);
  });
});

describe("slotFor", () => {
  test("two records differing only in a context dimension produce the same slot", () => {
    const first = slotFor(REPRODUCES, { repository: "acme/widget", issue: "42", platform: "linux" });
    const second = slotFor(REPRODUCES, { repository: "acme/widget", issue: "42", platform: "windows" });
    expect(first).toBe(second);
  });

  test("a difference in an identity dimension produces a different slot", () => {
    const first = slotFor(REPRODUCES, { repository: "acme/widget", issue: "42" });
    const second = slotFor(REPRODUCES, { repository: "acme/widget", issue: "43" });
    expect(first).not.toBe(second);
  });

  test("the slot is a sha256 record id minted through the kernel canonicalizer", () => {
    const slot = slotFor(REPRODUCES, { repository: "acme/widget", issue: "42" });
    expect(slot).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("computing a slot twice in separate processes yields the same value", async () => {
    const claimTypesModulePath = fileURLToPath(new URL("../src/record/claim-types.ts", import.meta.url));
    const scriptDir = await mkdtemp(join(tmpdir(), "musai-slot-roundtrip-"));

    // The subprocess runs unbundled, so its ".js" specifiers must resolve to ".ts" sources.
    const registerPath = fileURLToPath(import.meta.resolve("@musai/test-support/ts-esm"));

    const scriptPath = join(scriptDir, "compute-slot.mjs");
    await writeFile(
      scriptPath,
      [
        `import { slotFor } from ${JSON.stringify(claimTypesModulePath)};`,
        "const declaration = {",
        '  type: "bugs.reproduces@1",',
        '  identityDimensions: ["repository", "issue"],',
        "};",
        'process.stdout.write(slotFor(declaration, { repository: "acme/widget", issue: "42" }));',
      ].join("\n"),
    );

    try {
      const runOnce = () => execa("node", ["--experimental-strip-types", "--import", registerPath, scriptPath]);
      const [first, second] = await Promise.all([runOnce(), runOnce()]);
      expect(first.stdout).toBe(second.stdout);
      expect(first.stdout).toMatch(/^sha256:[0-9a-f]{64}$/);
    } finally {
      await rm(scriptDir, { recursive: true, force: true });
    }
  });
});
