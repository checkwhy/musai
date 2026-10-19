import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bundleDigest,
  CURRENT_SCHEMA_VERSIONS,
  canonicalBytes,
  NO_CLAIM_TYPES,
  type RecordId,
  recordId,
  recordPath,
  SALTABLE_KINDS,
  saltFor,
  sidecarPath,
  timestamp,
  validateRecord,
} from "@musai/records";
import { execaSync } from "execa";
import { keyPrincipalOf } from "../src/allowed-signers.js";
import { mintAttestation } from "../src/attestation.js";

export const CONFORMANCE_DIR = fileURLToPath(new URL("../../../conformance", import.meta.url));

const FIXTURE_DIR = fileURLToPath(new URL("../test/fixtures/previous-versions", import.meta.url));
/** The fixture's attestation signed under this kernel's namespace, which its sidecar predates. */
const SIGNATURE_DIR = fileURLToPath(new URL("../test/fixtures/signature", import.meta.url));

export const CLAIM = "sha256:921e892da524cdff8699d6025fc8fd4c3b735fec451ab5c2b0c7e90fee7d3f68" as RecordId;
export const BRIEF_RUN = "sha256:946cb831732cdcf0a2fe465c7acb49e48fdb4015c92d7efc86ea930b4385e679" as RecordId;
export const RULING = "sha256:4c006fc58e70d4e7df0d10469cd874f7897a6920edeaf35140949b954c5f539f" as RecordId;
export const ATTESTATION = "sha256:42eb14cc43763a1d89f80dd81def025b9bda99a2e7b4d0b128d06569ba365b28" as RecordId;
export const RULE = "sha256:052cb330723067db76271a8d69f83e6cee0ca211676249d7a3b7cfe86229bee4" as RecordId;

/** Each path relative to the bundle's root, with the exact bytes written there. */
export type Bundle = Map<string, Uint8Array>;

export interface BundleCase {
  readonly name: string;
  readonly verdict: "verified" | "failed";
  /** Error and warning codes the bundle produces, sorted; an informational finding is not listed.
   * */
  readonly codes: readonly string[];
  readonly what: string;
}

/** Every fixture bundle carries it: its real case pins a core module record no scope held. */
const PIN = "ref.pin-absent";

function filesUnder(dir: string, root = dir): [string, Uint8Array][] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return filesUnder(path, root);
    }
    return [[relative(root, path).split("\\").join("/"), new Uint8Array(readFileSync(path))] as [string, Uint8Array]];
  });
}

/** The previous-versions fixture as a bundle: its records, with the signature fixture's sidecar
 * and allowed-signers. */
export function fixtureBundle(): Bundle {
  return new Map([...filesUnder(FIXTURE_DIR), ...filesUnder(SIGNATURE_DIR)].filter(([path]) => path !== "README.md"));
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

function withChanges(changes: (bundle: Bundle) => void): Bundle {
  const bundle = fixtureBundle();
  changes(bundle);
  return bundle;
}

function recordOf(bundle: Bundle, kind: Parameters<typeof recordPath>[0], id: RecordId): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bundle.get(recordPath(kind, id)))) as Record<string, unknown>;
}

function putRecord(bundle: Bundle, kind: Parameters<typeof recordPath>[0], value: Record<string, unknown>): RecordId {
  const id = recordId(value);
  bundle.set(recordPath(kind, id), canonicalBytes(value));
  return id;
}

/** Fixed, so the salted case is the same every run; a workspace's own key never leaves it. */
const SALT_KEY = new Uint8Array(32).fill(7);

