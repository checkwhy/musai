import {
  ALLOWED_SIGNERS_FILE,
  KEY_PRINCIPAL_PREFIX,
  keyPrincipal,
  sshKeyFingerprint,
  TrustFileError,
} from "@musai/records";

/** Each key type OpenSSH 9.6 reads, and the fields its blob holds after the type's own name. */
const KEY_FIELDS: ReadonlyMap<string, number> = new Map([
  ["ssh-ed25519", 1],
  ["sk-ssh-ed25519@openssh.com", 2],
  ["ssh-rsa", 2],
  ["ssh-dss", 4],
  ["ecdsa-sha2-nistp256", 2],
  ["ecdsa-sha2-nistp384", 2],
  ["ecdsa-sha2-nistp521", 2],
  ["sk-ecdsa-sha2-nistp256@openssh.com", 3],
]);

/** OpenSSH 10 reads no DSA key, so a line naming one is trust a current OpenSSH cannot check. */
const RETIRED_KEY_TYPES: ReadonlySet<string> = new Set(["ssh-dss"]);

export interface Curve {
  readonly prime: bigint;
  readonly b: bigint;
  readonly order: bigint;
  readonly size: number;
}

/** Each NIST curve OpenSSH reads, y² = x³ - 3x + b over its prime, and its coordinates' bytes. */
export const CURVES: ReadonlyMap<string, Curve> = new Map([
  [
    "nistp256",
    {
      prime: 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn,
      b: 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn,
      order: 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n,
      size: 32,
    },
  ],
  [
    "nistp384",
    {
      prime: 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffeffffffff0000000000000000ffffffffn,
      b: 0xb3312fa7e23ee7e4988e056be3f82d19181d9c6efe8141120314088f5013875ac656398d8a2ed19d2a85c8edd3ec2aefn,
      order: 0xffffffffffffffffffffffffffffffffffffffffffffffffc7634d81f4372ddf581a0db248b0a77aecec196accc52973n,
      size: 48,
    },
  ],
  [
    "nistp521",
    {
      prime: (1n << 521n) - 1n,
      b: 0x51953eb9618e1c9a1f929a21a0b68540eea2da725b99b315f3b8b489918ef109e156193951ec7e937b1652c0bd3bb1bf073573df883d2c34f1ef451fd46b503f00n,
      order:
        0x1fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa51868783bf2f966b7fcc0148f709a5d03bb5c9b8899c47aebb6fb71e91386409n,
      size: 66,
    },
  ],
]);

const bitLength = (value: bigint) => (value === 0n ? 0 : value.toString(2).length);

const integerOf = (bytes: Buffer) => (bytes.length === 0 ? 0n : BigInt(`0x${bytes.toString("hex")}`));

/** One entry of an OpenSSH allowed-signers file. */
export interface AllowedSigner {
  readonly principals: string;
  readonly certAuthority: boolean;
  readonly namespaces?: string;
  readonly validAfter?: string;
  readonly validBefore?: string;
  readonly keyType: string;
  readonly key: string;
  readonly comment?: string;
}

/** Why a line is refused, named alike by every verifier that reads the file. */
export type LineRefusal =
  | "unread-character"
  | "incomplete"
  | "principal-pattern"
  | "principal-quoted"
  | "option-unknown"
  | "option-unquoted"
  | "option-repeated"
  | "option-time"
  | "window-empty"
  | "key-type-unknown"
  | "key-invalid"
  | "key-foreign";

export interface RefusedLine {
  readonly refused: LineRefusal;
  readonly problem: string;
}

const refusal = (refused: LineRefusal, problem: string): RefusedLine => ({ refused, problem });

