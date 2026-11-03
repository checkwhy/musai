import { rm } from "node:fs/promises";
import { TrustFileError } from "@musai/records";
import { readTrustBranch } from "@musai/store";
import { type FixtureRepo, generateTestKey, makeFixtureRepo, writeTrustFile } from "@musai/test-support";
import { afterEach, describe, expect, test } from "vitest";
import { parseAllowedSigners } from "../src/allowed-signers.js";
import { parseAudiences } from "../src/audiences.js";
import { signingLevelOf } from "../src/level.js";
import { parseRoles } from "../src/roles.js";
import { trustFileFaults } from "../src/trust-file-faults.js";

function refusalOf(read: () => unknown): unknown {
  try {
    read();
  } catch (error) {
    return error;
  }
  throw new Error("the read did not refuse");
}

describe("a trust file no reader takes is a workspace to fix, named where it is and how to clear it", () => {
  let repo: FixtureRepo | undefined;

  afterEach(async () => {
    await repo?.cleanup();
    repo = undefined;
  });

  test("an allowed-signers line OpenSSH would not read names its line and the fix on the trust branch", () => {
    const refusal = refusalOf(() => parseAllowedSigners("# the team\nalice ssh-ed25519\n"));

    expect(refusal).toBeInstanceOf(TrustFileError);
    expect(refusal).toMatchObject({ reason: "workspace-incomplete", file: "allowed-signers", line: 2 });
    expect((refusal as Error).message).toContain("fix or remove line 2 of allowed-signers on the trust branch");
  });

  test("a roles line that grants no shipped role names its line and the fix", () => {
    const refusal = refusalOf(() => parseRoles("alice owner any\nbob overlord any\n"));

    expect(refusal).toMatchObject({ reason: "workspace-incomplete", file: "roles", line: 2 });
    expect((refusal as Error).message).toContain("bob overlord any");
    expect((refusal as Error).message).toContain("fix or remove line 2 of roles on the trust branch");
  });

  test("an audiences line including an audience the file never declares names its line and the fix", () => {
    const refusal = refusalOf(() => parseAudiences("known\nknown includes nobody\n"));

    expect(refusal).toMatchObject({ reason: "workspace-incomplete", file: "audiences", line: 2 });
    expect((refusal as Error).message).toContain("fix or remove line 2 of audiences on the trust branch");
  });

  test("a cycle of audiences includes names the line that closes it, the cycle and the fix", () => {
    const refusal = refusalOf(() => parseAudiences("a includes b\nb includes c\nc includes a\n"));

    expect(refusal).toBeInstanceOf(TrustFileError);
    expect(refusal).toMatchObject({ reason: "workspace-incomplete", file: "audiences", line: 3 });
    expect((refusal as Error).message).toContain("a includes b includes c includes a");
    expect((refusal as Error).message).toContain("fix or remove line 3 of audiences on the trust branch");
  });

  test("a signing level that is no level names its key and the fix", async () => {
    repo = await makeFixtureRepo("trust-file-signing");
    await writeTrustFile(repo.ctx, "config.json", JSON.stringify({ signing: "sometimes" }));
    const { config } = await readTrustBranch(repo.ctx);

    const refusal = refusalOf(() => signingLevelOf(config));

    expect(refusal).toMatchObject({ reason: "workspace-incomplete", file: "config.json", line: null });
    expect((refusal as Error).message).toContain("fix or remove signing in config.json on the trust branch");
  });

  test("a configuration that is no JSON names the file and the fix", async () => {
    repo = await makeFixtureRepo("trust-file-json");
    await writeTrustFile(repo.ctx, "config.json", "not json\n");

    const refusal = await readTrustBranch(repo.ctx).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(TrustFileError);
    expect((refusal as Error).message).toContain("fix config.json on the trust branch");
  });

  test("every line no reader takes is listed, across the trust files, each by its own number", async () => {
    const key = await generateTestKey("alice");
    try {
      const faults = trustFileFaults({
        allowedSigners: `alice ssh-ed25519\n${key.principal} ${key.pubKeyLine}\nbob ssh-foo AAAA\n`,
        roles: "alice owner\n",
        audiences: "known\n",
      });

      expect(
        faults.map((fault) => (fault instanceof TrustFileError ? [fault.file, fault.line] : fault.reason)),
      ).toEqual([
        ["allowed-signers", 1],
        ["allowed-signers", 3],
        ["roles", 1],
      ]);
    } finally {
      await rm(key.dir, { recursive: true, force: true });
    }
  });

  test("a cycle two lines close is named at each, since removing one leaves the other closing it", () => {
    const faults = trustFileFaults({
      allowedSigners: "",
      roles: "",
      audiences: "a\nb\na includes b\nb includes a\nb includes a\n",
    });

    expect(faults.map((fault) => (fault instanceof TrustFileError ? [fault.file, fault.line] : fault.reason))).toEqual([
      ["audiences", 4],
      ["audiences", 5],
    ]);
  });

  test("a line relying on an audience only a refused line declares is not named, since it reads on its own", () => {
    const faults = trustFileFaults({
      allowedSigners: "",
      roles: "",
      audiences: "team member nobody-at-all\npeer includes nowhere\nall includes team\nall includes peer\n",
    });

    expect(faults.map((fault) => (fault instanceof TrustFileError ? [fault.file, fault.line] : fault.reason))).toEqual([
      ["audiences", 1],
      ["audiences", 2],
    ]);
  });

  test("faults a later check of the reader finds first are still listed in line order", () => {
    const faults = trustFileFaults({
      allowedSigners: "",
      roles: "",
      audiences: "peer includes nowhere\nteam member nobody-at-all\n",
    });

    expect(faults.map((fault) => (fault instanceof TrustFileError ? [fault.file, fault.line] : fault.reason))).toEqual([
      ["audiences", 1],
      ["audiences", 2],
    ]);
  });

  test("a trust branch whose every line is read lists none", () => {
    expect(trustFileFaults({ allowedSigners: "", roles: "# none yet\n", audiences: "known\npeer\n" })).toEqual([]);
  });
});
