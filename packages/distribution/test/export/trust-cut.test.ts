import { describe, expect, test } from "vitest";
import { cutTrustFile } from "../../src/export/trust-cut.js";

const RECEIVER = "identity:https://idp.example.test#receiver";
const OTHER = "identity:https://idp.example.test#other";

const needs = { signers: new Set(["owner@example.test"]), releasedTo: new Set(["team"]), audience: RECEIVER };

describe("cutting a trust file for an export", () => {
  test("keeps the audiences a release reaches through what each includes, and only the receiver's membership", () => {
    const audiences = [
      "team includes reviewers",
      `reviewers member ${RECEIVER}`,
      `reviewers member ${OTHER}`,
      `outsiders member ${RECEIVER}`,
      "",
    ].join("\n");

    expect(cutTrustFile("audiences", audiences, needs)).toBe(`team includes reviewers\nreviewers member ${RECEIVER}\n`);
  });

  test("keeps a signer's line in allowed-signers and roles, and drops comments and everyone else", () => {
    const signers = "# the team\nowner@example.test ssh-ed25519 AAAA1\nother@example.test ssh-ed25519 AAAA2\n";
    const roles = "owner@example.test owner any\nother@example.test maintainer any\n";

    expect(cutTrustFile("allowed-signers", signers, needs)).toBe("owner@example.test ssh-ed25519 AAAA1\n");
    expect(cutTrustFile("roles", roles, needs)).toBe("owner@example.test owner any\n");
  });
});
