import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { bundleDigest, isKeyPrincipal, recordId, recordPath, sidecarPath, validateRecord } from "@musai/records";
import { describe, expect, it } from "vitest";
import {
  ATTESTATION,
  type BundleCase,
  bundleTable,
  CONFORMANCE_DIR,
  fixtureBundle,
  KEYED_CASES,
  SIGNED_CASES,
  unsignedCases,
} from "../scripts/conformance-bundles.js";
import { parseAllowedSigners } from "../src/allowed-signers.js";
import type { Attestation } from "../src/attestation.js";
import { verifyAttestation } from "../src/verify.js";

const BUNDLES = join(CONFORMANCE_DIR, "bundles");

function filesOf(dir: string, root = dir): Map<string, Buffer> {
  const found = new Map<string, Buffer>();
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      for (const [inner, bytes] of filesOf(path, root)) {
        found.set(inner, bytes);
      }
    } else {
      found.set(relative(root, path).split("\\").join("/"), readFileSync(path));
    }
  }
  return found;
}

const opensshAvailable = spawnSync("ssh-keygen", ["-Y", "check-novalidate"], { stdio: "ignore" }).error === undefined;

describe("the conformance bundles", () => {
  it("are listed in bundles.json exactly as the generator lists them", () => {
    const table = bundleTable([...unsignedCases(), ...SIGNED_CASES, ...KEYED_CASES]);
    expect(readFileSync(join(CONFORMANCE_DIR, "bundles.json"), "utf8")).toBe(table);
    expect(readdirSync(BUNDLES).sort()).toEqual(
      [...unsignedCases(), ...SIGNED_CASES, ...KEYED_CASES].map(({ bundleCase }) => bundleCase.name).sort(),
    );
  });

  it("name record.unreadable exactly where the kernel refuses an attestation a bundle holds", () => {
    const rows = JSON.parse(readFileSync(join(CONFORMANCE_DIR, "bundles.json"), "utf8")) as BundleCase[];
    for (const row of rows) {
      const refused = [...filesOf(join(BUNDLES, row.name))]
        .filter(([path]) => path.startsWith("records/attestation/") && path.endsWith(".json"))
        .filter(([, bytes]) => !validateRecord(JSON.parse(bytes.toString("utf8"))).ok);
      expect(refused.length > 0, row.name).toBe(row.codes.includes("record.unreadable"));
    }
  });

  it("name trust.key-mismatch exactly where the kernel refuses the allowed-signers a bundle holds", () => {
    const rows = JSON.parse(readFileSync(join(CONFORMANCE_DIR, "bundles.json"), "utf8")) as BundleCase[];
    for (const row of rows) {
      const signers = readFileSync(join(BUNDLES, row.name, "allowed-signers"), "utf8");
      if (row.codes.includes("trust.key-mismatch")) {
        expect(() => parseAllowedSigners(signers), row.name).toThrow(/one key never speaks as another/);
      } else {
        expect(() => parseAllowedSigners(signers), row.name).not.toThrow();
      }
    }
  });

  it("hold each unsigned case byte for byte as the generator derives it from the fixture", () => {
    for (const { bundleCase, bundle } of unsignedCases()) {
      const onDisk = filesOf(join(BUNDLES, bundleCase.name));
      expect([...onDisk.keys()].sort(), bundleCase.name).toEqual([...bundle.keys()].sort());
      for (const [path, bytes] of bundle) {
        expect(Buffer.compare(onDisk.get(path)!, Buffer.from(bytes)), `${bundleCase.name} ${path}`).toBe(0);
      }
    }
  });

  it("hold each signed case as the fixture with only its signature and allowed-signers changed", () => {
    const fixture = fixtureBundle();
    for (const { bundleCase } of SIGNED_CASES) {
      const onDisk = filesOf(join(BUNDLES, bundleCase.name));
      expect([...onDisk.keys()].sort()).toEqual([...fixture.keys()].sort());
      for (const [path, bytes] of fixture) {
        if (path !== "allowed-signers" && path !== sidecarPath(ATTESTATION)) {
          expect(Buffer.compare(onDisk.get(path)!, Buffer.from(bytes)), `${bundleCase.name} ${path}`).toBe(0);
        }
      }
    }
  });

  it("are each named in digests.json by the digest their files on disk give", () => {
    const digests = JSON.parse(readFileSync(join(CONFORMANCE_DIR, "digests.json"), "utf8")) as Record<string, string>;
    expect(Object.keys(digests).sort()).toEqual(readdirSync(BUNDLES).sort());
    for (const name of readdirSync(BUNDLES)) {
      expect(bundleDigest(filesOf(join(BUNDLES, name))), name).toBe(digests[name]);
    }
  });

  it("hold the passing bundle's every record at the path its kernel id names", () => {
    for (const [path, bytes] of filesOf(join(BUNDLES, "passing"))) {
      if (path.endsWith(".json")) {
        const value = JSON.parse(bytes.toString("utf8")) as { kind: Parameters<typeof recordPath>[0] };
        expect(recordPath(value.kind, recordId(value))).toBe(path);
      }
    }
  });
});

