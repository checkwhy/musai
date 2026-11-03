import { access, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  coveringRelease,
  type OperationContext,
  type OperationDescriptor,
  OperationError,
  openWorkspace,
  type ReleaseStanding,
  releaseCoverage,
  releaseStanding,
  runHandler,
  type StandingRelease,
  type Withholding,
  type Workspace,
  withdrawnUnverified,
} from "@musai/api-core";
import {
  type Audience,
  blobPath,
  bundleDigest,
  canonicalBytes,
  isKernelError,
  type RecordId,
  recordPath,
  sidecarPath,
  type Timestamp,
  versionString,
} from "@musai/records";
import { gitCatFile, isAbsentPathError } from "@musai/store";
import { covers } from "@musai/trust";
import { claimSlotNamed, shortIdOf } from "../claim-ref.js";
import {
  buildCarried,
  type Closure,
  type ClosureMember,
  closureOf,
  type JudgingModule,
  judgingModuleName,
} from "../export/closure.js";
import { tarGz } from "../export/tar.js";
import { cutTrustFile, type TrustFileName } from "../export/trust-cut.js";
import { releaseAgain, revokeAgain, signingKeyPrincipals, withdrawnIn } from "../withdrawn-in.js";
import { audienceOf, DEFAULT_USES, releaseGrant } from "./release.js";

export interface BundleExportInput {
  /** A claim's sentence, a short id, or a record id. */
  readonly id: string;
  readonly to: string;
  readonly out: string;
  readonly key?: string;
}

export interface BundleExportOutput {
  /** Where the archive was written. */
  readonly path: string;
  /** Named as a verifier names it: the SHA-256 of `sha256sum`'s listing of the unpacked tree. */
  readonly digest: string;
  readonly records: number;
  readonly signatures: number;
  readonly blobs: number;
  /** The release this export minted to cover what it ships, or `null` where one already stood. */
  readonly released: string | null;
  /** Each claim whose rule's verdict a receiver cannot re-derive from the bundle, where any. */
  readonly underivable?: readonly Underivable[];
}

export interface Underivable {
  readonly claim: string;
  readonly rule: string;
  readonly why: string;
}

/** `config.json` stays home: no check reads it, and it may hold the project's own configuration. */
const TRUST_FILES: readonly TrustFileName[] = ["allowed-signers", "roles", "audiences"];

/** Read by the verifier to say whom the bundle was cut for and when. */
const MANIFEST = "bundle.json";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A claim's sentence or short id names its current record; anything else must be a record id. */
function rootOf(opened: Workspace, named: string): RecordId {
  const claim = opened.index.claimAtSlot(claimSlotNamed(opened.index, named));
  if (claim !== undefined) {
    return claim.id;
  }
  opened.read(named as RecordId);
  return named as RecordId;
}

interface Coverage {
  readonly covering: ReadonlyMap<RecordId, StandingRelease>;
  readonly uncovered: readonly RecordId[];
  /** Uncovered members a revocation or a release's own window keeps home, each with the command
   * that mints a release standing in for the one withholding it, none for a revocation of yours. */
  readonly withheld: readonly { readonly id: RecordId; readonly because: string; readonly again: string | null }[];
}

function withholdingOf(
  by: Withholding,
  to: Audience,
  now: Timestamp,
  yours: ReadonlySet<string>,
): { readonly because: string; readonly again: string | null } {
  const { release } = by;
  if (by.because === "window") {
    return {
      because: `its release ${release.id} is outside its window at ${now}`,
      again: releaseAgain(release, to, false),
    };
  }
  if (!withdrawnUnverified(by.release)) {
    return { because: `its release ${release.id} was revoked`, again: releaseAgain(release, to, true) };
  }
  const name = withdrawnIn(by.release, yours);
  const resign = `${revokeAgain(by.release)} signs it anew`;
  return {
    because: `its release ${release.id} was revoked by an unverified revocation ${name}, which ${resign}${name === "in your name" ? "" : " if it is yours"}`,
    again: name === "in your name" ? null : releaseAgain(release, to, true),
  };
}

