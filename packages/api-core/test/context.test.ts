import { afterEach, describe, expect, test, vi } from "vitest";
import { clockFromEnvironment } from "../src/context.js";
import { OperationError } from "../src/errors.js";

describe("clockFromEnvironment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("refuses a malformed MUSAI_NOW when the clock is built, as a mistake in the invocation, before any read", () => {
    vi.stubEnv("MUSAI_NOW", "bogus");

    let refusal: unknown;
    try {
      clockFromEnvironment();
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(OperationError);
    expect(refusal).toMatchObject({ reason: "invalid-input", code: "invocation", about: ["MUSAI_NOW"] });
    expect((refusal as OperationError).detail).toContain("bogus");
  });
});
