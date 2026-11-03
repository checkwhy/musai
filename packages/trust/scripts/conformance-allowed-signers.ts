import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CURVES,
  keyPrincipalOf,
  type LineRefusal,
  principalsOf,
  readAllowedSignersLine,
  secondsOf,
} from "../src/allowed-signers.js";
import { CONFORMANCE_DIR, SOME_KEY as ED25519 } from "./conformance-bundles.js";

const ECDSA =
  "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBLyXQ58Vd/sPi8ChbwrxUUonffJNNUCpmvbDj3xNQy356BCE4UQHrvZmwNpzBIoJL6IneUqmCFS/N287UplxuVE=";
const ED25519_BLOB = ED25519.split(" ")[1]!;
const ECDSA_BLOB = ECDSA.split(" ")[1]!;
const OWN_FORM = keyPrincipalOf(ED25519);
const OTHER_FORM = keyPrincipalOf(ECDSA);
const ECDSA_384 =
  "ecdsa-sha2-nistp384 AAAAE2VjZHNhLXNoYTItbmlzdHAzODQAAAAIbmlzdHAzODQAAABhBJN/4v56XIkdSIFvU//qbzNesfztJm337QAhDO9emWqZJyOuyo+7LTQYREcYf/xSXXnfd3YOu6je9PSYknMiYU1HRiRrFFSGiV1Cx1pZvcVAOjwpv+aGyGz5lHvCfX/SCw==";
const ECDSA_521 =
  "ecdsa-sha2-nistp521 AAAAE2VjZHNhLXNoYTItbmlzdHA1MjEAAAAIbmlzdHA1MjEAAACFBAAznWKRaxO32r191SOgBrhSHtBl66gRUs+Ru7xAnBcoAD0jyZZmxNx4WMcGqO45IyMS4gnr4HpYaEVSuLsy1cV0mQB+sreOSQ2wz4FaI0uF5EMrtNAcXGePo15Eh9A2ohmOrnlS+O3KjO4FUzJYaH4GYhtkHWJVOuDWEx9jAfcgSgy5cg==";
const POINT = Buffer.from(ECDSA_BLOB, "base64").subarray(39);
const OFF_CURVE = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]);

const { prime: P256, b: P256_B, order: P256_ORDER } = CURVES.get("nistp256")!;

function power(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  for (let b = base % modulus, e = exponent; e > 0n; b = (b * b) % modulus, e >>= 1n) {
    result = e & 1n ? (result * b) % modulus : result;
  }
  return result;
}

/** The uncompressed P-256 point of the least x from `from` on the curve, its y a square root
 * taken as the prime is 3 mod 4. */
function p256PointFrom(from: bigint): Buffer {
  for (let x = from; ; x += 1n) {
    const right = (((x * x * x - 3n * x + P256_B) % P256) + P256) % P256;
    const y = power(right, (P256 + 1n) / 4n, P256);
    if ((y * y) % P256 === right) {
      const hex = (value: bigint) => value.toString(16).padStart(64, "0");
      return Buffer.from(`04${hex(x)}${hex(y)}`, "hex");
    }
  }
}

const p256 = (point: Buffer) => `ecdsa-sha2-nistp256 ${blob("ecdsa-sha2-nistp256", "nistp256", point)}`;

/** A key blob of SSH strings, as a line spells it. */
function blob(...fields: (string | Uint8Array)[]): string {
  const parts = fields.map((field) => (typeof field === "string" ? Buffer.from(field, "latin1") : Buffer.from(field)));
  return Buffer.concat(
    parts.flatMap((part) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(part.length);
      return [length, part];
    }),
  ).toString("base64");
}

/** An RSA key of a modulus `bytes` long, written from the bytes `top`, under `exponent`. */
function rsa(exponent: readonly number[], top: readonly number[], bytes: number): string {
  const modulus = Buffer.concat([
    Buffer.from(top),
    Buffer.alloc(bytes - top.filter((byte) => byte !== 0).length, 0x35),
  ]);
  return `ssh-rsa ${blob("ssh-rsa", Buffer.from(exponent), modulus)}`;
}

const F4 = [1, 0, 1];
const RSA = rsa(F4, [0, 0xc1], 256);

/** How ssh-keygen 9.6 answers a refused line under the principal `as` it reads first in it, and
 * the key type it reads the line only where its build knows. */
interface OpenSshAnswer {
  readonly as: string;
  readonly reads: boolean;
  readonly knowing?: string;
}

/** One line, and the refusal the kernel names for it, or none where it reads the line; a refused
 * line ssh-keygen refuses as `florin` gives no `openSsh`. */
export interface AllowedSignersCase {
  readonly name: string;
  readonly line: string;
  readonly refused?: LineRefusal;
  readonly openSsh?: OpenSshAnswer;
}