/** A closure release on a root outside this export's closure waits for a fold index. */
async function coverageOf(
  opened: Workspace,
  cited: readonly ClosureMember[],
  to: Audience,
  yours: ReadonlySet<string>,
): Promise<Coverage> {
  const standing = new Map<RecordId, ReleaseStanding>();
  for (const member of cited) {
    standing.set(member.id, await releaseStanding(opened, member.id));
  }
  const now = opened.now();
  const { covering, uncovered } = releaseCoverage(cited, standing, to, opened.audiences, now);
  const withheld = uncovered.flatMap(({ id, withheld: by }) =>
    by === null ? [] : [{ id, ...withholdingOf(by, to, now, yours) }],
  );
  return { covering, uncovered: uncovered.map(({ id }) => id), withheld };
}

/** A receipt or an attestation left home is not shown to the receiver, so neither ever stops the
 * records it rests on or speaks for from leaving. */
async function travellingThatGo(
  opened: Workspace,
  closure: Closure,
  to: Audience,
): Promise<{ members: readonly ClosureMember[]; releases: readonly StandingRelease[] }> {
  const going = new Map<RecordId, { member: ClosureMember; release: StandingRelease }>();
  for (const member of [...closure.receipts, ...closure.attesting]) {
    const { standing } = await releaseStanding(opened, member.id);
    const release = coveringRelease(standing, to, opened.audiences, opened.now());
    if (release !== undefined) {
      going.set(member.id, { member, release });
    }
  }
  const cited = new Set(closure.cited.map((member) => member.id));
  for (let dropped = true; dropped; ) {
    dropped = false;
    for (const [id, { member }] of going) {
      if (!member.cites.every((cite) => cited.has(cite) || going.has(cite))) {
        going.delete(id);
        dropped = true;
      }
    }
  }
  return {
    members: [...going.values()].map(({ member }) => member),
    releases: [...going.values()].map(({ release }) => release),
  };
}

/** The members no release to `to` has spoken for, standing or revoked; a revoked one stays home. */
async function unreleasedFor(
  opened: Workspace,
  members: readonly ClosureMember[],
  to: Audience,
): Promise<ClosureMember[]> {
  const unreleased: ClosureMember[] = [];
  for (const member of members) {
    const { standing, revoked } = await releaseStanding(opened, member.id);
    if (![...standing, ...revoked].some((release) => covers(opened.audiences, release.record.audience, to))) {
      unreleased.push(member);
    }
  }
  return unreleased;
}

/** Mints what ships through the release verb: the root's closure, and each receipt and attestation
 * on a member, since no closure fixes those; a revocation or a window keeps a member home. */
