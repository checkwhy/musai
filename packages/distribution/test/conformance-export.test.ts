import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { bundleDigest, type RecordId, type RecordKind, recordId, recordPath } from "@musai/records";
import { type Attestation, verifyAttestation } from "@musai/trust";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONFORMANCE_DIR, type ExportCase } from "../scripts/conformance-export.js";

const hasTar = spawnSync("tar", ["--version"]).status === 0;
const opensshAvailable = spawnSync("ssh-keygen", ["-Y", "check-novalidate"], { stdio: "ignore" }).error === undefined;

function filesOf(dir: string, root = dir): Map<string, Uint8Array> {
  const found = new Map<string, Uint8Array>();
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      for (const [inner, bytes] of filesOf(path, root)) {
        found.set(inner, bytes);
      }
    } else {
      found.set(relative(root, path).split("\\").join("/"), new Uint8Array(readFileSync(path)));
    }
  }
  return found;
}

const rows = JSON.parse(readFileSync(join(CONFORMANCE_DIR, "exports.json"), "utf8")) as ExportCase[];

describe("the exports the kernel wrote for a verifier to pass", () => {
  it("are listed in exports.json, each archive under exports/, and nothing else", () => {
    expect(rows.map((row) => row.archive).sort()).toEqual(
      readdirSync(join(CONFORMANCE_DIR, "exports"))
        .map((name) => `exports/${name}`)
        .sort(),
    );
  });
});

describe.skipIf(!hasTar)("an export, unpacked as a receiver unpacks it", () => {
  const unpacked = new Map<string, Map<string, Uint8Array>>();
  let scratch: string;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "musai-conformance-export-"));
    for (const row of rows) {
      const dir = join(scratch, row.name);
      mkdirSync(dir, { recursive: true });
      execFileSync("tar", ["-xzf", join(CONFORMANCE_DIR, row.archive), "-C", dir]);
      unpacked.set(row.name, filesOf(dir));
    }
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("digests to what its row names", () => {
    for (const row of rows) {
      expect(bundleDigest(unpacked.get(row.name)!), row.name).toBe(row.digest);
    }
  });

  it("holds every record at the path its kernel id names", () => {
    for (const [name, files] of unpacked) {
      for (const [path, bytes] of files) {
        if (path.startsWith("records/") && path.endsWith(".json")) {
          const value = JSON.parse(new TextDecoder().decode(bytes)) as { kind: RecordKind };
          expect(recordPath(value.kind, recordId(value)), `${name} ${path}`).toBe(path);
        }
      }
    }
  });

  it.skipIf(!opensshAvailable)(
    "holds a signature for every attestation, each verifying against its own allowed-signers",
    async () => {
      for (const row of rows) {
        const files = unpacked.get(row.name)!;
        const attestations = [...files.keys()].filter(
          (path) => path.startsWith("records/attestation/") && path.endsWith(".json"),
        );
        expect(attestations.length, row.name).toBeGreaterThan(0);
        for (const path of attestations) {
          const signedBytes = files.get(path)!;
          const record = JSON.parse(new TextDecoder().decode(signedBytes)) as Attestation["record"];
          const result = await verifyAttestation({
            attestation: { id: recordId(record) as RecordId, record },
            signedBytes,
            signature: new TextDecoder().decode(files.get(`${path}.sig`)!),
            allowedSignersPath: join(scratch, row.name, "allowed-signers"),
          });
          expect(result.good, `${row.name} ${path}`).toBe(true);
        }
      }
    },
  );
});
