import { KEY_PRINCIPAL_PREFIX, keyPrincipal, sshKeyFingerprint } from "@musai/records";

const KEY_TYPE_PATTERN =
  /^(ssh-rsa|ssh-dss|ssh-ed25519|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)$/;

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
    if (char === " " && !inQuotes) {
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

function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

interface ParsedOptions {
  certAuthority: boolean;
  namespaces?: string;
  validAfter?: string;
  validBefore?: string;
}

function parseOptions(raw: string): ParsedOptions {
  const options: ParsedOptions = { certAuthority: false };
  for (const spec of splitOptionSpecs(raw)) {
    const equalsIndex = spec.indexOf("=");
    const key = (equalsIndex === -1 ? spec : spec.slice(0, equalsIndex)).toLowerCase();
    const value = equalsIndex === -1 ? undefined : unquote(spec.slice(equalsIndex + 1));
    if (key === "cert-authority") {
      options.certAuthority = true;
    } else if (key === "namespaces" && value !== undefined) {
      options.namespaces = value;
    } else if (key === "valid-after" && value !== undefined) {
      options.validAfter = value;
    } else if (key === "valid-before" && value !== undefined) {
      options.validBefore = value;
    }
  }
  return options;
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
function refuseSpeakingForAnotherKey(signer: AllowedSigner, rawLine: string): void {
  const own = keyPrincipal(fingerprintOf(signer.key));
  const other = principalsOf(signer).find((member) => member.startsWith(KEY_PRINCIPAL_PREFIX) && member !== own);
  if (other !== undefined) {
    throw new RangeError(
      `allowed-signers names ${other} for the key ${own}, and one key never speaks as another: ${rawLine}`,
    );
  }
}

/** Parses OpenSSH's allowed-signers format; every empty form of the file yields no entries. */
export function parseAllowedSigners(content: string): AllowedSigner[] {
  const signers: AllowedSigner[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const tokens = tokenizeRespectingQuotes(line);
    if (tokens.length < 3) {
      throw new RangeError(`not an allowed-signers line: ${rawLine}`);
    }
    const principals = tokens[0]!;
    const hasOptions = !KEY_TYPE_PATTERN.test(tokens[1]!);
    const optionsToken = hasOptions ? tokens[1] : undefined;
    const keyTypeIndex = hasOptions ? 2 : 1;
    const keyType = tokens[keyTypeIndex];
    const key = tokens[keyTypeIndex + 1];
    if (keyType === undefined || key === undefined) {
      throw new RangeError(`not an allowed-signers line: ${rawLine}`);
    }
    const comment = tokens.slice(keyTypeIndex + 2).join(" ") || undefined;
    const options = optionsToken ? parseOptions(optionsToken) : { certAuthority: false };
    const signer: AllowedSigner = { principals, keyType, key, comment, ...options };
    refuseSpeakingForAnotherKey(signer, rawLine);
    signers.push(signer);
  }
  return signers;
}
