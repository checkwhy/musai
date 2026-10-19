import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTIONS, ANY_SCOPE, coded, contains, narrowerThan, point, versionString } from "@musai/records";
import { describe, expect, test } from "vitest";
import { parseAllowedSigners } from "../src/allowed-signers.js";
import { EMPTY_TRUST_DEFAULT, may, type RoleMatrix, roleMatrix } from "../src/authority.js";
import { parseRoles, ROLES, type RoleGrant } from "../src/roles.js";

const SAMPLE_PUBLIC_KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIMCX3JpuLe+4GAsZ2UMufrO8HDH0UBCe3s/vbgD46W1O";

async function readFileOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function digestTree(dir: string): Promise<string> {
  const entries: string[] = [];
  async function walk(current: string, prefix: string): Promise<void> {
    const names = (await readdir(current)).sort();
    for (const name of names) {
      const fullPath = join(current, name);
      const relativePath = `${prefix}${name}`;
      const info = await stat(fullPath);
      if (info.isDirectory()) {
        await walk(fullPath, `${relativePath}/`);
      } else {
        const content = await readFile(fullPath);
        entries.push(`${relativePath}:${createHash("sha256").update(content).digest("hex")}`);
      }
    }
  }
  await walk(dir, "");
  return entries.join("\n");
}