/** The cases that need no signature of their own, derived from the fixture alone. */
export function unsignedCases(): { bundleCase: BundleCase; bundle: Bundle }[] {
  const flippedRuling = (bundle: Bundle): void => {
    const path = recordPath("ruling", RULING);
    const bytes = bundle.get(path)!.slice();
    const at = new TextDecoder().decode(bytes).indexOf("A binary");
    bytes[at] = "B".charCodeAt(0);
    bundle.set(path, bytes);
  };
  const otherBytesSidecar = (bundle: Bundle): void => {
    const attestation = recordOf(bundle, "attestation", ATTESTATION);
    const later = putRecord(bundle, "attestation", { ...attestation, at: "2026-08-31T12:16:01.376Z" });
    bundle.set(sidecarPath(later), bundle.get(sidecarPath(ATTESTATION))!);
  };
  const wrongIdPath = (bundle: Bundle): void => {
    const bytes = bundle.get(recordPath("claim", CLAIM))!;
    bundle.delete(recordPath("claim", CLAIM));
    bundle.set(recordPath("claim", recordId({ elsewhere: CLAIM })), bytes);
  };
  const wrongKindDirectory = (bundle: Bundle): void => {
    const bytes = bundle.get(recordPath("claim", CLAIM))!;
    bundle.delete(recordPath("claim", CLAIM));
    bundle.set(recordPath("case", CLAIM), bytes);
  };
  const notCanonical = (bundle: Bundle): void => {
    const rule = recordOf(bundle, "rule", RULE);
    bundle.set(recordPath("rule", RULE), text(JSON.stringify(rule, null, 1)));
  };
  const notComposed = (bundle: Bundle): void => {
    putRecord(bundle, "rule", { ...recordOf(bundle, "rule", RULE), scope: { "platfo\u0301rm": { kind: "any" } } });
  };
  const unlistedId = (bundle: Bundle): void => {
    putRecord(bundle, "rule", { ...recordOf(bundle, "rule", RULE), name: CLAIM });
  };
  const saltedRecords = (bundle: Bundle): void => {
    for (const kind of SALTABLE_KINDS) {
      const [path, bytes] = [...bundle].find(([at]) => at.startsWith(`records/${kind}/`))!;
      const read = validateRecord(JSON.parse(new TextDecoder().decode(bytes)), {
        unregisteredClaimTypes: "admit",
        claimTypes: NO_CLAIM_TYPES,
      });
      if (!read.ok) {
        throw new Error(`the fixture's ${path} does not read: ${read.error}`);
      }
      putRecord(bundle, kind, { ...read.record, salt: saltFor(SALT_KEY, read.record) });
    }
  };
  const barePrincipal = (bundle: Bundle): void => {
    const attestation = recordOf(bundle, "attestation", ATTESTATION);
    putRecord(bundle, "attestation", {
      ...attestation,
      schemaVersion: CURRENT_SCHEMA_VERSIONS.attestation,
      supersedes: [],
    });
  };
  const orphanSidecar = (bundle: Bundle): void => {
    const nowhere = recordId({ attested: "nothing" });
    bundle.set(sidecarPath(nowhere), bundle.get(sidecarPath(ATTESTATION))!);
  };
  const cases: [BundleCase, (bundle: Bundle) => void][] = [
    [{ name: "passing", verdict: "verified", codes: [PIN], what: "the fixture as it is" }, () => {}],
    [
      { name: "unsigned", verdict: "verified", codes: [PIN], what: "the attestation's sidecar removed" },
      (bundle) => bundle.delete(sidecarPath(ATTESTATION)),
    ],
    [
      {
        name: "salted",
        verdict: "verified",
        codes: [PIN],
        what: "the fixture's claim, argument, ruling, case and artifact, each read at its kind's current version and salted under a workspace key, beside the fixture",
      },
      saltedRecords,
    ],
    [
      {
        name: "flipped-byte",
        verdict: "failed",
        codes: ["record.id-mismatch", PIN, "ref.dangling"],
        what: "one byte of the ruling changed, so the ruling the attestation names is no longer held",
      },
      flippedRuling,
    ],
    [
      {
        name: "sidecar-over-other-bytes",
        verdict: "failed",
        codes: [PIN, "sig.bad"],
        what: "an attestation one second later carrying the original attestation's signature",
      },
      otherBytesSidecar,
    ],
    [
      {
        name: "principal-absent",
        verdict: "failed",
        codes: [PIN, "sig.principal-unknown"],
        what: "allowed-signers names the key under another principal",
      },
      (bundle) =>
        bundle.set(
          "allowed-signers",
          text(new TextDecoder().decode(bundle.get("allowed-signers")).replace(/^florin /, "alice ")),
        ),
    ],
    [
      {
        name: "dangling-reference",
        verdict: "failed",
        codes: [PIN, "ref.dangling"],
        what: "the brief run removed: the ruling's brief and the artifact's receipt anchor name nothing held",
      },
      (bundle) => bundle.delete(recordPath("run", BRIEF_RUN)),
    ],
    [
      {
        name: "wrong-id-path",
        verdict: "failed",
        codes: ["record.id-mismatch", PIN, "ref.dangling"],
        what: "the claim stored under another id's path",
      },
      wrongIdPath,
    ],
    [
      {
        name: "wrong-kind-directory",
        verdict: "failed",
        codes: ["record.path-mismatch", PIN],
        what: "the claim stored under the case directory",
      },
      wrongKindDirectory,
    ],
    [
      {
        name: "not-canonical",
        verdict: "failed",
        codes: ["record.not-canonical", PIN],
        what: "the rule stored indented at its canonical id's path",
      },
      notCanonical,
    ],
    [
      {
        name: "not-nfc",
        verdict: "failed",
        codes: [PIN, "record.not-nfc"],
        what: "a rule whose scope names a dimension in decomposed form, which a statement never takes",
      },
      notComposed,
    ],
    [
      {
        name: "unlisted-id",
        verdict: "failed",
        codes: [PIN, "ref.unlisted"],
        what: "a rule whose name is a record id, a path the reference table does not name",
      },
      unlistedId,
    ],
    [
      {
        name: "orphan-sidecar",
        verdict: "failed",
        codes: [PIN, "sig.orphan"],
        what: "a signature beside no attestation",
      },
      orphanSidecar,
    ],
    [
      {
        name: "bare-principal",
        verdict: "failed",
        codes: [PIN, "record.unreadable"],
        what: "the fixture's attestation written by hand at the current version, where its principal's bare name is never held",
      },
      barePrincipal,
    ],
  ];
  return cases.map(([bundleCase, change]) => ({ bundleCase, bundle: withChanges(change) }));
}

