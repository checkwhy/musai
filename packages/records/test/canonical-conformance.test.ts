import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalBytes, recordId } from "../src/canonical/canonicalize.js";

interface ConformanceVector {
  readonly name: string;
  readonly input: unknown;
  readonly expectedId: string;
}

const vectorsPath = fileURLToPath(new URL("../src/canonical/vectors.json", import.meta.url));
const vectors = JSON.parse(readFileSync(vectorsPath, "utf8")) as ConformanceVector[];

const PACKAGES_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// A static import of an untyped .mjs does not compile under strict, so it is read at runtime.
const { ROLES } = (await import(new URL("../../../scripts/package-roles.mjs", import.meta.url).href)) as {
  ROLES: ReadonlyMap<string, string>;
};

/** A hash minted in any kernel-side package bypasses the one canonicaliser. */
const KERNEL_SIDE_SRC_ROOTS: readonly string[] = [...ROLES]
  .filter(([, role]) => role === "kernel-side")
  .map(([dir]) => join(PACKAGES_ROOT, dir, "src"));

/** Reverses every object's key order and leaves arrays alone: only key order is insignificant. */
function permuteKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(permuteKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const permuted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).reverse()) {
      permuted[key] = permuteKeysDeep((value as Record<string, unknown>)[key]);
    }
    return permuted;
  }
  return value;
}

describe("the fixed table of adversarial vectors is an oracle for the canonicalizer", () => {
  it("has at least fourteen rows, each shaped { name, input, expectedId }", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(14);
    for (const vector of vectors) {
      expect(typeof vector.name).toBe("string");
      expect(vector).toHaveProperty("input");
      expect(vector.expectedId).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("has no duplicate vector name", () => {
    const names = vectors.map((vector) => vector.name);
    expect(new Set(names).size).toBe(names.length);
  });

  for (const vector of vectors) {
    it(`hashes "${vector.name}" to the id recorded in its row`, () => {
      expect(recordId(vector.input)).toBe(vector.expectedId);
    });

    it(`hashes a key-order-permuted copy of "${vector.name}" to the same id`, () => {
      const permuted = permuteKeysDeep(vector.input);
      expect(recordId(permuted)).toBe(vector.expectedId);
    });
  }

  it("never gives two vectors with different canonical bytes the same id, except where a row is expected to collide", () => {
    const idsByBytes = new Map<string, string>();
    for (const vector of vectors) {
      const bytesKey = new TextDecoder().decode(canonicalBytes(vector.input));
      const existing = idsByBytes.get(bytesKey);
      if (existing !== undefined) {
        expect(vector.expectedId).toBe(existing);
      } else {
        idsByBytes.set(bytesKey, vector.expectedId);
      }
    }
  });

  it("collapses negative zero and positive zero to the same canonical bytes and the same id", () => {
    const negativeZero = vectors.find((vector) => vector.name === "negative-zero")!;
    const positiveZero = vectors.find((vector) => vector.name === "positive-zero")!;
    expect(negativeZero.expectedId).toBe(positiveZero.expectedId);
  });
});

describe("values the canonicalizer refuses outright rather than silently hashing", () => {
  it("refuses NaN", () => {
    expect(() => canonicalBytes({ v: Number.NaN })).toThrow();
  });

  it("refuses Infinity", () => {
    expect(() => canonicalBytes({ v: Number.POSITIVE_INFINITY })).toThrow();
  });

  it("refuses a lone surrogate rather than hashing ill-formed UTF-16", () => {
    expect(() => canonicalBytes({ v: "\ud800" })).toThrow();
  });

  it("refuses a bare undefined value, since it has no canonical JSON representation", () => {
    expect(() => canonicalBytes(undefined)).toThrow(TypeError);
  });
});

async function collectTsFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.push(fullPath);
      }
    }
  }
  await walk(dir);
  return files;
}

async function kernelSideTsFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const root of KERNEL_SIDE_SRC_ROOTS) {
    files.push(...(await collectTsFiles(root)));
  }
  return files;
}

