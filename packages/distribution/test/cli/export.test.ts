import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RecordId, type RecordKind, recordPath } from "@musai/records";
import { generateTestKey, pseudonymOf, type TestKey, writeTrustFile } from "@musai/test-support";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  bookAndRule,
  musai,
  musaiJson,
  type Ruled,
  type SignedWorkspace,
  signedWorkspace,
} from "./signed-workspace.js";

interface Exported {
  readonly path: string;
  readonly digest: string;
  readonly records: number;
  readonly signatures: number;
  readonly blobs: number;
  readonly released: string | null;
}

const hasTar = spawnSync("tar", ["--version"]).status === 0;
const hasSha256sum = spawnSync("sha256sum", ["--version"]).status === 0;

const AT = { now: "2026-03-01T00:00:00.000Z" };

function stored(kind: RecordKind, id: string): string {
  return recordPath(kind, id as RecordId);
}

function entriesOf(archive: string): string[] {
  return execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
}

function fileIn(archive: string, path: string): string {
  return execFileSync("tar", ["-xzOf", archive, path], { encoding: "utf8" });
}

describe("an export releases a record and its closure to an audience and writes them as a bundle a stranger verifies", () => {
  let key: TestKey;
  let scratch: string;
  const workspaces: SignedWorkspace[] = [];
  let count = 0;

  async function ruled(
    name: string,
    roles = `${key.principal} owner any\n`,
  ): Promise<{ workspace: SignedWorkspace } & Ruled> {
    const workspace = await signedWorkspace(name, key, roles);
    workspaces.push(workspace);
    return { workspace, ...(await bookAndRule(workspace, name, key)) };
  }

  function out(): string {
    count += 1;
    return join(scratch, `bundle-${count}.tar.gz`);
  }

  async function tip(workspace: SignedWorkspace): Promise<string> {
    return execFileSync("git", ["--git-dir", workspace.gitDir, "rev-parse", "refs/heads/scope/default"], {
      encoding: "utf8",
    });
  }

  beforeAll(async () => {
    key = await generateTestKey("operator");
    scratch = await mkdtemp(join(tmpdir(), "musai-export-"));
  }, 60_000);

  afterAll(async () => {
    await rm(key.dir, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
    for (const workspace of workspaces) {
      await rm(workspace.dir, { recursive: true, force: true });
    }
  });

  test.skipIf(!hasTar)(
    "an export with nothing released mints one closure release and ships it, with who made each record",
    async () => {
      const { workspace, ruling, claim, brief, made } = await ruled("export-mints");

      const path = out();
      const exported = await musaiJson<Exported>(workspace, [
        "export",
        ruling,
        "--to",
        "public",
        "--out",
        path,
        "--key",
        key.keyPath,
      ]);
      const entries = entriesOf(path);

      expect(exported.released).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(entries).toEqual([...entries].sort());
      expect(entries).toEqual(
        expect.arrayContaining([
          "allowed-signers",
          "audiences",
          "bundle.json",
          "roles",
          stored("ruling", ruling),
          stored("claim", claim),
          stored("run", brief),
          stored("attestation", exported.released!),
          stored("attestation", made),
        ]),
      );
      expect(entries).not.toContain("config.json");
      const attestations = entries.filter(
        (entry) => entry.startsWith("records/attestation/") && entry.endsWith(".json"),
      );
      const signatures = entries.filter((entry) => entry.endsWith(".sig"));
      expect(signatures.sort()).toEqual(attestations.map((entry) => `${entry}.sig`).sort());
      expect(exported.records).toBe(
        entries.filter((entry) => entry.endsWith(".json") && entry !== "bundle.json").length,
      );
      expect(exported.signatures).toBe(signatures.length);
      expect(exported.path).toBe(path);
    },
    180_000,
  );

  test.skipIf(!hasTar || !hasSha256sum)(
    "an export to an audience already covered mints nothing, and names the same bundle by the same digest",
    async () => {
      const { workspace, ruling } = await ruled("export-digest");
      const first = out();
      const second = out();
      const one = await musaiJson<Exported>(
        workspace,
        ["export", ruling, "--to", "known", "--out", first, "--key", key.keyPath],
        AT,
      );
      const two = await musaiJson<Exported>(workspace, ["export", ruling, "--to", "known", "--out", second], AT);

      expect(one.released).not.toBeNull();
      expect(two.released).toBeNull();
      expect(Buffer.from(await readFile(first)).equals(Buffer.from(await readFile(second)))).toBe(true);
      expect(two.digest).toBe(one.digest);
      const unpacked = await mkdtemp(join(scratch, "unpacked-"));
      execFileSync("tar", ["-xzf", first, "-C", unpacked]);
      const listing = execFileSync("sha256sum", entriesOf(first), { cwd: unpacked });
      expect(execFileSync("sha256sum", { input: listing, encoding: "utf8" }).split(" ")[0]).toBe(one.digest);
    },
    180_000,
  );

  test.skipIf(!hasTar)(
    "the manifest names the root, the audience the export was cut for and when",
    async () => {
      const { workspace, ruling } = await ruled("export-manifest");
      const path = out();
      await musaiJson(workspace, ["export", ruling, "--to", "public", "--out", path, "--key", key.keyPath], AT);

      expect(JSON.parse(fileIn(path, "bundle.json"))).toEqual({ root: ruling, audience: "public", at: AT.now });
    },
    180_000,
  );

  test.skipIf(!hasTar)(
    "the bundle carries the audiences its release reaches, and none an export to the public needs",
    async () => {
      const { workspace, ruling } = await ruled("export-audiences");
      const toKnown = out();
      const toPublic = out();
      await musaiJson(workspace, ["export", ruling, "--to", "known", "--out", toKnown, "--key", key.keyPath]);
      await musaiJson(workspace, ["export", ruling, "--to", "public", "--out", toPublic, "--key", key.keyPath]);

      expect(fileIn(toKnown, "audiences")).toBe("peer\nknown includes peer\n");
      expect(fileIn(toPublic, "audiences")).toBe("");
    },
    180_000,
  );

  test.skipIf(!hasTar)(
    "carries only what the record cites and who made it, never a record it merely pins",
    async () => {
      const { workspace, ruling } = await ruled("export-pins");
      const path = out();
      await musaiJson(workspace, ["export", ruling, "--to", "public", "--out", path, "--key", key.keyPath]);
      const entries = entriesOf(path);

      expect(entries.filter((entry) => /^records\/(case|module)\//.test(entry) || entry.startsWith("blobs/"))).toEqual(
        [],
      );
      expect(
        entries.filter(
          (entry) => !/^records\/[a-z]+\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.json(\.sig)?$/.test(entry),
        ),
      ).toEqual(["allowed-signers", "audiences", "bundle.json", "roles"]);
    },
    180_000,
  );

  test.skipIf(!hasTar)(
    "a closure release covers each record its root cites, transitively, and no attestation on them",
    async () => {
      const { workspace, ruling, claim, brief, made } = await ruled("export-closure");
      await musaiJson(workspace, ["lab", "release", ruling, "--to", "public", "--closure", "--key", key.keyPath]);

      const path = out();
      const exported = await musaiJson<Exported>(workspace, ["export", ruling, "--to", "public", "--out", path]);
      const entries = entriesOf(path);

      expect(exported.released).toBeNull();
      expect(entries).toEqual(
        expect.arrayContaining([stored("ruling", ruling), stored("claim", claim), stored("run", brief)]),
      );
      expect(entries).not.toContain(stored("attestation", made));
    },
    180_000,
  );

  test.skipIf(!hasTar)(
    "carries into a narrower audience what was released to a wider one",
    async () => {
      const { workspace, ruling } = await ruled("export-nested");
      await musaiJson(workspace, ["lab", "release", ruling, "--to", "known", "--closure", "--key", key.keyPath]);

      const exported = await musaiJson<Exported>(workspace, ["export", ruling, "--to", "peer", "--out", out()]);
      expect(exported.released).toBeNull();
    },
    180_000,
  );

  test.skipIf(!hasTar)(
    "an export to a member key is carried by a release to an audience holding that key",
    async () => {
      const { workspace, ruling } = await ruled("export-member");
      const fingerprint = execFileSync("ssh-keygen", ["-l", "-f", `${key.keyPath}.pub`], { encoding: "utf8" }).split(
        " ",
      )[1]!;
      await writeTrustFile({ gitDir: workspace.gitDir }, "audiences", `team member key:${fingerprint}\n`);
      await musaiJson(workspace, ["lab", "release", ruling, "--to", "team", "--closure", "--key", key.keyPath]);

      const exported = await musaiJson<Exported>(workspace, [
        "export",
        ruling,
        "--to",
        `key:${fingerprint}`,
        "--out",
        out(),
      ]);
      expect(exported.released).toBeNull();
    },
    180_000,
  );

  test.skipIf(!hasTar)(
    "a revoked release is never in a bundle",
    async () => {
      const { workspace, ruling } = await ruled("export-revoked-release");
      const first = await musaiJson<{ minted: { id: string }[] }>(workspace, [
        "lab",
        "release",
        ruling,
        "--to",
        "public",
        "--closure",
        "--key",
        key.keyPath,
      ]);
      await musaiJson(workspace, ["lab", "revoke", ruling, "--to", "public", "--key", key.keyPath]);
      const again = await musaiJson<{ minted: { id: string }[] }>(workspace, [
        "lab",
        "release",
        ruling,
        "--to",
        "public",
        "--for",
        "review",
        "--closure",
        "--key",
        key.keyPath,
      ]);

      const path = out();
      await musaiJson(workspace, ["export", ruling, "--to", "public", "--out", path]);
      const entries = entriesOf(path);
      expect(entries).toContain(stored("attestation", again.minted[0]!.id));
      expect(entries).not.toContain(stored("attestation", first.minted[0]!.id));
    },
    180_000,
  );

  test("an export refuses to undo a revocation, naming lab release", async () => {
    const { workspace, ruling } = await ruled("export-revoked");
    await musaiJson(workspace, ["export", ruling, "--to", "public", "--out", out(), "--key", key.keyPath]);
    await musaiJson(workspace, ["lab", "revoke", ruling, "--to", "public", "--key", key.keyPath]);
    const before = await tip(workspace);

    const refused = await musai(workspace, ["export", ruling, "--to", "public", "--out", out(), "--key", key.keyPath]);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("was revoked");
    expect(refused.stderr).toContain(`musai lab release ${ruling} --to public --closure`);
    expect(await tip(workspace)).toBe(before);
  }, 180_000);

  test("a release outside its window at the export's now is refused by name", async () => {
    const { workspace, ruling } = await ruled("export-window");
    const released = await musaiJson<{ minted: { id: string }[] }>(workspace, [
      "lab",
      "release",
      ruling,
      "--to",
      "public",
      "--closure",
      "--until",
      "2026-02-01T00:00:00.000Z",
      "--key",
      key.keyPath,
    ]);

    const refused = await musai(
      workspace,
      ["export", ruling, "--to", "public", "--out", out(), "--key", key.keyPath],
      AT,
    );
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain(`its release ${released.minted[0]!.id} is outside its window at ${AT.now}`);
  }, 180_000);

  test("an export by a principal without publish mints nothing and writes no bundle", async () => {
    const bystander = "bystander@example.test";
    const { workspace, ruling } = await ruled(
      "export-bystander",
      `${key.principal} owner any\n${pseudonymOf(bystander)} delegate any\n`,
    );
    const before = await tip(workspace);
    const path = out();

    const refused = await musai(workspace, ["export", ruling, "--to", "public", "--out", path], {
      principal: bystander,
    });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain(
      `release.grant@2 needs publish, and the role matrix does not grant it to ${pseudonymOf(bystander)}`,
    );
    expect(await tip(workspace)).toBe(before);
    await expect(readFile(path)).rejects.toThrow();
  }, 180_000);

  test("an export names its root as status and why do, by a claim's short id", async () => {
    const { workspace, claim } = await ruled("export-short");
    const path = out();
    await musaiJson(
      workspace,
      [
        "export",
        claim.slice("sha256:".length, "sha256:".length + 12),
        "--to",
        "public",
        "--out",
        path,
        "--key",
        key.keyPath,
      ],
      AT,
    );

    expect(JSON.parse(fileIn(path, "bundle.json"))).toMatchObject({ root: claim });
  }, 180_000);

  test("never writes over a file already at the path it was given, and mints nothing first", async () => {
    const { workspace, ruling } = await ruled("export-overwrite");
    const path = out();
    await writeFile(path, "someone else's file");
    const before = await tip(workspace);

    const refused = await musai(workspace, ["export", ruling, "--to", "public", "--out", path, "--key", key.keyPath]);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain(`${path} already exists, and an export never writes over a file`);
    expect(await readFile(path, "utf8")).toBe("someone else's file");
    expect(await tip(workspace)).toBe(before);
  }, 180_000);
});
