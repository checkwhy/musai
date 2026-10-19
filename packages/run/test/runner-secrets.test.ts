import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import type { RunRecipe } from "@musai/records";
import { keyedHash, RUN_ENV_HASH_PURPOSE } from "@musai/records";
import { currentKey, KeyFileError, keyById, mintKeyFile, readKeyFile, rotateKey } from "@musai/store";
import { fixedClock } from "@musai/test-support";
import { execa } from "execa";
import { describe, expect, test } from "vitest";
import { BindingError, readBindings } from "../src/bindings.js";
import { RunRefusedError } from "../src/hygiene.js";
import { movedSecretReads, refuseSecretInArgv, scrubOutput, secretObservation, secretReadId } from "../src/secrets.js";
import { performRecipe } from "../src/spawn.js";

const now = fixedClock("2026-01-01T00:00:00.000Z");

async function withWorkspace<T>(fn: (localDir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "musai-bindings-"));
  const localDir = join(root, "local");
  await mkdir(localDir, { recursive: true });
  try {
    return await fn(localDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeBindings(localDir: string, content: unknown, mode = 0o600): Promise<void> {
  const path = join(localDir, "bindings.json");
  await writeFile(path, JSON.stringify(content), { mode });
  await execa("chmod", [mode.toString(8), path]);
}

function recipeDeclaring(names: readonly { name: string; secret: boolean }[], command: readonly string[]): RunRecipe {
  return {
    command: [...command],
    workingDirectory: "/",
    environment: {},
    declared: names.map((n) => ({ name: n.name, secret: n.secret })),
    substrates: [],
    isolation: "hygiene",
  };
}

async function withLocalDir<T>(fn: (localDir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "musai-keys-"));
  const localDir = join(root, "local");
  await mkdir(localDir, { recursive: true });
  try {
    return await fn(localDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("keyedHash: a secret's presence on a receipt", () => {
  const key = new TextEncoder().encode("workspace-key-material");

  test("is reproducible for the same key, purpose, name and value", () => {
    const first = keyedHash(key, RUN_ENV_HASH_PURPOSE, "TOKEN", "abc123");
    const second = keyedHash(key, RUN_ENV_HASH_PURPOSE, "TOKEN", "abc123");
    expect(first).toBe(second);
  });

  test("differs for a different key", () => {
    const other = new TextEncoder().encode("a different workspace key");
    expect(keyedHash(key, RUN_ENV_HASH_PURPOSE, "TOKEN", "abc123")).not.toBe(
      keyedHash(other, RUN_ENV_HASH_PURPOSE, "TOKEN", "abc123"),
    );
  });

  test("differs for a different name", () => {
    expect(keyedHash(key, RUN_ENV_HASH_PURPOSE, "TOKEN", "abc123")).not.toBe(
      keyedHash(key, RUN_ENV_HASH_PURPOSE, "OTHER_TOKEN", "abc123"),
    );
  });

  test("differs for a value differing only in Unicode normalisation form", () => {
    const nfc = "café"; // é as one code point
    const nfd = "café"; // e + combining acute accent
    expect(nfc.normalize("NFC")).toBe(nfc);
    expect(nfc).not.toBe(nfd);
    expect(keyedHash(key, RUN_ENV_HASH_PURPOSE, "NAME", nfc)).not.toBe(
      keyedHash(key, RUN_ENV_HASH_PURPOSE, "NAME", nfd),
    );
  });

  test("an empty-string value still produces a hash", () => {
    const hash = keyedHash(key, RUN_ENV_HASH_PURPOSE, "TOKEN", "");
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
  });
});

describe("the workspace key file: minted exclusively, read strictly, rotated by adding and retiring", () => {
  test("mintKeyFile creates the file at mode 0600 with one current key", async () => {
    await withLocalDir(async (localDir) => {
      const file = await mintKeyFile(localDir, { now });
      expect(file.keys).toHaveLength(1);
      expect(file.keys[0]!.status).toBe("current");

      const stats = await stat(join(localDir, "keys.json"));
      expect(stats.mode & 0o777).toBe(0o600);
    });
  });

  test("a second mint against an existing file re-reads it rather than overwriting it", async () => {
    await withLocalDir(async (localDir) => {
      const first = await mintKeyFile(localDir, { now });
      const before = await readFile(join(localDir, "keys.json"), "utf8");
      const second = await mintKeyFile(localDir, { now });
      const after = await readFile(join(localDir, "keys.json"), "utf8");

      expect(second.keys[0]!.id).toBe(first.keys[0]!.id);
      expect(after).toBe(before);
    });
  });

  test("two concurrent mints against a workspace with no key file yet end with one key file holding one current key", async () => {
    await withLocalDir(async (localDir) => {
      const [a, b] = await Promise.all([mintKeyFile(localDir, { now }), mintKeyFile(localDir, { now })]);
      expect(a.keys[0]!.id).toBe(b.keys[0]!.id);

      const onDisk = await readKeyFile(localDir);
      expect(onDisk.keys).toHaveLength(1);
      expect(onDisk.keys[0]!.status).toBe("current");
    });
  });

  test("readKeyFile refuses a mode wider than 0600, naming the file by its name and the mode found", async () => {
    await withLocalDir(async (localDir) => {
      await mintKeyFile(localDir, { now });
      await execa("chmod", ["0644", join(localDir, "keys.json")]);

      await expect(readKeyFile(localDir)).rejects.toThrow(KeyFileError);
      await expect(readKeyFile(localDir)).rejects.toThrow("refusing keys.json: its mode is 644");
    });
  });

  test("readKeyFile refuses a malformed entry, naming the field", async () => {
    await withLocalDir(async (localDir) => {
      const path = join(localDir, "keys.json");
      await writeFile(
        path,
        JSON.stringify({ keys: [{ id: "abc", status: "unknown", createdAt: "x", material: "y" }] }),
        {
          mode: 0o600,
        },
      );
      await execa("chmod", ["0600", path]);

      await expect(readKeyFile(localDir)).rejects.toThrow(KeyFileError);
      await expect(readKeyFile(localDir)).rejects.toThrow(/status/);
    });
  });

  test("rotateKey leaves the previous key present and retired, and never unlinks anything", async () => {
    await withLocalDir(async (localDir) => {
      const minted = await mintKeyFile(localDir, { now });
      const originalId = minted.keys[0]!.id;

      const rotated = await rotateKey(localDir, { now });
      expect(rotated.keys).toHaveLength(2);

      const original = keyById(rotated, originalId)!;
      expect(original.status).toBe("retired");
      expect(currentKey(rotated).id).not.toBe(originalId);

      const stats = await stat(join(localDir, "keys.json"));
      expect(stats.mode & 0o777).toBe(0o600);
    });
  });

  test("a workspace directory an enclosing git working tree does not ignore refuses minting, naming the fix", async () => {
    const enclosingDir = await mkdtemp(join(tmpdir(), "musai-enclosing-"));
    try {
      await execa("git", ["init", "--quiet", "--initial-branch", "main", enclosingDir]);
      const localDir = join(enclosingDir, ".musai", "local");
      await mkdir(localDir, { recursive: true });

      await expect(mintKeyFile(localDir, { now })).rejects.toThrow(KeyFileError);
      await expect(mintKeyFile(localDir, { now })).rejects.toThrow(/ignore/);
    } finally {
      await rm(enclosingDir, { recursive: true, force: true });
    }
  });

  test("a GIT_DIR inherited from the operator's shell, naming a repository that ignores the workspace, does not lift the refusal", async () => {
    const enclosingDir = await mkdtemp(join(tmpdir(), "musai-enclosing-"));
    const elsewhereDir = await mkdtemp(join(tmpdir(), "musai-elsewhere-"));
    const saved = process.env["GIT_DIR"];
    try {
      await execa("git", ["init", "--quiet", "--initial-branch", "main", enclosingDir]);
      await execa("git", ["init", "--quiet", "--initial-branch", "main", elsewhereDir]);
      await writeFile(join(elsewhereDir, ".git", "info", "exclude"), ".musai/\n");
      const localDir = join(enclosingDir, ".musai", "local");
      await mkdir(localDir, { recursive: true });
      process.env["GIT_DIR"] = join(elsewhereDir, ".git");

      await expect(mintKeyFile(localDir, { now })).rejects.toThrow(KeyFileError);
    } finally {
      if (saved === undefined) {
        delete process.env["GIT_DIR"];
      } else {
        process.env["GIT_DIR"] = saved;
      }
      await rm(enclosingDir, { recursive: true, force: true });
      await rm(elsewhereDir, { recursive: true, force: true });
    }
  });

  test("a workspace directory an enclosing git working tree does ignore mints normally", async () => {
    const enclosingDir = await mkdtemp(join(tmpdir(), "musai-enclosing-"));
    try {
      await execa("git", ["init", "--quiet", "--initial-branch", "main", enclosingDir]);
      await writeFile(join(enclosingDir, ".gitignore"), ".musai/\n");
      const localDir = join(enclosingDir, ".musai", "local");
      await mkdir(localDir, { recursive: true });

      const file = await mintKeyFile(localDir, { now });
      expect(file.keys).toHaveLength(1);
    } finally {
      await rm(enclosingDir, { recursive: true, force: true });
    }
  });
});

describe("secretObservation: what a secret becomes on a receipt", () => {
  test("carries the keyed hash and the key id, and never the value", async () => {
    await withLocalDir(async (localDir) => {
      const file = await mintKeyFile(localDir, { now });
      const key = currentKey(file);
      const observation = secretObservation(key, "TOKEN", "super-secret-value");

      expect(observation.secret).toBe(true);
      expect(observation.value).toBeNull();
      expect(observation.keyId).toBe(key.id);
      expect(typeof observation.keyedHash).toBe("string");
      expect(JSON.stringify(observation)).not.toContain("super-secret-value");
    });
  });
});

describe("movedSecretReads: whether a bound secret's read has moved, per read id", () => {
  test("binding one name to one value twice under the same current key produces the same hash and the same read id", async () => {
    await withLocalDir(async (localDir) => {
      const file = await mintKeyFile(localDir, { now });
      const key = currentKey(file);
      const first = secretObservation(key, "TOKEN", "value-one");
      const second = secretObservation(key, "TOKEN", "value-one");

      expect(first.keyedHash).toBe(second.keyedHash);
      expect(secretReadId("TOKEN", first.keyId!, first.keyedHash!)).toBe(
        secretReadId("TOKEN", second.keyId!, second.keyedHash!),
      );
    });
  });

  test("rotating the workspace key alone, with no value changed, moves no read", async () => {
    await withLocalDir(async (localDir) => {
      const minted = await mintKeyFile(localDir, { now });
      const key = currentKey(minted);
      const observation = secretObservation(key, "TOKEN", "value-one");
      const readId = secretReadId("TOKEN", observation.keyId!, observation.keyedHash!);

      const rotated = await rotateKey(localDir, { now });
      const moved = movedSecretReads(rotated, new Set([readId]), (name) =>
        name === "TOKEN" ? "value-one" : undefined,
      );

      expect(moved.size).toBe(0);
    });
  });

  test("changing the bound value moves exactly the read that bound it", async () => {
    await withLocalDir(async (localDir) => {
      const file = await mintKeyFile(localDir, { now });
      const key = currentKey(file);
      const observation = secretObservation(key, "TOKEN", "value-one");
      const readId = secretReadId("TOKEN", observation.keyId!, observation.keyedHash!);

      const moved = movedSecretReads(file, new Set([readId]), (name) => (name === "TOKEN" ? "value-two" : undefined));

      expect(moved.has(readId)).toBe(true);
    });
  });

  test("a binding that disappeared entirely moves its read", async () => {
    await withLocalDir(async (localDir) => {
      const file = await mintKeyFile(localDir, { now });
      const key = currentKey(file);
      const observation = secretObservation(key, "TOKEN", "value-one");
      const readId = secretReadId("TOKEN", observation.keyId!, observation.keyedHash!);

      const moved = movedSecretReads(file, new Set([readId]), () => undefined);

      expect(moved.has(readId)).toBe(true);
    });
  });

  test("a key id the workspace never held leaves its read untouched", async () => {
    await withLocalDir(async (localDir) => {
      const file = await mintKeyFile(localDir, { now });
      const readId = secretReadId("TOKEN", "some-peer-workspace-key-id", "0123456789abcdef");

      const moved = movedSecretReads(file, new Set([readId]), () => "whatever");

      expect(moved.size).toBe(0);
    });
  });
});

describe("bindDeclaredNames, wired into performRecipe: where a declared name's value comes from", () => {
  test("a plain binding's value appears in the child's environment and in the receipt", async () => {
    await withWorkspace(async (localDir) => {
      await writeBindings(localDir, { NAME: { secret: false, value: "plain-value" } });
      const recipe = recipeDeclaring(
        [{ name: "NAME", secret: false }],
        ["node", "-e", "process.stdout.write(process.env.NAME || '')"],
      );

      const { observation } = await performRecipe(recipe, { localDir });

      expect(observation.output).toBe("plain-value");
      expect(observation.bindings).toEqual([
        { name: "NAME", secret: false, layer: "bindings", value: "plain-value", keyedHash: null, keyId: null },
      ]);
    });
  });

  test("a secret binding's value appears in the child's environment and nowhere in the receipt", async () => {
    await withWorkspace(async (localDir) => {
      const value = "shh-secret-value";
      const expectedBase64 = Buffer.from(value, "utf8").toString("base64");
      await writeBindings(localDir, { TOKEN: { secret: true, value } });
      const recipe = recipeDeclaring(
        [{ name: "TOKEN", secret: true }],
        // The expected value travels as base64, so the argument list never carries the raw secret.
        [
          "node",
          "-e",
          `process.exit(process.env.TOKEN === Buffer.from(${JSON.stringify(expectedBase64)}, 'base64').toString() ? 0 : 1)`,
        ],
      );

      const { observation } = await performRecipe(recipe, { localDir });

      expect(observation.exitCode).toBe(0);
      expect(observation.bindings).toHaveLength(1);
      expect(observation.bindings[0]!.value).toBeNull();
      expect(typeof observation.bindings[0]!.keyedHash).toBe("string");
      expect(JSON.stringify(observation.bindings)).not.toContain(value);
    });
  });

  test("a command binding runs the operator's helper and records the command rather than its output", async () => {
    await withWorkspace(async (localDir) => {
      const helperCommand = ["node", "-e", "process.stdout.write(String(21 * 2))"];
      await writeBindings(localDir, { NAME: { secret: false, command: helperCommand } });
      const recipe = recipeDeclaring(
        [{ name: "NAME", secret: false }],
        ["node", "-e", "process.stdout.write(process.env.NAME || '')"],
      );

      const { observation } = await performRecipe(recipe, { localDir });

      expect(observation.output).toBe("42");
      expect(observation.bindings[0]!.value).toBe(JSON.stringify(helperCommand));
      expect(observation.bindings[0]!.value).not.toContain("42");
    });
  });

  test("a helper named by its path is recorded by its program name, so the receipt holds no path", async () => {
    await withWorkspace(async (localDir) => {
      const helperCommand = [process.execPath, "-e", "process.stdout.write('42')"];
      await writeBindings(localDir, { NAME: { secret: false, command: helperCommand } });
      const recipe = recipeDeclaring(
        [{ name: "NAME", secret: false }],
        ["node", "-e", "process.stdout.write(process.env.NAME || '')"],
      );

      const { observation } = await performRecipe(recipe, { localDir });

      expect(observation.output).toBe("42");
      expect(JSON.parse(observation.bindings[0]!.value!)[0]).toBe(basename(process.execPath));
      expect(observation.bindings[0]!.value).not.toContain(dirname(process.execPath));
    });
  });

  test("a name declared plain by a recipe and secret by the local file is recorded secret", async () => {
    await withWorkspace(async (localDir) => {
      await writeBindings(localDir, { NAME: { secret: true, value: "x" } });
      const recipe = recipeDeclaring([{ name: "NAME", secret: false }], ["true"]);

      const { observation } = await performRecipe(recipe, { localDir });

      expect(observation.bindings[0]!.secret).toBe(true);
    });
  });

  test("a name declared secret by a recipe and plain by the local file is recorded secret", async () => {
    await withWorkspace(async (localDir) => {
      await writeBindings(localDir, { NAME: { secret: false, value: "x" } });
      const recipe = recipeDeclaring([{ name: "NAME", secret: true }], ["true"]);

      const { observation } = await performRecipe(recipe, { localDir });

      expect(observation.bindings[0]!.secret).toBe(true);
    });
  });

  test("a name no source raises stays plain", async () => {
    await withWorkspace(async (localDir) => {
      await writeBindings(localDir, { NAME: { secret: false, value: "x" } });
      const recipe = recipeDeclaring([{ name: "NAME", secret: false }], ["true"]);

      const { observation } = await performRecipe(recipe, { localDir });

      expect(observation.bindings[0]!.secret).toBe(false);
    });
  });

  test("a name only the project layer's declarations mark secret is recorded as a keyed hash and scrubbed from the output", async () => {
    await withWorkspace(async (localDir) => {
      const value = "layer-declared-secret";
      await writeBindings(localDir, { TOKEN: { secret: false, value } });
      const recipe = recipeDeclaring(
        [{ name: "TOKEN", secret: false }],
        ["node", "-e", "process.stdout.write('token=' + process.env.TOKEN)"],
      );

      const { observation } = await performRecipe(recipe, {
        localDir,
        layerDeclarations: new Map([["TOKEN", { secret: true }]]),
      });

      expect(observation.bindings).toHaveLength(1);
      expect(observation.bindings[0]).toMatchObject({ name: "TOKEN", secret: true, value: null });
      expect(typeof observation.bindings[0]!.keyedHash).toBe("string");
      expect(observation.output).not.toContain(value);
      expect(observation.scrubbed).toEqual([{ name: "TOKEN", count: 1 }]);
    });
  });

  test("the same name the project layer's declarations leave out is recorded with its value", async () => {
    await withWorkspace(async (localDir) => {
      const value = "layer-declared-secret";
      await writeBindings(localDir, { TOKEN: { secret: false, value } });
      const recipe = recipeDeclaring(
        [{ name: "TOKEN", secret: false }],
        ["node", "-e", "process.stdout.write('token=' + process.env.TOKEN)"],
      );

      const { observation } = await performRecipe(recipe, { localDir, layerDeclarations: new Map() });

      expect(observation.bindings[0]).toMatchObject({ name: "TOKEN", secret: false, value, keyedHash: null });
      expect(observation.output).toBe(`token=${value}`);
      expect(observation.scrubbed).toEqual([]);
    });
  });

  test("a declared name with no binding refuses the run before spawn, naming the variable and the file", async () => {
    await withWorkspace(async (localDir) => {
      await writeBindings(localDir, {});
      const recipe = recipeDeclaring([{ name: "MISSING_NAME", secret: false }], ["true"]);

      await expect(performRecipe(recipe, { localDir })).rejects.toThrow(BindingError);
      await expect(performRecipe(recipe, { localDir })).rejects.toThrow(/MISSING_NAME/);
      await expect(performRecipe(recipe, { localDir })).rejects.toThrow(/bindings\.json/);
    });
  });

  test("a bindings file whose mode is wider than 0600 refuses the run naming the file", async () => {
    await withWorkspace(async (localDir) => {
      await writeBindings(localDir, { NAME: { secret: false, value: "x" } }, 0o644);
      const recipe = recipeDeclaring([{ name: "NAME", secret: false }], ["true"]);

      await expect(performRecipe(recipe, { localDir })).rejects.toThrow(BindingError);
      await expect(performRecipe(recipe, { localDir })).rejects.toThrow(/0644|644/);
    });
  });

  test("a bindings file that is an array rather than an object keyed by name refuses the run naming the file", async () => {
    await withWorkspace(async (localDir) => {
      await writeBindings(localDir, [{ secret: false, value: "x" }]);
      const recipe = recipeDeclaring([{ name: "NAME", secret: false }], ["true"]);

      await expect(performRecipe(recipe, { localDir })).rejects.toThrow(BindingError);
      await expect(performRecipe(recipe, { localDir })).rejects.toThrow(/bindings\.json: it must be an object/);
    });
  });

  test("an entry that is an array rather than an object refuses, naming the variable", async () => {
    await withWorkspace(async (localDir) => {
      await writeBindings(localDir, { NAME: ["x"] });
      const recipe = recipeDeclaring([{ name: "NAME", secret: false }], ["true"]);

      await expect(performRecipe(recipe, { localDir })).rejects.toThrow(BindingError);
      await expect(performRecipe(recipe, { localDir })).rejects.toThrow(/binding NAME .*each entry must be an object/);
    });
  });

  test("an entry declaring both a value and a command refuses, naming the variable", async () => {
    await withWorkspace(async (localDir) => {
      await writeBindings(localDir, { NAME: { secret: false, value: "x", command: ["true"] } });
      const recipe = recipeDeclaring([{ name: "NAME", secret: false }], ["true"]);

      await expect(performRecipe(recipe, { localDir })).rejects.toThrow(BindingError);
      await expect(performRecipe(recipe, { localDir })).rejects.toThrow(/NAME/);
    });
  });

  test("the key file is minted only when a secret binding is first needed", async () => {
    await withWorkspace(async (localDir) => {
      await writeBindings(localDir, { NAME: { secret: false, value: "x" } });
      const recipe = recipeDeclaring([{ name: "NAME", secret: false }], ["true"]);

      await performRecipe(recipe, { localDir });

      await expect(stat(join(localDir, "keys.json"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  test("a run with a secret binding mints the key file", async () => {
    await withWorkspace(async (localDir) => {
      await writeBindings(localDir, { TOKEN: { secret: true, value: "x" } });
      const recipe = recipeDeclaring([{ name: "TOKEN", secret: true }], ["true"]);

      await performRecipe(recipe, { localDir });

      const stats = await stat(join(localDir, "keys.json"));
      expect(stats.mode & 0o777).toBe(0o600);
    });
  });
});

describe("refuseSecretInArgv: the leak that precedes the receipt", () => {
  test("refuses a command whose argument list carries a bound secret's value, naming the variable", () => {
    expect(() =>
      refuseSecretInArgv(
        ["curl", "--header", "Authorization: shh-secret-value"],
        [{ name: "TOKEN", value: "shh-secret-value" }],
      ),
    ).toThrow(RunRefusedError);
    expect(() =>
      refuseSecretInArgv(
        ["curl", "--header", "Authorization: shh-secret-value"],
        [{ name: "TOKEN", value: "shh-secret-value" }],
      ),
    ).toThrow(/TOKEN/);
  });

  test("the refusal message never contains the value", () => {
    try {
      refuseSecretInArgv(["curl", "shh-secret-value"], [{ name: "TOKEN", value: "shh-secret-value" }]);
      throw new Error("expected refuseSecretInArgv to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RunRefusedError);
      expect((error as Error).message).not.toContain("shh-secret-value");
    }
  });

  test("does not refuse when no argument carries the value", () => {
    expect(() =>
      refuseSecretInArgv(["curl", "--silent"], [{ name: "TOKEN", value: "shh-secret-value" }]),
    ).not.toThrow();
  });

  test("a secret bound to the empty string is never matched", () => {
    expect(() => refuseSecretInArgv(["curl", ""], [{ name: "TOKEN", value: "" }])).not.toThrow();
  });
});

describe("refuseSecretInArgv, wired into performRecipe: no child process runs when the argument list would carry a bound secret", () => {
  test("the run is refused with no child process created", async () => {
    await withWorkspace(async (localDir) => {
      const markerPath = join(localDir, "spawned-marker");
      await writeBindings(localDir, { TOKEN: { secret: true, value: "shh-secret-value" } });
      const recipe = recipeDeclaring(
        [{ name: "TOKEN", secret: true }],
        ["node", "-e", `require('fs').writeFileSync(${JSON.stringify(markerPath)}, '')`, "shh-secret-value"],
      );

      await expect(performRecipe(recipe, { localDir })).rejects.toThrow(RunRefusedError);
      await expect(stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});

describe("scrubOutput: what the output lost, and what it says it lost", () => {
  const secret = { name: "TOKEN", value: "supersecretvalue" };

  test("replaces the raw, base64 and URL-encoded forms and counts each", () => {
    const raw = secret.value;
    const base64 = Buffer.from(raw, "utf8").toString("base64");
    const encoded = encodeURIComponent(raw);
    const output = `raw=${raw} b64=${base64} enc=${encoded}`;

    const { text, report } = scrubOutput(output, [secret], 6);

    expect(text).not.toContain(raw);
    expect(text).not.toContain(base64);
    expect(text).not.toContain(encoded);
    expect(report).toEqual([{ name: "TOKEN", count: 3 }]);
  });

  test("a secret shorter than the minimum length is not scrubbed and produces no report entry", () => {
    const short = { name: "SHORT", value: "abc" };
    const output = "value is abc here";

    const { text, report } = scrubOutput(output, [short], 6);

    expect(text).toBe(output);
    expect(report).toEqual([]);
  });

  test("an output holding no secret records an empty report", () => {
    const { text, report } = scrubOutput("nothing to see here", [secret], 6);
    expect(text).toBe("nothing to see here");
    expect(report).toEqual([]);
  });
});

describe("scrubOutput, wired into performRecipe: the observation's scrub report", () => {
  test("an output holding a secret in three encodings comes back scrubbed with a report counting each", async () => {
    await withWorkspace(async (localDir) => {
      await writeBindings(localDir, { TOKEN: { secret: true, value: "supersecretvalue" } });
      const recipe = recipeDeclaring(
        [{ name: "TOKEN", secret: true }],
        [
          "node",
          "-e",
          "const v = process.env.TOKEN; process.stdout.write('raw=' + v + ' b64=' + Buffer.from(v).toString('base64') + ' enc=' + encodeURIComponent(v))",
        ],
      );

      const { observation } = await performRecipe(recipe, { localDir });

      expect(observation.output).not.toContain("supersecretvalue");
      expect(observation.scrubbed).toEqual([{ name: "TOKEN", count: 3 }]);
    });
  });

  test("a run whose output held no secret records an empty scrub array", async () => {
    await withWorkspace(async (localDir) => {
      await writeBindings(localDir, { TOKEN: { secret: true, value: "supersecretvalue" } });
      const recipe = recipeDeclaring(
        [{ name: "TOKEN", secret: true }],
        ["node", "-e", "process.stdout.write('nothing secret here')"],
      );

      const { observation } = await performRecipe(recipe, { localDir });

      expect(observation.scrubbed).toEqual([]);
    });
  });
});

describe("a secret binding contributes a read, through the same mechanism every other read id uses", () => {
  test("the same value bound twice under one key yields the same read id", async () => {
    await withWorkspace(async (localDir) => {
      await writeBindings(localDir, { TOKEN: { secret: true, value: "value-one" } });
      const recipe = recipeDeclaring([{ name: "TOKEN", secret: true }], ["true"]);

      const first = await performRecipe(recipe, { localDir });
      const second = await performRecipe(recipe, { localDir });

      expect(first.reads.size).toBe(1);
      expect([...first.reads]).toEqual([...second.reads]);
    });
  });

  test("a changed value yields a different read id", async () => {
    await withWorkspace(async (localDir) => {
      await writeBindings(localDir, { TOKEN: { secret: true, value: "value-one" } });
      const recipe = recipeDeclaring([{ name: "TOKEN", secret: true }], ["true"]);
      const first = await performRecipe(recipe, { localDir });

      await writeBindings(localDir, { TOKEN: { secret: true, value: "value-two" } });
      const second = await performRecipe(recipe, { localDir });

      expect([...first.reads]).not.toEqual([...second.reads]);
    });
  });

  test("no secret binding contributes no read", async () => {
    await withWorkspace(async (localDir) => {
      const recipe = recipeDeclaring([], ["true"]);
      const { reads } = await performRecipe(recipe, { localDir });
      expect(reads.size).toBe(0);
    });
  });
});

describe("a refusal over the workspace's bindings or key file names the file and never a path on this machine", () => {
  /** The refusal `recipe` meets, checked to name neither the local directory nor its parent. */
  async function refusalOf(recipe: RunRecipe, localDir: string): Promise<string> {
    const error = await performRecipe(recipe, { localDir }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).not.toContain(localDir);
    expect(message).not.toContain(basename(dirname(localDir)));
    return message;
  }

  const plain = recipeDeclaring([{ name: "NAME", secret: false }], ["true"]);
  const secret = recipeDeclaring([{ name: "TOKEN", secret: true }], ["true"]);

  async function writeKeys(localDir: string, content: string, mode: number): Promise<void> {
    const path = join(localDir, "keys.json");
    await writeFile(path, content);
    await chmod(path, mode);
  }

  test("a bindings file that is not JSON, or wider than its owner", async () => {
    await withWorkspace(async (localDir) => {
      await writeFile(join(localDir, "bindings.json"), "{ not json", { mode: 0o600 });
      expect(await refusalOf(plain, localDir)).toContain("refusing bindings.json: it is not valid JSON");

      await writeBindings(localDir, { NAME: { secret: false, value: "v" } }, 0o644);
      expect(await refusalOf(plain, localDir)).toContain("refusing bindings.json: its mode is 644");
    });
  });

  test("a key file wider than its owner, or holding a malformed entry", async () => {
    await withWorkspace(async (localDir) => {
      await writeBindings(localDir, { TOKEN: { secret: true, value: "a-bound-secret" } });
      await writeKeys(localDir, JSON.stringify({ keys: [] }), 0o644);
      expect(await refusalOf(secret, localDir)).toContain("refusing keys.json: its mode is 644");

      await writeKeys(localDir, JSON.stringify({ keys: [{ id: 1 }] }), 0o600);
      expect(await refusalOf(secret, localDir)).toContain("refusing keys.json: entry 0's id must be a string");
    });
  });

  test("a key the enclosing working tree would stage", async () => {
    const enclosingDir = await mkdtemp(join(tmpdir(), "musai-enclosing-"));
    try {
      await execa("git", ["init", "--quiet", "--initial-branch", "main", enclosingDir]);
      const localDir = join(enclosingDir, ".musai", "local");
      await mkdir(localDir, { recursive: true });
      await writeBindings(localDir, { TOKEN: { secret: true, value: "a-bound-secret" } });
      expect(await refusalOf(secret, localDir)).toContain("refusing to mint keys.json");
    } finally {
      await rm(enclosingDir, { recursive: true, force: true });
    }
  });

  test.skipIf(process.getuid?.() === 0)(
    "a bindings file, a key file or a binary the system will not read, or a key file it will not write",
    async () => {
      await withWorkspace(async (localDir) => {
        await chmod(localDir, 0o000);
        try {
          expect(await refusalOf(plain, localDir)).toContain("refusing tools.json: it could not be read (EACCES)");
          const unreadBindings = await readBindings(localDir).catch((caught: unknown) => caught);
          expect((unreadBindings as Error).message).toBe("refusing bindings.json: it could not be read (EACCES)");
        } finally {
          await chmod(localDir, 0o700);
        }

        await writeBindings(localDir, { TOKEN: { secret: true, value: "a-bound-secret" } });
        await writeKeys(localDir, JSON.stringify({ keys: [] }), 0o000);
        expect(await refusalOf(secret, localDir)).toContain("refusing keys.json: it could not be read (EACCES)");

        await rm(join(localDir, "keys.json"));
        await chmod(localDir, 0o500);
        try {
          expect(await refusalOf(secret, localDir)).toContain("refusing keys.json: it could not be written (EACCES)");
        } finally {
          await chmod(localDir, 0o700);
        }

        const binDir = join(dirname(localDir), "bin");
        await mkdir(binDir);
        await writeFile(join(binDir, "musai-unreadable-tool"), "#!/bin/sh\n", { mode: 0o111 });
        await chmod(join(binDir, "musai-unreadable-tool"), 0o111);
        const savedPath = process.env["PATH"];
        process.env["PATH"] = `${binDir}${delimiter}${savedPath ?? ""}`;
        try {
          expect(await refusalOf(recipeDeclaring([], ["musai-unreadable-tool"]), localDir)).toContain(
            "the binary musai-unreadable-tool found on the invoking process's own PATH could not be read to digest it (EACCES)",
          );
        } finally {
          process.env["PATH"] = savedPath;
        }
      });
    },
  );
});
