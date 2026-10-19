import { type ElicitResult, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, test, vi } from "vitest";
import { elicitGateAnswer, titledSingleSelect } from "../src/elicitation.js";

function stubServer(result: ElicitResult) {
  return { elicitInput: vi.fn().mockResolvedValue(result) };
}

function stubServerRejecting(error: unknown) {
  return { elicitInput: vi.fn().mockRejectedValue(error) };
}

describe("titledSingleSelect", () => {
  test("produces a oneOf of {const, title} in the option order given, with no enumNames key", () => {
    const schema = titledSingleSelect("Disposition", [
      { const: "file", title: "File a new issue" },
      { const: "comment", title: "Post a comment" },
      { const: "withdraw", title: "Withdraw" },
    ]);

    expect(schema).toEqual({
      type: "string",
      title: "Disposition",
      oneOf: [
        { const: "file", title: "File a new issue" },
        { const: "comment", title: "Post a comment" },
        { const: "withdraw", title: "Withdraw" },
      ],
    });
    expect(schema).not.toHaveProperty("enumNames");
  });
});

describe("elicitGateAnswer", () => {
  const field = titledSingleSelect("Disposition", [
    { const: "file", title: "File a new issue" },
    { const: "comment", title: "Post a comment" },
  ]);

  test("an accepted answer carries its value", async () => {
    const server = stubServer({ action: "accept", content: { answer: "file" } });

    const outcome = await elicitGateAnswer(server, { message: "How should this be dispositioned?", field });

    expect(outcome).toEqual({ answered: true, value: "file" });
    expect(server.elicitInput).toHaveBeenCalledWith({
      mode: "form",
      message: "How should this be dispositioned?",
      requestedSchema: { type: "object", properties: { answer: field }, required: ["answer"] },
    });
  });

  test("a declined form produces a not-answered outcome carrying no content", async () => {
    const server = stubServer({ action: "decline" });

    const outcome = await elicitGateAnswer(server, { message: "How should this be dispositioned?", field });

    expect(outcome).toEqual({ answered: false, action: "decline" });
  });

  test("a cancelled form produces a not-answered outcome carrying no content", async () => {
    const server = stubServer({ action: "cancel" });

    const outcome = await elicitGateAnswer(server, { message: "How should this be dispositioned?", field });

    expect(outcome).toEqual({ answered: false, action: "cancel" });
  });

  test("a requested schema naming a secret field is refused before the request is issued", async () => {
    const server = stubServer({ action: "accept", content: { answer: "irrelevant" } });
    const secretField = { type: "string", secret: true };

    await expect(elicitGateAnswer(server, { message: "what is the token?", field: secretField })).rejects.toThrow(
      /secret/,
    );
    expect(server.elicitInput).not.toHaveBeenCalled();
  });

  test("a requested schema naming a field the workspace binds as a secret is refused before the request is issued", async () => {
    const server = stubServer({ action: "accept", content: { answer: "irrelevant" } });

    await expect(elicitGateAnswer(server, { message: "what is it?", field, secretNames: ["answer"] })).rejects.toThrow(
      /secret/,
    );
    expect(server.elicitInput).not.toHaveBeenCalled();
  });

  test("issues the exact request payload a real client accepted", async () => {
    const server = stubServer({ action: "accept", content: { answer: "file" } });
    const dispositionField = titledSingleSelect("Disposition", [
      { const: "file", title: "File a new issue" },
      { const: "comment", title: "Post a comment" },
      { const: "withdraw", title: "Withdraw" },
    ]);

    await elicitGateAnswer(server, {
      message: "How should this be dispositioned?",
      field: dispositionField,
    });

    expect(server.elicitInput).toHaveBeenCalledWith({
      mode: "form",
      message: "How should this be dispositioned?",
      requestedSchema: {
        type: "object",
        properties: {
          answer: {
            type: "string",
            title: "Disposition",
            oneOf: [
              { const: "file", title: "File a new issue" },
              { const: "comment", title: "Post a comment" },
              { const: "withdraw", title: "Withdraw" },
            ],
          },
        },
        required: ["answer"],
      },
    });
  });

  test("a client's own request-timeout error becomes an expired outcome, distinct from a decline, carrying no content", async () => {
    const server = stubServerRejecting(new McpError(ErrorCode.RequestTimeout, "Request timed out"));

    const outcome = await elicitGateAnswer(server, { message: "How should this be dispositioned?", field });

    expect(outcome).toEqual({ answered: false, action: "expired" });
  });

  test("an error that is not the client's own request timeout propagates rather than reading as an expiry", async () => {
    const server = stubServerRejecting(new McpError(ErrorCode.InternalError, "something else went wrong"));

    await expect(elicitGateAnswer(server, { message: "How should this be dispositioned?", field })).rejects.toThrow(
      /something else went wrong/,
    );
  });

  test("a declined or cancelled result never carries a value an answer could be read from", async () => {
    for (const action of ["decline", "cancel"] as const) {
      const server = stubServer({ action });

      const outcome = await elicitGateAnswer(server, { message: "How should this be dispositioned?", field });

      expect(outcome.answered).toBe(false);
      expect(outcome).not.toHaveProperty("value");
    }
  });
});
