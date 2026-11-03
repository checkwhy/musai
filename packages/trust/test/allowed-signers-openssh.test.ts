import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalBytes, recordId, timestamp } from "@musai/records";
import { generateTestKey, type TestKey, writeAllowedSigners } from "@musai/test-support";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { parseAllowedSigners } from "../src/allowed-signers.js";
import { type Attestation, mintAttestation } from "../src/attestation.js";
import { signAttestation } from "../src/sign.js";
import { verifyAttestation } from "../src/verify.js";

/** An allowed-signers line for `key`, listing its name and its key form. */
type Line = (key: TestKey) => string;

const named = (key: TestKey) => `${key.name},${key.principal}`;
const typeOf = (key: TestKey) => key.pubKeyLine.split(" ")[0]!;
const blobOf = (key: TestKey) => key.pubKeyLine.split(" ")[1]!;
const withOptions =
  (options: string): Line =>
  (key) =>
    `${named(key)} ${options} ${key.pubKeyLine}`;

/** Lines OpenSSH reads and reaches a verdict under, good or bad. */
const READ: readonly (readonly [string, Line])[] = [
  ["a plain line", (key) => `${named(key)} ${key.pubKeyLine}`],
  ["a tab between principals and key", (key) => `${named(key)}\t${key.pubKeyLine}`],
  ["a comment after the key", (key) => `${named(key)} ${key.pubKeyLine} the author's laptop`],
  ["an option named in capitals", withOptions('NAMESPACES="musai"')],
  ["two namespaces, one a pattern", withOptions('namespaces="git,mu*"')],
  ["a namespace that is not ours", withOptions('namespaces="git"')],
  ["cert-authority", withOptions("cert-authority")],
  ["a window to the day", withOptions('valid-after="20250101Z",valid-before="20990101Z"')],
  ["a window to the minute, in UTC", withOptions('valid-after="202501010000Z"')],
  ["a window to the second, in UTC by name", withOptions('valid-after="20250101000000UTC"')],
];

/** Lines OpenSSH reports on stderr by path and line number and never judges a signature under. */
const UNREAD: readonly (readonly [string, Line])[] = [
  ["an option OpenSSH does not know", withOptions("bogus-opt")],
  ["an option value without quotes", withOptions("namespaces=musai")],
  ["one option given twice", withOptions('namespaces="musai",namespaces="musai"')],
  ["a time that is not one", withOptions('valid-after="tomorrow"')],
  ["a month that does not exist", withOptions('valid-after="20251301Z"')],
  ["a time of ten digits", withOptions('valid-after="2025010100Z"')],
  ["a window that closes before it opens", withOptions('valid-after="20250101Z",valid-before="20240101Z"')],
  [
    "a window empty once its day past the month's end is read",
    withOptions('valid-after="20270231Z",valid-before="20270302Z"'),
  ],
  ["the epoch", withOptions('valid-after="19700101Z"')],
  ["a time before the epoch", withOptions('valid-before="19691231Z"')],
  ["a value ending in an escaped quote", withOptions('namespaces="musai\\"')],
  ["a truncated key", (key) => `${named(key)} ${typeOf(key)} ${blobOf(key).slice(0, 20)}`],
  ["a key with a character too many", (key) => `${named(key)} ${typeOf(key)} ${blobOf(key)}x`],
  ["a key type OpenSSH does not know", (key) => `${named(key)} ssh-foo ${blobOf(key)}`],
  ["a key type its key is not", (key) => `${named(key)} ssh-rsa ${blobOf(key)}`],
];

/** Lines OpenSSH reads without a word, but by a rule a re-check elsewhere may not share, or as no
 * exact match: musai principals are key forms, pseudonyms and names, never patterns. */
const AMBIGUOUS: readonly (readonly [string, Line])[] = [
  ["a time in the machine's own zone", withOptions('valid-after="20250101"')],
  ["a time to the second in the machine's own zone", withOptions('valid-after="20250101000000"')],
  ["a negation of the key's own form", (key) => `${named(key)},!${key.principal} ${key.pubKeyLine}`],
  ["a negation of every principal", (key) => `${named(key)},!* ${key.pubKeyLine}`],
  ["principals in quotes", (key) => `"${named(key)}" ${key.pubKeyLine}`],
  ["a name matching by wildcard", (key) => `${key.name.replace("alice", "al*ce")},${key.principal} ${key.pubKeyLine}`],
  [
    "a name matching by one character",
    (key) => `${key.name.replace("alice", "al?ce")},${key.principal} ${key.pubKeyLine}`,
  ],
];

describe("an allowed-signers line is read by musai exactly where the system OpenSSH reads it", () => {
  let key: TestKey;
  let dir: string;
  let attestation: Attestation;
  let signature: string;

  beforeAll(async () => {
    key = await generateTestKey("alice@example.com");
    dir = await mkdtemp(join(tmpdir(), "musai-allowed-signers-openssh-"));
    attestation = mintAttestation({
      subject: recordId({ example: "a record its signer's line vouches for" }),
      principal: key.principal,
      principalClass: "person",
      via: "signature",
      purpose: "asserted",
      at: timestamp("2026-01-01T00:00:00Z"),
    });
    signature = await signAttestation({ attestation, keyPath: key.keyPath });
  }, 60_000);

  afterAll(async () => {
    await rm(key.dir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  });

  const verifyUnder = async (line: string) =>
    verifyAttestation({
      attestation,
      signedBytes: canonicalBytes(attestation.record),
      signature,
      allowedSignersPath: await writeAllowedSigners(dir, `${line}\n`),
    });

  test.each(READ)("%s parses, and ssh-keygen reaches a verdict under it", async (_, line) => {
    expect(parseAllowedSigners(`${line(key)}\n`)).toHaveLength(1);
    await expect(verifyUnder(line(key))).resolves.toMatchObject({ principal: key.principal });
  });

  test.each(AMBIGUOUS)("%s is refused by musai, naming the line, though OpenSSH answers silently", async (_, line) => {
    expect(() => parseAllowedSigners(`# the team\n${line(key)}\n`)).toThrow(`line 2: ${line(key)}`);
    await expect(verifyUnder(line(key))).resolves.toMatchObject({ principal: key.principal });
  });

  test.each(UNREAD)("%s is refused by musai, naming the line", (_, line) => {
    expect(() => parseAllowedSigners(`# the team\n${line(key)}\n`)).toThrow(`line 2: ${line(key)}`);
  });

  test.each(UNREAD)("%s refuses a verification under it rather than judge the signature", async (_, line) => {
    await expect(verifyUnder(line(key))).rejects.toMatchObject({
      reason: "tool-unavailable",
      about: [attestation.id],
    });
  });
});