/** Signed under a namespace by a key made for this call, returned with that key's public line. */
function signFixtureAttestation(namespace: string): { signature: Uint8Array; publicKey: string } {
  const dir = mkdtempSync(join(tmpdir(), "musai-conformance-"));
  try {
    const key = join(dir, "key");
    execaSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "conformance", "-f", key]);
    const message = join(dir, "attestation.json");
    writeFileSync(message, fixtureBundle().get(recordPath("attestation", ATTESTATION))!);
    execaSync("ssh-keygen", ["-Y", "sign", "-f", key, "-n", namespace, message]);
    const [type, body] = readFileSync(`${key}.pub`, "utf8").trim().split(" ");
    return { signature: new Uint8Array(readFileSync(`${message}.sig`)), publicKey: `${type} ${body}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A case whose signature is made for the run, under a namespace and the signer's allowed-signers
 * options. */
interface SignedCase {
  readonly bundleCase: BundleCase;
  readonly namespace: string;
  readonly options: string;
}

export const SIGNED_CASES: readonly SignedCase[] = [
  {
    bundleCase: {
      name: "other-namespace",
      verdict: "failed",
      codes: [PIN, "sig.namespace"],
      what: "signed under the namespace file rather than musai",
    },
    namespace: "file",
    options: "",
  },
  {
    bundleCase: {
      name: "namespace-not-permitted",
      verdict: "failed",
      codes: [PIN, "sig.namespace-not-permitted"],
      what: "the signer's line permits only the namespace git",
    },
    namespace: "musai",
    options: 'namespaces="git"',
  },
  {
    bundleCase: {
      name: "not-yet-valid",
      verdict: "failed",
      codes: [PIN, "sig.not-yet-valid"],
      what: "the signer's key is valid only after the attestation's own time",
    },
    namespace: "musai",
    options: 'valid-after="20270101Z"',
  },
  {
    bundleCase: {
      name: "expired",
      verdict: "failed",
      codes: [PIN, "sig.expired"],
      what: "the signer's key expired before the attestation's own time",
    },
    namespace: "musai",
    options: 'valid-before="20260101Z"',
  },
  {
    bundleCase: {
      name: "window-held",
      verdict: "verified",
      codes: [PIN],
      what: "the signer's key is valid over a window holding the attestation's own time, for two namespaces",
    },
    namespace: "musai",
    options: 'namespaces="musai,git",valid-after="20260101Z",valid-before="20270101Z"',
  },
];

/** The signed cases as bundles, each signed by a key made for this call. */
export function signedCases(): { bundleCase: BundleCase; bundle: Bundle }[] {
  return SIGNED_CASES.map(({ bundleCase, namespace, options }) => {
    const { signature, publicKey } = signFixtureAttestation(namespace);
    const bundle = withChanges((changed) => {
      changed.set(sidecarPath(ATTESTATION), signature);
      changed.set("allowed-signers", text(`florin ${options}${options ? " " : ""}${publicKey}\n`));
    });
    return { bundleCase, bundle };
  });
}

/** When each attestation a keyed case adds was made. */
const KEYED_AT = timestamp("2026-09-01T00:00:00.000Z");

/** The fixture with one attestation over its ruling, made at the current version by `principal`. */
function attestedAtCurrentVersion(principal: string): { bundle: Bundle; path: string; bytes: Uint8Array } {
  const { id, record } = mintAttestation({
    subject: RULING,
    principal,
    principalClass: "person",
    via: "tty",
    purpose: "made",
    at: KEYED_AT,
  });
  const bundle = fixtureBundle();
  const bytes = canonicalBytes(record);
  bundle.set(recordPath("attestation", id), bytes);
  return { bundle, path: recordPath("attestation", id), bytes };
}

/** A key made for the run, as its public line and the principal its fingerprint names. */
function keyFor(dir: string, name: string): { path: string; publicKey: string; principal: string } {
  const path = join(dir, name);
  execaSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", path]);
  const [type, body] = readFileSync(`${path}.pub`, "utf8").trim().split(" ");
  const publicKey = `${type} ${body}`;
  return { path, publicKey, principal: keyPrincipalOf(publicKey) };
}

function signedBy(dir: string, keyPath: string, bytes: Uint8Array): Uint8Array {
  const message = join(dir, "attestation.json");
  writeFileSync(message, bytes);
  rmSync(`${message}.sig`, { force: true });
  execaSync("ssh-keygen", ["-Y", "sign", "-f", keyPath, "-n", "musai", message]);
  return new Uint8Array(readFileSync(`${message}.sig`));
}

export const KEYED_CASES: readonly { readonly bundleCase: BundleCase }[] = [
  {
    bundleCase: {
      name: "key-principal",
      verdict: "verified",
      codes: [PIN],
      what: "an attestation at the current version naming its signer by key, the key's line listing that form beside a name",
    },
  },
  {
    bundleCase: {
      name: "key-mismatch",
      verdict: "failed",
      codes: [PIN, "sig.principal-unknown", "trust.key-mismatch"],
      what: "an attestation naming one key signed by another, whose line lists the first key's form: one key never speaks as another",
    },
  },
];

/** The cases attesting at the current version by key, each signed by keys made for this call. */
export function keyedCases(): { bundleCase: BundleCase; bundle: Bundle }[] {
  const dir = mkdtempSync(join(tmpdir(), "musai-conformance-keyed-"));
  try {
    const alice = keyFor(dir, "alice");
    const mallory = keyFor(dir, "mallory");
    const fixtureSigners = new TextDecoder().decode(fixtureBundle().get("allowed-signers"));
    const [held, impersonating] = KEYED_CASES.map(({ bundleCase }) => bundleCase);
    const keyed = attestedAtCurrentVersion(alice.principal);
    keyed.bundle.set(`${keyed.path}.sig`, signedBy(dir, alice.path, keyed.bytes));
    keyed.bundle.set("allowed-signers", text(`${fixtureSigners}alice,${alice.principal} ${alice.publicKey}\n`));
    const forged = attestedAtCurrentVersion(alice.principal);
    forged.bundle.set(`${forged.path}.sig`, signedBy(dir, mallory.path, forged.bytes));
    forged.bundle.set("allowed-signers", text(`${fixtureSigners}mallory,${alice.principal} ${mallory.publicKey}\n`));
    return [
      { bundleCase: held!, bundle: keyed.bundle },
      { bundleCase: impersonating!, bundle: forged.bundle },
    ];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The bundles.json table, in the order the cases are written. */
export function bundleTable(cases: readonly { bundleCase: BundleCase }[]): string {
  return `${JSON.stringify(
    cases.map(({ bundleCase }) => ({ ...bundleCase, codes: [...bundleCase.codes].sort() })),
    null,
    2,
  )}\n`;
}

/** Each case's digest as a verifier names it: the SHA-256 of `sha256sum`'s listing of its files. */
export function digestTable(cases: readonly { bundleCase: BundleCase; bundle: Bundle }[]): string {
  return `${JSON.stringify(Object.fromEntries(cases.map(({ bundleCase, bundle }) => [bundleCase.name, bundleDigest(bundle)])), null, 2)}\n`;
}

/** Cases that need a signature sign with a key made for the run, so they need OpenSSH; the rest are
 * the same every run. */
export function writeBundles(dir: string): void {
  const cases = [...unsignedCases(), ...signedCases(), ...keyedCases()];
  const root = join(dir, "bundles");
  rmSync(root, { recursive: true, force: true });
  for (const { bundleCase, bundle } of cases) {
    for (const [path, bytes] of bundle) {
      const target = join(root, bundleCase.name, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
  }
  writeFileSync(join(dir, "bundles.json"), bundleTable(cases));
  writeFileSync(join(dir, "digests.json"), digestTable(cases));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeBundles(CONFORMANCE_DIR);
  process.stdout.write(`wrote the conformance bundles to ${CONFORMANCE_DIR}\n`);
}