function tokenizeRespectingQuotes(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if ((char === " " || char === "\t") && !inQuotes) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

function splitOptionSpecs(raw: string): string[] {
  const specs: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const char of raw) {
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (char === "," && !inQuotes) {
      specs.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  specs.push(current);
  return specs;
}

interface ParsedOptions {
  certAuthority: boolean;
  namespaces?: string;
  validAfter?: string;
  validBefore?: string;
}

type Valued = "namespaces" | "validAfter" | "validBefore";

const VALUED: ReadonlyMap<string, Valued> = new Map([
  ["namespaces", "namespaces"],
  ["valid-after", "validAfter"],
  ["valid-before", "validBefore"],
]);

/** OpenSSH's absolute times to the day, minute or second, in UTC only: one without `Z` or `UTC`
 * reads in the verifying machine's zone, so a stranger's re-check could judge it otherwise. */
const TIME = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?(?:z|utc)$/i;

/** The seconds since the epoch `value` names, or null where OpenSSH reads no time in it; it
 * normalises as `mktime` does, so the 30th of February is in March, and refuses the epoch. */
export function secondsOf(value: string): number | null {
  const parts = TIME.exec(value);
  if (parts === null) {
    return null;
  }
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] = parts
    .slice(1)
    .map((field) => Number(field ?? 0));
  const within = (field: number, low: number, high: number) => field >= low && field <= high;
  const valid =
    within(year, 1970, 9999) &&
    within(month, 1, 12) &&
    within(day, 1, 31) &&
    within(hour, 0, 23) &&
    within(minute, 0, 59) &&
    within(second, 0, 59);
  const seconds = Date.UTC(year, month - 1, day, hour, minute, second) / 1000;
  return valid && seconds > 0 ? seconds : null;
}

/** Read as OpenSSH reads options, so a line it would skip is refused rather than trusted. */
function parseOptions(raw: string): ParsedOptions | RefusedLine {
  const options: ParsedOptions = { certAuthority: false };
  for (const spec of splitOptionSpecs(raw)) {
    const equalsIndex = spec.indexOf("=");
    const name = (equalsIndex === -1 ? spec : spec.slice(0, equalsIndex)).toLowerCase();
    if (name === "cert-authority" && equalsIndex === -1) {
      options.certAuthority = true;
      continue;
    }
    const field = VALUED.get(name);
    if (field === undefined || equalsIndex === -1) {
      return refusal("option-unknown", `an option OpenSSH does not read, ${spec === "" ? "an empty one" : spec}`);
    }
    const quoted = spec.slice(equalsIndex + 1);
    // OpenSSH reads a backslash before the closing quote as escaping it, so the value never ends.
    if (!/^"[^"]*"$/.test(quoted) || quoted.endsWith('\\"')) {
      return refusal("option-unquoted", `the option ${name} with a value not in quotes`);
    }
    if (options[field] !== undefined) {
      return refusal("option-repeated", `the option ${name} more than once`);
    }
    const value = quoted.slice(1, -1);
    if (field !== "namespaces" && secondsOf(value) === null) {
      return refusal("option-time", `the option ${name} with no time in UTC OpenSSH reads`);
    }
    options[field] = value;
  }
  if (
    options.validAfter !== undefined &&
    options.validBefore !== undefined &&
    secondsOf(options.validBefore)! <= secondsOf(options.validAfter)!
  ) {
    return refusal("window-empty", "a window closing before it opens");
  }
  return options;
}

/** The value of an SSH mpint written in its one canonical form, or null: OpenSSH fingerprints the
 * key it re-encodes, so a padded or negative one would name a key other than its bytes hash to. */
function canonicalMpint(field: Buffer): bigint | null {
  if (field.length === 0) {
    return 0n;
  }
  if ((field[0]! & 0x80) !== 0 || (field[0] === 0 && (field.length === 1 || (field[1]! & 0x80) === 0))) {
    return null;
  }
  return integerOf(field);
}

/** An RSA key OpenSSH reads, of 1024 to 16384 bits, whose exponent is odd, at least 3 and of at
 * most 24 bits, the bound the Go verifier's SSH library parses a signature's key under. */
function holdsRsaKey([exponent, modulus]: readonly Buffer[]): boolean {
  const e = canonicalMpint(exponent!);
  const n = canonicalMpint(modulus!);
  const bits = n === null ? 0 : bitLength(n);
  return e !== null && e >= 3n && e % 2n === 1n && e < 1n << 24n && bits >= 1024 && bits <= 16384;
}

/** An uncompressed point on `curve` as OpenSSH's `sshkey_ec_validate_public` takes one: each
 * coordinate longer than half the order's bits and short of the order less one. */
