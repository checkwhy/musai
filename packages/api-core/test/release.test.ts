import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  type AttestationRecord,
  type Audience,
  CURRENT_SCHEMA_VERSIONS,
  canonicalBytes,
  type RecordId,
  type ReleaseAttestationRecord,
  type ReleaseTerms,
  rawId,
  recordId,
  recordPath,
  sidecarPath,
  timestamp,
  type ViaChannel,
} from "@musai/records";
import {
  allowedSignersLine,
  commitFilesAroundTheStore,
  fixtureRunRecord,
  generateTestKey,
  type TestKey,
  writeTrustFile,
} from "@musai/test-support";
import { mintAttestation, parseAudiences, signAttestation } from "@musai/trust";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { openWorkspace } from "../src/open-workspace.js";
import { coveringRelease, releaseStanding, type StandingRelease, sealStanding } from "../src/release.js";
import { FIXTURE_CLOCK, fixtureWorkspace } from "./fixture-distribution.js";

const PUBLISHER = "publisher@example.test";
const BYSTANDER = "bystander@example.test";

const TERMS: ReleaseTerms = { form: "bytes", uses: ["review", "cite"], from: null, until: null, marking: null };

const opensshAvailable = spawnSync("ssh-keygen", ["-Y", "check-novalidate"], { stdio: "ignore" }).error === undefined;

interface Attest {
  readonly purpose: "released" | "revoked" | "sealed";
  readonly by?: string;
  /** Whose key signs it, where not the principal it names; `false` leaves it without a sidecar. */
  readonly signedBy?: string | false;
  readonly at?: string;
  readonly subject?: RecordId;
  readonly supersedes?: readonly RecordId[];
  readonly terms?: ReleaseTerms;
  readonly via?: ViaChannel;
  /** Written around the store at an attestation version later than the kernel's, as a later
   * kernel would write it, with a field no version this kernel reads defines. */
  readonly later?: true;
  /** Written over a later one by hand, a field set to `undefined` left out. */
  readonly laterFields?: Record<string, unknown>;
}

/** An `ssh-keygen` first on the path for the rest of the test, answering as OpenSSH answers a line
 * it cannot read: a diagnostic naming the file, and no judgement. */
async function unreadingSshKeygen(): Promise<void> {
  const bin = await mkdtemp(join(tmpdir(), "musai-unreading-ssh-keygen-"));
  onTestFinished(() => rm(bin, { recursive: true, force: true }));
  await writeFile(
    join(bin, "ssh-keygen"),
    "#!/bin/sh\necho \"$5:1: bad options: unknown key option\" >&2\necho 'Could not verify signature.'\nexit 255\n",
  );
  await chmod(join(bin, "ssh-keygen"), 0o755);
  vi.stubEnv("PATH", `${bin}${delimiter}${process.env["PATH"] ?? ""}`);
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
}

/** A workspace where `PUBLISHER` alone holds `publish` and both principals can sign, with a writer
 * of releases and revocations of its run. */
