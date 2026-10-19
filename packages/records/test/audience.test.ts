import { describe, expect, it } from "vitest";
import { isAudience, parseAudience } from "../src/record/audience.js";

const KEY = `key:SHA256:${"A".repeat(43)}`;

describe("an audience names public, a key, an identity or a declared name", () => {
  it("parses each of the four forms", () => {
    expect(parseAudience("public")).toEqual({ form: "public" });
    expect(parseAudience(KEY)).toEqual({ form: "key", fingerprint: `SHA256:${"A".repeat(43)}` });
    expect(parseAudience("identity:https://token.actions.githubusercontent.com#repo:o/r")).toEqual({
      form: "identity",
      issuer: "https://token.actions.githubusercontent.com",
      subject: "repo:o/r",
    });
    expect(parseAudience("vendor-ecosystem")).toEqual({ form: "name", name: "vendor-ecosystem" });
  });

  it("refuses an audience outside public, a key, an identity and a bare name", () => {
    for (const text of [
      "",
      "Public",
      "key:SHA256:short",
      `key:MD5:${"A".repeat(43)}`,
      "identity:http://issuer.example#me",
      "identity:https://issuer.example#",
      "identity:https://issuer.example",
      "-leading-hyphen",
      "has space",
      "a".repeat(64),
    ]) {
      expect(() => parseAudience(text), text).toThrow(RangeError);
      expect(isAudience(text), text).toBe(false);
    }
  });
});
