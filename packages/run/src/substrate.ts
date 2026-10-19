import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import platformPath, { dirname, join, type PlatformPath, posix, resolve } from "node:path";
import type { DigestSet, ResourceDescriptor } from "@musai/records";
import { hexOfRecordId, rawId } from "@musai/records";
import { type GitContext, gitRevParse, gitWorkingTreeTree, resolveGitDir, resolveWorkTree } from "@musai/store";
import { type CheckoutBindings, readCheckoutBindings } from "./bindings.js";
import { RunRefusedError } from "./hygiene.js";

const TREE_SUBSTRATE_NAME = "source";

function hasDigest(descriptor: ResourceDescriptor): boolean {
  return descriptor.digest !== undefined && Object.keys(descriptor.digest).length > 0;
}

function assertResolvable(descriptor: ResourceDescriptor): void {
  if (descriptor.uri === undefined && !hasDigest(descriptor)) {
    throw new RunRefusedError(`substrate ${JSON.stringify(descriptor)} names neither a locator nor a digest`);
  }
}

export async function fileSubstrate(path: string): Promise<ResourceDescriptor> {
  const bytes = await readFile(path);
  const digest: DigestSet = { sha256: hexOfRecordId(rawId(bytes)) };
  return { uri: `file://${path}`, digest };
}

/** The tree git would commit from a checkout, since a dirty flag cannot tell two dirty states
 * apart. `seed` supplies only modes the disk cannot hold; a locator would cost portability. */