function onCurve(curve: string, point: Buffer): boolean {
  const { prime, b, order, size } = CURVES.get(curve)!;
  if (point.length !== 1 + 2 * size || point[0] !== 4) {
    return false;
  }
  const x = integerOf(point.subarray(1, 1 + size));
  const y = integerOf(point.subarray(1 + size));
  const half = Math.floor(bitLength(order) / 2);
  const within = (coordinate: bigint) => bitLength(coordinate) > half && coordinate < order - 1n;
  return within(x) && within(y) && (y * y - (x * x * x - 3n * x + b)) % prime === 0n;
}

/** Whether `key` is base64 of a `keyType` blob OpenSSH reads: its name, then its fields and
 * nothing more, each as that type holds it. */
function holdsKeyOf(keyType: string, key: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(key) || key.length % 4 !== 0) {
    return false;
  }
  const blob = Buffer.from(key, "base64");
  if (blob.toString("base64") !== key) {
    return false;
  }
  const fields: Buffer[] = [];
  let offset = 0;
  while (offset < blob.length) {
    if (offset + 4 > blob.length) {
      return false;
    }
    const length = blob.readUInt32BE(offset);
    if (offset + 4 + length > blob.length) {
      return false;
    }
    fields.push(blob.subarray(offset + 4, offset + 4 + length));
    offset += 4 + length;
  }
  const [name, ...rest] = fields;
  if (name?.toString("latin1") !== keyType || rest.length !== KEY_FIELDS.get(keyType)) {
    return false;
  }
  const curve = keyType.match(/nistp\d+/)?.[0];
  if (curve !== undefined) {
    return rest[0]!.toString("latin1") === curve && onCurve(curve, rest[1]!);
  }
  return keyType === "ssh-rsa" ? holdsRsaKey(rest) : rest[0]!.length === 32;
}

/** The fingerprint of a key as allowed-signers and a public key line spell it, in base64. */
export function fingerprintOf(key: string): string {
  return sshKeyFingerprint(Buffer.from(key, "base64"));
}

/** The principal a public key line, `<type> <base64> [comment]`, names its key by. */
export function keyPrincipalOf(publicKey: string): string {
  const [, key] = publicKey.trim().split(/\s+/);
  if (key === undefined) {
    throw new RangeError(`not a public key line: ${publicKey}`);
  }
  return keyPrincipal(fingerprintOf(key));
}

export function principalsOf(signer: Pick<AllowedSigner, "principals">): string[] {
  return signer.principals.split(",").map((member) => member.trim());
}

/** The first name a line binding the key `principal` names lists for it, for display only. */
export function aliasOf(signers: readonly AllowedSigner[], principal: string): string | undefined {
  for (const signer of signers) {
    const listed = principalsOf(signer);
    if (listed.includes(principal)) {
      const alias = listed.find((member) => !member.startsWith(KEY_PRINCIPAL_PREFIX));
      if (alias !== undefined) {
        return alias;
      }
    }
  }
  return undefined;
}

/** A principal as a person reads it: the alias beside its key, then the principal itself. */
export function shownPrincipal(signers: readonly AllowedSigner[], principal: string): string {
  const alias = aliasOf(signers, principal);
  return alias === undefined ? principal : `${alias} (${principal})`;
}

/** A signer as one allowed-signers line, its options in the order OpenSSH documents them. */
export function formatAllowedSigner(signer: AllowedSigner): string {
  const options = [
    signer.certAuthority ? "cert-authority" : null,
    signer.namespaces === undefined ? null : `namespaces="${signer.namespaces}"`,
    signer.validAfter === undefined ? null : `valid-after="${signer.validAfter}"`,
    signer.validBefore === undefined ? null : `valid-before="${signer.validBefore}"`,
  ].filter((option): option is string => option !== null);
  return [signer.principals, options.join(","), signer.keyType, signer.key, signer.comment ?? ""]
    .filter((field) => field.length > 0)
    .join(" ");
}

/** The first line binding the key `principal` names that does not list it, as it reads with the
 * key's form added; null where none does. */
export function lineLackingKeyForm(signers: readonly AllowedSigner[], principal: string): string | null {
  const lacking = signers.find(
    (signer) =>
      !signer.certAuthority &&
      keyPrincipal(fingerprintOf(signer.key)) === principal &&
      !principalsOf(signer).includes(principal),
  );
  return lacking === undefined
    ? null
    : formatAllowedSigner({ ...lacking, principals: `${lacking.principals},${principal}` });
}

