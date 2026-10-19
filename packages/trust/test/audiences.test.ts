import { KernelError } from "@musai/records";
import { describe, expect, it } from "vitest";
import { covers, parseAudiences } from "../src/audiences.js";

const KEY = `key:SHA256:${"k".repeat(43)}`;
const OTHER_KEY = `key:SHA256:${"o".repeat(43)}`;
const IDENTITY = "identity:https://issuer.example#maintainer";

const FILE = [
  "# who receives what",
  "peer",
  "known includes peer",
  "partners includes known",
  `peer member ${KEY}`,
  `known member ${IDENTITY}`,
  "",
].join("\n");

describe("the audiences file decides which audience covers which", () => {
  const audiences = parseAudiences(FILE);

  it("public covers every audience, and nothing but public covers public", () => {
    for (const target of ["public", "peer", KEY, IDENTITY]) {
      expect(covers(audiences, "public", target)).toBe(true);
    }
    for (const granted of ["peer", "partners", KEY, IDENTITY]) {
      expect(covers(audiences, granted, "public")).toBe(false);
    }
  });

  it("a name covers every name it includes, transitively", () => {
    expect(covers(audiences, "partners", "peer")).toBe(true);
    expect(covers(audiences, "partners", "known")).toBe(true);
    expect(covers(audiences, "known", "partners")).toBe(false);
    expect(covers(audiences, "peer", "known")).toBe(false);
  });

  it("a key is covered by each audience holding it and covers only itself", () => {
    expect(covers(audiences, "peer", KEY)).toBe(true);
    expect(covers(audiences, "partners", KEY)).toBe(true);
    expect(covers(audiences, "peer", IDENTITY)).toBe(false);
    expect(covers(audiences, "known", IDENTITY)).toBe(true);
    expect(covers(audiences, KEY, KEY)).toBe(true);
    expect(covers(audiences, KEY, "peer")).toBe(false);
    expect(covers(audiences, KEY, OTHER_KEY)).toBe(false);
  });

  it("a cycle of includes is refused as a declaration conflict, naming it", () => {
    const refusal = (() => {
      try {
        parseAudiences("a includes b\nb includes c\nc includes a\n");
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(refusal).toBeInstanceOf(KernelError);
    expect(refusal).toMatchObject({ reason: "declaration-conflict" });
    expect((refusal as KernelError).detail).toContain("a includes b includes c includes a");
  });

  it("an absent audiences file declares no name", () => {
    const empty = parseAudiences("");
    expect(empty.names.size).toBe(0);
    expect(covers(empty, "peer", "peer")).toBe(true);
    expect(covers(empty, "peer", KEY)).toBe(false);
  });

  it("refuses a line that is not a declaration, a member or an includes, naming it", () => {
    for (const line of [
      "peer member",
      "peer holds known",
      "peer member public",
      "peer member known",
      "peer includes nobody",
      "Peer",
      `${KEY} includes peer`,
    ]) {
      expect(() => parseAudiences(`known\n${line}\n`), line).toThrow(
        new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    }
  });
});
