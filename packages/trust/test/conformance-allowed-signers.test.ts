import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrustFileError } from "@musai/records";
import { afterAll, describe, expect, it } from "vitest";
import {
  ALLOWED_SIGNERS_CASES,
  type AllowedSignersCase,
  allowedSignersTable,
} from "../scripts/conformance-allowed-signers.js";
import { CONFORMANCE_DIR } from "../scripts/conformance-bundles.js";
import { parseAllowedSigners, principalsOf, readAllowedSignersLine } from "../src/allowed-signers.js";

const opensshAvailable = spawnSync("ssh-keygen", ["-Y", "check-novalidate"], { stdio: "ignore" }).error === undefined;
// A build of OpenSSH 10, or one made without DSA, reads no line of a key type it does not list.
const knownKeyTypes = new Set(spawnSync("ssh", ["-Q", "key"], { encoding: "utf8" }).stdout?.split("\n") ?? []);
const readsHere = (openSsh: AllowedSignersCase["openSsh"]) =>
  openSsh?.reads === true && (openSsh.knowing === undefined || knownKeyTypes.has(openSsh.knowing));

describe("the allowed-signers lines a verifier in another language reads as the kernel does", () => {
  it("hold byte for byte what the generator derives from the kernel", () => {
    expect(readFileSync(join(CONFORMANCE_DIR, "allowed-signers.json"), "utf8")).toBe(allowedSignersTable());
  });

  it.each(ALLOWED_SIGNERS_CASES)("$name is read or refused for the reason its case names", ({ line, refused }) => {
    const read = readAllowedSignersLine(line);
    expect("refused" in read ? read.refused : undefined).toBe(refused);
  });

  it.each(ALLOWED_SIGNERS_CASES.filter(({ refused }) => refused !== undefined))(
    "$name refuses the file holding it, naming its line",
    ({ line }) => {
      expect(() => parseAllowedSigners(`# the team\n${line}\n`)).toThrow(TrustFileError);
      expect(() => parseAllowedSigners(`# the team\n${line}\n`)).toThrow(/at line 2: /);
    },
  );

  describe.skipIf(!opensshAvailable)("under the system OpenSSH", () => {
    const dir = mkdtempSync(join(tmpdir(), "musai-conformance-allowed-signers-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    const matching = (line: string, principal: string) => {
      const file = join(dir, "allowed-signers");
      writeFileSync(file, `${line}\n`);
      const run = spawnSync("ssh-keygen", ["-Y", "match-principals", "-f", file, "-I", principal], {
        encoding: "utf8",
      });
      return { status: run.status, stdout: run.stdout.trim(), stderr: run.stderr };
    };

    it.each(ALLOWED_SIGNERS_CASES.filter(({ refused }) => refused === undefined))(
      "$name is read by ssh-keygen, its every principal matching the line, without a word",
      ({ line }) => {
        const [signer] = parseAllowedSigners(`${line}\n`);
        for (const principal of principalsOf(signer!)) {
          expect(matching(line, principal)).toEqual({ status: 0, stdout: signer!.principals, stderr: "" });
        }
      },
    );

    it.each(ALLOWED_SIGNERS_CASES.filter(({ refused, openSsh }) => refused !== undefined && readsHere(openSsh)))(
      "$name is read by ssh-keygen without a word, and refused here as it reads otherwise",
      ({ line, openSsh }) => {
        expect(matching(line, openSsh!.as)).toMatchObject({ status: 0, stderr: "" });
      },
    );

    it.each(ALLOWED_SIGNERS_CASES.filter(({ refused, openSsh }) => refused !== undefined && !readsHere(openSsh)))(
      "$name is refused by ssh-keygen too, naming its line",
      ({ line, openSsh }) => {
        expect(matching(line, openSsh?.as ?? "florin").stderr).toMatch(/:1: /);
      },
    );
  });
});