export async function treeSubstrate(
  ctx: GitContext,
  checkoutPath: string,
  seed?: string,
  excluded: readonly string[] = [],
): Promise<ResourceDescriptor> {
  const scratchDir = await mkdtemp(join(tmpdir(), "musai-substrate-"));
  try {
    const treeSha = await gitWorkingTreeTree(ctx, checkoutPath, join(scratchDir, "index"), seed, excluded);
    const digest: DigestSet = { gitTree: treeSha };
    return { name: TREE_SUBSTRATE_NAME, digest };
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

/** Whether a descriptor names a commit, and so a checkout this machine must bind. */
export function namesCommit(descriptor: ResourceDescriptor): boolean {
  return descriptor.digest?.gitCommit !== undefined;
}

/** A recipe names a working tree by name alone; its digest belongs to the observation, so the
 * recipe, and a claim over it, stays one across edits. */
export const TREE_SUBSTRATE_URI = "musai:tree";

export function namesTree(descriptor: ResourceDescriptor): boolean {
  return descriptor.uri === TREE_SUBSTRATE_URI;
}

/** A checkout a relative working directory resolves against: a named commit or a working tree. */
export function namesRoot(descriptor: ResourceDescriptor): boolean {
  return namesCommit(descriptor) || namesTree(descriptor);
}

/** Judges the spelling alone, the one thing a recipe carries to every machine; a symlink out is
 * refused at spawn by its real path. */
export function insideCheckout(workingDirectory: string): boolean {
  const portable = workingDirectory.replaceAll("\\", "/");
  if (posix.isAbsolute(portable) || /^[A-Za-z]:/.test(portable)) {
    return false;
  }
  const normalised = posix.normalize(portable);
  return normalised !== ".." && !normalised.startsWith("../");
}

/** Read only when a substrate names a checkout, a working tree `checkouts.json` leaves unbound
 * standing at `treeRoot`, or else at the top of the repository holding the workspace. */
export async function checkoutBindingsFor(
  substrates: readonly ResourceDescriptor[],
  localDir: string | undefined,
  treeRoot?: string,
): Promise<CheckoutBindings> {
  if (!substrates.some(namesRoot)) {
    return {};
  }
  const bound = localDir === undefined ? {} : await readCheckoutBindings(localDir);
  const unbound = substrates.filter(
    (descriptor) => namesTree(descriptor) && descriptor.name !== undefined && !Object.hasOwn(bound, descriptor.name),
  );
  if (unbound.length === 0) {
    return bound;
  }
  // The local directory sits in the workspace's `.musai/`, which sits in the project.
  const root = treeRoot ?? (localDir === undefined ? null : await resolveWorkTree(dirname(dirname(localDir))));
  if (root === null) {
    return bound;
  }
  return { ...bound, ...Object.fromEntries(unbound.map((descriptor) => [descriptor.name!, { directory: root }])) };
}

export function boundDirectory(checkouts: CheckoutBindings, descriptor: ResourceDescriptor): string | undefined {
  return descriptor.name !== undefined && Object.hasOwn(checkouts, descriptor.name)
    ? checkouts[descriptor.name]!.directory
    : undefined;
}

/** Reads objects, never the working tree, so it answers the same wherever the checkout moved. */
export async function commitTree(checkouts: CheckoutBindings, descriptor: ResourceDescriptor): Promise<string | null> {
  const directory = boundDirectory(checkouts, descriptor);
  const commit = descriptor.digest?.gitCommit;
  if (directory === undefined || commit === undefined) {
    return null;
  }
  const gitDir = await resolveGitDir(directory);
  return gitDir === null ? null : treeOfCommit({ gitDir }, commit);
}

function treeOfCommit(ctx: GitContext, commit: string): Promise<string | null> {
  return gitRevParse(ctx, `${commit}^{commit}^{tree}`);
}

/** Measured under the operator's git configuration, so a checkout `git status` calls clean
 * measures as its commit. No refusal names the directory, which a git failure's message holds. */
async function measureCheckout(
  checkouts: CheckoutBindings,
  descriptor: ResourceDescriptor,
): Promise<ResourceDescriptor> {
  const commit = descriptor.digest!.gitCommit!;
  if (descriptor.name === undefined) {
    throw new RunRefusedError(
      `refusing to run: substrate commit ${commit} has no name, so it names no checkout to measure`,
    );
  }
  const name = descriptor.name;
  const directory = boundDirectory(checkouts, descriptor);
  if (directory === undefined) {
    throw new RunRefusedError(
      `refusing to run: substrate ${name} names commit ${commit}, and no directory is bound for it; add it to checkouts.json in the workspace's local directory`,
    );
  }
  const gitDir = await resolveGitDir(directory);
  const expected = gitDir === null ? null : await treeOfCommit({ gitDir }, commit);
  if (gitDir === null || expected === null) {
    throw new RunRefusedError(
      `refusing to run: the checkout bound for substrate ${name} does not hold commit ${commit}`,
    );
  }
  let measured: string;
  try {
    measured = (await treeSubstrate({ gitDir, operatorConfig: true }, directory, commit)).digest!.gitTree!;
  } catch {
    throw new RunRefusedError(`refusing to run: the checkout bound for substrate ${name} could not be measured`);
  }
  if (measured !== expected) {
    throw new RunRefusedError(
      `refusing to run: the checkout bound for substrate ${name} is not at commit ${commit}: its tree is ${measured}, and the commit's tree is ${expected}`,
    );
  }
  return { name, digest: { gitCommit: commit, gitTree: measured } };
}

/** `inner` relative to `outer` with `/` separators, `""` where they are one, `null` outside it. */
export async function pathWithin(outer: string, inner: string): Promise<string | null> {
  // Compared as real paths: a symlink on either side would leave the inner path looking outside.
  const real = (path: string) => realpath(path).catch(() => resolve(path));
  return relativeWithin(await real(outer), await real(inner));
}

/** `pathWithin` over paths taken as they stand, under one platform's rules. */
export function relativeWithin(outer: string, inner: string, paths: PlatformPath = platformPath): string | null {
  const inside = paths.relative(outer, inner);
  const leaves = inside === ".." || inside.startsWith(`..${paths.sep}`) || paths.isAbsolute(inside);
  return leaves ? null : inside.replaceAll("\\", "/");
}

/** Each directory a run's records are written into, relative to `tree`, where it sits inside. */
async function recordDirsInside(tree: string, recordDirs: readonly string[]): Promise<string[]> {
  const inside = await Promise.all(recordDirs.map((dir) => pathWithin(tree, dir)));
  return inside.filter((path): path is string => path !== null && path.length > 0);
}

/** Measured as the commit-bound checkout is, less the directories the run writes its records
 * into, which would otherwise move the tree with every receipt. */
async function measureTree(
  checkouts: CheckoutBindings,
  descriptor: ResourceDescriptor,
  recordDirs: readonly string[],
): Promise<ResourceDescriptor> {
  const name = descriptor.name;
  if (name === undefined) {
    throw new RunRefusedError(
      `refusing to run: substrate ${TREE_SUBSTRATE_URI} has no name, so it names no tree to measure`,
    );
  }
  const directory = boundDirectory(checkouts, descriptor);
  if (directory === undefined) {
    throw new RunRefusedError(
      `refusing to run: substrate ${name} names a working tree, and no directory is bound for it; add it to checkouts.json in the workspace's local directory`,
    );
  }
  const gitDir = await resolveGitDir(directory);
  if (gitDir === null) {
    throw new RunRefusedError(
      `refusing to run: the directory bound for substrate ${name} is not in a git working tree`,
    );
  }
  const ctx: GitContext = { gitDir, operatorConfig: true };
  const head = await gitRevParse(ctx, "HEAD");
  let measured: string;
  try {
    measured = (await treeSubstrate(ctx, directory, head ?? undefined, await recordDirsInside(directory, recordDirs)))
      .digest!.gitTree!;
  } catch {
    throw new RunRefusedError(`refusing to run: the working tree bound for substrate ${name} could not be measured`);
  }
  return { name, digest: { gitTree: measured } };
}

/** Keeps declared positions so the two lists compare entry by entry. A checkout resolves to its
 * name, any commit and its measured tree, never its directory. */
export async function resolveSubstrates(
  declared: readonly ResourceDescriptor[],
  checkouts: CheckoutBindings,
  recordDirs: readonly string[] = [],
): Promise<ResourceDescriptor[]> {
  const resolved: ResourceDescriptor[] = [];
  for (const descriptor of declared) {
    assertResolvable(descriptor);
    if (namesCommit(descriptor)) {
      resolved.push(await measureCheckout(checkouts, descriptor));
      continue;
    }
    if (namesTree(descriptor)) {
      resolved.push(await measureTree(checkouts, descriptor, recordDirs));
      continue;
    }
    if (hasDigest(descriptor)) {
      resolved.push({ ...descriptor, digest: { ...descriptor.digest } });
      continue;
    }
    const fileDescriptor = await fileSubstrate(descriptor.uri!.replace(/^file:\/\//, ""));
    resolved.push({ ...descriptor, digest: fileDescriptor.digest });
  }
  return resolved;
}

/** The declared reference, never its digest, so a locator's read moves when it re-resolves. */
export function substrateReadId(declared: ResourceDescriptor): string {
  const reference = declared.uri ?? JSON.stringify(declared.digest ?? {});
  return `substrate:${reference}`;
}
