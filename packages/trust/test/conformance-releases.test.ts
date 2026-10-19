import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { type AttestationRecord, KIND_CONTRACTS, type RecordId, validateRecord } from "@musai/records";
import { describe, expect, it } from "vitest";
import { CONFORMANCE_DIR } from "../scripts/conformance-bundles.js";
import { audiencesTable, RELEASE_CASES, releasesTable, rolesTable } from "../scripts/conformance-releases.js";
import { verifyAttestation } from "../src/verify.js";

const RELEASES = join(CONFORMANCE_DIR, "releases");

const opensshAvailable = spawnSync("ssh-keygen", ["-Y", "check-novalidate"], { stdio: "ignore" }).error === undefined;

function filesOf(dir: string, root = dir): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? filesOf(path, root) : [relative(root, path).split("\\").join("/")];
  });
}

describe("the release conformance tables a verifier in another language is held to", () => {
  it("hold byte for byte what the generator derives from the kernel", () => {
    expect(readFileSync(join(CONFORMANCE_DIR, "roles.json"), "utf8")).toBe(rolesTable());
    expect(readFileSync(join(CONFORMANCE_DIR, "audiences.json"), "utf8")).toBe(audiencesTable());
    expect(readFileSync(join(CONFORMANCE_DIR, "releases.json"), "utf8")).toBe(releasesTable());
    expect(readdirSync(RELEASES).sort()).toEqual(RELEASE_CASES.map(({ name }) => name).sort());
  });

  it.skipIf(!opensshAvailable)("every release case's attestations verify under the system OpenSSH", async () => {
    for (const { name } of RELEASE_CASES) {
      const dir = join(RELEASES, name);
      const sidecars = filesOf(dir).filter((path) => path.endsWith(".json.sig"));
      expect(sidecars.length, name).toBeGreaterThan(0);
      for (const sidecar of sidecars) {
        const path = sidecar.slice(0, -".sig".length);
        const signedBytes = new Uint8Array(readFileSync(join(dir, path)));
        const record = JSON.parse(new TextDecoder().decode(signedBytes)) as AttestationRecord;
        const result = await verifyAttestation({
          attestation: { id: `sha256:${path.slice(-69, -5)}` as RecordId, record },
          signedBytes,
          signature: readFileSync(join(dir, sidecar), "utf8"),
          allowedSignersPath: join(dir, "allowed-signers"),
        });
        expect(result.good, `${name} ${path}`).toBe(true);
      }
    }
  });
});

describe("the release conformance cases agree with the kernel on which attestations it holds", () => {
  it("name record.unreadable exactly when the kernel refuses an attestation of a version it reads", () => {
    for (const { name, codes } of RELEASE_CASES) {
      const dir = join(RELEASES, name);
      const refused = filesOf(dir)
        .filter((path) => path.startsWith("records/attestation/") && path.endsWith(".json"))
        .map((path) => JSON.parse(readFileSync(join(dir, path), "utf8")) as Record<string, unknown>)
        .filter(
          (record) =>
            typeof record["schemaVersion"] !== "number" ||
            record["schemaVersion"] <= KIND_CONTRACTS.attestation.version,
        )
        .filter((record) => !validateRecord(record).ok);
      expect(refused.length > 0, name).toBe(codes.includes("record.unreadable"));
    }
  });

  it("read the attestation versions the Go verifier checks, 2 to 6", () => {
    const { version, normalizers } = KIND_CONTRACTS.attestation;
    expect([version, ...Object.keys(normalizers).map(Number)].sort()).toEqual([2, 3, 4, 5, 6]);
  });
});
