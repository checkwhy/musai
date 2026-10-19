import { isPlainObject } from "../canonical/plain-object.js";
import { isStringRecord } from "./fields.js";

export const DIGEST_ALGORITHMS = ["sha256", "gitTree", "gitCommit"] as const;

export type DigestAlgorithm = (typeof DIGEST_ALGORITHMS)[number];

export type DigestSet = Partial<Record<DigestAlgorithm, string>>;

/** A locator, a digest, or both, naming a substrate a run stood on; naming neither is refused. */
export interface ResourceDescriptor {
  name?: string;
  uri?: string;
  digest?: DigestSet;
  mediaType?: string;
  annotations?: Record<string, string>;
}

export function isDigestSet(value: unknown): value is DigestSet {
  if (!isPlainObject(value)) {
    return false;
  }
  return Object.entries(value).every(
    ([algorithm, digest]) => (DIGEST_ALGORITHMS as readonly string[]).includes(algorithm) && typeof digest === "string",
  );
}

export function isResourceDescriptor(value: unknown): value is ResourceDescriptor {
  if (!isPlainObject(value)) {
    return false;
  }
  if ("name" in value && typeof value["name"] !== "string") {
    return false;
  }
  if ("uri" in value && typeof value["uri"] !== "string") {
    return false;
  }
  if ("mediaType" in value && typeof value["mediaType"] !== "string") {
    return false;
  }
  if ("annotations" in value && value["annotations"] !== undefined && !isStringRecord(value["annotations"])) {
    return false;
  }
  const digest = value["digest"];
  if (digest !== undefined && !isDigestSet(digest)) {
    return false;
  }
  const hasLocator = typeof value["uri"] === "string";
  const hasDigest = digest !== undefined && Object.keys(digest as object).length > 0;
  return hasLocator || hasDigest;
}

export function cloneDescriptor(descriptor: ResourceDescriptor): ResourceDescriptor {
  const clone: ResourceDescriptor = {};
  if (descriptor.name !== undefined) {
    clone.name = descriptor.name;
  }
  if (descriptor.uri !== undefined) {
    clone.uri = descriptor.uri;
  }
  if (descriptor.digest !== undefined) {
    clone.digest = { ...descriptor.digest };
  }
  if (descriptor.mediaType !== undefined) {
    clone.mediaType = descriptor.mediaType;
  }
  if (descriptor.annotations !== undefined) {
    clone.annotations = { ...descriptor.annotations };
  }
  return clone;
}
