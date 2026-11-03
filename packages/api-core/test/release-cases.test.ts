import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  idFromPath,
  kindFromPath,
  type MusaiRecord,
  type RecordId,
  type RecordKind,
  RecordRefusedError,
  readLaterAttestation,
  readStoredRecord,
  referencesOf,
  sidecarPath,
  timestamp,
} from "@musai/records";
import { parseAllowedSigners, parseAudiences, parseRoles, roleMatrix, verifyAttestation } from "@musai/trust";
import { beforeAll, describe, expect, it } from "vitest";
import { type ReleaseStanding, releaseCoverage, releaseStandingAmong, type Withdrawing } from "../src/release.js";

const CONFORMANCE = fileURLToPath(new URL("../../../conformance/", import.meta.url));

const opensshAvailable = spawnSync("ssh-keygen", ["-Y", "check-novalidate"], { stdio: "ignore" }).error === undefined;

interface ReleaseRow {
  readonly name: string;
  readonly entitlement: "covered" | "uncovered" | "unchecked";
  readonly codes: readonly string[];
}

/** The verifier codes a coverage answers; the rest speak of integrity or of single releases. */
const COVERAGE_CODES: ReadonlySet<string> = new Set(["release.uncovered", "release.window"]);

/** A release or a revocation lets a record go and is never part of what must be covered. */
const LETTING_GO: ReadonlySet<string> = new Set(["released", "revoked"]);

const rows = JSON.parse(readFileSync(join(CONFORMANCE, "releases.json"), "utf8")) as ReleaseRow[];

function filesOf(dir: string, root = dir): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? filesOf(path, root) : [relative(root, path).split("\\").join("/")];
  });
}

const trustFile = (dir: string, name: string): string =>
  existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "";

/** Each record as the fold reads it, with what its bytes cite, and as the fold keeps them, what
 * every version fixes of each attestation it refused for a later version. */
function recordsIn(dir: string): {
  records: Map<RecordId, { record: MusaiRecord; cites: RecordId[] }>;
  later: Withdrawing[];
} {
  const records = new Map<RecordId, { record: MusaiRecord; cites: RecordId[] }>();
  const later: Withdrawing[] = [];
  for (const path of filesOf(dir).filter((file) => file.startsWith("records/") && file.endsWith(".json"))) {
    const id = idFromPath(path);
    const bytes = new Uint8Array(readFileSync(join(dir, path)));
    try {
      const record = readStoredRecord(bytes, id, kindFromPath(path));
      const value = JSON.parse(new TextDecoder().decode(bytes)) as { kind: RecordKind };
      records.set(id, { record, cites: referencesOf(value).citations.map((citation) => citation.id) });
    } catch (error) {
      if (!(error instanceof RecordRefusedError)) {
        throw error;
      }
      const fixed = kindFromPath(path) === "attestation" ? readLaterAttestation(bytes, id) : null;
      if (fixed !== null) {
        later.push({ id, record: fixed });
      }
    }
  }
  return { records, later };
}

async function verifiedIn(dir: string, attestations: readonly Withdrawing[]): Promise<Set<RecordId>> {
  const verified = new Set<RecordId>();
  for (const { id, record } of attestations) {
    const sidecar = join(dir, sidecarPath(id));
    if (!existsSync(sidecar) || record.principal === null || record.at === null) {
      continue;
    }
    const recordPath = sidecar.slice(0, -".sig".length);
    const result = await verifyAttestation({
      attestation: { id, record: { principal: record.principal, at: record.at } },
      signedBytes: new Uint8Array(readFileSync(recordPath)),
      signature: readFileSync(sidecar, "utf8"),
      allowedSignersPath: join(dir, "allowed-signers"),
    });
    if (result.good) {
      verified.add(id);
    }
  }
  return verified;
}

/** The kernel's answer for a case: its entitlement, and the coverage codes that answer names. */
async function kernelJudgement(name: string): Promise<{ entitlement: ReleaseRow["entitlement"]; codes: string[] }> {
  const dir = join(CONFORMANCE, "releases", name);
  if (!existsSync(join(dir, "bundle.json"))) {
    return { entitlement: "unchecked", codes: [] };
  }
  const manifest = JSON.parse(readFileSync(join(dir, "bundle.json"), "utf8")) as { audience: string; at: string };
  const matrix = roleMatrix(
    parseAllowedSigners(trustFile(dir, "allowed-signers")),
    parseRoles(trustFile(dir, "roles")),
    name,
  );
  const audiences = parseAudiences(trustFile(dir, "audiences"));
  const { records, later } = recordsIn(dir);
  const attestations = [...records]
    .flatMap(([id, { record }]) => (record.kind === "attestation" ? [{ id, record }] : []))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const verified = await verifiedIn(dir, [...attestations, ...later]);
  const members = [...records]
    .filter(([, { record }]) => record.kind !== "attestation" || !LETTING_GO.has(record.purpose))
    .map(([id, { cites }]) => ({ id, cites }));
  const standing = new Map<RecordId, ReleaseStanding>(
    members.map((member) => [member.id, releaseStandingAmong(member.id, attestations, later, matrix, verified)]),
  );
  const { uncovered } = releaseCoverage(members, standing, manifest.audience, audiences, timestamp(manifest.at));
  const codes = [
    ...(uncovered.length === 0 ? [] : ["release.uncovered"]),
    ...(uncovered.some((member) => member.withheld?.because === "window") ? ["release.window"] : []),
  ];
  return { entitlement: uncovered.length === 0 ? "covered" : "uncovered", codes };
}

describe.skipIf(!opensshAvailable)("the kernel's release coverage over each release conformance case", () => {
  const judged = new Map<string, Awaited<ReturnType<typeof kernelJudgement>>>();

  beforeAll(async () => {
    for (const row of rows) {
      judged.set(row.name, await kernelJudgement(row.name));
    }
  });

  it("answers the entitlement each case's row names", () => {
    for (const row of rows) {
      expect(judged.get(row.name)!.entitlement, row.name).toBe(row.entitlement);
    }
  });

  it("names a member uncovered, or withheld by its release's window, exactly where the row does", () => {
    for (const row of rows) {
      expect(judged.get(row.name)!.codes, row.name).toEqual(row.codes.filter((code) => COVERAGE_CODES.has(code)));
    }
  });
});