async function releasable() {
  const keys = new Map<string, TestKey>();
  for (const name of [PUBLISHER, BYSTANDER]) {
    const key = await generateTestKey(name);
    onTestFinished(() => rm(key.dir, { recursive: true, force: true }));
    keys.set(name, key);
  }
  const principalOf = (name: string): string => keys.get(name)!.principal;
  const workspace = await fixtureWorkspace({
    roles: `${principalOf(PUBLISHER)} owner any\n${principalOf(BYSTANDER)} delegate any\n`,
  });
  await writeTrustFile(
    { gitDir: join(workspace.dir, ".musai") },
    "allowed-signers",
    [...keys.values()].map((key) => allowedSignersLine(key)).join(""),
  );
  const run = fixtureRunRecord("released by someone");
  const subject = recordId(run);
  const other = fixtureRunRecord("another record");
  await workspace.store().putMany([
    { kind: "run", value: run },
    { kind: "run", value: other },
  ]);
  const attest = async (asked: Attest): Promise<RecordId> => {
    const by = asked.by ?? PUBLISHER;
    const attestation = mintAttestation({
      subject: asked.subject ?? subject,
      principal: principalOf(by),
      principalClass: asked.via === "model" ? "agent" : "person",
      via: asked.via ?? "tty",
      purpose: asked.purpose,
      at: timestamp(asked.at ?? "2026-01-01T00:00:01.000Z"),
      ...(asked.purpose === "released"
        ? { release: { audience: "public" as Audience, extent: "record" as const, terms: asked.terms ?? TERMS } }
        : {}),
      ...(asked.purpose === "sealed" ? { seal: { audience: "cast" as Audience } } : {}),
      ...(asked.supersedes === undefined ? {} : { supersedes: asked.supersedes }),
    });
    const signer = asked.signedBy ?? by;
    if (asked.later === true) {
      const written = {
        ...attestation.record,
        schemaVersion: CURRENT_SCHEMA_VERSIONS.attestation + 1,
        reach: "all",
        ...asked.laterFields,
      };
      const later = Object.fromEntries(Object.entries(written).filter(([, field]) => field !== undefined));
      const bytes = canonicalBytes(later);
      const id = rawId(bytes);
      const signed = { id, record: later as unknown as AttestationRecord };
      const signature =
        signer === false ? [] : [await signAttestation({ attestation: signed, keyPath: keys.get(signer)!.keyPath })];
      await commitFilesAroundTheStore(
        { ctx: { gitDir: join(workspace.dir, ".musai") }, scope: workspace.scope, now: FIXTURE_CLOCK },
        [
          { path: recordPath("attestation", id), bytes },
          ...signature.map((text) => ({ path: sidecarPath(id), bytes: new TextEncoder().encode(text) })),
        ],
      );
      return id;
    }
    const signature =
      signer === false ? undefined : await signAttestation({ attestation, keyPath: keys.get(signer)!.keyPath });
    await workspace
      .store()
      .putMany([{ kind: "attestation", value: attestation.record, ...(signature === undefined ? {} : { signature }) }]);
    return attestation.id;
  };
  const opened = async () =>
    workspace.keep(await openWorkspace({ workspace: workspace.dir, scope: workspace.scope, now: FIXTURE_CLOCK }));
  const standingOf = async (of: RecordId = subject) =>
    (await releaseStanding(await opened(), of)).standing.map((release) => release.id);
  const sealsOf = async () => {
    const { standing, revoked } = await sealStanding(await opened(), subject);
    return {
      standing: standing.map((seal) => seal.id).sort(),
      revoked: revoked.map((seal) => seal.id),
      unverified: standing.filter((seal) => !seal.verified).map((seal) => seal.id),
    };
  };
  return { attest, standingOf, sealsOf, other: recordId(other) };
}