/** What ssh-keygen answers for a bundle's signed attestation, through the kernel's own
 * verification. */
async function openSshVerdict(name: string): Promise<{ good: boolean; failureReason?: string }> {
  const dir = join(BUNDLES, name);
  const path = recordPath("attestation", ATTESTATION);
  const signedBytes = readFileSync(join(dir, path));
  const attestation = { id: ATTESTATION, record: JSON.parse(signedBytes.toString("utf8")) } as Attestation;
  const result = await verifyAttestation({
    attestation,
    signedBytes,
    signature: readFileSync(join(dir, `${path}.sig`), "utf8"),
    allowedSignersPath: join(dir, "allowed-signers"),
  });
  return result.failureReason === undefined
    ? { good: result.good }
    : { good: result.good, failureReason: result.failureReason };
}

describe.skipIf(!opensshAvailable)("the signed bundles, as the system OpenSSH answers them", () => {
  const expected: Record<string, { good: boolean; failureReason?: string }> = {
    passing: { good: true },
    "principal-absent": { good: false, failureReason: "signature-invalid" },
    "other-namespace": { good: false, failureReason: "signature-invalid" },
    "namespace-not-permitted": { good: false, failureReason: "signature-invalid" },
    "not-yet-valid": { good: false, failureReason: "not-yet-valid" },
    expired: { good: false, failureReason: "no-longer-valid" },
    "window-held": { good: true },
  };
  for (const [name, verdict] of Object.entries(expected)) {
    it(`answers ${name} as its row says`, async () => {
      expect(await openSshVerdict(name)).toEqual(verdict);
    });
  }

  it("verifies an attestation naming its signer by key against a line listing that key's form", async () => {
    const dir = join(BUNDLES, "key-principal");
    const [path, bytes] = [...filesOf(dir)].find(
      ([candidate]) =>
        candidate.startsWith("records/attestation/") &&
        candidate.endsWith(".json") &&
        candidate !== recordPath("attestation", ATTESTATION),
    )!;
    const record = JSON.parse(bytes.toString("utf8")) as Attestation["record"];
    expect(isKeyPrincipal(record.principal)).toBe(true);
    const result = await verifyAttestation({
      attestation: { id: `sha256:${path.slice(-69, -5)}` as Attestation["id"], record },
      signedBytes: bytes,
      signature: readFileSync(join(dir, `${path}.sig`), "utf8"),
      allowedSignersPath: join(dir, "allowed-signers"),
    });
    expect(result.good).toBe(true);
  });

  it("agrees with every signed row's verdict", () => {
    const rows = JSON.parse(readFileSync(join(CONFORMANCE_DIR, "bundles.json"), "utf8")) as BundleCase[];
    for (const row of rows.filter((candidate) => candidate.name in expected)) {
      expect(expected[row.name]!.good, row.name).toBe(row.verdict === "verified");
    }
  });
});
