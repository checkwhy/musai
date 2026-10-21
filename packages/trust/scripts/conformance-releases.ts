import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACTIONS,
  ANY_SCOPE,
  type Audience,
  CURRENT_SCHEMA_VERSIONS,
  canonicalBytes,
  type RecordId,
  type RecordKind,
  type ReleaseExtent,
  type ReleaseTerms,
  recordId,
  recordPath,
  referencesOf,
  sidecarPath,
  timestamp,
} from "@musai/records";
import { execaSync } from "execa";
import { keyPrincipalOf, parseAllowedSigners } from "../src/allowed-signers.js";
import { mintAttestation } from "../src/attestation.js";
import { covers, parseAudiences } from "../src/audiences.js";
import { EMPTY_TRUST_DEFAULT, may, roleMatrix } from "../src/authority.js";
import { ROLES } from "../src/roles.js";
import { type Bundle, CONFORMANCE_DIR, fixtureBundle, RULING } from "./conformance-bundles.js";

const LATER_ATTESTATION_VERSION = CURRENT_SCHEMA_VERSIONS.attestation + 1;

/** A release case: its integrity verdict, its entitlement verdict, and its error and warning codes,
 * sorted; an informational finding is not listed. */
export interface ReleaseCase {
  readonly name: string;
  readonly verdict: "verified" | "failed";
  readonly entitlement: "covered" | "uncovered" | "unchecked";
  readonly codes: readonly string[];
  readonly what: string;
}

const PIN = "ref.pin-absent";

/** A signer only for the role table, which reads no signature. */
const SOME_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK2BQWDJDXC+Z7BUUruH+wCErasTO3aYNeoSUkCdWdb5";

const AT = "2026-09-01T00:00:00.000Z";

const TERMS: ReleaseTerms = { form: "bytes", uses: ["review", "cite"], from: null, until: null, marking: null };

/** The seeded pair, a key member, an identity member, and a three-step chain of includes. */
export const AUDIENCES_TEXT = [
  "peer",
  "known includes peer",
  "vendor-ecosystem includes known",
  "maintainers includes vendor-ecosystem",
  `known member key:SHA256:${"r".repeat(43)}`,
  "ci member identity:https://token.actions.githubusercontent.com#repo:example/project",
  "",
].join("\n");

/** What each shipped role grants at scope `any`, and what an empty trust branch grants everyone. */
export function rolesTable(): string {
  const signers = parseAllowedSigners(`p ${SOME_KEY}\n`);
  const granted = (matrix: ReturnType<typeof roleMatrix>) =>
    ACTIONS.filter((action) => may(matrix, "p", action, ANY_SCOPE));
  const roles = Object.fromEntries(
    [...ROLES]
      .sort()
      .map((role) => [role, granted(roleMatrix(signers, [{ principal: "p", role, scope: ANY_SCOPE }], "c"))]),
  );
  return `${JSON.stringify({ roles, emptyDefault: [...EMPTY_TRUST_DEFAULT] }, null, 2)}\n`;
}

/** Every ordered pair of the audiences the shared text names, plus public, a key and an identity
 * outside it, with what `covers` answers. */
export function audiencesTable(): string {
  const audiences = parseAudiences(AUDIENCES_TEXT);
  const named = [
    "public",
    ...[...audiences.names.keys()].sort(),
    `key:SHA256:${"r".repeat(43)}`,
    `key:SHA256:${"o".repeat(43)}`,
    "identity:https://token.actions.githubusercontent.com#repo:example/project",
    "identity:https://issuer.example#someone",
  ];
  const pairs = named.flatMap((granted) =>
    named.map((target) => ({ granted, target, covers: covers(audiences, granted, target) })),
  );
  return `${JSON.stringify({ text: AUDIENCES_TEXT, pairs }, null, 2)}\n`;
}

interface Signer {
  readonly principal: string;
  readonly key: string;
  readonly publicLine: string;
}

/** A key named by its own form, listed under `name` beside it as `init --key` registers one. */
function makeSigner(dir: string, name: string): Signer {
  const key = join(dir, name);
  execaSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", key]);
  const [type, body] = readFileSync(`${key}.pub`, "utf8").trim().split(" ");
  const principal = keyPrincipalOf(`${type} ${body}`);
  return { principal, key, publicLine: `${name},${principal} ${type} ${body}\n` };
}

let messages = 0;

function sign(dir: string, signer: Signer, bytes: Uint8Array): Uint8Array {
  messages += 1;
  const message = join(dir, `message-${messages}`);
  writeFileSync(message, bytes);
  execaSync("ssh-keygen", ["-Y", "sign", "-f", signer.key, "-n", "musai", message]);
  return new Uint8Array(readFileSync(`${message}.sig`));
}

function kindAt(path: string): RecordKind {
  return path.split("/")[1] as RecordKind;
}

