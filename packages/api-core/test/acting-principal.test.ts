import { rename } from "node:fs/promises";
import { join } from "node:path";
import { type AttestationRecord, isPseudonym, pseudonymFor } from "@musai/records";
import { LOCAL_DIR, MUSAI_DIR, workspaceKey } from "@musai/store";
import { allowedSignersLine, generateTestKey } from "@musai/test-support";
import { describe, expect, test } from "vitest";
import { runHandler } from "../src/handler.js";
import { openWorkspace } from "../src/open-workspace.js";
import { FIXTURE_CLOCK, fixtureAttested, fixtureWorkspace, refusalOf } from "./fixture-distribution.js";

const attestationOf = (minted: readonly { kind: string; record: unknown }[]): AttestationRecord =>
  minted.find((item) => item.kind === "attestation")!.record as AttestationRecord;

describe("the principal a call acts as is the key it signs with", () => {
  test("a configured key is the principal the authority check grants and the attestation names", async () => {
    const key = await generateTestKey("ruler");
    const workspace = await fixtureWorkspace({
      roles: `${key.principal} delegate any\n`,
      allowedSigners: allowedSignersLine(key),
      signingKey: key.keyPath,
    });

    const made = await runHandler(
      fixtureAttested,
      { label: "by the ruler's key" },
      workspace.context({ via: "tty", principalName: "someone-else" }),
    );

    expect(attestationOf(made.minted).principal).toBe(key.principal);
  });

  test("a key named at the invocation outranks the configured one", async () => {
    const configured = await generateTestKey("configured");
    const named = await generateTestKey("named");
    const workspace = await fixtureWorkspace({
      roles: `${configured.principal} delegate any\n${named.principal} delegate any\n`,
      allowedSigners: allowedSignersLine(configured) + allowedSignersLine(named),
      signingKey: configured.keyPath,
    });

    const made = await runHandler(
      fixtureAttested,
      { label: "by the named key", key: named.keyPath },
      workspace.context({ via: "tty" }),
    );

    expect(attestationOf(made.minted).principal).toBe(named.principal);
  });

  test("a preview names the principal performing writes, reading the public half alone", async () => {
    const key = await generateTestKey("ruler");
    const workspace = await fixtureWorkspace({ signingKey: key.keyPath });
    const aside = `${key.keyPath}.aside`;
    await rename(key.keyPath, aside);

    const previewed = await runHandler(
      fixtureAttested,
      { label: "previewed" },
      workspace.context({ via: "tty", mode: "plan" }),
    );
    await rename(aside, key.keyPath);
    const performed = await runHandler(fixtureAttested, { label: "previewed" }, workspace.context({ via: "tty" }));

    expect(attestationOf(previewed.minted)).toEqual(attestationOf(performed.minted));
    expect(attestationOf(previewed.minted).principal).toBe(key.principal);
  });

  test("with no key, the surface's name attests as its pseudonym under the workspace key", async () => {
    const workspace = await fixtureWorkspace();

    const made = await runHandler(
      fixtureAttested,
      { label: "by a name" },
      workspace.context({ via: "tty", principalName: "florin" }),
    );

    const principal = attestationOf(made.minted).principal;
    expect(isPseudonym(principal)).toBe(true);
    const workspaceSecret = await workspaceKey(join(workspace.dir, MUSAI_DIR, LOCAL_DIR), { now: FIXTURE_CLOCK });
    expect(principal).toBe(pseudonymFor(workspaceSecret, "florin"));
  });

  test("with neither a key nor a name, an attesting call is refused naming both remedies", async () => {
    const workspace = await fixtureWorkspace();
    const before = await workspace.head();

    const refusal = await refusalOf(() =>
      runHandler(fixtureAttested, { label: "by nobody" }, workspace.context({ via: "tty" })),
    );

    expect(refusal.message).toContain("musai init --key");
    expect(refusal.message).toContain("MUSAI_PRINCIPAL");
    expect(await workspace.head()).toBe(before);
  });

  test("a key registered under a name alone is refused with the line that names it, and no file is rewritten", async () => {
    const key = await generateTestKey("florin");
    const registered = `florin namespaces="musai" ${key.pubKeyLine}\n`;
    const workspace = await fixtureWorkspace({ allowedSigners: registered, signingKey: key.keyPath });
    const before = await workspace.head();

    const refusal = await refusalOf(() =>
      runHandler(fixtureAttested, { label: "by an old line" }, workspace.context({ via: "tty" })),
    );

    expect(refusal.reason).toBe("workspace-incomplete");
    expect(refusal.message).toContain(`florin,${key.principal} namespaces="musai" ${key.pubKeyLine}`);
    expect(await workspace.head()).toBe(before);
    const opened = await openWorkspace(workspace.context());
    expect(opened.allowedSigners.map((signer) => signer.principals)).toEqual(["florin"]);
    opened.close();
  });
});
