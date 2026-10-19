import { isPlainObject } from "../canonical/plain-object.js";
import { KernelError } from "../reason/error.js";
/** The one key the canonical form reserves; a sealed value hashes as an ordinary object. */
export const SEALED_KEY = "$sealed";

export const SEALED_ALGORITHMS = ["aes-256-gcm"] as const;

/** Shown where a sealed value stands, never the ciphertext. */
export const SEALED_RENDERING_PLACEHOLDER = "[sealed]";

export interface SealedValue {
  readonly [SEALED_KEY]: {
    readonly alg: (typeof SEALED_ALGORITHMS)[number];
    readonly keyId: string;
    readonly ciphertext: string;
    readonly digest: string;
  };
}

/** A field that holds text, or a sealed value standing in its place. */
export type SealableText = string | SealedValue;

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** The reserved key alone, over exactly the four fields a sealed value has. */
export function isSealedValue(value: unknown): value is SealedValue {
  if (!isPlainObject(value) || Object.keys(value).length !== 1 || !(SEALED_KEY in value)) {
    return false;
  }
  const sealed = value[SEALED_KEY];
  if (!isPlainObject(sealed)) {
    return false;
  }
  const keys = Object.keys(sealed).sort();
  if (keys.join(",") !== "alg,ciphertext,digest,keyId") {
    return false;
  }
  return (
    (SEALED_ALGORITHMS as readonly unknown[]).includes(sealed["alg"]) &&
    typeof sealed["keyId"] === "string" &&
    sealed["keyId"] !== "" &&
    typeof sealed["ciphertext"] === "string" &&
    sealed["ciphertext"] !== "" &&
    typeof sealed["digest"] === "string" &&
    DIGEST_PATTERN.test(sealed["digest"])
  );
}

/** Raised where a reader needing text meets a sealed value; this kernel never unseals. */
export class SealedValueError extends KernelError {
  constructor(where: string) {
    super({
      reason: "unsupported-format",
      detail: `${where} is sealed, and this kernel reserves the sealed form without being able to open it`,
      about: [where],
    });
    this.name = "SealedValueError";
  }
}

export function textOf(value: SealableText, where: string): string {
  if (typeof value === "string") {
    return value;
  }
  throw new SealedValueError(where);
}

export function renderedTextOf(value: SealableText): string {
  return typeof value === "string" ? value : SEALED_RENDERING_PLACEHOLDER;
}

/** The first path where the reserved key is malformed or not allowed, walking into values the
 * contract otherwise carries through unread. */
export function misplacedSealedPath(value: unknown, allowed: ReadonlySet<string>, path = "$"): string | null {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const found = misplacedSealedPath(entry, allowed, `${path}[${index}]`);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }
  if (!isPlainObject(value)) {
    return null;
  }
  if (SEALED_KEY in value) {
    return isSealedValue(value) && allowed.has(path) ? null : path;
  }
  for (const [key, entry] of Object.entries(value)) {
    const found = misplacedSealedPath(entry, allowed, `${path}.${key}`);
    if (found !== null) {
      return found;
    }
  }
  return null;
}