describe("parsing the allowed-signers file", () => {
  test("round-trips a hand-written file with a validity window, a comment line and a blank line", () => {
    const content = [
      "# a comment line",
      "",
      `alice@example.com valid-after="20250101000000",valid-before="20990101000000" ssh-ed25519 ${SAMPLE_PUBLIC_KEY}`,
      "",
    ].join("\n");
    const signers = parseAllowedSigners(content);
    expect(signers).toHaveLength(1);
    expect(signers[0]!.principals).toBe("alice@example.com");
    expect(signers[0]!.validAfter).toBe("20250101000000");
    expect(signers[0]!.validBefore).toBe("20990101000000");
    expect(signers[0]!.keyType).toBe("ssh-ed25519");
    expect(signers[0]!.key).toBe(SAMPLE_PUBLIC_KEY);
  });

  test("each of the four empty forms of the file parses to no entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "musai-authority-test-"));
    try {
      expect(parseAllowedSigners(await readFileOrEmpty(join(dir, "does-not-exist")))).toEqual([]);

      const zeroLengthPath = join(dir, "zero-length");
      await writeFile(zeroLengthPath, "");
      expect(parseAllowedSigners(await readFileOrEmpty(zeroLengthPath))).toEqual([]);

      const whitespaceOnlyPath = join(dir, "whitespace-only");
      await writeFile(whitespaceOnlyPath, "   \n\t\n  \n");
      expect(parseAllowedSigners(await readFileOrEmpty(whitespaceOnlyPath))).toEqual([]);

      const commentOnlyPath = join(dir, "comment-only");
      await writeFile(commentOnlyPath, "# nothing here\n# or here\n");
      expect(parseAllowedSigners(await readFileOrEmpty(commentOnlyPath))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the scope algebra stand-in", () => {
  test("two incomparable point scopes: neither contains the other, and narrowerThan reports neither as narrower", () => {
    const a = point("project-a");
    const b = point("project-b");
    expect(contains(a, b)).toBe(false);
    expect(contains(b, a)).toBe(false);
    expect(narrowerThan(a, b)).toBe(false);
    expect(narrowerThan(b, a)).toBe(false);
  });

  test("any contains every scope", () => {
    expect(contains(ANY_SCOPE, point("project-a"))).toBe(true);
    expect(contains(ANY_SCOPE, ANY_SCOPE)).toBe(true);
  });
});

describe("parsing the roles file", () => {
  test("each of the four empty forms of the file parses to no grants", async () => {
    const dir = await mkdtemp(join(tmpdir(), "musai-authority-test-"));
    try {
      expect(parseRoles(await readFileOrEmpty(join(dir, "does-not-exist")))).toEqual([]);

      const zeroLengthPath = join(dir, "zero-length");
      await writeFile(zeroLengthPath, "");
      expect(parseRoles(await readFileOrEmpty(zeroLengthPath))).toEqual([]);

      const whitespaceOnlyPath = join(dir, "whitespace-only");
      await writeFile(whitespaceOnlyPath, "   \n\t\n  \n");
      expect(parseRoles(await readFileOrEmpty(whitespaceOnlyPath))).toEqual([]);

      const commentOnlyPath = join(dir, "comment-only");
      await writeFile(commentOnlyPath, "# nothing here\n# or here\n");
      expect(parseRoles(await readFileOrEmpty(commentOnlyPath))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a hand-written line becomes one grant", () => {
    const grants = parseRoles("alice@example.com maintainer project-a\n");
    expect(grants).toEqual([{ principal: "alice@example.com", role: "maintainer", scope: point("project-a") }]);
  });
});

describe("the role matrix", () => {
  test("both files empty takes the empty-files default", () => {
    const matrix = roleMatrix([], [], "deadbeef");
    expect(matrix.emptyDefault).toBe(true);
    expect(matrix.asymmetric).toBe(false);
    expect(may(matrix, "anyone@example.com", "rule", ANY_SCOPE)).toBe(true);
    expect(may(matrix, "anyone@example.com", "configure-floor", point("project-a"))).toBe(true);
  });

  test("EMPTY_TRUST_DEFAULT lists exactly the five actions in the documented order", () => {
    expect(EMPTY_TRUST_DEFAULT).toEqual(["rule", "set-aside", "publish", "override-person", "configure-floor"]);
    expect(EMPTY_TRUST_DEFAULT).toEqual([...ACTIONS]);
  });

  test("evaluating the empty-files default writes nothing to the workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "musai-authority-test-"));
    try {
      await writeFile(join(dir, "marker"), "unchanged\n");
      const before = await digestTree(dir);
      roleMatrix([], [], "deadbeef");
      const after = await digestTree(dir);
      expect(after).toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a principal granted one role twice at one scope holds it once", () => {
    const grants: RoleGrant[] = [
      { principal: "alice@example.com", role: "maintainer", scope: point("project-a") },
      { principal: "alice@example.com", role: "maintainer", scope: point("project-a") },
    ];
    const matrix = roleMatrix(
      [{ principals: "alice@example.com", certAuthority: false, keyType: "ssh-ed25519", key: SAMPLE_PUBLIC_KEY }],
      grants,
      "deadbeef",
    );
    expect(matrix.entries).toHaveLength(1);
    expect(matrix.entries[0]!.actions.size).toBe(new Set(["rule", "set-aside", "publish"]).size);
  });

  test("every role granting set-aside also grants rule", () => {
    for (const role of ROLES) {
      const matrix = roleMatrix(
        [{ principals: "alice@example.com", certAuthority: false, keyType: "ssh-ed25519", key: SAMPLE_PUBLIC_KEY }],
        [{ principal: "alice@example.com", role, scope: ANY_SCOPE }],
        "deadbeef",
      );
      if (may(matrix, "alice@example.com", "set-aside", ANY_SCOPE)) {
        expect(may(matrix, "alice@example.com", "rule", ANY_SCOPE), role).toBe(true);
      }
    }
  });

  test("two grants at coded scopes differing only in their arguments sort as two entries", () => {
    const contribution = { module: "musai.demo", name: "in-team", version: versionString("1") };
    const grants: RoleGrant[] = [
      {
        principal: "alice@example.com",
        role: "maintainer",
        scope: coded({ ...contribution, args: { team: "platform" } }),
      },
      { principal: "alice@example.com", role: "maintainer", scope: coded({ ...contribution, args: { team: "docs" } }) },
    ];
    const matrix = roleMatrix(
      [{ principals: "alice@example.com", certAuthority: false, keyType: "ssh-ed25519", key: SAMPLE_PUBLIC_KEY }],
      grants,
      "deadbeef",
    );
    expect(matrix.entries).toHaveLength(2);
  });

  test("the roles file and the matrix match a pseudonymous principal by exact string, as they match any other", () => {
    const pseudonym = `pseudonym:key-1:${"a".repeat(64)}`;
    const grants = parseRoles(`${pseudonym} maintainer project-a\n`);
    expect(grants).toEqual([{ principal: pseudonym, role: "maintainer", scope: point("project-a") }]);

    const matrix = roleMatrix(
      [{ principals: pseudonym, certAuthority: false, keyType: "ssh-ed25519", key: SAMPLE_PUBLIC_KEY }],
      grants,
      "deadbeef",
    );
    expect(may(matrix, pseudonym, "publish", point("project-a"))).toBe(true);
    expect(may(matrix, "alice@example.com", "publish", point("project-a"))).toBe(false);
  });

  test("grants at two incomparable scopes both apply, neither narrower", () => {
    const grants: RoleGrant[] = [
      { principal: "alice@example.com", role: "maintainer", scope: point("project-a") },
      { principal: "alice@example.com", role: "arbiter", scope: point("project-b") },
    ];
    const signers = [
      { principals: "alice@example.com", certAuthority: false, keyType: "ssh-ed25519", key: SAMPLE_PUBLIC_KEY },
    ];
    const matrix = roleMatrix(signers, grants, "deadbeef");
    expect(may(matrix, "alice@example.com", "publish", point("project-a"))).toBe(true);
    expect(may(matrix, "alice@example.com", "override-person", point("project-b"))).toBe(true);
    expect(may(matrix, "alice@example.com", "publish", point("project-b"))).toBe(false);
    expect(narrowerThan(point("project-a"), point("project-b"))).toBe(false);
    expect(narrowerThan(point("project-b"), point("project-a"))).toBe(false);
  });

  test("reordering the roles file's lines produces the same matrix", () => {
    const original = [
      "alice@example.com maintainer project-a",
      "bob@example.com arbiter project-b",
      "carol@example.com owner any",
    ].join("\n");
    const shuffled = [
      "carol@example.com owner any",
      "bob@example.com arbiter project-b",
      "alice@example.com maintainer project-a",
    ].join("\n");
    const signers = [{ principals: "*", certAuthority: false, keyType: "ssh-ed25519", key: SAMPLE_PUBLIC_KEY }];
    const fromOriginal = roleMatrix(signers, parseRoles(original), "deadbeef");
    const fromShuffled = roleMatrix(signers, parseRoles(shuffled), "deadbeef");
    expect(toComparableMatrix(fromShuffled)).toEqual(toComparableMatrix(fromOriginal));
  });

  test("the matrix carries the commit it was evaluated against, and two evaluations at the same commit are deep-equal", () => {
    const grants: RoleGrant[] = [{ principal: "alice@example.com", role: "owner", scope: ANY_SCOPE }];
    const first = roleMatrix([], grants, "abc123");
    const second = roleMatrix([], grants, "abc123");
    expect(first.commit).toBe("abc123");
    expect(toComparableMatrix(first)).toEqual(toComparableMatrix(second));
  });

  test("the allowed-signers file empty while the roles file holds grants is reported as its own condition", () => {
    const grants: RoleGrant[] = [{ principal: "alice@example.com", role: "owner", scope: ANY_SCOPE }];
    const matrix = roleMatrix([], grants, "deadbeef");
    expect(matrix.emptyDefault).toBe(false);
    expect(matrix.asymmetric).toBe(true);
  });
});

/** Sets are order-independent for deep-equality purposes; arrays are not. */
function toComparableMatrix(matrix: RoleMatrix): unknown {
  return {
    commit: matrix.commit,
    emptyDefault: matrix.emptyDefault,
    asymmetric: matrix.asymmetric,
    entries: matrix.entries.map((entry) => ({
      principal: entry.principal,
      scope: entry.scope,
      actions: [...entry.actions].sort(),
    })),
  };
}

describe("authority comes only from the two trust files", () => {
  test("the trust package's signing and authority files name no external platform as a source of authority", async () => {
    const files = [
      "../src/attestation.ts",
      "../src/sign.ts",
      "../src/verify.ts",
      "../src/allowed-signers.ts",
      "../src/roles.ts",
      "../src/authority.ts",
    ];
    const forbidden = /collaborator|committer|gh api|forge/i;
    for (const relativePath of files) {
      const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
      expect(source).not.toMatch(forbidden);
    }
  });
});