describe("what a record stands released to, decided by what supersedes what and never by a clock", () => {
  test.skipIf(!opensshAvailable)(
    "an unverified release does not stand, unsigned or signed by another key",
    async () => {
      const { attest, standingOf } = await releasable();
      await attest({ purpose: "released", signedBy: false });
      await attest({ purpose: "released", signedBy: BYSTANDER, at: "2026-01-01T00:00:02.000Z" });
      expect(await standingOf()).toEqual([]);
    },
  );

  test.skipIf(!opensshAvailable)("a signed release by a principal holding publish lets the record leave", async () => {
    const { attest, standingOf } = await releasable();
    const release = await attest({ purpose: "released" });
    expect(await standingOf()).toEqual([release]);
  });

  test.skipIf(!opensshAvailable)("a release whose principal holds no publish stands for no audience", async () => {
    const { attest, standingOf } = await releasable();
    await attest({ purpose: "released", by: BYSTANDER });
    expect(await standingOf()).toEqual([]);
  });

  test.skipIf(!opensshAvailable)("a release relayed through a model stands for no audience", async () => {
    const { attest, standingOf } = await releasable();
    await attest({ purpose: "released", via: "model" });
    expect(await standingOf()).toEqual([]);
  });

  test.skipIf(!opensshAvailable)("a release relayed through a model replaces no release a person granted", async () => {
    const { attest, standingOf } = await releasable();
    const granted = await attest({ purpose: "released" });
    await attest({ purpose: "released", via: "model", supersedes: [granted] });
    expect(await standingOf()).toEqual([granted]);
  });

  test.skipIf(!opensshAvailable)(
    "a revocation whose verification reaches no verdict refuses rather than leave its release standing",
    async () => {
      const { attest, standingOf } = await releasable();
      const release = await attest({ purpose: "released" });
      expect(await standingOf()).toEqual([release]);
      await attest({ purpose: "revoked", supersedes: [release] });
      await unreadingSshKeygen();

      await expect(standingOf()).rejects.toMatchObject({ reason: "tool-unavailable" });
    },
  );

  test.skipIf(!opensshAvailable)("a revocation withdraws exactly the releases it supersedes", async () => {
    const { attest, standingOf } = await releasable();
    const first = await attest({ purpose: "released" });
    const second = await attest({ purpose: "released", terms: { ...TERMS, uses: ["review"] } });
    await attest({ purpose: "revoked", supersedes: [first] });
    expect(await standingOf()).toEqual([second]);
  });

  test.skipIf(!opensshAvailable)("a release that supersedes another replaces its terms", async () => {
    const { attest, standingOf } = await releasable();
    const first = await attest({ purpose: "released" });
    const replacing = await attest({
      purpose: "released",
      terms: { ...TERMS, uses: ["review"] },
      supersedes: [first],
    });
    expect(await standingOf()).toEqual([replacing]);
  });

  test.skipIf(!opensshAvailable)("a release dated after its revocation still falls to it", async () => {
    const { attest, standingOf } = await releasable();
    const release = await attest({ purpose: "released", at: "2099-01-01T00:00:00.000Z" });
    await attest({ purpose: "revoked", supersedes: [release], at: "2026-01-01T00:00:00.000Z" });
    expect(await standingOf()).toEqual([]);
  });

  test.skipIf(!opensshAvailable)(
    "an unverified revocation in the name of a holder of publish withdraws the release it supersedes",
    async () => {
      const { attest, standingOf } = await releasable();
      const stripped = await attest({ purpose: "released" });
      const replaced = await attest({ purpose: "released", terms: { ...TERMS, uses: ["review"] } });
      await attest({ purpose: "revoked", supersedes: [stripped], signedBy: false });
      await attest({ purpose: "revoked", supersedes: [replaced], signedBy: BYSTANDER });
      expect(await standingOf()).toEqual([]);
    },
  );

  test.skipIf(!opensshAvailable)(
    "an unverified revocation in the name of someone who neither holds publish nor signed the release withdraws nothing",
    async () => {
      const { attest, standingOf } = await releasable();
      const release = await attest({ purpose: "released" });
      await attest({ purpose: "revoked", by: BYSTANDER, supersedes: [release], signedBy: false });
      expect(await standingOf()).toEqual([release]);
    },
  );

  test.skipIf(!opensshAvailable)(
    "a revocation by someone who neither holds publish nor signed the release withdraws nothing",
    async () => {
      const { attest, standingOf } = await releasable();
      const release = await attest({ purpose: "released" });
      await attest({ purpose: "revoked", by: BYSTANDER, supersedes: [release] });
      expect(await standingOf()).toEqual([release]);
    },
  );

  test.skipIf(!opensshAvailable)(
    "a revocation relayed through a model withdraws the release it supersedes",
    async () => {
      const { attest, standingOf } = await releasable();
      const release = await attest({ purpose: "released" });
      await attest({ purpose: "revoked", supersedes: [release], via: "model" });
      expect(await standingOf()).toEqual([]);
    },
  );

  test.skipIf(!opensshAvailable)(
    "a signed release at a later attestation version withdraws the release it supersedes and stands for no audience itself",
    async () => {
      const { attest, standingOf } = await releasable();
      const replaced = await attest({ purpose: "released" });
      const kept = await attest({ purpose: "released", terms: { ...TERMS, uses: ["review"] } });
      await attest({ purpose: "released", later: true, supersedes: [replaced] });
      expect(await standingOf()).toEqual([kept]);
    },
  );

  test.skipIf(!opensshAvailable)(
    "a release at a later attestation version withdraws nothing unverified, without publish, or through a model",
    async () => {
      const { attest, standingOf } = await releasable();
      const release = await attest({ purpose: "released" });
      await attest({ purpose: "released", later: true, supersedes: [release], signedBy: false });
      await attest({
        purpose: "released",
        later: true,
        supersedes: [release],
        by: BYSTANDER,
        at: "2026-01-01T00:00:02.000Z",
      });
      await attest({
        purpose: "released",
        later: true,
        supersedes: [release],
        via: "model",
        at: "2026-01-01T00:00:03.000Z",
      });
      expect(await standingOf()).toEqual([release]);
    },
  );

  test.skipIf(!opensshAvailable)(
    "a revocation at a later attestation version withdraws the release it supersedes, verified or not",
    async () => {
      const { attest, standingOf } = await releasable();
      const signed = await attest({ purpose: "released" });
      const stripped = await attest({ purpose: "released", terms: { ...TERMS, uses: ["review"] } });
      await attest({ purpose: "revoked", later: true, supersedes: [signed] });
      await attest({ purpose: "revoked", later: true, supersedes: [stripped], signedBy: false });
      expect(await standingOf()).toEqual([]);
    },
  );

  test.skipIf(!opensshAvailable)(
    "a revocation at a later attestation version withdraws by its subject and supersedes whatever else it lacks",
    async () => {
      const { attest, standingOf } = await releasable();
      const release = await attest({ purpose: "released" });
      await attest({
        purpose: "revoked",
        later: true,
        supersedes: [release],
        signedBy: false,
        laterFields: { at: undefined, via: 7, supersedes: ["not a record id", release] },
      });
      expect(await standingOf()).toEqual([]);
    },
  );

  test.skipIf(!opensshAvailable)(
    "a release at a later attestation version naming no principal or no time replaces nothing, as it cannot count",
    async () => {
      const { attest, standingOf } = await releasable();
      const release = await attest({ purpose: "released" });
      await attest({ purpose: "released", later: true, supersedes: [release], laterFields: { principal: 7 } });
      await attest({ purpose: "released", later: true, supersedes: [release], laterFields: { at: undefined } });
      expect(await standingOf()).toEqual([release]);
    },
  );

  test.skipIf(!opensshAvailable)(
    "a release of another record that counts withdraws the release it supersedes, at any version",
    async () => {
      const { attest, standingOf, other } = await releasable();
      const first = await attest({ purpose: "released" });
      const second = await attest({ purpose: "released", terms: { ...TERMS, uses: ["review"] } });
      const across = await attest({ purpose: "released", subject: other, supersedes: [first] });
      await attest({ purpose: "released", subject: other, later: true, supersedes: [second] });
      expect(await standingOf()).toEqual([]);
      expect(await standingOf(other)).toEqual([across]);
    },
  );

  test.skipIf(!opensshAvailable)(
    "a release of another record that does not count withdraws nothing it supersedes",
    async () => {
      const { attest, standingOf, other } = await releasable();
      const release = await attest({ purpose: "released" });
      await attest({ purpose: "released", subject: other, supersedes: [release], signedBy: false });
      await attest({ purpose: "released", subject: other, supersedes: [release], via: "model" });
      await attest({ purpose: "released", subject: other, supersedes: [release], by: BYSTANDER });
      expect(await standingOf()).toEqual([release]);
    },
  );

  test.skipIf(!opensshAvailable)("a revocation naming another record's release withdraws nothing", async () => {
    const { attest, standingOf, other } = await releasable();
    const release = await attest({ purpose: "released" });
    await attest({ purpose: "revoked", subject: other, supersedes: [release] });
    expect(await standingOf()).toEqual([release]);
  });
});

