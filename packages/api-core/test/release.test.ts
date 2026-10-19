import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type Audience,
  type RecordId,
  type ReleaseAttestationRecord,
  type ReleaseTerms,
  recordId,
  timestamp,
  type ViaChannel,
} from "@musai/records";
import {
  allowedSignersLine,
  fixtureRunRecord,
  generateTestKey,
  type TestKey,
  writeTrustFile,
} from "@musai/test-support";
import { mintAttestation, parseAudiences, signAttestation } from "@musai/trust";
import { describe, expect, onTestFinished, test } from "vitest";
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
  readonly signed?: boolean;
  readonly at?: string;
  readonly subject?: RecordId;
  readonly supersedes?: readonly RecordId[];
  readonly terms?: ReleaseTerms;
  readonly via?: ViaChannel;
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
    const signature =
      asked.signed === false ? undefined : await signAttestation({ attestation, keyPath: keys.get(by)!.keyPath });
    await workspace
      .store()
      .putMany([{ kind: "attestation", value: attestation.record, ...(signature === undefined ? {} : { signature }) }]);
    return attestation.id;
  };
  const opened = () => openWorkspace({ workspace: workspace.dir, scope: workspace.scope, now: FIXTURE_CLOCK });
  const standingOf = async (of: RecordId = subject) =>
    (await releaseStanding(await opened(), of)).standing.map((release) => release.id);
  const sealsOf = async () => {
    const { standing, revoked } = await sealStanding(await opened(), subject);
    return { standing: standing.map((seal) => seal.id), revoked: revoked.map((seal) => seal.id) };
  };
  return { attest, standingOf, sealsOf, other: recordId(other) };
}

describe("what a record stands released to, decided by what supersedes what and never by a clock", () => {
  test.skipIf(!opensshAvailable)("an unsigned release lets nothing leave", async () => {
    const { attest, standingOf } = await releasable();
    await attest({ purpose: "released", signed: false });
    expect(await standingOf()).toEqual([]);
  });

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

  test.skipIf(!opensshAvailable)("an unsigned revocation withdraws nothing", async () => {
    const { attest, standingOf } = await releasable();
    const release = await attest({ purpose: "released" });
    await attest({ purpose: "revoked", supersedes: [release], signed: false });
    expect(await standingOf()).toEqual([release]);
  });

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
    expect(await sealsOf()).toEqual({ standing: [seal], revoked: [] });
  });

  test.skipIf(!opensshAvailable)("a seal by a signer without publish, or unsigned, does not stand", async () => {
    const { attest, sealsOf } = await releasable();
    await attest({ purpose: "sealed", by: BYSTANDER });
    await attest({ purpose: "sealed", signed: false, at: "2026-01-01T00:00:02.000Z" });
    expect(await sealsOf()).toEqual({ standing: [], revoked: [] });
  });

  test.skipIf(!opensshAvailable)(
    "a revocation lifts the seal it supersedes and leaves a release standing",
    async () => {
      const { attest, sealsOf, standingOf } = await releasable();
      const seal = await attest({ purpose: "sealed" });
      const release = await attest({ purpose: "released" });
      await attest({ purpose: "revoked", supersedes: [seal] });
      expect(await sealsOf()).toEqual({ standing: [], revoked: [seal] });
      expect(await standingOf()).toEqual([release]);
    },
  );

  test.skipIf(!opensshAvailable)(
    "a revocation relayed through a model lifts no seal, as none is made through one",
    async () => {
      const { attest, sealsOf } = await releasable();
      const seal = await attest({ purpose: "sealed" });
      await attest({ purpose: "revoked", supersedes: [seal], via: "model" });
      expect(await sealsOf()).toEqual({ standing: [seal], revoked: [] });
    },
  );

  test.skipIf(!opensshAvailable)("a seal is never a release, and a release never a seal", async () => {
    const { attest, sealsOf, standingOf } = await releasable();
    const seal = await attest({ purpose: "sealed" });
    const release = await attest({ purpose: "released" });
    expect(await standingOf()).toEqual([release]);
    expect(await sealsOf()).toEqual({ standing: [seal], revoked: [] });
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
