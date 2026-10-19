import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCAL_DIR, MUSAI_DIR } from "@musai/store";
import {
  allowedSignersLine,
  fixWorkspaceKey,
  generateTestKey,
  pseudonymOf,
  type TestKey,
  writeTrustFile,
} from "@musai/test-support";
import { type ExecaError, execa } from "execa";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const CLI_PATH = fileURLToPath(new URL("../../dist/bin/cli.js", import.meta.url));

/** The name a call holding no key attests under, as its pseudonym. */
const KEYLESS = "keyless-ruler";

interface Workspace {
  readonly dir: string;
  readonly gitDir: string;
  readonly localDir: string;
}

describe("a verb that mints an attestation signs it, from whichever place names a key", () => {
  let key: TestKey;

  async function freshWorkspace(name: string, signing: string): Promise<Workspace> {
    const dir = await mkdtemp(join(tmpdir(), `musai-signs-${name}-`));
    await execa("node", [CLI_PATH, "init", dir]);
    await fixWorkspaceKey(dir);
    const gitDir = join(dir, MUSAI_DIR);
    await writeTrustFile({ gitDir }, "allowed-signers", allowedSignersLine(key));
    await writeTrustFile({ gitDir }, "roles", `${key.principal} owner any\n${pseudonymOf(KEYLESS)} owner any\n`);
    await writeTrustFile({ gitDir }, "config.json", JSON.stringify({ signing }));
    return { dir, gitDir, localDir: join(gitDir, LOCAL_DIR) };
  }

  /** Books a case and renders its brief; answers the claim record and the brief run. */
  async function bookAndBrief(
    workspace: Workspace,
    slug: string,
  ): Promise<{ claim: string; brief: string; slot: string }> {
    const booked = await execa("node", [
      CLI_PATH,
      "--workspace",
      workspace.dir,
      "lab",
      "book",
      slug,
      "--about",
      "https://example.invalid/signed",
      "--json",
    ]);
    const minted = (JSON.parse(booked.stdout) as { minted: Array<{ id: string; kind: string }> }).minted;
    const claim = minted.find((item) => item.kind === "claim")!.id;
    const rendered = await execa("node", [CLI_PATH, "--workspace", workspace.dir, "lab", "brief", claim, "--json"]);
    const checked = await execa("node", [CLI_PATH, "--workspace", workspace.dir, "lab", "soundcheck", slug, "--json"]);
    const slot = (JSON.parse(checked.stdout) as { claims: Array<{ slot: string }> }).claims[0]!.slot;
    return { claim, brief: (JSON.parse(rendered.stdout) as { brief: string }).brief, slot };
  }

  async function sidecarCount(workspace: Workspace): Promise<number> {
    const { stdout } = await execa("git", [
      "--git-dir",
      workspace.gitDir,
      "ls-tree",
      "-r",
      "--name-only",
      "refs/heads/scope/default",
    ]);
    return stdout.split("\n").filter((path) => path.endsWith(".sig")).length;
  }

  beforeAll(async () => {
    key = await generateTestKey("operator");
  }, 60_000);

  afterAll(async () => {
    await rm(key.dir, { recursive: true, force: true });
  });

  test("a key named at the invocation signs the ruling's attestation, and the signature verifies on the next read", async () => {
    const workspace = await freshWorkspace("named", "person");
    const { claim, brief, slot } = await bookAndBrief(workspace, "named-key");
    expect(await sidecarCount(workspace)).toBe(0);

    await execa("node", [
      CLI_PATH,
      "--workspace",
      workspace.dir,
      "lab",
      "rule",
      claim,
      "--verdict",
      "holds",
      "--reason",
      "signed at the invocation",
      "--brief",
      brief,
      "--key",
      key.keyPath,
    ]);

    expect(await sidecarCount(workspace)).toBe(1);
    const { stdout } = await execa("node", [CLI_PATH, "--workspace", workspace.dir, "status", slot]);
    expect(stdout).toContain("holds");
    await rm(workspace.dir, { recursive: true, force: true });
  }, 60_000);

  test("a key this machine configured signs without the invocation naming one", async () => {
    const workspace = await freshWorkspace("configured", "person");
    await mkdir(workspace.localDir, { recursive: true });
    const signerPath = join(workspace.localDir, "signer.json");
    await writeFile(signerPath, JSON.stringify({ keyPath: key.keyPath }), { mode: 0o600 });
    await chmod(signerPath, 0o600);

    const { claim, brief, slot } = await bookAndBrief(workspace, "configured-key");
    await execa("node", [
      CLI_PATH,
      "--workspace",
      workspace.dir,
      "lab",
      "rule",
      claim,
      "--verdict",
      "holds",
      "--reason",
      "signed from the machine's own configuration",
      "--brief",
      brief,
    ]);

    expect(await sidecarCount(workspace)).toBe(1);
    const { stdout } = await execa("node", [CLI_PATH, "--workspace", workspace.dir, "status", slot]);
    expect(stdout).toContain("holds");
    await rm(workspace.dir, { recursive: true, force: true });
  }, 60_000);

  test("with the level demanding a signature and no key anywhere, the ruling is refused before anything is written", async () => {
    const workspace = await freshWorkspace("keyless", "all");
    const { claim, brief } = await bookAndBrief(workspace, "keyless");
    const before = await execa("git", ["--git-dir", workspace.gitDir, "rev-parse", "refs/heads/scope/default"]);

    const refused = (await execa(
      "node",
      [
        CLI_PATH,
        "--workspace",
        workspace.dir,
        "lab",
        "rule",
        claim,
        "--verdict",
        "holds",
        "--reason",
        "nothing signs this",
        "--brief",
        brief,
      ],
      { reject: false, env: { MUSAI_PRINCIPAL: KEYLESS } },
    )) as ExecaError;

    expect(refused.exitCode).not.toBe(0);
    expect(`${refused.stdout}${refused.stderr}`).toContain("requires a signature");
    const after = await execa("git", ["--git-dir", workspace.gitDir, "rev-parse", "refs/heads/scope/default"]);
    expect(after.stdout).toBe(before.stdout);
    await rm(workspace.dir, { recursive: true, force: true });
  }, 60_000);

  test("at level off with no key, a ruling still mints and lays no signature beside it", async () => {
    const workspace = await freshWorkspace("off", "off");
    const { claim, brief, slot } = await bookAndBrief(workspace, "unsigned");

    await execa(
      "node",
      [
        CLI_PATH,
        "--workspace",
        workspace.dir,
        "lab",
        "rule",
        claim,
        "--verdict",
        "holds",
        "--reason",
        "nobody asked for a signature",
        "--brief",
        brief,
      ],
      { env: { MUSAI_PRINCIPAL: KEYLESS } },
    );

    expect(await sidecarCount(workspace)).toBe(0);
    const { stdout } = await execa("node", [CLI_PATH, "--workspace", workspace.dir, "status", slot]);
    expect(stdout).toContain("holds");
    await rm(workspace.dir, { recursive: true, force: true });
  }, 60_000);

  test("a plan previews the same ruling without reaching for a key at all", async () => {
    const workspace = await freshWorkspace("planned", "person");
    const { claim, brief } = await bookAndBrief(workspace, "planned");

    const planned = await execa(
      "node",
      [
        CLI_PATH,
        "--workspace",
        workspace.dir,
        "lab",
        "rule",
        claim,
        "--verdict",
        "holds",
        "--reason",
        "previewed",
        "--brief",
        brief,
        "--plan",
      ],
      { env: { MUSAI_PRINCIPAL: KEYLESS } },
    );

    expect(planned.exitCode).toBe(0);
    expect(await sidecarCount(workspace)).toBe(0);
    await rm(workspace.dir, { recursive: true, force: true });
  }, 60_000);
});