/** A line may list its own key's form among its principals and no other key's. */
function foreignKeyRefusal(signer: AllowedSigner): RefusedLine | null {
  const own = keyPrincipal(fingerprintOf(signer.key));
  const other = principalsOf(signer).find((member) => member.startsWith(KEY_PRINCIPAL_PREFIX) && member !== own);
  return other === undefined
    ? null
    : refusal("key-foreign", `the principal ${other} beside the key ${own}, and one key never speaks as another,`);
}

/** A line as OpenSSH reads it: spaces and tabs skipped before it, and a carriage return after. */
function trimLine(line: string): string {
  return line.replace(/^[ \t]+/, "").replace(/[ \t\r]+$/, "");
}

/** What OpenSSH reads as part of a name though it reads as a space elsewhere: controls, Unicode's
 * spaces and the byte-order mark. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
const UNREAD_CHARACTER = /[\x00-\x20\x7f-\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/u;

const codePoint = (character: string) => `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;

/** One line of the file, neither blank nor a comment, as OpenSSH reads it or refused. */
export function readAllowedSignersLine(rawLine: string): AllowedSigner | RefusedLine {
  const line = trimLine(rawLine);
  if (line.includes("\0")) {
    return refusal("unread-character", "a NUL, where OpenSSH ends the line");
  }
  const tokens = tokenizeRespectingQuotes(line);
  const optionsToken = tokens[1] !== undefined && !KEY_FIELDS.has(tokens[1]) ? tokens[1] : undefined;
  const keyTypeIndex = optionsToken === undefined ? 1 : 2;
  const keyType = tokens[keyTypeIndex];
  const key = tokens[keyTypeIndex + 1];
  if (keyType === undefined || key === undefined) {
    return refusal("incomplete", "no principals, options and key");
  }
  const unread = UNREAD_CHARACTER.exec(tokens[0]!)?.[0];
  if (unread !== undefined) {
    return refusal("unread-character", `principals holding ${codePoint(unread)}, which OpenSSH reads as a name's`);
  }
  // OpenSSH matches these as patterns, so a line musai reads as granting may match nobody there.
  if (/[!*?]/.test(tokens[0]!)) {
    return refusal("principal-pattern", `principals OpenSSH matches as patterns, ${tokens[0]}`);
  }
  // OpenSSH strips the quotes and ends the principals at the closing one, reading other names.
  if (tokens[0]!.includes('"')) {
    return refusal("principal-quoted", `principals OpenSSH reads without their quotes, ${tokens[0]}`);
  }
  const options = optionsToken === undefined ? { certAuthority: false } : parseOptions(optionsToken);
  if ("refused" in options) {
    return options;
  }
  if (!KEY_FIELDS.has(keyType)) {
    return refusal("key-type-unknown", `a key type OpenSSH does not read, ${keyType}`);
  }
  if (RETIRED_KEY_TYPES.has(keyType)) {
    return refusal("key-type-unknown", `a key type OpenSSH no longer reads, ${keyType}`);
  }
  if (!holdsKeyOf(keyType, key)) {
    return refusal("key-invalid", `a key that is no ${keyType} key OpenSSH reads`);
  }
  const comment = tokens.slice(keyTypeIndex + 2).join(" ") || undefined;
  const signer: AllowedSigner = { principals: tokens[0]!, keyType, key, comment, ...options };
  return foreignKeyRefusal(signer) ?? signer;
}

/** Parses OpenSSH's allowed-signers format, refusing by number any line OpenSSH would not read;
 * every empty form of the file yields no entries. */
export function parseAllowedSigners(content: string): AllowedSigner[] {
  const signers: AllowedSigner[] = [];
  for (const [index, rawLine] of content.split("\n").entries()) {
    const line = trimLine(rawLine);
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const read = readAllowedSignersLine(line);
    if ("refused" in read) {
      throw TrustFileError.atLine(ALLOWED_SIGNERS_FILE, index, read.problem, rawLine);
    }
    signers.push(read);
  }
  return signers;
}