describe("what a record stands sealed from, decided as a release's standing is", () => {
  test.skipIf(!opensshAvailable)("a signed seal by a principal holding publish stands", async () => {
    const { attest, sealsOf } = await releasable();
    const seal = await attest({ purpose: "sealed" });
    expect(await sealsOf()).toEqual({ standing: [seal], revoked: [], unverified: [] });
  });

  test.skipIf(!opensshAvailable)(
    "a seal whose sidecar was stripped or replaced, in the name of a holder of publish, stands unverified",
    async () => {
      const { attest, sealsOf } = await releasable();
      const stripped = await attest({ purpose: "sealed", signedBy: false });
      const replaced = await attest({ purpose: "sealed", signedBy: BYSTANDER, at: "2026-01-01T00:00:02.000Z" });
      const both = [stripped, replaced].sort();
      expect(await sealsOf()).toEqual({ standing: both, revoked: [], unverified: both });
    },
  );

  test.skipIf(!opensshAvailable)(
    "a seal in the name of a writer the trust does not grant publish does not stand, signed or forged",
    async () => {
      const { attest, sealsOf } = await releasable();
      await attest({ purpose: "sealed", by: BYSTANDER });
      await attest({ purpose: "sealed", by: BYSTANDER, signedBy: false, at: "2026-01-01T00:00:02.000Z" });
      await attest({ purpose: "sealed", by: BYSTANDER, signedBy: PUBLISHER, at: "2026-01-01T00:00:03.000Z" });
      expect(await sealsOf()).toEqual({ standing: [], revoked: [], unverified: [] });
    },
  );

  test.skipIf(!opensshAvailable)("an unverified seal replaces no seal it supersedes", async () => {
    const { attest, sealsOf } = await releasable();
    const signed = await attest({ purpose: "sealed" });
    const forged = await attest({ purpose: "sealed", signedBy: false, supersedes: [signed] });
    expect(await sealsOf()).toEqual({ standing: [signed, forged].sort(), revoked: [], unverified: [forged] });
  });

  test.skipIf(!opensshAvailable)(
    "a seal whose verification reaches no verdict refuses rather than stand unverified",
    async () => {
      const { attest, sealsOf } = await releasable();
      await attest({ purpose: "sealed" });
      await unreadingSshKeygen();

      await expect(sealsOf()).rejects.toMatchObject({ reason: "tool-unavailable" });
    },
  );

  test.skipIf(!opensshAvailable)("an unverified revocation lifts no seal, stripped or replaced", async () => {
    const { attest, sealsOf } = await releasable();
    const seal = await attest({ purpose: "sealed" });
    await attest({ purpose: "revoked", supersedes: [seal], signedBy: false });
    await attest({ purpose: "revoked", supersedes: [seal], signedBy: BYSTANDER, at: "2026-01-01T00:00:02.000Z" });
    expect(await sealsOf()).toEqual({ standing: [seal], revoked: [], unverified: [] });
  });

  test.skipIf(!opensshAvailable)(
    "an unverified revocation naming a seal and a release withdraws the release and lifts no seal",
    async () => {
      const { attest, sealsOf, standingOf } = await releasable();
      const seal = await attest({ purpose: "sealed" });
      const release = await attest({ purpose: "released" });
      await attest({ purpose: "revoked", supersedes: [seal, release], signedBy: false });
      expect(await sealsOf()).toEqual({ standing: [seal], revoked: [], unverified: [] });
      expect(await standingOf()).toEqual([]);
    },
  );

  test.skipIf(!opensshAvailable)(
    "a revocation lifts the seal it supersedes and leaves a release standing",
    async () => {
      const { attest, sealsOf, standingOf } = await releasable();
      const seal = await attest({ purpose: "sealed" });
      const release = await attest({ purpose: "released" });
      await attest({ purpose: "revoked", supersedes: [seal] });
      expect(await sealsOf()).toEqual({ standing: [], revoked: [seal], unverified: [] });
      expect(await standingOf()).toEqual([release]);
    },
  );

  test.skipIf(!opensshAvailable)(
    "a revocation relayed through a model lifts no seal, as none is made through one",
    async () => {
      const { attest, sealsOf } = await releasable();
      const seal = await attest({ purpose: "sealed" });
      await attest({ purpose: "revoked", supersedes: [seal], via: "model" });
      expect(await sealsOf()).toEqual({ standing: [seal], revoked: [], unverified: [] });
    },
  );

  test.skipIf(!opensshAvailable)(
    "an attestation at a later version lifts no seal and replaces none, as a later meaning only narrows",
    async () => {
      const { attest, sealsOf } = await releasable();
      const seal = await attest({ purpose: "sealed" });
      await attest({ purpose: "revoked", later: true, supersedes: [seal] });
      await attest({ purpose: "sealed", later: true, supersedes: [seal], at: "2026-01-01T00:00:02.000Z" });
      expect(await sealsOf()).toEqual({ standing: [seal], revoked: [], unverified: [] });
    },
  );

  test.skipIf(!opensshAvailable)("a seal is never a release, and a release never a seal", async () => {
    const { attest, sealsOf, standingOf } = await releasable();
    const seal = await attest({ purpose: "sealed" });
    const release = await attest({ purpose: "released" });
    expect(await standingOf()).toEqual([release]);
    expect(await sealsOf()).toEqual({ standing: [seal], revoked: [], unverified: [] });
  });
});