describe("one canonicalizer in the kernel mints every hash", () => {
  it("exactly one file under any kernel-side package's src/ imports a crypto primitive, and that file is canonical/canonicalize.ts", async () => {
    const cryptoPattern = /\bnode:crypto\b|createHash|createHmac|webcrypto|crypto\.subtle|CryptoHasher/;
    const allFiles = await kernelSideTsFiles();

    const filesWithCrypto: string[] = [];
    for (const file of allFiles) {
      const source = await readFile(file, "utf8");
      if (cryptoPattern.test(source)) {
        filesWithCrypto.push(file);
      }
    }

    expect(filesWithCrypto, `files importing a crypto primitive: ${filesWithCrypto.join(", ")}`).toHaveLength(1);
    expect(filesWithCrypto[0]).toContain("canonical/canonicalize.ts");
  });

  it("the canonicaliser is blind to the reserved key, hashing a sealed value as the ordinary object it is", () => {
    const sealed = {
      $sealed: { alg: "aes-256-gcm", keyId: "key-1", ciphertext: "Y2lwaGVydGV4dA==", digest: "a".repeat(64) },
    };
    const asPlainObject = {
      $sealed: { digest: "a".repeat(64), ciphertext: "Y2lwaGVydGV4dA==", keyId: "key-1", alg: "aes-256-gcm" },
    };
    expect(recordId(sealed)).toBe(recordId(asPlainObject));
    expect(new TextDecoder().decode(canonicalBytes(sealed))).toBe(
      '{"$sealed":{"alg":"aes-256-gcm","ciphertext":"Y2lwaGVydGV4dA==","digest":"' +
        "a".repeat(64) +
        '","keyId":"key-1"}}',
    );
  });

  it("exactly one file under any kernel-side package's src/ imports the canonicalize package, and it is the same file", async () => {
    const canonicalizePattern = /import\s+(\{.*\}|\w+)\s+from\s+['"]canonicalize['"]/;
    const allFiles = await kernelSideTsFiles();

    const filesWithCanonicalizeImport: string[] = [];
    for (const file of allFiles) {
      const source = await readFile(file, "utf8");
      if (canonicalizePattern.test(source)) {
        filesWithCanonicalizeImport.push(file);
      }
    }

    expect(
      filesWithCanonicalizeImport,
      `files importing the canonicalize package: ${filesWithCanonicalizeImport.join(", ")}`,
    ).toHaveLength(1);
    expect(filesWithCanonicalizeImport[0]).toContain("canonical/canonicalize.ts");
  });

  /** Admitted by name, so a third minting site fails the guard rather than loosening a count. */
  const ADMITTED_DIGEST_FUNCTIONS = ["digestId", "keyedHash"] as const;

  function functionBody(source: string, name: string): string {
    const signature = new RegExp(`function ${name}\\([^)]*\\)[^{]*\\{`);
    const match = signature.exec(source);
    if (!match) {
      throw new Error(`no function named ${name} found in canonical/canonicalize.ts`);
    }
    const openBraceIndex = match.index + match[0].length - 1;
    let depth = 0;
    let index = openBraceIndex;
    for (; index < source.length; index++) {
      if (source[index] === "{") depth++;
      else if (source[index] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    return source.slice(openBraceIndex, index + 1);
  }

  it("computes a digest only inside digestId and keyedHash, admitted here by name, one call each", async () => {
    const canonicalizeFile = fileURLToPath(new URL("../src/canonical/canonicalize.ts", import.meta.url));
    const source = await readFile(canonicalizeFile, "utf8");

    for (const name of ADMITTED_DIGEST_FUNCTIONS) {
      const body = functionBody(source, name);
      const digestCallsInFunction = body.match(/\.digest\s*\(/g) ?? [];
      expect(digestCallsInFunction).toHaveLength(1);
    }

    const digestCalls = source.match(/\.digest\s*\(/g) ?? [];
    expect(digestCalls).toHaveLength(ADMITTED_DIGEST_FUNCTIONS.length);
  });
});