async function releasedForExport(
  opened: Workspace,
  root: RecordId,
  to: Audience,
  input: BundleExportInput,
  context: OperationContext,
): Promise<{ readonly opened: Workspace; readonly coverage: Coverage; readonly released: string | null }> {
  const closure = await closureOf(opened, root);
  const yours = await signingKeyPrincipals(opened, input.key);
  const coverage = await coverageOf(opened, closure.cited, to, yours);
  const unreleased = await unreleasedFor(opened, closure.receipts, to);
  if (coverage.uncovered.length === 0 && unreleased.length === 0) {
    return { opened, coverage, released: null };
  }
  if (coverage.withheld.length > 0) {
    const releasable = coverage.withheld.flatMap((entry) => (entry.again === null ? [] : [entry.again]));
    const again = [...new Set(releasable)];
    throw new OperationError({
      reason: "not-authorised",
      about: coverage.withheld.map((entry) => entry.id),
      detail:
        `${coverage.withheld.map((entry) => `${entry.id}: ${entry.because}`).join("; ")}; an export never undoes that` +
        (again.length === 0
          ? ""
          : `, and ${again.join(" and ")} ${again.length === 1 ? "releases" : "release"} ` +
            `${releasable.length === 1 ? "it" : "them"} again deliberately`),
    });
  }
  const grant = (id: RecordId, closure: boolean) =>
    runHandler(
      releaseGrant,
      { id, to, for: DEFAULT_USES, closure, ...(input.key === undefined ? {} : { key: input.key }) },
      context,
    );
  const granted = coverage.uncovered.length === 0 ? null : await grant(root, true);
  for (const member of [...unreleased, ...(await unreleasedFor(opened, closure.attesting, to))]) {
    await grant(member.id, false);
  }
  const reopened = await openWorkspace(context);
  const recovered = await coverageOf(reopened, (await closureOf(reopened, root)).cited, to, yours);
  const released = granted?.minted[0]?.id ?? null;
  if (recovered.uncovered.length > 0) {
    throw new OperationError({
      reason: "not-authorised",
      about: recovered.uncovered,
      detail: `the release ${released ?? "already standing"} covers no record it names for ${to}: its signature does not verify against the allowed signers, or its principal holds no publish`,
    });
  }
  return { opened: reopened, coverage: recovered, released };
}

async function bundleOf(
  opened: Workspace,
  members: readonly ClosureMember[],
  releases: readonly StandingRelease[],
  manifest: { readonly root: RecordId; readonly audience: Audience },
): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  files.set(MANIFEST, canonicalBytes({ ...manifest, at: opened.now() }));
  const attestations: RecordId[] = [];
  const signers = new Set<string>();
  const releasedTo = new Set<string>();
  const attesting = (bytes: Uint8Array): void => {
    const record = JSON.parse(decoder.decode(bytes)) as { principal: string; purpose: string; audience?: string };
    signers.add(record.principal);
    if (record.purpose === "released" && record.audience !== undefined) {
      releasedTo.add(record.audience);
    }
  };
  for (const member of members) {
    files.set(recordPath(member.kind, member.id), member.bytes);
    if (member.kind === "attestation") {
      attestations.push(member.id);
      attesting(member.bytes);
    }
  }
  for (const id of new Set(releases.map((release) => release.id))) {
    const bytes = await opened.store.readBytes(id, "attestation");
    files.set(recordPath("attestation", id), bytes);
    attestations.push(id);
    attesting(bytes);
  }
  for (const attestation of attestations) {
    const signature = await opened.store.readSidecar(attestation);
    if (signature !== null) {
      files.set(sidecarPath(attestation), encoder.encode(signature));
    }
  }
  for (const blob of members.flatMap((member) => member.blobs)) {
    try {
      files.set(blobPath(blob), await opened.blobs.read(blob));
    } catch (error) {
      if (!isKernelError(error) || error.reason !== "no-such-record") {
        throw error;
      }
    }
  }
  const needs = { signers, releasedTo, audience: manifest.audience };
  for (const name of TRUST_FILES) {
    try {
      const content = decoder.decode(await gitCatFile(opened.ctx, `${opened.matrix.commit}:${name}`));
      files.set(name, encoder.encode(cutTrustFile(name, content, needs)));
    } catch (error) {
      if (!isAbsentPathError(error)) {
        throw error;
      }
    }
  }
  return files;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function countUnder(files: ReadonlyMap<string, Uint8Array>, test: (path: string) => boolean): number {
  return [...files.keys()].filter(test).length;
}

/** A judging module must leave with its code, or a receiver has nothing to run it with. */
function underivableIn(
  opened: Workspace,
  judging: readonly JudgingModule[],
  files: ReadonlyMap<string, Uint8Array>,
  to: Audience,
): Underivable[] {
  return judging.flatMap((judged) => {
    const { claim, rule, module } = judged;
    const its = judgingModuleName(opened, judged);
    const why = !files.has(recordPath("module", module))
      ? `${its} stays home, since no release of ${module} to ${to} stands`
      : !buildCarried(opened, module, files)
        ? `${its} has no build on this machine to carry`
        : null;
    return why === null ? [] : [{ claim, rule, why }];
  });
}

