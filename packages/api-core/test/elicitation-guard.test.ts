import { describe, expect, test } from "vitest";
import { assertNoSecretField, SecretInElicitationError } from "../src/elicitation-guard.js";

describe("a requested schema naming a declared-secret field is refused before the request is issued", () => {
  test("a top-level field whose name is a declared secret is refused, naming the field", () => {
    const schema = {
      type: "object",
      properties: {
        password: { type: "string" },
      },
    };

    expect(() => assertNoSecretField(schema, ["password"])).toThrow(SecretInElicitationError);
    try {
      assertNoSecretField(schema, ["password"]);
      throw new Error("expected assertNoSecretField to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SecretInElicitationError);
      expect((error as SecretInElicitationError).about).toEqual(["password"]);
      expect((error as SecretInElicitationError).reason).toBe("invalid-input");
    }
  });

  test("a top-level field whose own sub-schema carries a truthy secret annotation is refused with no declared-name list needed", () => {
    const schema = {
      type: "object",
      properties: {
        apiKey: { type: "string", secret: true },
      },
    };

    expect(() => assertNoSecretField(schema, [])).toThrow(SecretInElicitationError);
  });

  test("a nested object property carrying a secret field is refused too — the guard walks the schema, not only the top level", () => {
    const schema = {
      type: "object",
      properties: {
        credentials: {
          type: "object",
          properties: {
            token: { type: "string", secret: true },
          },
        },
      },
    };

    try {
      assertNoSecretField(schema, []);
      throw new Error("expected assertNoSecretField to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SecretInElicitationError);
      expect((error as SecretInElicitationError).about).toEqual(["credentials.token"]);
    }
  });

  test("a schema with no secret field passes unchanged, object identity preserved", () => {
    const schema = {
      type: "object",
      properties: {
        disposition: {
          type: "string",
          title: "Disposition",
          oneOf: [
            { const: "file", title: "File a new issue" },
            { const: "comment", title: "Post a comment" },
          ],
        },
      },
    };
    const before = JSON.stringify(schema);

    expect(() => assertNoSecretField(schema, ["unrelated-name"])).not.toThrow();
    expect(JSON.stringify(schema)).toBe(before);
  });
});