describe("the release that covers an audience at the recorded now", () => {
  const audiences = parseAudiences("peer\nknown includes peer\n");
  const now = timestamp("2026-06-01T00:00:00.000Z");

  function standing(audience: string, terms: Partial<ReleaseTerms> = {}): StandingRelease {
    const { id, record } = mintAttestation({
      subject: recordId(fixtureRunRecord(`released to ${audience}`)),
      principal: `key:SHA256:${"p".repeat(43)}`,
      principalClass: "person",
      via: "tty",
      purpose: "released",
      at: timestamp("2026-01-01T00:00:00.000Z"),
      release: { audience: audience as Audience, extent: "record", terms: { ...TERMS, ...terms } },
    });
    return { id, record: record as ReleaseAttestationRecord };
  }

  test("a wider declared audience covers a narrower one, an exact audience is preferred, and none covers wider", () => {
    const known = standing("known");
    const peer = standing("peer");
    expect(coveringRelease([known], "peer", audiences, now)).toBe(known);
    expect(coveringRelease([known, peer], "peer", audiences, now)).toBe(peer);
    expect(coveringRelease([peer], "known", audiences, now)).toBeUndefined();
  });

  test("a release outside its window at the recorded now covers nothing", () => {
    const lapsed = standing("public", { until: timestamp("2026-05-01T00:00:00.000Z") });
    const early = standing("public", { from: timestamp("2026-07-01T00:00:00.000Z") });
    const open = standing("public", { from: timestamp("2026-05-01T00:00:00.000Z") });
    expect(coveringRelease([lapsed, early], "public", audiences, now)).toBeUndefined();
    expect(coveringRelease([lapsed, open], "public", audiences, now)).toBe(open);
  });
});