/** The fixture's records nothing but an attestation cites: what a closure release starts from. */
function roots(bundle: Bundle): RecordId[] {
  const records = [...bundle].filter(([path]) => path.startsWith("records/") && path.endsWith(".json"));
  const cited = new Set(
    records
      .filter(([path]) => kindAt(path) !== "attestation")
      .flatMap(([, bytes]) =>
        referencesOf(JSON.parse(new TextDecoder().decode(bytes))).citations.map((citation) => citation.id),
      ),
  );
  return records
    .filter(([path]) => kindAt(path) !== "attestation")
    .map(([path]) => `sha256:${path.slice(-69, -5)}` as RecordId)
    .filter((id) => !cited.has(id))
    .sort();
}

function attestationsIn(bundle: Bundle): RecordId[] {
  return [...bundle.keys()]
    .filter((path) => path.startsWith("records/attestation/") && path.endsWith(".json"))
    .map((path) => `sha256:${path.slice(-69, -5)}` as RecordId)
    .sort();
}

interface Shape {
  readonly audience: string;
  readonly signer: "florin" | "mallory";
  /** How every release arrived; a release relayed through a model stands for no audience. */
  readonly via?: "model";
  readonly terms?: ReleaseTerms;
  /** Written by hand over every release or over the seal: a version later than the kernel reads. */
  readonly laterVersion?: { readonly of: "released" | "sealed"; readonly schemaVersion: number };
  readonly revokeAll?: boolean;
  /** The audience the ruling is sealed from by florin, before anything is released. */
  readonly sealFrom?: string;
  /** `record` is written by hand: the kernel names a seal of the record alone by no extent. */
  readonly sealExtent?: "closure" | "record";
  readonly manifest: string | null;
}

/** Releases every root's closure and each attestation on its own, then applies the shape. */
function releaseBundle(dir: string, signers: Record<string, Signer>, shape: Shape): Bundle {
  const bundle = fixtureBundle();
  const signer = signers[shape.signer]!;
  const put = (record: Record<string, unknown>, by: Signer): RecordId => {
    const id = recordId(record);
    const bytes = canonicalBytes(record);
    bundle.set(recordPath("attestation", id), bytes);
    bundle.set(sidecarPath(id), sign(dir, by, bytes));
    return id;
  };
  const later = (purpose: "released" | "sealed") =>
    shape.laterVersion?.of === purpose ? { schemaVersion: shape.laterVersion.schemaVersion } : {};
  const release = (subject: RecordId, extent: ReleaseExtent): RecordId => {
    const { record } = mintAttestation({
      subject,
      principal: signer.principal,
      principalClass: shape.via === "model" ? "agent" : "person",
      via: shape.via ?? "signature",
      purpose: "released",
      at: timestamp(AT),
      release: { audience: "peer" as Audience, extent, terms: shape.terms ?? TERMS },
    });
    return put({ ...record, audience: shape.audience, ...later("released") }, signer);
  };
  if (shape.sealFrom !== undefined) {
    const { record } = mintAttestation({
      subject: RULING,
      principal: signers["florin"]!.principal,
      principalClass: "person",
      via: "signature",
      purpose: "sealed",
      at: timestamp(AT),
      seal: {
        audience: shape.sealFrom as Audience,
        ...(shape.sealExtent === "closure" ? { extent: shape.sealExtent } : {}),
      },
    });
    const sealed =
      shape.sealExtent === "record" ? { ...record, seal: { audience: shape.sealFrom, extent: "record" } } : record;
    put({ ...sealed, ...later("sealed") }, signers["florin"]!);
  }
  const made = attestationsIn(bundle);
  const released = [
    ...roots(bundle).map((root) => [root, release(root, "closure")] as const),
    ...made.map((attestation) => [attestation, release(attestation, "record")] as const),
  ];
  if (shape.revokeAll === true) {
    for (const [subject, id] of released) {
      const { record } = mintAttestation({
        subject,
        principal: signers["florin"]!.principal,
        principalClass: "person",
        via: "signature",
        purpose: "revoked",
        at: timestamp(AT),
        supersedes: [id],
      });
      put({ ...record }, signers["florin"]!);
    }
  }
  bundle.set(
    "allowed-signers",
    new TextEncoder().encode(
      new TextDecoder().decode(bundle.get("allowed-signers")) +
        signers["florin"]!.publicLine +
        signers["mallory"]!.publicLine,
    ),
  );
  bundle.set("roles", new TextEncoder().encode(`${signers["florin"]!.principal} owner any\n`));
  bundle.set("audiences", new TextEncoder().encode(AUDIENCES_TEXT));
  if (shape.manifest !== null) {
    bundle.set("bundle.json", canonicalBytes({ root: RULING, audience: shape.manifest, at: AT }));
  }
  return bundle;
}