/** Nothing is re-canonicalised on the way out: each record leaves as the bytes git holds, which its
 * id and signature cover. */
export const bundleExport: OperationDescriptor<BundleExportInput, BundleExportOutput> = {
  id: "bundle.export",
  version: versionString("2"),
  input: {
    type: "object",
    additionalProperties: false,
    required: ["id", "to", "out"],
    properties: {
      id: { type: "string" },
      to: { type: "string", description: "public, key:SHA256:…, identity:<issuer>#<subject>, or a declared name" },
      out: { type: "string" },
      key: { type: "string" },
    },
  },
  output: {
    type: "object",
    additionalProperties: false,
    required: ["path", "digest", "records", "signatures", "blobs", "released"],
    properties: {
      path: { type: "string" },
      digest: { type: "string" },
      records: { type: "integer", minimum: 0 },
      signatures: { type: "integer", minimum: 0 },
      blobs: { type: "integer", minimum: 0 },
      released: { type: ["string", "null"] },
      underivable: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["claim", "rule", "why"],
          properties: { claim: { type: "string" }, rule: { type: "string" }, why: { type: "string" } },
        },
      },
    },
  },
  effect: "performs",
  authority: null,
  plans: false,
  reasons: ["no-such-record", "invalid-input", "not-authorised", "head-moved", "tool-unavailable"],
  documentation:
    "Writes a record and everything it cites as a bundle a verifier checks, releasing it to the audience first when nothing stands released there.",
  paths: ["out", "key"],
  cli: {
    verb: "export",
    positional: ["id"],
    flags: ["to", "out", "key"],
    describe: "release a record and its closure to an audience and write them as a bundle a stranger can verify",
  },
  renderText: (output) =>
    `${output.released === null ? "" : `released ${shortIdOf(output.released)} for ${DEFAULT_USES.replace(",", ", ")}\n`}` +
    `${output.path}\nbundle ${output.digest}\n` +
    `${output.records} record${output.records === 1 ? "" : "s"}, ` +
    `${output.signatures} signature${output.signatures === 1 ? "" : "s"}, ` +
    `${output.blobs} blob${output.blobs === 1 ? "" : "s"}` +
    (output.underivable ?? [])
      .map((entry) => `\nrule ${entry.rule} judging ${entry.claim} is not re-derivable from this bundle: ${entry.why}`)
      .join(""),
  exitCode: () => 0,
  async handler(input, context) {
    const first = await openWorkspace(context);
    const root = rootOf(first, input.id);
    const to = audienceOf(first, input.to);
    const path = resolve(input.out);
    if (await exists(path)) {
      throw new OperationError({
        reason: "invalid-input",
        about: [path],
        detail: `${path} already exists, and an export never writes over a file: name another with --out`,
      });
    }
    const { opened, coverage, released } = await releasedForExport(first, root, to, input, context);
    const closure = await closureOf(opened, root);
    const travelling = await travellingThatGo(opened, closure, to);
    const files = await bundleOf(
      opened,
      [...closure.cited, ...travelling.members],
      [...coverage.covering.values(), ...travelling.releases],
      { root, audience: to },
    );

    await writeFile(path, tarGz(files), { flag: "wx" });
    const underivable = underivableIn(opened, closure.judging, files, to);
    return {
      path,
      digest: bundleDigest(files),
      records: countUnder(files, (file) => file.startsWith("records/") && file.endsWith(".json")),
      signatures: countUnder(files, (file) => file.endsWith(".sig")),
      blobs: countUnder(files, (file) => file.startsWith("blobs/")),
      released,
      ...(underivable.length === 0 ? {} : { underivable }),
    };
  },
};