const READS = { openSsh: { as: "florin", reads: true } };

const at = (options: string, key = ED25519) => `florin ${options} ${key}`;

export const ALLOWED_SIGNERS_CASES: readonly AllowedSignersCase[] = [
  { name: "a name and its key", line: `florin ${ED25519}` },
  { name: "a name beside its key's own form", line: `florin,${OWN_FORM} ${ED25519}` },
  { name: "the key's own form alone", line: `${OWN_FORM} ${ED25519}` },
  { name: "tabs between principals, options and key", line: `florin\tnamespaces="musai"\t${ED25519}` },
  { name: "a comment after the key", line: `florin ${ED25519} the author's laptop` },
  { name: "whitespace around the line", line: `  florin ${ED25519} \r` },
  { name: "an ECDSA key", line: `florin ${ECDSA}` },
  { name: "cert-authority", line: at("cert-authority") },
  { name: "cert-authority twice", line: at("cert-authority,cert-authority") },
  { name: "namespaces, one a pattern", line: at('namespaces="musai,git*"') },
  { name: "an empty namespaces list", line: at('namespaces=""') },
  { name: "an option named in capitals", line: at('NAMESPACES="musai"') },
  { name: "a window to the day in UTC", line: at('valid-after="20250101Z",valid-before="20990101Z"') },
  { name: "a window to the minute in UTC", line: at('valid-after="202501010000Z"') },
  { name: "a time to the second, UTC named in lower case", line: at('valid-before="20990101000000utc"') },
  { name: "a day past its month's end, read in the next month", line: at('valid-before="20270230Z"') },
  { name: "the first second after the epoch", line: at('valid-after="19700101000001Z"') },
  {
    name: "every option at once",
    line: at('cert-authority,namespaces="musai",valid-after="20250101Z",valid-before="20990101Z"'),
  },
  { name: "the 29th of February of a common year, read as the 1st of March", line: at('valid-before="20270229Z"') },
  { name: "the 31st of April, read as the 1st of May", line: at('valid-after="20270431Z"') },
  { name: "the last second OpenSSH reads", line: at('valid-before="99991231235959Z"') },
  { name: "a backslash inside a value", line: at('namespaces="mu\\sai"') },
  { name: "an empty principal", line: `,florin ${ED25519}` },
  { name: "an ECDSA key on P-384", line: `florin ${ECDSA_384}` },
  { name: "an ECDSA key on P-521", line: `florin ${ECDSA_521}` },
  { name: "an RSA key", line: `florin ${RSA}` },
  { name: "an RSA key beside its own form", line: `florin,${keyPrincipalOf(RSA)} ${RSA}` },
  { name: "an RSA key of 1024 bits", line: `florin ${rsa(F4, [0, 0xc1], 128)}` },
  { name: "an RSA exponent of 3", line: `florin ${rsa([3], [0, 0xc1], 256)}` },
  { name: "an RSA exponent of 24 bits", line: `florin ${rsa([0, 0xff, 0xff, 0xff], [0, 0xc1], 256)}` },
  {
    name: "a security key's ed25519 key",
    line: `florin sk-ssh-ed25519@openssh.com ${blob("sk-ssh-ed25519@openssh.com", Buffer.from(ED25519_BLOB, "base64").subarray(19), "ssh:")}`,
  },
  {
    name: "a security key's ECDSA key",
    line: `florin sk-ecdsa-sha2-nistp256@openssh.com ${blob("sk-ecdsa-sha2-nistp256@openssh.com", "nistp256", POINT, "ssh:")}`,
  },
  { name: "a NUL inside a value", line: at('namespaces="mu\0sai"'), refused: "unread-character" },
  {
    name: "a no-break space inside the principals",
    line: `florin,\u00a0alice ${ED25519}`,
    refused: "unread-character",
    ...READS,
  },
  {
    name: "a carriage return inside a principal",
    line: `flo\rrin ${ED25519}`,
    refused: "unread-character",
    openSsh: { as: "flo", reads: false },
  },
  {
    name: "a byte-order mark before the principals",
    line: `\ufeffflorin ${ED25519}`,
    refused: "unread-character",
    openSsh: { as: "\ufeffflorin", reads: true },
  },
  {
    name: "a vertical tab after the principals",
    line: `florin\v ${ED25519}`,
    refused: "unread-character",
    openSsh: { as: "florin\v", reads: true },
  },
  { name: "a principal alone", line: "florin", refused: "incomplete" },
  { name: "a key type with no key", line: "florin ssh-ed25519", refused: "incomplete" },
  { name: "an unknown key type and no options", line: `florin ssh-foo ${ED25519_BLOB}`, refused: "incomplete" },
  { name: "an option value whose quote never closes", line: at('namespaces="musai'), refused: "incomplete" },
  { name: "a wildcard principal", line: `fl*n ${ED25519}`, refused: "principal-pattern", ...READS },
  { name: "a principal matching one character", line: `fl?rin ${ED25519}`, refused: "principal-pattern", ...READS },
  { name: "a negated principal", line: `florin,!alice ${ED25519}`, refused: "principal-pattern", ...READS },
  { name: "a pattern principal before an unknown option", line: `fl*n bogus ${ED25519}`, refused: "principal-pattern" },
  { name: "a principal in quotes", line: `"florin" ${ED25519}`, refused: "principal-quoted", ...READS },
  {
    name: "a quote inside a principal",
    line: `fl"or"in ${ED25519}`,
    refused: "principal-quoted",
    openSsh: { as: "flor", reads: false },
  },
  { name: "an unknown option", line: at("bogus"), refused: "option-unknown" },
  { name: "cert-authority given a value", line: at('cert-authority="yes"'), refused: "option-unknown" },
  { name: "namespaces given no value", line: at("namespaces"), refused: "option-unknown" },
  { name: "a trailing comma", line: at('namespaces="musai",'), refused: "option-unknown" },
  { name: "a leading comma", line: at(',namespaces="musai"'), refused: "option-unknown", ...READS },
  { name: "two commas", line: at('namespaces="musai",,valid-after="20250101Z"'), refused: "option-unknown", ...READS },
  { name: "an option named only by Unicode case folding", line: at('namespaceſ="musai"'), refused: "option-unknown" },
  { name: "an unknown option before a bad key", line: `florin bogus ssh-ed25519 AAAA`, refused: "option-unknown" },
  { name: "a value without quotes", line: at("namespaces=musai"), refused: "option-unquoted" },
  { name: "a value with text after its quotes", line: at('namespaces="musai"x'), refused: "option-unquoted" },
  { name: "a value ending in an escaped quote", line: at('namespaces="musai\\"'), refused: "option-unquoted" },
  { name: "namespaces twice", line: at('namespaces="musai",namespaces="git"'), refused: "option-repeated" },
  {
    name: "a bound twice in two cases",
    line: at('valid-after="20250101Z",VALID-AFTER="20260101Z"'),
    refused: "option-repeated",
  },
  { name: "a day with no zone", line: at('valid-after="20250101"'), refused: "option-time", ...READS },
  { name: "a second with no zone", line: at('valid-before="20990101000000"'), refused: "option-time", ...READS },
  { name: "a time of ten digits", line: at('valid-after="2025010100Z"'), refused: "option-time" },
  { name: "a month that does not exist", line: at('valid-after="20251301Z"'), refused: "option-time" },
  { name: "a day of zero", line: at('valid-after="20250100Z"'), refused: "option-time" },
  { name: "a sixtieth second", line: at('valid-after="20250101000060Z"'), refused: "option-time", ...READS },
  { name: "a word for a time", line: at('valid-after="tomorrow"'), refused: "option-time" },
  { name: "a space before the time", line: at('valid-after=" 20250101Z"'), refused: "option-time" },
  { name: "the epoch", line: at('valid-after="19700101Z"'), refused: "option-time" },
  { name: "a time before the epoch", line: at('valid-before="19691231Z"'), refused: "option-time" },
  {
    name: "a window closing before it opens",
    line: at('valid-after="20990101Z",valid-before="20250101Z"'),
    refused: "window-empty",
  },
  {
    name: "a window closing as it opens",
    line: at('valid-after="20250101Z",valid-before="20250101Z"'),
    refused: "window-empty",
  },
  {
    name: "a window empty once its day past the month's end is read",
    line: at('valid-after="20270231Z",valid-before="20270302Z"'),
    refused: "window-empty",
  },
  {
    name: "an unknown key type",
    line: at('namespaces="musai"', `ssh-foo ${ED25519_BLOB}`),
    refused: "key-type-unknown",
  },
  { name: "a key cut short", line: `florin ssh-ed25519 ${ED25519_BLOB.slice(0, 20)}`, refused: "key-invalid" },
  { name: "a key with a character too many", line: `florin ${ED25519}x`, refused: "key-invalid" },
  { name: "a key padded past its length", line: `florin ${ED25519}=`, refused: "key-invalid" },
  { name: "a key in base64 that is not strict", line: `florin ${ECDSA.replace(/E=$/, "F=")}`, refused: "key-invalid" },
  { name: "a key of another type", line: `florin ssh-rsa ${ED25519_BLOB}`, refused: "key-invalid" },
  { name: "a key on another curve", line: `florin ecdsa-sha2-nistp384 ${ECDSA_BLOB}`, refused: "key-invalid" },
  {
    name: "an ed25519 key a byte short",
    line: `florin ssh-ed25519 ${blob("ssh-ed25519", new Uint8Array(31))}`,
    refused: "key-invalid",
  },
  {
    name: "an ed25519 key with a field too many",
    line: `florin ssh-ed25519 ${blob("ssh-ed25519", new Uint8Array(32), "")}`,
    refused: "key-invalid",
  },
  {
    name: "a principal naming another key's form",
    line: `florin,${OTHER_FORM} ${ED25519}`,
    refused: "key-foreign",
    ...READS,
  },
  {
    name: "a principal naming no key's form",
    line: `florin,key:SHA256:nope ${ED25519}`,
    refused: "key-foreign",
    ...READS,
  },
  {
    name: "an ECDSA point off its curve",
    line: `florin ecdsa-sha2-nistp256 ${blob("ecdsa-sha2-nistp256", "nistp256", OFF_CURVE)}`,
    refused: "key-invalid",
  },
  {
    name: "a compressed ECDSA point",
    line: `florin ecdsa-sha2-nistp256 ${blob("ecdsa-sha2-nistp256", "nistp256", Buffer.concat([Buffer.from([2]), POINT.subarray(1, 33)]))}`,
    refused: "key-invalid",
  },
  { name: "an ECDSA point of a small x", line: `florin ${p256(p256PointFrom(1n))}`, refused: "key-invalid" },
  {
    name: "an ECDSA point of an x past the order",
    line: `florin ${p256(p256PointFrom(P256_ORDER - 1n))}`,
    refused: "key-invalid",
  },
  {
    name: "a security key's ECDSA point off its curve",
    line: `florin sk-ecdsa-sha2-nistp256@openssh.com ${blob("sk-ecdsa-sha2-nistp256@openssh.com", "nistp256", OFF_CURVE, "ssh:")}`,
    refused: "key-invalid",
  },
  { name: "an RSA key of 512 bits", line: `florin ${rsa(F4, [0, 0xc1], 64)}`, refused: "key-invalid" },
  { name: "an RSA key of 1023 bits", line: `florin ${rsa(F4, [0x41], 128)}`, refused: "key-invalid" },
  { name: "an RSA exponent of 1", line: `florin ${rsa([1], [0, 0xc1], 256)}`, refused: "key-invalid", ...READS },
  { name: "an even RSA exponent", line: `florin ${rsa([1, 0, 0], [0, 0xc1], 256)}`, refused: "key-invalid", ...READS },
  {
    name: "an RSA exponent of 25 bits",
    line: `florin ${rsa([1, 0, 0, 1], [0, 0xc1], 256)}`,
    refused: "key-invalid",
    ...READS,
  },
  {
    name: "an RSA exponent padded with a zero",
    line: `florin ${rsa([0, 1, 0, 1], [0, 0xc1], 256)}`,
    refused: "key-invalid",
    ...READS,
  },
  {
    name: "an RSA modulus padded with a zero",
    line: `florin ${rsa(F4, [0, 0, 0xc1], 256)}`,
    refused: "key-invalid",
    ...READS,
  },
  { name: "a negative RSA modulus", line: `florin ${rsa(F4, [0xc1], 256)}`, refused: "key-invalid" },
  {
    name: "a DSA key",
    line: `florin ssh-dss ${blob("ssh-dss", Buffer.from([1]), Buffer.from([1]), Buffer.from([1]), Buffer.from([1]))}`,
    refused: "key-type-unknown",
    openSsh: { as: "florin", reads: true, knowing: "ssh-dss" },
  },
];

const seconds = (time: string | undefined) => (time === undefined ? null : secondsOf(time));

/** The cases as the kernel reads each line: its principals, cert-authority, namespaces and window
 * in seconds since the epoch, or the class of its refusal. */
export function allowedSignersTable(): string {
  const cases = ALLOWED_SIGNERS_CASES.map(({ name, line }) => {
    const read = readAllowedSignersLine(line);
    if ("refused" in read) {
      return { name, line, outcome: "refused", reason: read.refused };
    }
    const { certAuthority, namespaces, validAfter, validBefore } = read;
    return {
      name,
      line,
      outcome: "accepted",
      principals: principalsOf(read),
      certAuthority,
      namespaces,
      validAfter: seconds(validAfter),
      validBefore: seconds(validBefore),
    };
  });
  return `${JSON.stringify({ cases }, null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(join(CONFORMANCE_DIR, "allowed-signers.json"), allowedSignersTable());
  process.stdout.write(`wrote the allowed-signers cases to ${CONFORMANCE_DIR}\n`);
}