export const RELEASE_CASES: readonly (ReleaseCase & { readonly shape: Shape })[] = [
  {
    name: "released",
    verdict: "verified",
    entitlement: "covered",
    codes: [PIN],
    what: "every root released by closure and each attestation on its own, to maintainers, cut for known",
    shape: { audience: "maintainers", signer: "florin", manifest: "known" },
  },
  {
    name: "sealed",
    verdict: "verified",
    entitlement: "covered",
    codes: [PIN],
    what: "as released, with the ruling sealed from peer: a seal hides a record from a station and leaves what an export carries unchanged",
    shape: { audience: "maintainers", signer: "florin", sealFrom: "peer", manifest: "known" },
  },
  {
    name: "sealed-closure",
    verdict: "verified",
    entitlement: "covered",
    codes: [PIN],
    what: "as sealed, the seal naming the ruling's closure: a seal of any extent leaves what an export carries unchanged",
    shape: { audience: "maintainers", signer: "florin", sealFrom: "peer", sealExtent: "closure", manifest: "known" },
  },
  {
    name: "sealed-explicit-record",
    verdict: "failed",
    entitlement: "covered",
    codes: [PIN, "record.unreadable", "ref.dangling"],
    what: "as sealed, the seal naming extent record by hand, which the kernel never holds: a seal of the record alone names no extent, and the release of the seal then cites a record not held",
    shape: { audience: "maintainers", signer: "florin", sealFrom: "peer", sealExtent: "record", manifest: "known" },
  },
  {
    name: "revoked",
    verdict: "verified",
    entitlement: "uncovered",
    codes: [PIN, "release.uncovered"],
    what: "as released, with a revocation superseding each release",
    shape: { audience: "known", signer: "florin", revokeAll: true, manifest: "peer" },
  },
  {
    name: "unauthorised",
    verdict: "verified",
    entitlement: "uncovered",
    codes: [PIN, "release.unauthorised", "release.uncovered"],
    what: "released by a signer the roles file grants nothing",
    shape: { audience: "known", signer: "mallory", manifest: "peer" },
  },
  {
    name: "relayed",
    verdict: "verified",
    entitlement: "uncovered",
    codes: [PIN, "release.relayed", "release.uncovered"],
    what: "as released, every release relayed through a model, which stands for no audience",
    shape: { audience: "maintainers", signer: "florin", via: "model", manifest: "known" },
  },
  {
    name: "outside-audience",
    verdict: "verified",
    entitlement: "uncovered",
    codes: [PIN, "release.uncovered"],
    what: "released to peer, cut for known, which peer does not cover",
    shape: { audience: "peer", signer: "florin", manifest: "known" },
  },
  {
    name: "outside-window",
    verdict: "verified",
    entitlement: "uncovered",
    codes: [PIN, "release.uncovered", "release.window"],
    what: "released until before the bundle was cut",
    shape: {
      audience: "known",
      signer: "florin",
      terms: { ...TERMS, until: timestamp("2026-08-01T00:00:00.000Z") },
      manifest: "peer",
    },
  },
  {
    name: "later-version",
    verdict: "verified",
    entitlement: "uncovered",
    codes: [PIN, "attestation.version-unknown", "release.uncovered"],
    what: "as released, every release written by hand at a schema version later than the kernel reads: each is skipped, named with its version, and covers nothing",
    shape: {
      audience: "maintainers",
      signer: "florin",
      laterVersion: { of: "released", schemaVersion: LATER_ATTESTATION_VERSION },
      manifest: "known",
    },
  },
  {
    name: "later-version-seal",
    verdict: "verified",
    entitlement: "covered",
    codes: [PIN, "attestation.version-unknown"],
    what: "as sealed, the seal written by hand at a schema version later than the kernel reads: it is skipped, named with its version, and the releases still cover the bundle",
    shape: {
      audience: "maintainers",
      signer: "florin",
      sealFrom: "peer",
      laterVersion: { of: "sealed", schemaVersion: LATER_ATTESTATION_VERSION },
      manifest: "known",
    },
  },
  {
    name: "no-manifest",
    verdict: "verified",
    entitlement: "unchecked",
    codes: [PIN],
    what: "released as the first case, with no bundle.json to name an audience",
    shape: { audience: "known", signer: "florin", manifest: null },
  },
];

export function releasesTable(): string {
  return `${JSON.stringify(
    RELEASE_CASES.map(({ shape: _shape, codes, ...row }) => ({ ...row, codes: [...codes].sort() })),
    null,
    2,
  )}\n`;
}

/** The release cases sign with keys made for this call, so they need OpenSSH. */
export function writeReleases(dir: string): void {
  writeFileSync(join(dir, "roles.json"), rolesTable());
  writeFileSync(join(dir, "audiences.json"), audiencesTable());
  writeFileSync(join(dir, "releases.json"), releasesTable());
  const root = join(dir, "releases");
  rmSync(root, { recursive: true, force: true });
  const keys = mkdtempSync(join(tmpdir(), "musai-conformance-releases-"));
  try {
    const signers = { florin: makeSigner(keys, "florin"), mallory: makeSigner(keys, "mallory") };
    for (const { name, shape } of RELEASE_CASES) {
      for (const [path, bytes] of releaseBundle(keys, signers, shape)) {
        const target = join(root, name, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes);
      }
    }
  } finally {
    rmSync(keys, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeReleases(CONFORMANCE_DIR);
  process.stdout.write(`wrote the release conformance cases to ${CONFORMANCE_DIR}\n`);
}
