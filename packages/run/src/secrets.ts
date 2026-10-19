import type { BindingObservation, ScrubEntry } from "@musai/records";
import { keyedHash, RUN_ENV_HASH_PURPOSE } from "@musai/records";
import { type KeyFile, keyById, keyMaterial, type WorkspaceKey } from "@musai/store";
import { RunRefusedError } from "./hygiene.js";

/** A secret on a receipt: a keyed hash and the key id it was minted under, never the value. */
export function secretObservation(key: WorkspaceKey, name: string, value: string): BindingObservation {
  return {
    name,
    secret: true,
    layer: "bindings",
    value: null,
    keyedHash: keyedHash(keyMaterial(key), RUN_ENV_HASH_PURPOSE, name, value),
    keyId: key.id,
  };
}

/** Prefixes a secret binding's read id, as `substrateReadId` prefixes a substrate's. */
const SECRET_READ_PREFIX = "secret";

/** One name bound to one value under one key gives one id, so an unchanged re-run marks
 * nothing stale. */
export function secretReadId(name: string, keyId: string, hash: string): string {
  return `${SECRET_READ_PREFIX}:${RUN_ENV_HASH_PURPOSE}:${name}:${keyId}:${hash}`;
}

interface ParsedSecretReadId {
  readonly purpose: string;
  readonly name: string;
  readonly keyId: string;
  readonly hash: string;
}

function parseSecretReadId(readId: string): ParsedSecretReadId | undefined {
  const parts = readId.split(":");
  if (parts.length !== 5 || parts[0] !== SECRET_READ_PREFIX) {
    return undefined;
  }
  return { purpose: parts[1]!, name: parts[2]!, keyId: parts[3]!, hash: parts[4]! };
}

/** Reads whose bound value changed or vanished, recomputed under the key each names, retired or
 * not. A key this workspace never held is a peer's and is skipped; rotation alone moves nothing. */
export function movedSecretReads(
  file: KeyFile,
  reads: ReadonlySet<string>,
  current: (name: string) => string | undefined,
): ReadonlySet<string> {
  const moved = new Set<string>();
  for (const readId of reads) {
    const parsed = parseSecretReadId(readId);
    if (parsed === undefined) {
      continue;
    }
    const key = keyById(file, parsed.keyId);
    if (key === undefined) {
      continue;
    }
    const value = current(parsed.name);
    if (value === undefined) {
      moved.add(readId);
      continue;
    }
    const recomputed = keyedHash(keyMaterial(key), parsed.purpose, parsed.name, value);
    if (recomputed !== parsed.hash) {
      moved.add(readId);
    }
  }
  return moved;
}

/** A bound secret's value, held only for the one call that checks or scrubs with it. */
export interface BoundSecret {
  readonly name: string;
  readonly value: string;
}

/** An argument list is visible to every process on the machine, so no later scrub could reach a
 * secret in it. An empty value is never matched. */
export function refuseSecretInArgv(command: readonly string[], bound: readonly BoundSecret[]): void {
  for (const secret of bound) {
    if (secret.value.length === 0) {
      continue;
    }
    for (const argument of command) {
      if (argument.includes(secret.value)) {
        throw new RunRefusedError(`refusing to run: the argument list would carry the value bound to ${secret.name}`);
      }
    }
  }
}

/** Narrow on purpose: a match refuses a citation outright, so each is a shape no ordinary
 * document wears. */
const CREDENTIAL_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "a PEM private key", pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  { name: "an AWS access key id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "a GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/ },
  { name: "an sk- prefixed API key", pattern: /\bsk-(?:[A-Za-z0-9]+-)*[A-Za-z0-9_]{20,}/ },
  { name: "a Slack token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: "a Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}/ },
  { name: "a Stripe live key", pattern: /\b[rs]k_live_[0-9A-Za-z]{24,}/ },
];

/** A record is never rewritten, so an undeclared credential is refused rather than redacted.
 * The refusal names the shape and offset, never the text. */
export function refuseCredentialIn(locator: string, text: string): void {
  for (const { name, pattern } of CREDENTIAL_PATTERNS) {
    const match = pattern.exec(text);
    if (match !== null) {
      throw new RunRefusedError(
        `refusing to cite ${locator}: its body carries ${name} at character ${match.index}, and a record is never rewritten; bind that value as a secret so the scrub removes it, then fetch again`,
      );
    }
  }
}

function scrubForms(value: string): readonly string[] {
  return [value, Buffer.from(value, "utf8").toString("base64"), encodeURIComponent(value)];
}

function replaceAllOccurrences(text: string, form: string, substitute: string): { text: string; count: number } {
  if (form.length === 0) {
    return { text, count: 0 };
  }
  const parts = text.split(form);
  const count = parts.length - 1;
  return { text: count > 0 ? parts.join(substitute) : text, count };
}

/** Reports every replacement: an output altered silently would differ from a receiver's re-run
 * with nobody able to say why. */
export function scrubOutput(
  output: string,
  bound: readonly BoundSecret[],
  minimumLength: number,
): { readonly text: string; readonly report: readonly ScrubEntry[] } {
  let text = output;
  const report: ScrubEntry[] = [];
  for (const secret of bound) {
    if (secret.value.length < minimumLength) {
      continue;
    }
    let total = 0;
    for (const form of scrubForms(secret.value)) {
      const replaced = replaceAllOccurrences(text, form, `[scrubbed:${secret.name}]`);
      text = replaced.text;
      total += replaced.count;
    }
    if (total > 0) {
      report.push({ name: secret.name, count: total });
    }
  }
  return { text, report };
}
